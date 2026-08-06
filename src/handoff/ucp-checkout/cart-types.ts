/**
 * Kiwi v1.1 Transaction Handoff（WP2 补全）— UCP Cart 协议类型（UCP 2026-04-08
 * cart spec family；实体与 checkout 完全同构，最大限度复用 types.ts）。
 *
 * 已核实的 cart 事实（勿发明）：
 *   - capability：`dev.ucp.shopping.cart`；操作 Create/Get/Update/Cancel Cart；
 *   - cart 无支付配置、无 status 生命周期、无 complete 操作；totals 是估算
 *     （可缺 fulfillment/tax），平台 SHOULD 视为 estimate，不做 checkout 级 sum 校验；
 *   - ucp.status = success|error 判别（缺 id 为次要指标）；全部商品不可用时
 *     business MAY 返回 error 响应而不创建 cart；Get 对不存在/过期/已取消返回
 *     not_found；
 *   - expires_at 可选；continue_url 用于分享/恢复；
 *   - Cancel 返回删除前的 cart 状态，后续操作返回 not_found；
 *   - cart→checkout：Create Checkout 请求带 cart_id；business MUST 使用 cart 内容
 *     且 MUST 忽略 checkout payload 里的重叠字段；转换幂等。
 *
 * 实体字段（line_items / context / buyer / signals / attribution / totals /
 * messages / links）与 checkout 同构，直接复用 UcpCheckout* 子类型。
 */

import type {
  UcpCheckoutErrorResponse,
  UcpCheckoutLineItem,
  UcpCheckoutLink,
  UcpCheckoutMessage,
  UcpCheckoutTotals,
} from "./types.js";

/** UCP cart capability 名（cart→checkout 可用性的前置条件）。 */
export const CART_CAPABILITY = "dev.ucp.shopping.cart" as const;

/** UCP cart spec family 日期（与 checkout §43 pin 同一 spec 家族）。 */
export const CART_SPEC_VERSION = "2026-04-08" as const;

// ---------------------------------------------------------------------------
// 实体子类型（与 checkout 同构——复用，不另起平行实现）
// ---------------------------------------------------------------------------

export type UcpCartLineItem = UcpCheckoutLineItem;
export type UcpCartTotals = UcpCheckoutTotals;
export type UcpCartMessage = UcpCheckoutMessage;
export type UcpCartLink = UcpCheckoutLink;
export type UcpCartErrorResponse = UcpCheckoutErrorResponse;

/**
 * UCP cart 资源本体（success 响应）。与 checkout 的差别只在：`cart_id` 取代
 * `session_id`；无 `status` 生命周期；无 `payment`/`authorization_reference`
 * （cart 不是支付/完成载体）。totals 为估算，不参与 checkout 级 sum 校验。
 */
export interface UcpCart {
  ucp: { status: "success"; version: string; [key: string]: unknown };
  cart_id: string;
  expires_at?: string;
  line_items?: UcpCartLineItem[];
  /** 估算 totals（可缺 fulfillment/tax）；business 权威。 */
  totals?: UcpCartTotals;
  context?: Record<string, unknown>;
  buyer?: Record<string, unknown>;
  signals?: Record<string, unknown>;
  attribution?: Record<string, unknown>;
  messages?: UcpCartMessage[];
  links?: UcpCartLink[];
  continue_url?: string;
  [key: string]: unknown;
}

/** 判别联合：`response.ucp.status === "success" | "error"`。 */
export type UcpCartResponse = UcpCart | UcpCartErrorResponse;

// ---------------------------------------------------------------------------
// UcpCartChannel 的结构化结果（三形态，公共 status 判别）
// ---------------------------------------------------------------------------

export const UCP_CART_FAILURE_CODES = [
  "cart_not_found",
  "cart_not_actionable",
  "cart_capability_unavailable",
  "invalid_package",
  "invalid_terms",
  "invalid_quantity",
  "recoverable",
  "unrecoverable",
  "unsafe_target",
  "timeout",
  "network",
  "bad_status",
  "malformed",
] as const;
export type UcpCartFailureCode = (typeof UCP_CART_FAILURE_CODES)[number];

export type UcpCartResult =
  | {
      status: "ok";
      cart_ref: string;
      cart: UcpCart;
      /** Cancel 成功时为 true（返回的是删除前的 cart 状态）。 */
      canceled?: boolean;
    }
  | {
      status: "fail_closed";
      reason: string;
      /** 结构化上报码（cart_not_found / invalid_quantity / recoverable …）。 */
      code?: UcpCartFailureCode;
      messages: UcpCartMessage[];
      /** true=可改输入后重试；缺省=终态/传输失败。 */
      retryable?: boolean;
    }
  | {
      status: "requires_user";
      reason: string;
      continue_url?: string;
      messages: UcpCartMessage[];
    };
