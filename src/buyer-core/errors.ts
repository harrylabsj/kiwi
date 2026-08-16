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
 * kiwi-buyer-mcp 类型化错误（fail-closed，同仓库 `*Error` + code 约定）。
 * 错误码在跨宿主 Compatibility Matrix（§6.10）里作为语义不变量被验收。
 */

export type McpErrorCode =
  | "invalid_request"
  | "invalid_params"
  | "method_not_found"
  | "not_initialized"
  | "tool_not_found"
  | "contract_violation"
  | "idempotency_conflict"
  | "delegation_denied"
  | "authorization_denied"
  | "approval_required"
  | "approval_denied"
  | "task_not_found"
  | "task_expired"
  | "agreement_not_found"
  | "store_corrupted"
  | "internal_error";

const CODE_TO_JSON_RPC: Record<McpErrorCode, number> = {
  invalid_request: -32600,
  invalid_params: -32602,
  method_not_found: -32601,
  not_initialized: -32002,
  tool_not_found: -32002,
  contract_violation: -32602,
  idempotency_conflict: -32602,
  delegation_denied: -32000,
  authorization_denied: -32000,
  approval_required: -32000,
  approval_denied: -32000,
  task_not_found: -32602,
  task_expired: -32000,
  agreement_not_found: -32602,
  store_corrupted: -32603,
  internal_error: -32603,
};

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly detail?: unknown;

  constructor(code: McpErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.detail = detail;
  }

  /** 映射为 JSON-RPC 错误负载（§6.10 错误分类语义）。 */
  toJsonRpc(): { code: number; message: string; data: unknown } {
    return {
      code: CODE_TO_JSON_RPC[this.code],
      message: `${this.code}: ${this.message}`,
      data: this.detail,
    };
  }
}
