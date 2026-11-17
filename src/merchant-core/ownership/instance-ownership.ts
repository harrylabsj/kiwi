/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 实例级单写者所有权（TOP1-3 设计 v1.1 §19 / D-M0-08）。
 *
 * `instance_ownership` 表（merchant_ops 账本 v2）每商家一行：启动 CAS 获取、
 * 心跳续约；第二进程 acquire 失败即 fail-closed（不得提供写入能力）。租约
 * 过期可接管，fencing 递增；旧 owner 的 renew / assertOwner（提交守卫）都被拒。
 *
 * 所有权是实例级，followup_tasks 的 lease/fencing 是任务级——两者不互替、
 * 不共用 token 序列。所有变更走 `BEGIN IMMEDIATE` 事务（CAS 由 WHERE 承担）。
 * `owner_id` 必须进程唯一（如 boot id），复用 owner_id 不能绕过 fencing。
 */

import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";

export interface InstanceOwnershipLease {
  readonly merchant_id: string;
  readonly owner_id: string;
  readonly fencing: number;
  readonly heartbeat_at: string;
  readonly lease_expires_at: string;
}

interface OwnershipRow {
  merchant_id: string;
  owner_id: string;
  fencing: number;
  heartbeat_at: string;
  lease_expires_at: string;
  state: "HELD" | "RELEASED";
  updated_at: string;
}

export type InstanceOwnershipErrorCode =
  | "validation"
  | "ownership_held"
  | "not_owner"
  | "lease_expired"
  | "fencing_mismatch";

export class InstanceOwnershipError extends Error {
  readonly code: InstanceOwnershipErrorCode;

  constructor(code: InstanceOwnershipErrorCode, message: string) {
    super(message);
    this.name = "InstanceOwnershipError";
    this.code = code;
  }
}

export interface InstanceOwnershipServiceOptions {
  db: DatabaseSync;
  now: () => string;
  /** 租约时长（毫秒）；D-M0-09 冻结骨架：FollowUp 租约 60s 同量级。 */
  leaseMs: number;
}

export class InstanceOwnershipService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly leaseMs: number;

  constructor(options: InstanceOwnershipServiceOptions) {
    this.db = options.db;
    this.now = options.now;
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new InstanceOwnershipError("validation", "leaseMs 必须是正整数");
    }
    this.leaseMs = options.leaseMs;
  }

  /**
   * 服务器时钟规范化为定宽 UTC（toISOString 形式）：租约列全部以该形式存储，
   * 字符串比较（到期判定、SQL WHERE）必须同构——非 UTC 偏移或秒级/毫秒级
   * 精度差异都会让字典序偏离时刻序（到期等号误判）。
   */
  private nowUtc(): string {
    const ms = Date.parse(this.now());
    if (!Number.isFinite(ms)) {
      throw new InstanceOwnershipError("validation", "时钟输出必须是可解析的 RFC3339 时间");
    }
    return new Date(ms).toISOString();
  }

  /**
   * CAS 获取所有权：无记录插入（fencing=1）；有记录且 state=RELEASED 或
   * 租约已到期（`lease_expires_at <= now`，到期等号即失效）则接管并
   * fencing+1；否则抛 ownership_held——调用方必须 fail-closed，不得写入。
   */
  acquire(input: { merchant_id: string; owner_id: string }): InstanceOwnershipLease {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const ownerId = requireId(input.owner_id, "owner_id");
    return inImmediateTransaction(this.db, () => {
      const now = this.nowUtc();
      const expires = new Date(Date.parse(now) + this.leaseMs).toISOString();
      // INSERT 新行；冲突时仅在"当前无人持有或租约已到期"的 WHERE 下接管。
      const result = this.db
        .prepare(
          `INSERT INTO instance_ownership
            (merchant_id, owner_id, fencing, heartbeat_at, lease_expires_at, state, updated_at)
           VALUES (?, ?, 1, ?, ?, 'HELD', ?)
           ON CONFLICT(merchant_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             fencing = instance_ownership.fencing + 1,
             heartbeat_at = excluded.heartbeat_at,
             lease_expires_at = excluded.lease_expires_at,
             state = 'HELD',
             updated_at = excluded.updated_at
           WHERE instance_ownership.state != 'HELD'
             OR instance_ownership.lease_expires_at <= excluded.heartbeat_at`,
        )
        .run(merchantId, ownerId, now, expires, now);
      if (Number(result.changes) !== 1) {
        throw new InstanceOwnershipError(
          "ownership_held",
          `商家 ${merchantId} 的实例所有权被其他进程持有且租约未到期；fail-closed，不提供写入能力`,
        );
      }
      return this.readLease(merchantId);
    });
  }

  /**
   * 心跳续约：**以取得/续约时的 fencing 做 CAS**（WHERE 含 `fencing = ?`）。
   * 续约是所有权行上的写操作，与栅栏写入同规则——省略/旧 token 一律拒绝：
   * 同 owner_id 被重新 acquire（接管，fencing 递增）后，旧实例的续约在
   * fencing_mismatch 处失败，不会把接管方的新租约续上、也不会把新 fencing
   * 写回旧实例内存（DeepSeek 实证绕过）。过期后必须重新 acquire。
   */
  renew(input: {
    merchant_id: string;
    owner_id: string;
    expected_fencing: number;
  }): InstanceOwnershipLease {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const ownerId = requireId(input.owner_id, "owner_id");
    if (!Number.isSafeInteger(input.expected_fencing) || input.expected_fencing < 1) {
      throw new InstanceOwnershipError(
        "validation",
        "expected_fencing 必须是正整数（续约强制持有 fencing token）",
      );
    }
    return inImmediateTransaction(this.db, () => {
      const now = this.nowUtc();
      const expires = new Date(Date.parse(now) + this.leaseMs).toISOString();
      const result = this.db
        .prepare(
          `UPDATE instance_ownership
              SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
            WHERE merchant_id = ? AND owner_id = ? AND fencing = ?
              AND state = 'HELD' AND lease_expires_at > ?`,
        )
        .run(now, expires, now, merchantId, ownerId, input.expected_fencing, now);
      if (Number(result.changes) !== 1) {
        throw this.renewFailure(merchantId, ownerId, input.expected_fencing);
      }
      return this.readLease(merchantId);
    });
  }

  /**
   * 释放所有权：**以取得时的 fencing 做 CAS**（WHERE 含 `fencing = ?`）。
   * 释放是所有权行上的写操作，与续约/栅栏写入同规则——同 owner_id 被重新
   * acquire 后，旧实例的 stop 持旧 token 在此处 fencing_mismatch 被拒，不会
   * 释放接管方（同 owner 新实例）的租约（DeepSeek 审查：renew 同根因）。
   */
  release(input: {
    merchant_id: string;
    owner_id: string;
    expected_fencing: number;
  }): void {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const ownerId = requireId(input.owner_id, "owner_id");
    if (!Number.isSafeInteger(input.expected_fencing) || input.expected_fencing < 1) {
      throw new InstanceOwnershipError(
        "validation",
        "expected_fencing 必须是正整数（释放强制持有 fencing token）",
      );
    }
    inImmediateTransaction(this.db, () => {
      // 审计列统一定宽 UTC。
      const result = this.db
        .prepare(
          `UPDATE instance_ownership SET state = 'RELEASED', updated_at = ?
            WHERE merchant_id = ? AND owner_id = ? AND fencing = ? AND state = 'HELD'`,
        )
        .run(this.nowUtc(), merchantId, ownerId, input.expected_fencing);
      if (Number(result.changes) !== 1) {
        const row = this.readRow(merchantId);
        if (row === undefined || row.owner_id !== ownerId || row.state !== "HELD") {
          throw new InstanceOwnershipError("not_owner", "所有权不存在或不属于该 owner");
        }
        throw new InstanceOwnershipError(
          "fencing_mismatch",
          `fencing 已变化（提交方 ${input.expected_fencing}）；旧 token 释放被拒`,
        );
      }
    });
  }

  /**
   * 提交前预检（读路径/准入用）：owner 持有且租约未到期时返回当前租约；
   * 提供 expectedFencing 时必须严格相等。**预检与写入分离存在 TOCTOU 窗口**——
   * 业务写入必须走 `withFencedWrite`（校验与写入同一事务），不得"先查权限、
   * 稍后无条件写入"（设计 §4.3）。
   */
  assertOwner(input: {
    merchant_id: string;
    owner_id: string;
    expected_fencing?: number;
  }): InstanceOwnershipLease {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const ownerId = requireId(input.owner_id, "owner_id");
    if (
      input.expected_fencing !== undefined &&
      (!Number.isSafeInteger(input.expected_fencing) || input.expected_fencing < 1)
    ) {
      throw new InstanceOwnershipError("validation", "expected_fencing 必须是正整数");
    }
    const row = this.readRow(merchantId);
    if (
      row === undefined ||
      row.state !== "HELD" ||
      row.owner_id !== ownerId
    ) {
      throw new InstanceOwnershipError("not_owner", "所有权不存在或已不属于该 owner");
    }
    if (row.lease_expires_at <= this.nowUtc()) {
      // 到期等号即失效：过期 owner 不能借"还没被接管"继续提交。
      throw new InstanceOwnershipError("lease_expired", "所有权租约已过期，禁止提交");
    }
    if (input.expected_fencing !== undefined && row.fencing !== input.expected_fencing) {
      throw new InstanceOwnershipError(
        "fencing_mismatch",
        `fencing 已变化（当前 ${row.fencing}，提交方 ${input.expected_fencing}）；旧 owner 提交被拒`,
      );
    }
    return toLease(row);
  }

  /**
   * 栅栏写入（fenced write）：所有权校验与业务写入在同一个 `BEGIN IMMEDIATE`
   * 事务内完成，消除"先查权限、稍后写入"的竞态——
   * - **`expected_fencing` 必填**：写事务强制持有取得时的 fencing token。
   *   省略会退化为 owner_id 相等判定——同 owner_id 重新 acquire（fencing 已
   *   递增）后，旧 worker 省略 token 即可再写（DeepSeek 实证缺陷），故缺失
   *   一律 validation 拒绝；
   * - 校验语义与 `assertOwner` 一致（HELD + owner 匹配 + 租约未到期 + fencing
   *   严格相等），在持锁后逐项判定；租约过期/被接管/同 owner 重获后持旧
   *   token 的提交在提交路径上被拒；
   * - 接管方同为写事务，与本次写入串行化：先提交者胜，后者校验必然失败；
   * - `work` 在事务内执行业务写入，抛错即整体回滚（无部分写入）。
   * 注意：`work` 只做同库持久写入；模型调用、外网请求不得进入本事务。
   */
  withFencedWrite<T>(
    input: { merchant_id: string; owner_id: string; expected_fencing: number },
    work: (lease: InstanceOwnershipLease) => T,
  ): T {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const ownerId = requireId(input.owner_id, "owner_id");
    if (!Number.isSafeInteger(input.expected_fencing) || input.expected_fencing < 1) {
      // 覆盖省略/undefined/非法值：写事务没有"无 token"路径。
      throw new InstanceOwnershipError(
        "validation",
        "expected_fencing 必须是正整数（写事务强制持有 fencing token）",
      );
    }
    return inImmediateTransaction(this.db, () => {
      const lease = this.assertOwner({
        merchant_id: merchantId,
        owner_id: ownerId,
        expected_fencing: input.expected_fencing,
      });
      return work(lease);
    });
  }

  private renewFailure(
    merchantId: string,
    ownerId: string,
    expectedFencing: number,
  ): InstanceOwnershipError {
    const row = this.readRow(merchantId);
    if (row === undefined || row.owner_id !== ownerId) {
      return new InstanceOwnershipError("not_owner", "所有权不存在或不属于该 owner，续约被拒");
    }
    if (row.fencing !== expectedFencing) {
      // 同 owner_id 重获/接管后持旧 token 续约：不泄露接管方状态细节。
      return new InstanceOwnershipError(
        "fencing_mismatch",
        `fencing 已变化（提交方 ${expectedFencing}）；旧 token 续约被拒`,
      );
    }
    if (row.lease_expires_at <= this.nowUtc()) {
      return new InstanceOwnershipError("lease_expired", "租约已过期；必须重新 acquire 接管");
    }
    return new InstanceOwnershipError("not_owner", "所有权已释放，续约被拒");
  }

  private readRow(merchantId: string): OwnershipRow | undefined {
    return this.db
      .prepare("SELECT * FROM instance_ownership WHERE merchant_id = ?")
      .get(merchantId) as unknown as OwnershipRow | undefined;
  }

  private readLease(merchantId: string): InstanceOwnershipLease {
    const row = this.readRow(merchantId);
    if (row === undefined) {
      throw new InstanceOwnershipError("not_owner", "所有权记录不存在");
    }
    return toLease(row);
  }
}

function toLease(row: OwnershipRow): InstanceOwnershipLease {
  return {
    merchant_id: row.merchant_id,
    owner_id: row.owner_id,
    fencing: row.fencing,
    heartbeat_at: row.heartbeat_at,
    lease_expires_at: row.lease_expires_at,
  };
}

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new InstanceOwnershipError("validation", `${field} 必须是 1..128 字符`);
  }
  return value;
}
