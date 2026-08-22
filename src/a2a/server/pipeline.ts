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
 * 入站 message/send 处理管线（WP2 核心，子规范 §24 / §20 / §28）。
 *
 * 顺序（全部 fail-closed）：
 *   1. 严格解析入站 A2A Message（inbound-message.ts）——失败 → schema_invalid；
 *   2. 提取 KNP envelope（Data Part 的 `knp_envelope`）——失败 → schema_invalid；
 *   3. validateEnvelope（schema / version / action-payload 匹配）——失败 →
 *      NegotiationValidationError.code 映射（未知版本 → protocol_version_unsupported）；
 *   4. verifyEnvelopeDigest——不一致 → schema_invalid（完整性失败，§19.2）；
 *   5. 协议幂等 check（(sender_identity, message_id)，§20）——同 key 同 digest →
 *      返回原结果；同 key 异 digest → idempotency_conflict；
 *   6. 串行锁（按幂等键）内重新 check（并发兜底），调用 NegotiationHandler；
 *   7. 生成 A2A Task、落 Ledger（message_received 事件，含 handler 结果证据）、
 *      幂等 commit（携带 ledger_event_id/digest 交叉引用，§22）。
 *
 * 入站内容永不触发本地工具、永不写入 Principal Memory（基线 §4.5 / §36-11/13）；
 * handler 异常与 ledger 异常都收敛为通用内部错误，不泄漏内部细节。
 */

import { uuidv7 } from "../../negotiation/domain/identifiers.js";
import { NegotiationValidationError } from "../../negotiation/domain/common.js";
import { validateEnvelope, verifyEnvelopeDigest } from "../../negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../../negotiation/domain/envelope.js";
import { IdempotencyConflictError, idempotencyKey } from "../../negotiation/idempotency/index.js";
import type { IdempotencyRecord, IdempotencyStore } from "../../negotiation/idempotency/index.js";
import { LedgerError, LedgerStore } from "../../negotiation/ledger/index.js";
import type { LedgerEvent } from "../../negotiation/ledger/index.js";
import type { A2AMessage, A2ATask, A2ATaskState } from "../client/index.js";
import { extractKnpEnvelope, parseInboundMessage } from "./inbound-message.js";
import {
  fromNegotiationError,
  internalServerError,
  protocolCodeOf,
  protocolError,
  rateLimited,
  schemaInvalid,
} from "./errors.js";
import { A2AServerThrottle, domainFromUcpProfile, type ThrottleRequest } from "./throttle.js";
import type { TrustLevel } from "../../trust/identity/trust-policy.js";
import { isKnownTaskState, newArtifactId, newTaskId, TaskRegistry } from "./task-registry.js";
import type {
  InboundNegotiationContext,
  NegotiationHandler,
  NegotiationHandlerResult,
} from "./types.js";
import {
  defaultGenericResponder,
  newGenericContextId,
  type GenericMessageResponder,
} from "./generic-responder.js";

export interface InboundPipelineOptions {
  handler: NegotiationHandler;
  idempotency: IdempotencyStore;
  ledger: LedgerStore;
  tasks: TaskRegistry;
  now: () => string;
  logError: (message: string, err: unknown) => void;
  /** WP3 §31 反滥用限流（可选；配置后判定在认证之后、schema 校验之前）。 */
  throttle?: A2AServerThrottle;
  /** 通用（非 KNP）A2A 消息响应器（issue 10 / TCK）；缺省用 spec 一致的回显。 */
  genericResponder?: GenericMessageResponder;
  /** 商家运营统计接缝（可选，仅 merchant 节点注入）：message_received 落账
   *  成功后本地记录买家触达。记录失败绝不阻断消息处理。 */
  stats?: BuyerContactRecorder;
}

/** 商家运营统计记录接缝（src/merchant/stats-store.ts 实现；结构化类型解耦）。 */
export interface BuyerContactRecorder {
  recordBuyerContact(event: BuyerContactRecord): void;
}

export interface BuyerContactRecord {
  message_id: string;
  buyer_identity: string;
  negotiation_id: string;
  exchange_id: string;
  action: string;
  skus: string[];
  occurred_at: string;
}

/**
 * 防御性提取 envelope 中讨论的 SKU（untrusted 输入已过 schema 校验，此处仍不假设
 * 形状）：rfq → payload.items；offer → payload.terms.items；counter_offer →
 * payload.proposed_terms.items；conditional_offer → payload.base_terms.items。
 * inquiry 等无 SKU 动作与未知形状一律返回 []。
 */
export function extractEnvelopeSkus(envelope: NegotiationEnvelope): string[] {
  const payload = envelope.payload as unknown as Record<string, unknown>;
  const skus: string[] = [];
  const collect = (container: unknown): void => {
    if (container === null || typeof container !== "object") return;
    const items = (container as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const sku = (item as Record<string, unknown>)["sku"];
      if (typeof sku === "string" && sku !== "") skus.push(sku);
    }
  };
  collect(payload);
  collect(payload["terms"]);
  collect(payload["proposed_terms"]);
  collect(payload["base_terms"]);
  return skus;
}

export interface SendMessageCaller {
  senderIdentity: string;
  remoteAddress?: string;
  /** 对端 UCP-Agent 头声明的 platform profile URI（WP3 §25.1，可选）。 */
  ucpAgentProfile?: string;
  /** 对端 trust level（throttle 档位映射，缺省 T0）。 */
  trustLevel?: TrustLevel;
  /** 身份是否经过验签（缺省 false → throttle 按 remoteAddress 且限额更严）。 */
  identityVerified?: boolean;
  /** WP1 指纹变更短期降档信号。 */
  fingerprintChanged?: boolean;
}

export interface SendMessageInput {
  message: unknown;
  contextId?: unknown;
}

export interface SendMessageResult {
  task: A2ATask;
  /** 新处理的落账事件；幂等重放时为 undefined。 */
  ledgerEvent?: LedgerEvent;
}

/** 通用（非 KNP）消息的归一化响应：task（已入库）或 message（1.0 wire）。 */
export type GenericSendResult =
  | { task: A2ATask }
  | { message: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 按幂等键串行化：防止并发同 key 请求双执行 handler
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

// 审查 K-M16：幂等文件惰性清理节流——此前每条入站消息都全量 sweep
// （readdir 扫描全部 idem-*.json 并逐一读取），忙时开销随规模线性放大。
// 改每 IDEMPOTENCY_SWEEP_INTERVAL_MS 至多一次；首次调用必执行（0 起点）。
const IDEMPOTENCY_SWEEP_INTERVAL_MS = 5 * 60_000;
let lastIdempotencySweepAt = 0;

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const myTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = tail.then(() => myTurn);
  locks.set(key, chained);
  await tail;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Task 构造 / 幂等结果还原
// ---------------------------------------------------------------------------

function validateTaskState(value: A2ATaskState | undefined): A2ATaskState {
  if (value === undefined) return "completed";
  if (!isKnownTaskState(value)) {
    throw internalServerError();
  }
  return value;
}

/** 由 handler 结果构造 A2ATask。仅 accepted / declined 进入此路径（error 已提前抛）。 */
function buildTask(
  result: NegotiationHandlerResult,
  ctx: InboundNegotiationContext,
  now: () => string,
): A2ATask {
  if (result.kind === "error") {
    // 防御性：pipeline 在 handlerResult.kind === "error" 时已抛协议错误，不应走到这里。
    throw internalServerError();
  }
  const state = validateTaskState(result.taskState);
  const task: A2ATask = { id: ctx.taskId, status: { state, timestamp: now() } };
  if (ctx.contextId !== undefined) task.contextId = ctx.contextId;

  let message: A2AMessage | undefined;
  if (result.kind === "accepted") {
    message = result.message;
    if (result.artifactParts !== undefined) {
      task.artifacts = [{ artifactId: newArtifactId(), parts: result.artifactParts }];
    }
  } else {
    message = {
      role: "agent",
      parts: [
        {
          kind: "data",
          data: { decline: true, reason_code: result.reasonCode ?? "declined" },
        },
      ],
      messageId: `msg_${uuidv7()}`,
    };
  }
  if (message !== undefined) task.status.message = message;
  return task;
}

function isTaskLike(value: unknown): value is A2ATask {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return false;
  if (obj.status === null || typeof obj.status !== "object") return false;
  const status = obj.status as Record<string, unknown>;
  return isKnownTaskState(status.state);
}

/** 幂等重放：从已落账 outcome 还原原结果 task。 */
function outcomeToTask(outcome: IdempotencyRecord["outcome"]): A2ATask {
  if (outcome.kind !== "ok" || outcome.result === undefined) {
    throw internalServerError();
  }
  const record = outcome.result as Record<string, unknown>;
  const task = record["task"];
  if (!isTaskLike(task)) throw internalServerError();
  return task;
}

// ---------------------------------------------------------------------------
// InboundPipeline
// ---------------------------------------------------------------------------

export class InboundPipeline {
  private readonly handler: NegotiationHandler;
  private readonly idempotency: IdempotencyStore;
  private readonly ledger: LedgerStore;
  private readonly tasks: TaskRegistry;
  private readonly now: () => string;
  private readonly logError: (message: string, err: unknown) => void;
  private readonly throttle: A2AServerThrottle | undefined;
  private readonly genericResponder: GenericMessageResponder;
  private readonly stats: BuyerContactRecorder | undefined;

  constructor(options: InboundPipelineOptions) {
    this.handler = options.handler;
    this.idempotency = options.idempotency;
    this.ledger = options.ledger;
    this.tasks = options.tasks;
    this.now = options.now;
    this.logError = options.logError;
    this.throttle = options.throttle;
    this.genericResponder = options.genericResponder ?? defaultGenericResponder;
    this.stats = options.stats;
  }

  private toThrottleRequest(caller: SendMessageCaller): ThrottleRequest {
    return {
      identity: caller.senderIdentity,
      remoteAddress: caller.remoteAddress,
      domain: domainFromUcpProfile(caller.ucpAgentProfile),
      identityVerified: caller.identityVerified,
      trustLevel: caller.trustLevel,
      fingerprintChanged: caller.fingerprintChanged,
    };
  }

  /** 从已落账 message_received 事件还原最小 A2ATask（P1-05 恢复路径）。
   *  事件携带 remote_task_id + outcome.task_state（§24.5）；消息正文不落账，
   *  恢复的任务不含 message（与幂等重放路径的完整 task 不同，可接受）。 */
  private taskFromLedgerEvent(event: LedgerEvent): A2ATask | null {
    const taskId = event.remote_task_id;
    if (typeof taskId !== "string" || taskId.length === 0) return null;
    const result = event.outcome.kind === "ok" ? event.outcome.result : undefined;
    const state = result === undefined ? undefined : result["task_state"];
    if (!isKnownTaskState(state)) return null;
    return { id: taskId, status: { state } };
  }

  /**
   * 审查 P1-05：以 Ledger 为持久事实的幂等恢复——消息已落账（message_received）
   * 但幂等未 commit（commit 失败 / append 与 commit 之间崩溃的窗口）时，重试
   * 必须**不重复执行 handler**（至多一次）。三个调用点：
   *   - 幂等 check 返回 "new" 但 Ledger 已有同 message_id → 恢复（不跑 handler）；
   *   - ledger.append 成功后 commit 失败 → 从刚落账的事件恢复并返回稳定响应；
   *   - ledger.append 抛 ledger_duplicate_content（P2-E，首次落账成功）→ 恢复。
   *
   * digest 必须与链上证据一致：同 message_id 异 digest = 恶意重放 → conflict
   * fail-closed。补 commit 是 best-effort（失败不阻断恢复响应，ledger 仍是持久
   * 事实，下一次重试仍走本条恢复路径）。
   */
  private recoverFromLedgerEvidence(
    senderIdentity: string,
    envelope: NegotiationEnvelope,
    prior: { event: LedgerEvent },
    taskOverride?: A2ATask,
  ): SendMessageResult {
    // 防御性 sender 一致性（fail-closed）：链上证据必须归属当前 sender——幂等
    // 主键是 (sender_identity, message_id)，他人消息的证据不得被当作自己的。
    // 调用点已按 sender 过滤；此处兜底。
    if (prior.event.identity.sender_identity !== senderIdentity) {
      throw internalServerError();
    }
    if (prior.event.wire_digest !== envelope.digest) {
      throw protocolError(
        "idempotency_conflict",
        `message_id ${envelope.message_id} already processed with a different digest (ledger evidence, §20.3)`,
      );
    }
    // taskOverride：commit 失败恢复路径传入本回合完整 task（含 message）；
    // ledger 守卫/duplicate 恢复路径无内存 task，按事件 remote_task_id 还原最小 task。
    const task = taskOverride ?? this.taskFromLedgerEvent(prior.event);
    if (task === null) {
      throw internalServerError();
    }
    try {
      this.idempotency.commit({
        sender_identity: senderIdentity,
        message_id: envelope.message_id,
        digest: envelope.digest,
        negotiation_id: envelope.negotiation_id,
        outcome: { kind: "ok", result: { task } },
        ledger_event_id: prior.event.event_id,
        ledger_event_digest: prior.event.event_digest,
      });
    } catch (commitErr) {
      this.logError("idempotency commit failed during ledger recovery", commitErr);
    }
    return { task, ledgerEvent: prior.event };
  }

  /** message/send 入站处理（限流 → 校验 → 幂等 → handler → Ledger → 幂等 commit）。 */
  async sendMessage(
    input: SendMessageInput,
    caller: SendMessageCaller,
  ): Promise<SendMessageResult> {
    // 惰性清理（评审项 L2 / 审查 K-M16）：negotiation 幂等文件的 sweep 此前
    // 无调用方，过期行永久保留、磁盘无界增长。入站消息处理是低频操作，但每条
    // 都全量扫文件仍随规模线性放大——节流为每 IDEMPOTENCY_SWEEP_INTERVAL_MS 一次。
    try {
      const nowMs = Date.now();
      if (nowMs - lastIdempotencySweepAt >= IDEMPOTENCY_SWEEP_INTERVAL_MS) {
        lastIdempotencySweepAt = nowMs;
        this.idempotency.sweep();
      }
    } catch {
      // 清理失败不影响消息处理（fail-safe 方向；下次再试）。
    }
    // 0. WP3 §31 反滥用：认证之后、schema 校验之前的限流判定（fail-closed）。
    const th = this.throttle;
    const tReq = th === undefined ? undefined : this.toThrottleRequest(caller);
    if (th !== undefined && tReq !== undefined) {
      const decision = th.check(tReq);
      if (!decision.allowed) {
        throw rateLimited(decision.retryAfterSeconds, decision.reason);
      }
      const slot = th.enterTask(tReq);
      if (!slot.ok) {
        throw rateLimited(slot.retryAfterSeconds, slot.reason);
      }
    }

    try {
      // 1-2. A2A Message schema + KNP envelope 提取（untrusted，fail-closed）。
      const message = parseInboundMessage(input.message);
      const contextId =
        input.contextId === undefined ? message.contextId : requireContextId(input.contextId);
      const envelopeRaw = extractKnpEnvelope(message);

      // 3. KNP envelope schema / version / action-payload 校验。
      let envelope: NegotiationEnvelope;
      try {
        envelope = validateEnvelope(envelopeRaw);
      } catch (err) {
        if (err instanceof NegotiationValidationError) throw fromNegotiationError(err);
        throw err;
      }

      // 4. wire digest 一致性（完整性，§19.2）。
      if (!verifyEnvelopeDigest(envelope)) {
        throw schemaInvalid("envelope digest mismatch (wire digest does not match content)");
      }

      const senderIdentity = caller.senderIdentity;
      const key = idempotencyKey(senderIdentity, envelope.message_id);

      return await withKeyLock(key, async () => {
        // 5. 幂等三态判定（锁内重新判定，防 check/commit 并发窗口）。
        const decision = this.idempotency.check({
          sender_identity: senderIdentity,
          message_id: envelope.message_id,
          digest: envelope.digest,
        });
        if (decision.status === "replayed") {
          return { task: outcomeToTask(decision.record.outcome) };
        }
        if (decision.status === "conflict") {
          throw protocolError(
            "idempotency_conflict",
            `message_id ${envelope.message_id} already processed with a different digest (replay conflict, §20.3)`,
          );
        }

        // 审查 P1-05：幂等索引无记录但 Ledger 已落账同 (sender, message_id)（commit
        // 失败 / append 与 commit 之间崩溃的窗口）→ 以 Ledger 为持久事实恢复，
        // handler 不重复执行（至多一次）。**按 sender 过滤**：幂等主键是
        // (sender_identity, message_id)（§20），不同 sender 用同 message_id 是
        // 独立消息（sender 隔离），不得被他人消息的证据短路。
        const priorOnLedger = this.ledger.findByMessageId(envelope.message_id);
        if (priorOnLedger !== null && priorOnLedger.event.identity.sender_identity === senderIdentity) {
          return this.recoverFromLedgerEvidence(senderIdentity, envelope, priorOnLedger);
        }

        // 6. 路由给 NegotiationHandler。
        const taskId = newTaskId();
        const handlerCtx: InboundNegotiationContext = {
          envelope,
          message,
          taskId,
          contextId,
          senderIdentity,
          remoteAddress: caller.remoteAddress,
          ucpAgentProfile: caller.ucpAgentProfile,
        };
        let handlerResult: NegotiationHandlerResult;
        try {
          handlerResult = await this.handler.handle(handlerCtx);
        } catch (err) {
          this.logError(`negotiation handler "${this.handler.name}" failed`, err);
          throw internalServerError();
        }

        if (handlerResult.kind === "error") {
          throw protocolError(handlerResult.protocolCode, handlerResult.message);
        }

        // 7. 生成任务 → 落 Ledger → 幂等 commit（证据交叉引用）。
        const task = buildTask(handlerResult, handlerCtx, this.now);
        this.tasks.set(taskId, task);

        let ledgerEvent: LedgerEvent;
        try {
          ledgerEvent = this.ledger.append({
            event_kind: "message_received",
            negotiation_id: envelope.negotiation_id,
            exchange_id: envelope.exchange_id,
            message_id: envelope.message_id,
            in_reply_to: envelope.in_reply_to,
            remote_context_id: contextId,
            remote_task_id: taskId,
            identity: {
              sender_identity: senderIdentity,
              // 验签身份已给出时，counterparty 侧优先用验签身份（与 buyer 侧
              // 记录对称，基线 §22）；无验签身份（匿名/loopback/静态 bearer）才
              // 回退 socket 地址 —— 此时身份不足以标识对端，地址是仅有的区分面。
              counterparty_identity:
                caller.identityVerified === true
                  ? senderIdentity
                  : (caller.remoteAddress ?? senderIdentity),
              actor: envelope.actor,
            },
            capability: {
              capability: envelope.capability,
              protocol_version: envelope.protocol_version,
            },
            wire_digest: envelope.digest,
            wire_payload: envelope as unknown as Record<string, unknown>,
            outcome: { kind: "ok", result: { task_id: taskId, task_state: task.status.state } },
            occurred_at: envelope.created_at,
          });
        } catch (err) {
          if (err instanceof LedgerError && err.code === "ledger_forbidden_content") {
            // 内容策略违规：envelope 携带 ledger 不得记录的保留键（§28/§36-5）。
            throw schemaInvalid("envelope contains reserved content that must not be recorded");
          }
          if (err instanceof LedgerError && err.code === "ledger_duplicate_content") {
            // 审查 P2-E + P1-05：append 成功、幂等 commit 前崩溃的窗口。重试时
            // 消息内容已落链（首次运行的处理结果），但幂等未 commit——此前走
            // internalServerError 且永不 commit，消息永久卡死；且恢复路径用
            // 本轮新 taskId 查 remote_task_id 恒 miss（事件携带首次的 taskId）。
            // 统一走 ledger 恢复（digest 校验 + 按事件 remote_task_id 还原任务 +
            // 补 commit）：客户端拿到稳定响应，后续重试直接命中幂等短接或 ledger
            // 守卫，handler 至多一次。真实恶意重放（同 message_id 异 digest）在
            // digest 校验层 fail-closed（idempotency_conflict）。
            const prior = this.ledger.findByMessageId(envelope.message_id);
            if (prior === null) {
              this.logError("ledger duplicate but prior event unrecoverable", err);
              throw internalServerError();
            }
            return this.recoverFromLedgerEvidence(senderIdentity, envelope, prior);
          }
          this.logError("ledger append failed", err);
          throw internalServerError();
        }

        // 商家运营统计（可选接缝，仅 merchant 节点注入）：message_received 落账
        // 成功即恰好一次（幂等重放/恢复路径都到不了这里）。统计是本地旁路——
        // 记录失败绝不阻断消息处理，只进服务端日志。
        if (this.stats !== undefined) {
          try {
            this.stats.recordBuyerContact({
              message_id: envelope.message_id,
              buyer_identity: senderIdentity,
              negotiation_id: envelope.negotiation_id,
              exchange_id: envelope.exchange_id,
              action: envelope.action,
              skus: extractEnvelopeSkus(envelope),
              occurred_at: envelope.created_at,
            });
          } catch (statsErr) {
            this.logError("buyer contact stats recording failed", statsErr);
          }
        }

        try {
          this.idempotency.commit({
            sender_identity: senderIdentity,
            message_id: envelope.message_id,
            digest: envelope.digest,
            negotiation_id: envelope.negotiation_id,
            outcome: { kind: "ok", result: { task } },
            ledger_event_id: ledgerEvent.event_id,
            ledger_event_digest: ledgerEvent.event_digest,
          });
        } catch (err) {
          // commit 的并发兜底（异 digest）——本锁内不应发生；仍 fail-closed。
          if (err instanceof IdempotencyConflictError) {
            throw protocolError(
              "idempotency_conflict",
              `message_id ${envelope.message_id} already processed with a different digest`,
            );
          }
          // 审查 P1-05：commit 失败（非冲突，磁盘/瞬时）——message_received 已
          // 落账。从 ledger 恢复并补 commit（best-effort），返回稳定响应而不是
          // 抛错：否则客户端重试时幂等索引仍无记录 → handler 重复执行（双份
          // agreement）。taskOverride 传本回合完整 task（含 message）。ledger
          // 守卫兜底：即使客户端重试，也命中恢复路径。
          this.logError("idempotency commit failed; recovering from ledger evidence", err);
          return this.recoverFromLedgerEvidence(senderIdentity, envelope, { event: ledgerEvent }, task);
        }

        return { task, ledgerEvent };
      });
    } catch (err) {
      // schema_invalid 计入 malformed budget（独立于正常限流；WP3 §31）。
      if (th !== undefined && tReq !== undefined && protocolCodeOf(err) === "schema_invalid") {
        th.recordMalformed(tReq);
      }
      throw err;
    } finally {
      // 释放并发槽（幂等；与限流判定中的 enterTask 配对）。
      if (th !== undefined && tReq !== undefined) th.leaveTask(tReq);
    }
  }

  /** tasks/get：内存优先，miss 时回退 Ledger 视图（§23 恢复第 4 步）。 */
  async getTask(taskId: string): Promise<A2ATask | null> {
    const inMemory = this.tasks.get(taskId);
    if (inMemory !== null) return inMemory;
    return this.tasks.resolveFromLedger(this.ledger, taskId);
  }

  /** ListTasks（issue 10 / TCK CORE-LIST）：返回内存任务列表。 */
  listTasks(): { tasks: A2ATask[] } {
    return { tasks: this.tasks.list() };
  }

  /** CancelTask（issue 10 / TCK CORE-CANCEL）。 */
  cancelTask(
    taskId: string,
  ): { ok: boolean; outcome: "canceled" | "not_found" | "not_cancelable" } {
    return this.tasks.cancel(taskId);
  }

  /**
   * 通用 A2A 消息（issue 10 / TCK CORE-SEND/EXECUTION-MODE/MULTI）：无 KNP
   * envelope 的普通消息不进磋商管线——交给通用响应器（缺省：完成任务 + 回显
   * parts 为 artifact + 生成 contextId）。让 A2A 1.0 server 对任意消息合规
   * （KNP 是扩展，非 A2A 必载）。响应器可注入（TCK 参考场景）。
   */
  sendGenericMessage(message: Record<string, unknown>): GenericSendResult {
    const taskId = newTaskId();
    const contextId =
      typeof message.contextId === "string" && message.contextId.length > 0
        ? message.contextId
        : newGenericContextId();
    const result = this.genericResponder({ message, taskId, contextId, now: this.now });
    if (result.task !== undefined) {
      const t = result.task;
      // 1.0 通用路径是 raw 透传：task 的 message/artifacts 保持 1.0 wire 形状
      // （统一 Part），非 0.3 建模——类型经 unknown 放宽是有意的。
      const task: A2ATask = {
        id: taskId,
        status: {
          state: t.state,
          timestamp: this.now(),
          ...(t.statusMessage !== undefined
            ? { message: t.statusMessage as unknown as A2AMessage }
            : {}),
        },
        ...(t.contextId !== undefined ? { contextId: t.contextId } : {}),
        ...(t.artifacts !== undefined
          ? { artifacts: t.artifacts as unknown as A2ATask["artifacts"] }
          : {}),
      };
      this.tasks.set(taskId, task);
      return { task };
    }
    // 响应器契约：task XOR message；两者皆缺即内部错误（fail-closed）。
    if (result.message === undefined) throw internalServerError();
    return { message: result.message };
  }

  /** 内存任务注册表是否已存在该任务（issue 10 / TCK CORE-MULTI-004）。 */
  hasTask(taskId: string): boolean {
    return this.tasks.get(taskId) !== null;
  }
}

function requireContextId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw schemaInvalid("params/contextId must be a non-empty string");
  }
  return value;
}
