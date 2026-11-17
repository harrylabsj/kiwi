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
 * Governance 运行时接线（M1 收尾：D-M0-05 / D-M0-08 / D-M0-09）。
 *
 * bootstrap 的 `state.sqlite` 装配处调用 `initializeGovernanceRuntime`：
 * - 先幂等迁移 `merchant_ops` schema（`instance_ownership` 属其 v2——bootstrap
 *   可能在 ops facade 之前调用本运行时，新库首启必须先建表）并注册三个独立
 *   账本（功能装配前就绪；失败只关新功能，原接待继续，设计 §18.2"迁移失败
 *   功能保持关闭"）；
 * - 仅当 learning/memory/jobs 任一开启时 CAS 获取实例所有权并心跳续约
 *   （间隔 `leaseMs/3`，timer `unref()`）；第二进程获取失败即 fail-closed
 *   ——不启用新功能、记录拒绝原因（X12），现有接待/经营路径保持原行为
 *   （§1.3：合法询价必须始终可走现有确定性路径，故不整体拒绝启动）；
 * - 续约失败（not_owner / lease_expired）记录 `ownership_lost` 并停止新功能
 *   写入（`assertOwner` 从此拒绝）；不自动重新 acquire——租约过期后可能已有
 *   接管方，盲目抢占会制造双写；重启进程是唯一恢复路径；
 * - 进程关闭时尽力 `release`；释放失败只记录，不阻塞退出。
 *
 * 观测走 `onEvent` 回调（稳定原因码，不含客户数据）；bootstrap 负责落日志。
 */

import type { DatabaseSync } from "node:sqlite";

import { migrateMerchantOpsSchema } from "../ops/schema.js";
import { registerGovernanceLedgers } from "../migrations/ledgers.js";
import { MigrationLedgerError } from "../migrations/runner.js";
import {
  InstanceOwnershipError,
  InstanceOwnershipService,
  type InstanceOwnershipLease,
} from "./instance-ownership.js";
import type { GovernanceFeatureFlags } from "../context-governance/feature-flags.js";

export const DEFAULT_GOVERNANCE_LEASE_MS = 60_000;

/** 运行时事件：稳定 type/reason，供日志与测试断言；不含客户数据或密钥。 */
export type GovernanceRuntimeEvent =
  | { type: "ledgers_registered" }
  | { type: "ledger_registration_failed"; reason: string }
  | { type: "ownership_acquired"; fencing: number }
  | { type: "ownership_acquisition_failed"; reason: string }
  | { type: "ownership_renewed"; fencing: number }
  | { type: "ownership_renewal_deferred"; reason: string }
  | { type: "ownership_renewal_callback_failed"; reason: string }
  | { type: "ownership_lost"; reason: string }
  | { type: "ownership_released" }
  | { type: "ownership_release_failed"; reason: string };

export type GovernanceRuntimeErrorCode =
  | "validation"
  | "feature_disabled"
  | "not_acquired";

export class GovernanceRuntimeError extends Error {
  readonly code: GovernanceRuntimeErrorCode;

  constructor(code: GovernanceRuntimeErrorCode, message: string) {
    super(message);
    this.name = "GovernanceRuntimeError";
    this.code = code;
  }
}

export interface GovernanceRuntimeOptions {
  db: DatabaseSync;
  /** 商家域（bootstrap 里来自认证主体 profile.owner_id），非请求正文。 */
  merchantId: string;
  /** 已严格解析的开关（解析失败应在更早的配置层启动失败，见收尾决议 §1.4）。 */
  flags: GovernanceFeatureFlags;
  /** 进程唯一 owner id（如 boot UUID）；复用固定字符串不能绕过 fencing。 */
  ownerId: string;
  now?: () => string;
  leaseMs?: number;
  /** 心跳间隔；默认 leaseMs/3。 */
  heartbeatMs?: number;
  onEvent?: (event: GovernanceRuntimeEvent) => void;
}

/**
 * 启动阶段瞬时锁竞争判定：沿 cause 链检查 SQLite 错误码（SQLITE_BUSY /
 * SQLITE_BUSY_SNAPSHOT / SQLITE_LOCKED）与消息（database is locked 等）——
 * node:sqlite 在不同包装层可能只暴露其一。嵌套事务错误（编程错误）与
 * 其他错误一律不重试。
 */
const isTransientDbLockError = (err: unknown): boolean => {
  let current: unknown = err;
  for (let hop = 0; current !== undefined && current !== null && hop < 5; hop++) {
    const code = (current as { code?: unknown }).code;
    if (
      code === "SQLITE_BUSY" ||
      code === "SQLITE_BUSY_SNAPSHOT" ||
      code === "SQLITE_LOCKED"
    ) {
      return true;
    }
    const message = current instanceof Error ? current.message : String(current);
    if (
      /database is locked|SQLITE_BUSY/i.test(message) &&
      !/within a transaction/i.test(message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** 有界同步退避（启动阶段可接受的短暂阻塞；总上限 ~150ms，不无限等待）。 */
const startupBackoffSync = (attempt: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
};

/**
 * governance 运行时句柄：新功能**写入**必须走 `writeUnderOwnership`（校验与
 * 写入同一事务，§4.3 禁止先查后写）；`assertOwner` 仅作读路径/准入预检。
 * 关闭时调用 `stop()`（清 timer + 尽力释放所有权）。
 */
export class GovernanceRuntime {
  /** learning/memory/jobs 任一开启才为 true；全关时实例纯做账本注册。 */
  readonly featureEnabled: boolean;
  private readonly db: DatabaseSync;
  private readonly merchantId: string;
  private readonly ownerId: string;
  private readonly now: () => string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly onEvent?: (event: GovernanceRuntimeEvent) => void;
  private readonly ownership: InstanceOwnershipService | undefined;
  private lease: InstanceOwnershipLease | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** ledgers_registered 是否已发出（幂等；start 各路径共用）。 */
  private ledgersRegisteredEmitted = false;

  constructor(options: GovernanceRuntimeOptions) {
    if (typeof options.merchantId !== "string" || options.merchantId.length === 0) {
      throw new GovernanceRuntimeError("validation", "merchantId 不能为空");
    }
    if (typeof options.ownerId !== "string" || options.ownerId.length === 0) {
      throw new GovernanceRuntimeError("validation", "ownerId 不能为空");
    }
    const leaseMs = options.leaseMs ?? DEFAULT_GOVERNANCE_LEASE_MS;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new GovernanceRuntimeError("validation", "leaseMs 必须是正整数");
    }
    const heartbeatMs = options.heartbeatMs ?? Math.floor(leaseMs / 3);
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0) {
      throw new GovernanceRuntimeError("validation", "heartbeatMs 必须是正整数");
    }
    this.db = options.db;
    this.merchantId = options.merchantId;
    this.ownerId = options.ownerId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseMs = leaseMs;
    this.heartbeatMs = heartbeatMs;
    this.onEvent = options.onEvent;
    this.featureEnabled =
      options.flags.learning_enabled || options.flags.memory_enabled || options.flags.jobs_enabled;
    this.ownership = this.featureEnabled
      ? new InstanceOwnershipService({ db: this.db, now: this.now, leaseMs })
      : undefined;
  }

  /** 当前是否持有实例所有权（新功能写入口的准入依据）。 */
  get active(): boolean {
    return this.lease !== undefined && !this.stopped;
  }

  /**
   * 预检（读路径/准入用）：核验**自己取得/续约时的 fencing** 仍有效。
   * - 未启用/未获取/已失去所有权时抛 GovernanceRuntimeError；
   * - 服务级拒绝（旧 owner / fencing 不符 / 租约过期）透传底层
   *   InstanceOwnershipError（保留 not_owner / fencing_mismatch / lease_expired
   *   原因码）。
   *
   * 预检**不采纳** DB 当前租约的 token：同 owner_id 被重新 acquire（接管）后，
   * 旧实例的无 token 预检在此抛 fencing_mismatch，而不是把内存租约刷新成
   * 接管方的 token（DeepSeek 实证绕过）。显式传入与当前持有不一致的 token
   * 同样 validation 拒绝——预检不能凭空升级自己的持有状态。
   */
  assertOwner(input: { expected_fencing?: number } = {}): InstanceOwnershipLease {
    if (this.ownership === undefined) {
      throw new GovernanceRuntimeError(
        "feature_disabled",
        "governance 功能未启用（flags 全关），不提供新功能写入",
      );
    }
    if (this.lease === undefined || this.stopped) {
      throw new GovernanceRuntimeError(
        "not_acquired",
        "未持有实例所有权（获取失败或已失去）；fail-closed",
      );
    }
    if (input.expected_fencing !== undefined && input.expected_fencing !== this.lease.fencing) {
      throw new GovernanceRuntimeError(
        "validation",
        `expected_fencing ${input.expected_fencing} 与当前持有的 fencing ${this.lease.fencing} 不一致`,
      );
    }
    // 逐次核验（§4.1）：以自己持有的 token 校验 DB 当前状态，成功即同一
    // fencing（续约不变号），不存在"预检把租约升级成他人 token"的路径。
    const current = this.ownership.assertOwner({
      merchant_id: this.merchantId,
      owner_id: this.ownerId,
      expected_fencing: this.lease.fencing,
    });
    this.lease = current;
    return current;
  }

  /**
   * 新功能写入的唯一栅栏入口（§4.3 禁止先查后写）：所有权校验与 `work` 的
   * 同库写入在同一个 `BEGIN IMMEDIATE` 事务内——租约过期/被接管/同 owner
   * 重获后持旧 token 的提交在**提交路径**上被拒，预检与提交之间无竞态窗口。
   *
   * fencing 绑定规则：默认取运行时**取得/续约时**的 `lease.fencing`；显式
   * `expected_fencing` 只是断言，**必须与本实例持有的 fencing 一致**——
   * 不一致（如同 owner 重获后旧实例传接管方的 2）一律 validation 拒绝，
   * 不透传给服务层（DeepSeek 实证：透传会让旧实例凭新 token 成功写入）。
   * `work` 只做同库持久写入；模型调用与外网请求不得进入本事务。任何失败
   * 整体回滚。
   */
  writeUnderOwnership<T>(
    work: (lease: InstanceOwnershipLease) => T,
    input: { expected_fencing?: number } = {},
  ): T {
    if (this.ownership === undefined) {
      throw new GovernanceRuntimeError(
        "feature_disabled",
        "governance 功能未启用（flags 全关），不提供新功能写入",
      );
    }
    if (this.lease === undefined || this.stopped) {
      throw new GovernanceRuntimeError(
        "not_acquired",
        "未持有实例所有权（获取失败或已失去）；fail-closed",
      );
    }
    if (input.expected_fencing !== undefined && input.expected_fencing !== this.lease.fencing) {
      throw new GovernanceRuntimeError(
        "validation",
        `expected_fencing ${input.expected_fencing} 与当前持有的 fencing ${this.lease.fencing} 不一致`,
      );
    }
    return this.ownership.withFencedWrite(
      {
        merchant_id: this.merchantId,
        owner_id: this.ownerId,
        expected_fencing: this.lease.fencing,
      },
      work,
    );
  }

  /**
   * 启动：确保 schema + （启用时）CAS 获取所有权 + 心跳。操作失败不抛，走事件。
   *
   * 启动阶段瞬时锁竞争（DeepSeek 双进程实证：同时热启动时迁移/acquire 的
   * BEGIN IMMEDIATE 可能 SQLITE_BUSY）：对 **仅 BUSY/locked 类错误** 做有界
   * 重试（4 次、25ms×n 同步退避，总上限 ~150ms）——迁移与账本登记幂等、
   * acquire 为 CAS，重试安全；单写者 fencing 语义不变。非锁错误（账本损坏、
   * ownership_held 等）与重试耗尽一律 fail-closed，事件语义与单次路径一致，
   * 不吞错误。
   */
  start(): void {
    if (this.stopped) {
      throw new GovernanceRuntimeError("not_acquired", "运行时已停止，不能再次启动");
    }
    // 重复 start：已持有租约（含 startHeartbeat 抛错后 stop 前）时幂等返回
    // ——保留可释放状态（lease 与心跳不变），不重复 acquire、不产生第二次
    // HELD 行竞争。
    if (this.lease !== undefined) return;
    // DB 重试区**只含数据库操作**（迁移/账本登记/acquire）；所有 onEvent
    // 回调与 heartbeat 都在重试区/捕获范围之外——回调抛错（含"database is
    // locked"文案的非 DB 错误）不会触发重试、不被吞。
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let acquired: InstanceOwnershipLease | undefined;
      // 失败事件按实际阶段区分：迁移/账本登记失败是 ledger_registration_failed；
      // 只有账本已就绪、acquire 本身失败才是 ownership_acquisition_failed。
      // （此前开启路径把登记失败也报成 acquisition_failed 并先发 ledgers_registered，
      // 属于伪造成功事件。）
      let phase: "ledger" | "acquire" = "ledger";
      try {
        // instance_ownership 属 merchant_ops 账本 v2：bootstrap 可能在
        // openMerchantOperationsFacade 之前调用本运行时（新库首启），这里
        // 先行幂等迁移，保证获取所有权时表已存在；旧库（ops v1）就地升级。
        migrateMerchantOpsSchema(this.db);
        registerGovernanceLedgers(this.db);
        if (this.ownership !== undefined) {
          phase = "acquire";
          acquired = this.ownership.acquire({
            merchant_id: this.merchantId,
            owner_id: this.ownerId,
          });
        }
      } catch (err) {
        // 仅数据库锁类错误且未到重试上限 → 有界退避重试；其余一律终态处理。
        if (isTransientDbLockError(err) && attempt < maxAttempts) {
          startupBackoffSync(attempt);
          continue;
        }
        if (phase === "acquire") {
          // acquire 阶段失败：租约未取得（acquire 内部 CAS 失败不落行），
          // 无需释放。账本已登记成功 → ledgers_registered 先如实发出。
          this.emitOnceLedgersRegistered();
          this.lease = undefined;
          this.emit({
            type: "ownership_acquisition_failed",
            reason: err instanceof InstanceOwnershipError ? err.code : errorMessage(err),
          });
        } else {
          const reason =
            err instanceof MigrationLedgerError
              ? `${err.kind}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err);
          this.emit({ type: "ledger_registration_failed", reason });
        }
        return;
      }
      // —— DB 重试区结束 ——
      // flags 全关：不获取所有权。账本登记成功 → ledgers_registered 在数据库
      // try/catch **之外**发出（回调原错原样上抛：含 "database is locked" 文案
      // 的非 DB 错误不触发重试、不被吞、无伪造失败事件）。
      if (this.ownership === undefined) {
        this.emitOnceLedgersRegistered();
        return;
      }
      // 所有权成功路径整体包裹：任何回调（ledgers_registered /
      // ownership_acquired）抛错 → 以取得时 fencing 安全释放租约（所有权回
      // 到可接管态，DB 行不残留 HELD）→ 异常原样上抛（不吞；primitive 抛值
      // 不被包装覆盖）。
      const lease = acquired;
      if (lease === undefined) {
        // 不可达：ownership 已启用时，acquire 成功才会离开 try。
        throw new GovernanceRuntimeError("not_acquired", "所有权获取未返回租约（fail-closed）");
      }
      this.lease = lease;
      try {
        this.emitOnceLedgersRegistered();
        this.emit({ type: "ownership_acquired", fencing: lease.fencing });
        this.startHeartbeat();
      } catch (err) {
        let released = false;
        try {
          this.ownership.release({
            merchant_id: this.merchantId,
            owner_id: this.ownerId,
            expected_fencing: lease.fencing,
          });
          released = true;
        } catch (releaseErr) {
          // 释放失败不掩盖回调异常；释放错误作为 cause 附带（租约将由到期
          // 接管收敛）。**仅对 object 类型抛值附加字段**——primitive 抛值
          //（字符串等）添加属性会 TypeError 并覆盖原抛值，primitive 原样保留。
          if (typeof err === "object" && err !== null) {
            (err as { cause?: unknown }).cause = releaseErr;
          }
        }
        this.lease = undefined;
        if (released && typeof err === "object" && err !== null) {
          (err as { ownershipReleased?: boolean }).ownershipReleased = true;
        }
        throw err;
      }
      return;
    }
  }

  /**
   * ledgers_registered 幂等发出（去重置位在实例字段）。emit 的异常原样
   * 上抛——primitive 抛值（字符串等）不做对象包装、不添加字段（对 primitive
   * 添加属性会 TypeError 并覆盖原抛值）。
   */  /**
   * ledgers_registered 幂等发出（去重置位在实例字段）。emit 的异常原样
   * 上抛——primitive 抛值（字符串等）不做对象包装、不添加字段（对 primitive
   * 添加属性会 TypeError 并覆盖原抛值）。
   */
  private emitOnceLedgersRegistered(): void {
    if (this.ledgersRegisteredEmitted) return;
    this.ledgersRegisteredEmitted = true;
    this.emit({ type: "ledgers_registered" });
  }

  tick(): void {
    if (this.stopped || this.ownership === undefined || this.lease === undefined) return;
    let renewed: InstanceOwnershipLease | undefined;
    try {
      renewed = this.ownership.renew({
        merchant_id: this.merchantId,
        owner_id: this.ownerId,
        expected_fencing: this.lease.fencing,
      });
    } catch (err) {
      if (isTransientDbLockError(err)) {
        // 暂时锁竞争（另一进程短占库）：**不清空 lease、不停心跳**——
        // 本次 tick 放弃续约，租约仍持有；下一次 tick（或锁释放后的手动
        // tick）可恢复。越期写入由 `writeUnderOwnership` 的租约期限校验
        // fail-closed 阻止（租约到期后 assertOwner 拒绝一切写入）。
        this.emit({
          type: "ownership_renewal_deferred",
          reason: errorMessage(err),
        });
        return;
      }
      // 终态丢失（fencing_mismatch / not_owner / lease_expired）：清空 lease、
      // 停心跳、发 ownership_lost。不回滚已提交结果、不删表；不自动重抢
      // （可能有接管方），重启是唯一恢复路径。续约 CAS 含 fencing：同 owner
      // 重获后旧实例在此 fencing_mismatch，接管方的新租约不会被续上，新
      // fencing 也不会写回旧实例内存。
      this.lease = undefined;
      this.stopHeartbeat();
      this.emit({
        type: "ownership_lost",
        reason: err instanceof InstanceOwnershipError ? err.code : errorMessage(err),
      });
      return;
    }
    // 续约成功：lease 已更新（所有权真实持有）。ownership_renewed 回调异常
    // 被**安全处理**：保留租约（真实持有，无需释放）、发可诊断的专用事件
    //（避免误发 ownership_lost——所有权并未丢失）。若处理该事件的回调也
    // 抛错（真实 timer 持续抛错场景），最后防线写 stderr 可诊断日志——
    // 隔离定时器边界（不产生未捕获崩溃），租约状态不受影响。
    this.lease = renewed;
    try {
      this.emit({ type: "ownership_renewed", fencing: this.lease.fencing });
    } catch (err) {
      try {
        this.emit({
          type: "ownership_renewal_callback_failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      } catch (nestedErr) {
        process.stderr.write(
          `kiwi-governance: ownership_renewed 回调与其失败诊断回调均抛错（租约保留）——` +
            `renewed: ${err instanceof Error ? err.message : String(err)}; ` +
            `diagnostic: ${nestedErr instanceof Error ? nestedErr.message : String(nestedErr)}\n`,
        );
      }
    }
  }

  /** 关闭：清心跳 timer，尽力释放所有权；释放失败只记录，不阻塞退出。 */
  stop(): void {
    this.stopHeartbeat();
    this.stopped = true;
    if (this.ownership === undefined || this.lease === undefined) return;
    try {
      // 释放以取得时的 fencing 做 CAS：同 owner 重获后旧实例的 stop 在
      // fencing_mismatch 被拒，不影响接管方（新实例）的租约。
      this.ownership.release({
        merchant_id: this.merchantId,
        owner_id: this.ownerId,
        expected_fencing: this.lease.fencing,
      });
      this.lease = undefined;
      this.emit({ type: "ownership_released" });
    } catch (err) {
      this.lease = undefined;
      this.emit({
        type: "ownership_release_failed",
        reason: err instanceof InstanceOwnershipError ? err.code : errorMessage(err),
      });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => this.tick(), this.heartbeatMs);
    // 不阻止进程退出（收尾指令：timer unref）。
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private emit(event: GovernanceRuntimeEvent): void {
    this.onEvent?.(event);
  }
}

/**
 * bootstrap 装配入口：构造 + `start()`。操作级失败（账本/所有权）不抛——
 * 只关新功能并经事件上报；参数形状错误抛 GovernanceRuntimeError("validation")
 * 由调用方转为启动失败。
 */
export function initializeGovernanceRuntime(options: GovernanceRuntimeOptions): GovernanceRuntime {
  const runtime = new GovernanceRuntime(options);
  runtime.start();
  return runtime;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
