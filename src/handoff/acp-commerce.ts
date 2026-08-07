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
 * Kiwi v0.7.0 Transaction Handoff — AcpCommerceAdapter 接缝（WP3）。
 *
 * 面向 Agentic Commerce Protocol（ACP-Commerce）checkout 生态的 HandoffChannel
 * 适配占位。基线 §43：ACP-Commerce 属 v0.7.0+ Transaction Handoff，不绑定唯一实现；
 * 本模块只钉住接缝形状，未来真实 ACP adapter 在同样位置替换内部实现。
 *
 * fail-closed 语义：
 *   - 未配置真实 ACP-Commerce 服务时，所有操作一律返回 fail_closed；
 *   - 绝不静默降级到 UCP 或其他通道（reason 明确标注 acp_commerce_not_configured）；
 *   - 不创建订单、不处理支付凭据。
 *
 * 接口形状与 HandoffChannel 对齐（同一组操作、同一 HandoffResult 判别），未来
 * 实现替换内部而不破坏调用方；若未来 ACP 需要异步投影，遵循 UcpCheckoutChannel
 * 先例（AsyncHandoffChannel，status 判别不变）。
 */

import type { PaymentAuthorization } from "./authorization.js";
import type { HandoffChannel, HandoffResult } from "./channel.js";
import type { HandoffPackage } from "./package.js";
import { verifyHandoffPackageDigest } from "./package.js";
import type { TermSet } from "../negotiation/domain/common.js";

/** ACP-Commerce 接缝当前状态（占位阶段恒为 unconfigured）。 */
export const ACP_COMMERCE_ADAPTER_STATUS = ["unconfigured"] as const;
export type AcpCommerceAdapterStatus = (typeof ACP_COMMERCE_ADAPTER_STATUS)[number];

/**
 * 未来：ACP-Commerce checkout service endpoint / profile 配置。当前占位阶段无
 * 配置字段（Record<string, never> 阻止任意值混入）。
 */
export type AcpCommerceAdapterOptions = Record<string, never>;

const NOT_CONFIGURED_REASON =
  "acp_commerce_not_configured: no Agentic Commerce Protocol checkout service is configured; " +
  "refusing to route to UCP or any other channel (fail closed)";

const SESSION_NOT_CONFIGURED = "acp_commerce_not_configured: no checkout session can exist";

/**
 * ACP-Commerce 适配占位。实现 HandoffChannel 的全部操作，但未配置时一律
 * fail-closed。`configured` 恒为 false —— 调用方可用它显式分支，而不是隐式降级。
 */
export class AcpCommerceAdapter implements HandoffChannel {
  constructor(_options: AcpCommerceAdapterOptions = {}) {
    // 占位阶段无配置字段；未来真实 ACP adapter 在此接收 endpoint/profile。
  }

  /** 当前是否已配置真实 ACP-Commerce 服务（占位阶段恒为 false）。 */
  get configured(): boolean {
    return false;
  }

  get status(): AcpCommerceAdapterStatus {
    return "unconfigured";
  }

  createSession(pkg: HandoffPackage): HandoffResult {
    // 即使未配置也先做工件形状校验，fail-closed 信息更精确；但绝不创建 session。
    if (!verifyHandoffPackageDigest(pkg)) {
      return { status: "fail_closed", reason: "createSession rejected: invalid handoff package" };
    }
    return { status: "fail_closed", reason: NOT_CONFIGURED_REASON };
  }

  getSession(ref: string): HandoffResult {
    return {
      status: "fail_closed",
      reason: `${SESSION_NOT_CONFIGURED}: ${ref}`,
    };
  }

  updateSession(ref: string, _terms: TermSet): HandoffResult {
    return {
      status: "fail_closed",
      reason: `${SESSION_NOT_CONFIGURED}: ${ref}`,
    };
  }

  requestCompletion(ref: string, _authorization: PaymentAuthorization): HandoffResult {
    return {
      status: "fail_closed",
      reason: `${NOT_CONFIGURED_REASON}; cannot complete checkout session ${ref}`,
    };
  }

  cancelSession(ref: string): HandoffResult {
    return {
      status: "fail_closed",
      reason: `${SESSION_NOT_CONFIGURED}: ${ref}`,
    };
  }
}
