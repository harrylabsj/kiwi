/**
 * a2a/server — A2A JSONRPC binding 入站 server（WP2，node:http，零新增依赖）。
 *
 * 端点面：
 *   GET  /.well-known/agent-card.json    Agent Card（含 KNP negotiation extension 声明）；
 *   POST <a2aPath>                        JSON-RPC：message/send、tasks/get。
 *
 * 安全：所有入站内容 untrusted（基线 §4.5 / §36）；schema 不过 → schema_invalid；
 * 未知版本 → protocol_version_unsupported；幂等同 key 异 digest → idempotency_conflict；
 * body 大小上限；body 解析失败 fail-closed；未配置 AuthVerifier 时默认只接受
 * loopback 请求（fail-closed）。
 */

export { A2AServer } from "./server.js";
export { buildAgentCard } from "./card.js";
export {
  defaultAuthVerifier,
  LoopbackOnlyAuthVerifier,
  NoneAuthVerifier,
  StaticBearerAuthVerifier,
} from "./auth.js";
// WP5 完整身份方案（RFC 9421 HTTP Message Signature + Agent Card JWS +
// TrustPolicy + 身份绑定）。实现位于 src/trust/identity。
export { HttpMessageSignatureVerifier } from "../../trust/identity/index.js";
export { declineHandler, defaultHandler, echoHandler } from "./handler.js";
export { InboundPipeline } from "./pipeline.js";
export { TaskRegistry, isKnownTaskState, newArtifactId, newTaskId } from "./task-registry.js";
export {
  JSONRPC_CODES,
  ServerProtocolError,
  authError,
  fromNegotiationError,
  internalServerError,
  payloadTooLarge,
  protocolError,
  schemaInvalid,
  taskNotFound,
} from "./errors.js";
export type { JsonRpcErrorBody } from "./errors.js";
export {
  extractKnpEnvelope,
  KNP_ENVELOPE_DATA_KEY,
  parseInboundMessage,
} from "./inbound-message.js";
export type {
  A2AServerOptions,
  AgentCardConfig,
  AgentCardConfigProvider,
  AuthContext,
  AuthResult,
  AuthVerifier,
  InboundNegotiationContext,
  NegotiationHandler,
  NegotiationHandlerResult,
} from "./types.js";
