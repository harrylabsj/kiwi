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
 * Agent Card 校验错误。`code` 对齐基线 §32 协议错误词表（schema_invalid /
 * field_unsupported）；`secret_found` 是安全不变量 24 的拒绝信号。
 */

export type AgentCardErrorCode = "schema_invalid" | "field_unsupported" | "secret_found";

export class AgentCardError extends Error {
  readonly code: AgentCardErrorCode;
  /** JSON Pointer 风格的字段路径。 */
  readonly path: string;
  constructor(code: AgentCardErrorCode, message: string, path: string) {
    super(message);
    this.name = "AgentCardError";
    this.code = code;
    this.path = path;
  }
}

/** 默认 schema 校验错误。 */
export function schemaError(path: string, message: string): AgentCardError {
  return new AgentCardError("schema_invalid", message, path);
}
