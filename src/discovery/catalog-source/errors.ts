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
 * ShoppingCliCatalogSource 错误（fail-closed，基线 §4.6 / 设计 §17.1）。
 *
 * 任何校验 / 网络失败都必须抛 CatalogSourceError，绝不静默容错、不自动降级：
 *   - invalid_input      调用方给了非法查询（类型 / 取值错误）；
 *   - request_failed     HTTP 非 2xx 或网络异常（不含超时）；
 *   - request_timeout    请求超出配置时限（AbortSignal 中止）。与 request_failed
 *                        分开，买方搜索才能如实把来源标为"超时"而非"失败"
 *                        （双来源搜索设计 v1.1 §7/§17：无匹配 / 失败 / 超时 /
 *                        部分完成必须可区分，不能从提示词文本猜错误类型）；
 *   - endpoint_unavailable 该 catalog 部署没有这个端点（HTTP 404/405）。属于
 *                        "能力不存在"而非"本次查询失败"，买方据此标 not_searched
 *                        （设计 §7「未搜索」= 能力不可用）；
 *   - response_invalid   响应体不是契约要求的信封结构（缺 results / catalog_agent）；
 *   - contract_violation 候选元素未通过 CandidateAgent DTO schema 校验，或 contract
 *                        注解非 candidate-agent / 非 1.x（视为协议级违规）。
 *   - binding_rejected   运行时绑定声明被拒（签名/发行者/时间窗/与观测事实不符）。
 *                        见 cloud-card.ts 的 `BindingRejectionError`；**绝不降级为
 *                        "部分可信"**，调用方按 refusalCode 分流处置。
 */

export const CATALOG_SOURCE_ERROR_CODES = [
  "invalid_input",
  "request_failed",
  "request_timeout",
  "endpoint_unavailable",
  "response_invalid",
  "contract_violation",
  /** 会话认证端点拒绝了买家会话（HTTP 401/403）：登录态缺失或已过期。 */
  "session_rejected",
  "binding_rejected",
] as const;

export type CatalogSourceErrorCode = (typeof CATALOG_SOURCE_ERROR_CODES)[number];

/** Catalog 读取失败。带错误码；fail-closed，调用方不得吞掉。 */
export class CatalogSourceError extends Error {
  readonly code: CatalogSourceErrorCode;

  constructor(code: CatalogSourceErrorCode, message: string) {
    super(message);
    this.name = "CatalogSourceError";
    this.code = code;
  }
}
