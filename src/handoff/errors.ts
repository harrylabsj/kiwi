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
 * Kiwi v1.1 Transaction Handoff（WP1）错误模型。
 *
 * 交接域内两类失败语义分得很开：
 * - 结构化结果（HandoffChannel / AuthorizationProvider 返回 `{ok}` /
 *   `{fail_closed}` / `{requires_user}`）表达「运行时拒绝」，调用方按结果分支；
 * - `HandoffError` 表达「构造/校验失败」，只在工件构造与授权对象构造这类纯函数
 *   里抛出 —— 构造失败即 fail-closed：坏工件绝不会被创建出来。
 *
 * 代码与协议错误词表（§18）保持对齐，`terms_digest_mismatch` 直接复用 KNP 词表。
 */

export const HANDOFF_ERROR_CODES = [
  "terms_digest_mismatch",
  "invalid_agreement",
  "invalid_authorization",
  "invalid_session",
  "invalid_input",
  "concurrency_lock_timeout",
] as const;
export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];

/** Handoff 工件/授权对象构造失败。`path` 为字段路径（JSON Pointer 风格）。 */
export class HandoffError extends Error {
  readonly code: HandoffErrorCode;
  readonly path?: string;
  constructor(code: HandoffErrorCode, message: string, path?: string) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
