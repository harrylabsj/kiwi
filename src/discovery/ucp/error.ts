/**
 * UCP resolver / validator 错误。错误码对齐 UCP 错误表（profile_* 系列）。
 * fail-closed（§4.6）：任何无法证明合法的 profile 都拒绝。
 */

export type UcpErrorCode =
  | "invalid_input"
  | "profile_not_https"
  | "profile_redirect"
  | "profile_unreachable"
  | "profile_bad_status"
  | "profile_cache_control"
  | "profile_malformed"
  | "unsafe_target";

export class UcpError extends Error {
  readonly code: UcpErrorCode;
  constructor(code: UcpErrorCode, message: string) {
    super(message);
    this.name = "UcpError";
    this.code = code;
  }
}

export function isUcpError(err: unknown): err is UcpError {
  return err instanceof UcpError;
}
