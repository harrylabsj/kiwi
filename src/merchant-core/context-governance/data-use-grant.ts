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
 * DataUseGrant 存储（TOP1-3 设计 v1.1 §4.2 / §9.2 / §18.1）。
 *
 * 授权、撤销、epoch 递增、过期都在服务端完成：
 * - 创建：同 (merchant, subject, purpose, resource_scope) 的 epoch 取历史
 *   最大值 +1（撤销/过期后的重新授权是新 grant_id、新 epoch，不复活旧记录）；
 * - 撤销：CAS 校验 expected_epoch，ACTIVE → REVOKED；
 * - 过期：读取按 `status='ACTIVE' AND expires_at > now` 过滤（附录 C1：
 *   now 等于 expires_at 即失效）；`expireDue` 把到期行翻为 EXPIRED 便于观测。
 *
 * 查询一律带 merchant/subject 作用域（§18.1：禁止无作用域 getById 给接待）。
 * 表结构在 customer_memory 账本 v1（见 ../migrations/ledgers.ts）。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";
import {
  ContextGovernanceError,
  DATA_USE_PURPOSES,
  GOVERNANCE_POLICY_VERSION,
  assertOpaqueId,
  type DataGrantStatus,
  type DataUsePurpose,
} from "./types.js";

export interface DataUseGrant {
  readonly grant_id: string;
  readonly merchant_id: string;
  readonly subject_id: string;
  readonly purpose: DataUsePurpose;
  readonly resource_scope_id: string;
  readonly grant_epoch: number;
  readonly status: DataGrantStatus;
  readonly expires_at: string;
  readonly policy_version: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface GrantRow {
  grant_id: string;
  merchant_id: string;
  subject_id: string;
  purpose: DataUsePurpose;
  resource_scope_id: string;
  grant_epoch: number;
  status: DataGrantStatus;
  expires_at: string;
  policy_version: string;
  created_at: string;
  updated_at: string;
}

function rowToGrant(row: GrantRow): DataUseGrant {
  return {
    grant_id: row.grant_id,
    merchant_id: row.merchant_id,
    subject_id: row.subject_id,
    purpose: row.purpose,
    resource_scope_id: row.resource_scope_id,
    grant_epoch: row.grant_epoch,
    status: row.status,
    expires_at: row.expires_at,
    policy_version: row.policy_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 时间列以 UTC RFC3339 存储（工程约束：所有时间 RFC3339 UTC）。
 * - 拒绝非 UTC 偏移（如 +08:00）：SQL 侧按字符串比较到期时间，偏移形式
 *   会破坏字典序与时刻序的一致性；
 * - 返回 `toISOString()` 定宽形式（.sssZ）："…00Z" 与 "…00.000Z" 精度不同
 *   也会破坏字典序（到期等号误判），写入前统一规范化。
 */
function assertUtcRfc3339(value: string, field: string): string {
  if (!value.endsWith("Z")) {
    throw new ContextGovernanceError(
      "validation",
      `${field}_not_utc`,
      `${field} 必须是 UTC RFC3339（Z 结尾），收到 ${value}`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ContextGovernanceError("validation", `${field}_invalid`, `${field} 必须是 RFC3339 时间`);
  }
  return new Date(ms).toISOString();
}

export interface DataUseGrantStoreOptions {
  db: DatabaseSync;
  now: () => string;
}

export class DataUseGrantStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: DataUseGrantStoreOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  /**
   * 服务器时钟规范化为定宽 UTC（与存储形式一致，SQL 字符串比较才可靠）。
   * 时钟是服务端可信注入：偏移/秒级形式一律规范化，只拒绝不可解析值。
   */
  private nowUtc(): string {
    const ms = Date.parse(this.now());
    if (!Number.isFinite(ms)) {
      throw new ContextGovernanceError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
    }
    return new Date(ms).toISOString();
  }

  /**
   * 授予一个数据用途。purpose/scope 决定用途边界：记忆授权不等于历史检索
   * 或经验提炼授权。撤销/过期后重新授权产生新 grant_id 与递增 epoch。
   */
  createGrant(input: {
    merchant_id: string;
    subject_id: string;
    purpose: DataUsePurpose;
    resource_scope_id: string;
    expires_at: string;
  }): DataUseGrant {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const subjectId = assertOpaqueId(input.subject_id, "subject_id");
    const scopeId = assertOpaqueId(input.resource_scope_id, "resource_scope_id");
    if (!(DATA_USE_PURPOSES as readonly string[]).includes(input.purpose)) {
      throw new ContextGovernanceError(
        "validation",
        "purpose_unknown",
        `purpose "${input.purpose}" 不在固定注册表中`,
      );
    }
    const nowValue = this.nowUtc();
    const expiresAt = assertUtcRfc3339(input.expires_at, "expires_at");
    if (Date.parse(expiresAt) <= Date.parse(nowValue)) {
      // 附录 C1：now 等于 expires_at 即失效——创建即过期没有意义，直接拒绝。
      throw new ContextGovernanceError(
        "validation",
        "expires_at_not_future",
        "expires_at 必须晚于当前时间",
      );
    }
    return inImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT MAX(grant_epoch) AS max_epoch FROM data_grants
            WHERE merchant_id = ? AND subject_id = ? AND purpose = ? AND resource_scope_id = ?`,
        )
        .get(merchantId, subjectId, input.purpose, scopeId) as { max_epoch: number | null };
      const epoch = (row.max_epoch ?? 0) + 1;
      const grantId = `dug_${randomUUID()}`;
      // 审计列（created_at/updated_at）与到期列同构：统一规范化定宽 UTC。
      const stamp = this.nowUtc();
      this.db
        .prepare(
          `INSERT INTO data_grants
            (grant_id, merchant_id, subject_id, purpose, resource_scope_id, grant_epoch,
             status, expires_at, policy_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
        )
        .run(
          grantId,
          merchantId,
          subjectId,
          input.purpose,
          scopeId,
          epoch,
          expiresAt,
          GOVERNANCE_POLICY_VERSION,
          stamp,
          stamp,
        );
      return this.requireGrant(merchantId, grantId);
    });
  }

  /**
   * 撤销授权：CAS 在 expected_epoch 上；epoch 不匹配或已非 ACTIVE 抛
   * version_conflict（§17.3：回读当前状态，不覆盖）。撤销本身递增
   * grant_epoch（§17.1 `memory.revokeGrant` 返回新 grant_epoch）——递增值取
   * 该 scope 当前最大 epoch +1，避免与同 scope 其他记录冲突；被撤记录的旧
   * epoch 空出，旧快照绑定值此后必然失配。重新授权的 epoch 从递增后再 +1。
   */
  revokeGrant(input: { merchant_id: string; grant_id: string; expected_epoch: number }): DataUseGrant {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const grantId = assertOpaqueId(input.grant_id, "grant_id");
    if (!Number.isSafeInteger(input.expected_epoch) || input.expected_epoch < 1) {
      throw new ContextGovernanceError("validation", "expected_epoch_invalid", "expected_epoch 必须是正整数");
    }
    return inImmediateTransaction(this.db, () => {
      const existing = this.requireGrant(merchantId, grantId);
      if (existing.grant_epoch !== input.expected_epoch || existing.status !== "ACTIVE") {
        throw new ContextGovernanceError(
          "version_conflict",
          "grant_epoch_mismatch",
          `grant ${grantId} 已变化（epoch=${existing.grant_epoch}, status=${existing.status}）`,
        );
      }
      this.db
        .prepare(
          `UPDATE data_grants SET
             grant_epoch = (SELECT COALESCE(MAX(grant_epoch), 0) + 1 FROM data_grants
                             WHERE merchant_id = ? AND subject_id = ? AND purpose = ?
                               AND resource_scope_id = ?),
             status = 'REVOKED', updated_at = ?
           WHERE merchant_id = ? AND grant_id = ? AND grant_epoch = ? AND status = 'ACTIVE'`,
        )
        .run(
          merchantId,
          existing.subject_id,
          existing.purpose,
          existing.resource_scope_id,
          this.nowUtc(),
          merchantId,
          grantId,
          input.expected_epoch,
        );
      return this.requireGrant(merchantId, grantId);
    });
  }

  /** 读取当前有效授权：状态 ACTIVE 且未过期；无效统一返回 undefined。 */
  getActiveGrant(input: {
    merchant_id: string;
    subject_id: string;
    purpose: DataUsePurpose;
    resource_scope_id: string;
  }): DataUseGrant | undefined {
    const now = this.nowUtc();
    const row = this.db
      .prepare(
        `SELECT * FROM data_grants
          WHERE merchant_id = ? AND subject_id = ? AND purpose = ? AND resource_scope_id = ?
            AND status = 'ACTIVE' AND expires_at > ?
          ORDER BY grant_epoch DESC LIMIT 1`,
      )
      .get(
        input.merchant_id,
        input.subject_id,
        input.purpose,
        input.resource_scope_id,
        now,
      ) as unknown as GrantRow | undefined;
    return row === undefined ? undefined : rowToGrant(row);
  }

  /** 把已到期的 ACTIVE 行翻为 EXPIRED（幂等；读取路径本就按时间过滤）。 */
  expireDue(): number {
    const now = this.nowUtc();
    return inImmediateTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE data_grants SET status = 'EXPIRED', updated_at = ?
            WHERE status = 'ACTIVE' AND expires_at <= ?`,
        )
        .run(now, now);
      return Number(result.changes);
    });
  }

  /**
   * 主体作用域列表（客户自助/工作台）：最小字段，仅当前商家；不返回其他
   * 商家或其他主体的记录。
   */
  listBySubject(input: { merchant_id: string; subject_id: string }): Array<
    Pick<DataUseGrant, "grant_id" | "purpose" | "resource_scope_id" | "grant_epoch" | "status" | "expires_at">
  > {
    const rows = this.db
      .prepare(
        `SELECT grant_id, purpose, resource_scope_id, grant_epoch, status, expires_at
          FROM data_grants
          WHERE merchant_id = ? AND subject_id = ?
          ORDER BY created_at DESC LIMIT 200`,
      )
      .all(input.merchant_id, input.subject_id) as unknown as Array<GrantRow>;
    return rows.map((row) => ({
      grant_id: row.grant_id,
      purpose: row.purpose,
      resource_scope_id: row.resource_scope_id,
      grant_epoch: row.grant_epoch,
      status: row.status,
      expires_at: row.expires_at,
    }));
  }

  /**
   * grant 当前有效 epoch（守卫用）：仅当存在、ACTIVE 且未过期时返回 epoch，
   * 否则 undefined——撤销、封存与到期在守卫语义下等价（旧快照失效）。
   */
  currentGrantEpoch(merchantId: string, grantId: string): number | undefined {
    const now = this.nowUtc();
    const row = this.db
      .prepare(
        `SELECT grant_epoch FROM data_grants
          WHERE merchant_id = ? AND grant_id = ? AND status = 'ACTIVE' AND expires_at > ?`,
      )
      .get(merchantId, grantId, now) as unknown as { grant_epoch: number } | undefined;
    return row === undefined ? undefined : row.grant_epoch;
  }

  /** 作用域读取：merchant 必须匹配；不存在时返回 undefined（不泄露存在性）。 */
  private requireGrant(merchantId: string, grantId: string): DataUseGrant {
    const row = this.db
      .prepare("SELECT * FROM data_grants WHERE merchant_id = ? AND grant_id = ?")
      .get(merchantId, grantId) as unknown as GrantRow | undefined;
    if (row === undefined) {
      throw new ContextGovernanceError("access_denied", "grant_not_found", "授权不存在或不可见");
    }
    return rowToGrant(row);
  }
}
