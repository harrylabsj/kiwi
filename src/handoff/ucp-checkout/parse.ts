/**
 * Kiwi v1.1 Transaction Handoff（WP2）— UCP Checkout 响应解析 + 消息算法。
 *
 * 两层：
 *  1. 结构解析（parseUcpCheckoutResponse）：不可信响应 → UcpCheckoutResponse，
 *     任何结构问题抛 UcpCheckoutParseError（fail-closed，§4.6）——无法证明合法
 *     即拒绝。未知字段保留（forward-compat）。
 *  2. 消息算法（decideMessages / decideResponse）：把 messages[] 的 severity 汇聚
 *     成可执行动作。处理顺序（spec 事实）：
 *        unrecoverable 非空 → fail_closed（重试无意义或 handoff）；
 *        否则先解 recoverable（改输入重试）；仍 requires_* → handoff（requires_user）。
 *     requires_buyer_input / requires_buyer_review 汇聚成 requires_escalation。
 */

import {
  UCP_CHECKOUT_STATUSES,
  UCP_MESSAGE_SEVERITIES,
  UCP_MESSAGE_TYPES,
} from "./types.js";
import type {
  UcpCheckoutErrorResponse,
  UcpCheckoutLineItem,
  UcpCheckoutLink,
  UcpCheckoutMessage,
  UcpCheckoutResponse,
  UcpCheckoutSession,
  UcpCheckoutStatus,
  UcpCheckoutTotals,
} from "./types.js";

// ---------------------------------------------------------------------------
// Parse error
// ---------------------------------------------------------------------------

export class UcpCheckoutParseError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "UcpCheckoutParseError";
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

function fail(path: string, message: string): never {
  throw new UcpCheckoutParseError(path, message);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (s.length === 0) fail(path, "must be a non-empty string");
  return s;
}

function requireInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(path, "must be an integer");
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const s = requireNonEmptyString(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    fail(path, `must be one of ${allowed.join("|")} (got ${s})`);
  }
  return s as T;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function requireIsoTimestamp(value: unknown, path: string): string {
  const s = requireNonEmptyString(value, path);
  if (!RFC3339.test(s) || Number.isNaN(Date.parse(s))) fail(path, "must be an RFC 3339 timestamp");
  return s;
}

/** 解析对象并把「未知字段原样保留」的 forward-compat 补到目标对象上。 */
function preserveUnknown(obj: Record<string, unknown>, target: Record<string, unknown>, known: ReadonlySet<string>): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key) && !(key in target)) target[key] = obj[key];
  }
}

// ---------------------------------------------------------------------------
// 子结构解析
// ---------------------------------------------------------------------------

function parseLineItems(value: unknown): UcpCheckoutLineItem[] {
  if (!Array.isArray(value)) fail("/line_items", "must be an array");
  return value.map((entry, i) => {
    const obj = requireObject(entry, `/line_items/${i}`);
    const item: UcpCheckoutLineItem = {
      sku: requireNonEmptyString(obj.sku, `/line_items/${i}/sku`),
      quantity: requireInteger(obj.quantity, `/line_items/${i}/quantity`),
    };
    if (obj.unit_price !== undefined) {
      const price = requireObject(obj.unit_price, `/line_items/${i}/unit_price`);
      item.unit_price = {
        currency: requireNonEmptyString(price.currency, `/line_items/${i}/unit_price/currency`),
        amount_minor: requireInteger(
          price.amount_minor,
          `/line_items/${i}/unit_price/amount_minor`,
        ),
      };
    }
    preserveUnknown(obj, item, new Set(["sku", "quantity", "unit_price"]));
    return item;
  });
}

function parseTotals(value: unknown): UcpCheckoutTotals {
  const obj = requireObject(value, "/totals");
  const totals: UcpCheckoutTotals = {
    currency: requireNonEmptyString(obj.currency, "/totals/currency"),
    total: requireInteger(obj.total, "/totals/total"),
  };
  for (const key of ["items_total", "tax", "shipping", "discount"] as const) {
    if (obj[key] !== undefined) totals[key] = requireInteger(obj[key], `/totals/${key}`);
  }
  preserveUnknown(obj, totals, new Set(["currency", "total", "items_total", "tax", "shipping", "discount"]));
  return totals;
}

function parseMessages(value: unknown): UcpCheckoutMessage[] {
  if (!Array.isArray(value)) fail("/messages", "must be an array");
  return value.map((entry, i) => {
    const obj = requireObject(entry, `/messages/${i}`);
    const msg: UcpCheckoutMessage = {
      type: requireEnum(obj.type, UCP_MESSAGE_TYPES, `/messages/${i}/type`),
      severity: requireEnum(obj.severity, UCP_MESSAGE_SEVERITIES, `/messages/${i}/severity`),
    };
    if (obj.code !== undefined) msg.code = requireNonEmptyString(obj.code, `/messages/${i}/code`);
    if (obj.message !== undefined) msg.message = requireString(obj.message, `/messages/${i}/message`);
    preserveUnknown(obj, msg, new Set(["type", "severity", "code", "message"]));
    return msg;
  });
}

function parseLinks(value: unknown): UcpCheckoutLink[] {
  if (!Array.isArray(value)) fail("/links", "must be an array");
  return value.map((entry, i) => {
    const obj = requireObject(entry, `/links/${i}`);
    const link: UcpCheckoutLink = {
      rel: requireNonEmptyString(obj.rel, `/links/${i}/rel`),
      href: requireNonEmptyString(obj.href, `/links/${i}/href`),
    };
    preserveUnknown(obj, link, new Set(["rel", "href"]));
    return link;
  });
}

// ---------------------------------------------------------------------------
// 响应结构解析
// ---------------------------------------------------------------------------

/**
 * 解析并校验 UCP checkout 响应（success/error 判别走 /ucp/status）。
 * 结构非法 → 抛 UcpCheckoutParseError（fail-closed）。
 */
export function parseUcpCheckoutResponse(raw: unknown): UcpCheckoutResponse {
  const root = requireObject(raw, "/");
  const ucp = requireObject(root.ucp, "/ucp");
  const version = requireNonEmptyString(ucp.version, "/ucp/version");
  const status = ucp.status;
  if (status !== "success" && status !== "error") {
    fail("/ucp/status", `must be success|error (got ${String(status)})`);
  }
  if (status === "success") {
    return parseSuccessSession(root, ucp, version);
  }
  return parseErrorResponse(root, ucp, version);
}

function parseSuccessSession(
  root: Record<string, unknown>,
  ucp: Record<string, unknown>,
  version: string,
): UcpCheckoutSession {
  const session: UcpCheckoutSession = {
    ucp: { ...ucp, status: "success", version } as UcpCheckoutSession["ucp"],
    status: requireEnum(root.status, UCP_CHECKOUT_STATUSES, "/status") as UcpCheckoutStatus,
    session_id: requireNonEmptyString(root.session_id, "/session_id"),
  };
  const known = new Set(["ucp", "status", "session_id"]);
  if (root.expires_at !== undefined) {
    session.expires_at = requireIsoTimestamp(root.expires_at, "/expires_at");
    known.add("expires_at");
  }
  if (root.line_items !== undefined) {
    session.line_items = parseLineItems(root.line_items);
    known.add("line_items");
  }
  if (root.totals !== undefined) {
    session.totals = parseTotals(root.totals);
    known.add("totals");
  }
  if (root.messages !== undefined) {
    session.messages = parseMessages(root.messages);
    known.add("messages");
  }
  if (root.continue_url !== undefined) {
    session.continue_url = requireNonEmptyString(root.continue_url, "/continue_url");
    known.add("continue_url");
  }
  if (root.payment !== undefined) {
    session.payment = requireObject(root.payment, "/payment");
    known.add("payment");
  }
  if (root.links !== undefined) {
    session.links = parseLinks(root.links);
    known.add("links");
  }
  if (root.authorization_reference !== undefined) {
    session.authorization_reference = requireNonEmptyString(
      root.authorization_reference,
      "/authorization_reference",
    );
    known.add("authorization_reference");
  }
  preserveUnknown(root, session, known);
  return session;
}

function parseErrorResponse(
  root: Record<string, unknown>,
  ucp: Record<string, unknown>,
  version: string,
): UcpCheckoutErrorResponse {
  if (!Array.isArray(root.messages)) fail("/messages", "error response requires a messages array");
  const response: UcpCheckoutErrorResponse = {
    ucp: { ...ucp, status: "error", version } as UcpCheckoutErrorResponse["ucp"],
    messages: parseMessages(root.messages),
  };
  const known = new Set(["ucp", "messages"]);
  if (root.continue_url !== undefined) {
    response.continue_url = requireNonEmptyString(root.continue_url, "/continue_url");
    known.add("continue_url");
  }
  preserveUnknown(root, response, known);
  return response;
}

// ---------------------------------------------------------------------------
// 判别守卫
// ---------------------------------------------------------------------------

/**
 * 判别守卫：success 响应（资源本体）。嵌套判别（/ucp/status）在带 index signature
 * 的联合成员上无法被 TS 自动窄化，必须用显式 type guard。
 */
export function isUcpCheckoutSuccessSession(value: UcpCheckoutResponse): value is UcpCheckoutSession {
  return value.ucp.status === "success";
}

/** 判别守卫：error 响应（无资源本体，只有 messages + continue_url）。 */
export function isUcpCheckoutErrorResponse(value: UcpCheckoutResponse): value is UcpCheckoutErrorResponse {
  return value.ucp.status === "error";
}

// ---------------------------------------------------------------------------
// 消息算法
// ---------------------------------------------------------------------------

export interface MessageGrouping {
  unrecoverable: UcpCheckoutMessage[];
  requiresBuyerInput: UcpCheckoutMessage[];
  requiresBuyerReview: UcpCheckoutMessage[];
  recoverable: UcpCheckoutMessage[];
  other: UcpCheckoutMessage[];
}

const emptyGrouping = (): MessageGrouping => ({
  unrecoverable: [],
  requiresBuyerInput: [],
  requiresBuyerReview: [],
  recoverable: [],
  other: [],
});

/** 按 severity 分组（severity 是处理算法的唯一输入；type 只是辅助信息）。 */
export function groupMessages(messages: UcpCheckoutMessage[] | undefined): MessageGrouping {
  if (messages === undefined || messages.length === 0) return emptyGrouping();
  const groups = emptyGrouping();
  for (const m of messages) {
    switch (m.severity) {
      case "unrecoverable":
        groups.unrecoverable.push(m);
        break;
      case "requires_buyer_input":
        groups.requiresBuyerInput.push(m);
        break;
      case "requires_buyer_review":
        groups.requiresBuyerReview.push(m);
        break;
      case "recoverable":
        groups.recoverable.push(m);
        break;
      default:
        groups.other.push(m);
    }
  }
  return groups;
}

/** 汇总 messages 为可读字符串（`[code] message; …`）。空 → "no message details"。 */
export function summarizeMessages(messages: UcpCheckoutMessage[] | undefined): string {
  if (messages === undefined || messages.length === 0) return "no message details";
  const parts = messages
    .map((m) => `${m.code !== undefined ? `[${m.code}]` : ""}${m.message ?? ""}`.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join("; ") : "no message details";
}

export type CheckoutAction = "ok" | "fail_closed" | "requires_user" | "retryable";

export interface CheckoutDecision {
  action: CheckoutAction;
  reason?: string;
  continue_url?: string;
}

function hasErrorType(messages: UcpCheckoutMessage[]): boolean {
  return messages.some((m) => m.type === "error");
}

/**
 * 消息算法（不依赖会话状态）：unrecoverable → fail_closed；requires_* → requires_user；
 * recoverable 或 error 类型 → retryable（改输入重试）；否则 ok。
 */
export function decideMessages(
  messages: UcpCheckoutMessage[] | undefined,
  continue_url?: string,
): CheckoutDecision {
  const groups = groupMessages(messages);
  if (groups.unrecoverable.length > 0) {
    return {
      action: "fail_closed",
      reason: `unrecoverable: ${summarizeMessages(groups.unrecoverable)}`,
    };
  }
  const escalation = [...groups.requiresBuyerInput, ...groups.requiresBuyerReview];
  if (escalation.length > 0) {
    return {
      action: "requires_user",
      reason: `requires_escalation: ${summarizeMessages(escalation)}`,
      continue_url,
    };
  }
  if (groups.recoverable.length > 0 || hasErrorType(messages ?? [])) {
    return { action: "retryable", reason: `recoverable: ${summarizeMessages(messages)}` };
  }
  return { action: "ok" };
}

/**
 * 把一份 UCP checkout 响应（success/error）映射为「核心动作」。终态
 * （completed/canceled）与 requires_escalation 状态优先于消息算法。
 */
export function decideResponse(response: UcpCheckoutResponse): CheckoutDecision {
  if (response.ucp.status === "error") {
    const decision = decideMessages(response.messages, response.continue_url);
    // error 响应意味着操作失败：即使消息不可归因也绝不能 ok（fail-closed）。
    return decision.action === "ok"
      ? { action: "fail_closed", reason: "ucp error response without actionable messages" }
      : decision;
  }
  const checkout = response;
  if (checkout.status === "completed" || checkout.status === "canceled") {
    // 终态权威：消息只作旁证，不把已完成/已取消翻成失败。
    return { action: "ok" };
  }
  if (checkout.status === "requires_escalation") {
    return {
      action: "requires_user",
      reason: `requires_escalation: ${summarizeMessages(checkout.messages)}`,
      continue_url: checkout.continue_url,
    };
  }
  const decision = decideMessages(checkout.messages, checkout.continue_url);
  // ready_for_complete / complete_in_progress / incomplete：消息算法决定动作
  // （recoverable → retryable，requires_* → requires_user，无可操作 → ok）。
  return decision;
}

// ---------------------------------------------------------------------------
// 复用导出（同包 cart-parse 用；cart 实体与 checkout 同构，不另起平行实现）
// ---------------------------------------------------------------------------

export {
  fail,
  parseErrorResponse as parseUcpErrorEnvelope,
  parseLineItems,
  parseLinks,
  parseMessages,
  parseTotals,
  preserveUnknown,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireObject,
};
