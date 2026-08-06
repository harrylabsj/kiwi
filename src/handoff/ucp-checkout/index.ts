/**
 * Kiwi v1.1 Transaction Handoff（WP2）— UCP Checkout client。
 *
 * HandoffChannel 的真实 UCP 版本：在外部交易系统（business 为 Merchant of Record）
 * 上创建 / 读取 / 全量替换更新 / 请求完成 / 取消 checkout session。与 WP1 的
 * 同步接缝 `HandoffChannel` 相对，本包提供异步投影 `AsyncHandoffChannel`；
 * `requestCompletion` 复用 WP1 完成门禁（completion.ts），通过后才发 Complete，
 * 且只附 authorization 证据引用（不构造任何支付凭据）。
 *
 * 零新增依赖：Node 22 原生 fetch + AbortController；SSRF 复用 a2a url-policy。
 */

export {
  UcpCheckoutChannel,
  type AsyncHandoffChannel,
  type UcpCheckoutChannelOptions,
} from "./channel.js";

export {
  CHECKOUT_CANCEL_SUFFIX,
  CHECKOUT_COMPLETE_SUFFIX,
  CHECKOUT_SESSIONS_PATH,
  UcpCheckoutHttpClient,
  type UcpCheckoutHttpClientOptions,
  type UcpCheckoutHttpError,
  type UcpCheckoutHttpErrorCode,
  type UcpCheckoutHttpResult,
} from "./client.js";

export { findCheckoutEndpoint, type FindCheckoutEndpointOptions } from "./endpoint.js";

export {
  UcpCheckoutParseError,
  decideMessages,
  decideResponse,
  groupMessages,
  isUcpCheckoutErrorResponse,
  isUcpCheckoutSuccessSession,
  parseUcpCheckoutResponse,
  summarizeMessages,
  type CheckoutAction,
  type CheckoutDecision,
  type MessageGrouping,
} from "./parse.js";

export { validateTotals, type TotalsValidationResult } from "./totals.js";

export {
  DEFAULT_EXPIRY_MS,
  UCP_CHECKOUT_FAILURE_CODES,
  UCP_CHECKOUT_SPEC_VERSION,
  UCP_CHECKOUT_STATUSES,
  UCP_MESSAGE_SEVERITIES,
  UCP_MESSAGE_TYPES,
  type UcpCheckoutErrorResponse,
  type UcpCheckoutFailureCode,
  type UcpCheckoutLineItem,
  type UcpCheckoutLink,
  type UcpCheckoutMessage,
  type UcpCheckoutResponse,
  type UcpCheckoutResult,
  type UcpCheckoutSession,
  type UcpCheckoutStatus,
  type UcpCheckoutTotals,
  type UcpMessageSeverity,
  type UcpMessageType,
} from "./types.js";
