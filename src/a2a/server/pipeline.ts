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
  protocolError,
  schemaInvalid,
} from "./errors.js";
import { isKnownTaskState, newArtifactId, newTaskId, TaskRegistry } from "./task-registry.js";
import type {
  InboundNegotiationContext,
  NegotiationHandler,
  NegotiationHandlerResult,
} from "./types.js";

export interface InboundPipelineOptions {
  handler: NegotiationHandler;
  idempotency: IdempotencyStore;
  ledger: LedgerStore;
  tasks: TaskRegistry;
  now: () => string;
  logError: (message: string, err: unknown) => void;
}

export interface SendMessageCaller {
  senderIdentity: string;
  remoteAddress?: string;
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

// ---------------------------------------------------------------------------
// 按幂等键串行化：防止并发同 key 请求双执行 handler
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

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

  constructor(options: InboundPipelineOptions) {
    this.handler = options.handler;
    this.idempotency = options.idempotency;
    this.ledger = options.ledger;
    this.tasks = options.tasks;
    this.now = options.now;
    this.logError = options.logError;
  }

  /** message/send 入站处理（校验 → 幂等 → handler → Ledger → 幂等 commit）。 */
  async sendMessage(
    input: SendMessageInput,
    caller: SendMessageCaller,
  ): Promise<SendMessageResult> {
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

    return withKeyLock(key, async () => {
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

      // 6. 路由给 NegotiationHandler。
      const taskId = newTaskId();
      const handlerCtx: InboundNegotiationContext = {
        envelope,
        message,
        taskId,
        contextId,
        senderIdentity,
        remoteAddress: caller.remoteAddress,
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
            counterparty_identity: caller.remoteAddress ?? senderIdentity,
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
        this.logError("ledger append failed", err);
        throw internalServerError();
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
        throw err;
      }

      return { task, ledgerEvent };
    });
  }

  /** tasks/get：内存优先，miss 时回退 Ledger 视图（§23 恢复第 4 步）。 */
  async getTask(taskId: string): Promise<A2ATask | null> {
    const inMemory = this.tasks.get(taskId);
    if (inMemory !== null) return inMemory;
    return this.tasks.resolveFromLedger(this.ledger, taskId);
  }
}

function requireContextId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw schemaInvalid("params/contextId must be a non-empty string");
  }
  return value;
}
