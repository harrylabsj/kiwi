/**
 * ShoppingCliCatalogSource 错误（fail-closed，基线 §4.6 / 设计 §17.1）。
 *
 * 任何校验 / 网络失败都必须抛 CatalogSourceError，绝不静默容错、不自动降级：
 *   - invalid_input      调用方给了非法查询（类型 / 取值错误）；
 *   - request_failed     HTTP 非 2xx、网络异常或超时；
 *   - response_invalid   响应体不是契约要求的信封结构（缺 results / catalog_agent）；
 *   - contract_violation 候选元素未通过 CandidateAgent DTO schema 校验，或 contract
 *                        注解非 candidate-agent / 非 1.x（视为协议级违规）。
 */

export const CATALOG_SOURCE_ERROR_CODES = [
  "invalid_input",
  "request_failed",
  "response_invalid",
  "contract_violation",
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
