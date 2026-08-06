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
