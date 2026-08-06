/**
 * Kiwi v1.1 Transaction Handoff（WP2）— UCP Checkout 协议类型（UCP 2026-04-08
 * checkout spec family，基线 §3.2 / §43）。
 *
 * UCP Checkout REST binding：`{endpoint}/checkout-sessions`（Create/Get/Update/
 * Complete/Cancel）。响应判别走 `ucp.status`：
 *   - success：body 就是 checkout 资源本体（含 status/session_id/totals/messages…）；
 *   - error：无资源本体，只有 messages + continue_url。
 *
 * 本模块只建模类型与常量；运行时解析在 parse.ts，网络面在 client.ts。
 * 零新增依赖。
 */

import type { HandoffSession } from "../channel.js";

/** UCP checkout spec family 日期（§43 pin）。 */
export const UCP_CHECKOUT_SPEC_VERSION = "2026-04-08" as const;

/** expires_at 缺省值：创建后 6 小时（spec 事实）。 */
export const DEFAULT_EXPIRY_MS = 6 * 60 * 60 * 1000;

export const UCP_CHECKOUT_STATUSES = [
  "incomplete",
  "requires_escalation",
  "ready_for_complete",
  "complete_in_progress",
  "completed",
  "canceled",
] as const;
export type UcpCheckoutStatus = (typeof UCP_CHECKOUT_STATUSES)[number];

export const UCP_MESSAGE_TYPES = ["error", "warning", "info"] as const;
export type UcpMessageType = (typeof UCP_MESSAGE_TYPES)[number];

export const UCP_MESSAGE_SEVERITIES = [
  "recoverable",
  "requires_buyer_input",
  "requires_buyer_review",
  "unrecoverable",
] as const;
export type UcpMessageSeverity = (typeof UCP_MESSAGE_SEVERITIES)[number];

/** checkout messages[]（type + severity 是算法输入；requires_* 汇聚为 requires_escalation）。 */
export interface UcpCheckoutMessage {
  type: UcpMessageType;
  severity: UcpMessageSeverity;
  /** 标准错误码（out_of_stock / item_unavailable / payment_failed / eligibility_invalid …）。 */
  code?: string;
  message?: string;
  /** forward-compat：未知字段保留。 */
  [key: string]: unknown;
}

/** links[]（privacy_policy / terms_of_service 等）——合规必需，解析保留。 */
export interface UcpCheckoutLink {
  rel: string;
  href: string;
  [key: string]: unknown;
}

/**
 * totals：business 权威，platform MUST NOT 自行计算替代；MAY 校验
 * `非 total 各项之和 == total`（totals.ts）。金额一律整数 minor units。
 */
export interface UcpCheckoutTotals {
  currency: string;
  items_total?: number;
  tax?: number;
  shipping?: number;
  discount?: number;
  total: number;
  [key: string]: unknown;
}

export interface UcpCheckoutLineItem {
  sku: string;
  quantity: number;
  unit_price?: { currency: string; amount_minor: number };
  [key: string]: unknown;
}

/**
 * UCP checkout 资源本体（success 响应）。payment 对象可选——本实现 complete
 * 不构造任何支付凭据，只传 authorization 证据引用；payment/links 解析保留。
 */
export interface UcpCheckoutSession {
  ucp: { status: "success"; version: string; [key: string]: unknown };
  status: UcpCheckoutStatus;
  session_id: string;
  expires_at?: string;
  line_items?: UcpCheckoutLineItem[];
  totals?: UcpCheckoutTotals;
  messages?: UcpCheckoutMessage[];
  continue_url?: string;
  payment?: Record<string, unknown>;
  links?: UcpCheckoutLink[];
  authorization_reference?: string;
  [key: string]: unknown;
}

/** UCP error 响应：无资源本体，只有 messages + continue_url。 */
export interface UcpCheckoutErrorResponse {
  ucp: { status: "error"; version: string; [key: string]: unknown };
  messages: UcpCheckoutMessage[];
  continue_url?: string;
  [key: string]: unknown;
}

/** 判别联合：`response.ucp.status === "success" | "error"`。 */
export type UcpCheckoutResponse = UcpCheckoutSession | UcpCheckoutErrorResponse;

/** fail_closed 结果的结构化上报码（tests 与上层据此分支，不回退到字符串匹配）。 */
export const UCP_CHECKOUT_FAILURE_CODES = [
  "invalid_package",
  "invalid_terms",
  "invalid_quantity",
  "session_not_found",
  "session_not_actionable",
  "session_expired",
  "not_ready",
  "gate_denied",
  "totals_mismatch",
  "recoverable",
  "unrecoverable",
  "unsafe_target",
  "timeout",
  "network",
  "bad_status",
  "malformed",
] as const;
export type UcpCheckoutFailureCode = (typeof UCP_CHECKOUT_FAILURE_CODES)[number];

/**
 * UcpCheckoutChannel 的结构化结果。兼容 HandoffChannel 三形态（HandoffResult），
 * 每个成员都是对应 HandoffResult 成员的超集：
 *   ok            —— 操作成功，携带本地 session 投影 + 远端 checkout；
 *   fail_closed   —— 明确拒绝（retryable:true 表示「改输入重试」，不自动死循环）；
 *   requires_user —— 需要用户介入外部 checkout（continue_url 指向可信 UI）。
 */
export type UcpCheckoutResult =
  | {
      status: "ok";
      session_ref: string;
      session: HandoffSession;
      continue_url?: string;
      checkout: UcpCheckoutSession;
      checkout_status: UcpCheckoutStatus;
    }
  | {
      status: "fail_closed";
      reason: string;
      messages: UcpCheckoutMessage[];
      /** 结构化上报码（totals_mismatch / session_expired / unsafe_target …）。 */
      code?: UcpCheckoutFailureCode;
      /** true=可改输入后重试（recoverable）；缺省=终态/传输失败，重试无意义。 */
      retryable?: boolean;
      checkout_status?: UcpCheckoutStatus;
      /** 服务器已创建 session 时携带，供上层 updateSession 修正。 */
      session_ref?: string;
      checkout?: UcpCheckoutSession;
    }
  | {
      status: "requires_user";
      continue_url?: string;
      reason: string;
      messages: UcpCheckoutMessage[];
      checkout_status?: UcpCheckoutStatus;
      session_ref?: string;
      checkout?: UcpCheckoutSession;
    };
