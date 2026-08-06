/**
 * KNP/1.0 Negotiation Ledger 事件模型（基线 §22 / 子规范 §28）。
 *
 * 每条 Ledger 事件是 append-only、content-addressed、hash-linked 的记录：
 *
 * - `event_digest`：对事件「稳定内容」的 SHA-256 content digest（`sha256:` 前缀，
 *   与 jcs.ts 的 contentDigest 同源）。稳定内容 = 除 event_id / event_digest /
 *   previous_event_digest / recorded_at 之外的全部业务字段。这样同一逻辑事件
 *   无论何时、以何种链位置落账都产生同一地址 —— 内容寻址。
 * - `previous_event_digest`：同 negotiation_id 链上前一条的 event_digest。
 *   创世事件（链首）为 null。该字段由 store 按当前链尾计算，调用方不可伪造。
 * - 链完整性由 verifyChain 单独校验：断链（前一 digest 不匹配）与篡改
 *   （重算 digest 不匹配）是两种可区分的错误。
 *
 * 不保存（§22 / §28 / §36 不变量 5）：raw chain-of-thought 与 Vault plaintext。
 * 该约束不止是文档 —— append 前会递归扫描内容字段，命中禁词即 fail-closed。
 */

import { contentDigest } from "../jcs.js";
import { uuidv7 } from "../domain/identifiers.js";
import type { NegotiationActor } from "../domain/objects.js";
import type { NegotiationPhase } from "../state/phase.js";

export const LEDGER_EVENT_KINDS = [
  "message_received",
  "message_sent",
  "state_transition",
  "system",
  "reconciliation",
  "error",
] as const;
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

/** 身份快照（基线 §22 identity snapshot / 子规范 §28）。 */
export interface LedgerIdentitySnapshot {
  /** 协议级幂等主键的一半：(sender_identity, message_id)。 */
  sender_identity: string;
  /** 对手方身份。 */
  counterparty_identity: string;
  /** KNP envelope actor（buyer|merchant），便于审计快速过滤。 */
  actor?: NegotiationActor;
}

/** 能力/版本快照（基线 §22 capability snapshot）。 */
export interface LedgerCapabilitySnapshot {
  capability: string;
  protocol_version: string;
  agent_version?: string;
}

/** Phase 状态转换（对齐 state/phase.ts 的 NegotiationPhase）。 */
export interface LedgerStateTransition {
  from_phase?: NegotiationPhase;
  to_phase: NegotiationPhase;
}

/** 处理结果：成功（可带结构化 result）或协议错误（code 对齐子规范 §18 词表）。 */
export type LedgerOutcome =
  | { kind: "ok"; result?: Record<string, unknown> }
  | { kind: "error"; code: string; message: string };

/** 调用方提供的稳定内容字段（digest / 链指针 / 落账元数据由 store 填充）。 */
export interface LedgerEventContent {
  event_kind: LedgerEventKind;
  negotiation_id: string;
  /** message/exchange refs（基线 §22）。 */
  exchange_id?: string;
  message_id?: string;
  in_reply_to?: string;
  /** remote A2A contextId/taskId（基线 §22 / 子规范 §24.4/§24.5）。 */
  remote_context_id?: string;
  remote_task_id?: string;
  identity: LedgerIdentitySnapshot;
  capability: LedgerCapabilitySnapshot;
  /** wire digest = KNP envelope digest（§19.2）。 */
  wire_digest?: string;
  /** wire payload = 收发时的 envelope 内容（不含 transport signature 字段）。 */
  wire_payload?: Record<string, unknown>;
  /** Phase 状态转换（如该事件驱动了状态机推进）。 */
  state_transition?: LedgerStateTransition;
  outcome: LedgerOutcome;
  /** 业务发生时间（如 envelope.created_at），RFC 3339。 */
  occurred_at: string;
}

/** 完整 Ledger 事件。 */
export interface LedgerEvent extends LedgerEventContent {
  event_id: string;
  /** 链上一条的 event_digest；创世事件为 null。 */
  previous_event_digest: string | null;
  event_digest: string;
  /** 落账时间（可注入时钟），RFC 3339。 */
  recorded_at: string;
}

export type LedgerVerifyError =
  | { code: "chain_break"; index: number; detail: string }
  | { code: "tampered"; index: number; detail: string }
  | { code: "duplicate"; index: number; detail: string }
  | { code: "corrupt"; index: number; detail: string };

export interface LedgerVerifyResult {
  valid: boolean;
  count: number;
  error?: LedgerVerifyError;
}

export const LEDGER_ERROR_CODES = [
  "ledger_unknown_negotiation",
  "ledger_chain_corrupt",
  "ledger_append_only_violation",
  "ledger_duplicate_content",
  "ledger_forbidden_content",
  "ledger_invalid_identity",
  "ledger_invalid_capability",
] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/** Ledger 存储/校验失败。与协议错误词表（§18）分开：Ledger 是内部审计域。 */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  /** 出错的行索引（verifyChain 解析坏行时携带）。 */
  readonly index?: number;
  constructor(code: LedgerErrorCode, message: string, index?: number) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.index = index;
  }
}

// ---------------------------------------------------------------------------
// 禁词检查：不保存 raw chain-of-thought / Vault plaintext（§22 / §28 / §36-5）
// ---------------------------------------------------------------------------

/** 归一化 key：小写 + 去非字母数字。`chain_of_thought` → `chainofthought`。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** CoT 相关禁词（精确匹配归一化 key）。 */
const FORBIDDEN_COT_KEYS = new Set([
  "chainofthought",
  "cot",
  "thought",
  "thoughts",
  "reasoning",
  "rationale",
  "thinking",
  "internalmonologue",
  "scratchpad",
]);

/** Vault plaintext / 秘密相关禁词（精确匹配归一化 key）。 */
const FORBIDDEN_VAULT_KEYS = new Set([
  "vault",
  "vaultplaintext",
  "privatevault",
  "plaintext",
  "secret",
  "secrets",
  "secretkey",
  "privatekey",
  "apikey",
  "password",
  "credential",
  "credentials",
]);

/** 子串级兜底：任何 key 中出现即拒绝（双保险，防变形拼写）。 */
const FORBIDDEN_SUBSTRINGS = ["chainofthought", "vaultplaintext", "privatevault"];

function isForbiddenKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (FORBIDDEN_COT_KEYS.has(normalized) || FORBIDDEN_VAULT_KEYS.has(normalized)) return true;
  return FORBIDDEN_SUBSTRINGS.some((sub) => normalized.includes(sub));
}

/**
 * 递归扫描内容中的每个 key，命中 CoT / Vault plaintext 禁词即抛
 * ledger_forbidden_content。用于 wire_payload、outcome.result 等自由对象。
 * 幂等键本身（sender_identity 等）是结构化字段，不在递归范围内。
 */
export function assertNoForbiddenContent(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenContent(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const childPath = `${path}.${key}`;
      if (isForbiddenKey(key)) {
        throw new LedgerError(
          "ledger_forbidden_content",
          `ledger MUST NOT record ${childPath}: key is reserved for chain-of-thought / vault plaintext`,
        );
      }
      assertNoForbiddenContent((value as Record<string, unknown>)[key], childPath);
    }
  }
}

// ---------------------------------------------------------------------------
// 内容寻址与事件构造
// ---------------------------------------------------------------------------

/** 新事件 id：`evt_<uuidv7>`，跨重启稳定且可排序（同 identifiers 的 §6 约定）。 */
export function newLedgerEventId(): string {
  return `evt_${uuidv7()}`;
}

/**
 * 事件「稳定内容」视图：digest 的输入。排除 event_id / event_digest /
 * previous_event_digest / recorded_at（落账元数据），因此同一逻辑事件在任意
 * 链位置、任意落账时间的地址都一致 —— 内容寻址。JCS 跳过 undefined 字段，
 * 可选字段缺省不影响摘要。
 */
export function eventContentAddressable(
  content: LedgerEventContent | LedgerEvent,
): Record<string, unknown> {
  return {
    event_kind: content.event_kind,
    negotiation_id: content.negotiation_id,
    exchange_id: content.exchange_id,
    message_id: content.message_id,
    in_reply_to: content.in_reply_to,
    remote_context_id: content.remote_context_id,
    remote_task_id: content.remote_task_id,
    identity: content.identity,
    capability: content.capability,
    wire_digest: content.wire_digest,
    wire_payload: content.wire_payload,
    state_transition: content.state_transition,
    outcome: content.outcome,
    occurred_at: content.occurred_at,
  };
}

/** 由稳定内容计算 event_digest（contentDigest = JCS + SHA-256，`sha256:` 前缀）。 */
export function computeEventDigest(content: LedgerEventContent | LedgerEvent): string {
  return contentDigest(eventContentAddressable(content));
}

/** 基础结构守卫：保证从磁盘解析的事件具有链校验所需的最小形状。 */
export function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.event_id === "string" &&
    typeof obj.event_digest === "string" &&
    (obj.previous_event_digest === null || typeof obj.previous_event_digest === "string") &&
    typeof obj.negotiation_id === "string" &&
    typeof obj.event_kind === "string" &&
    typeof obj.recorded_at === "string" &&
    typeof obj.occurred_at === "string" &&
    obj.identity !== null &&
    typeof obj.identity === "object" &&
    obj.capability !== null &&
    typeof obj.capability === "object" &&
    obj.outcome !== null &&
    typeof obj.outcome === "object"
  );
}
