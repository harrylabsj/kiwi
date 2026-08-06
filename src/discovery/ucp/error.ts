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
