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
export { buildUcpProfile, WELL_KNOWN_UCP_PATH } from "./ucp.js";
export type { BuiltUcpProfile, UcpPublishOptions, UcpVendorOptions } from "./ucp.js";
export {
  A2AServerThrottle,
  DEFAULT_THROTTLE_TIERS,
  DEFAULT_UNVERIFIED_SCALE,
  DEFAULT_WINDOW_MS,
  domainFromUcpProfile,
} from "./throttle.js";
export type {
  TaskSlotResult,
  ThrottleDecision,
  ThrottleOptions,
  ThrottleRequest,
  ThrottleTierTable,
  TrustTierLimits,
} from "./throttle.js";
export {
  parseUcpAgentHeader,
  serializeRfc8941String,
  serializeUcpAgentHeader,
  UCP_AGENT_HEADER,
  UCP_AGENT_PROFILE_MEMBER,
} from "../ucp-agent.js";
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
export { InboundPipeline, extractEnvelopeSkus } from "./pipeline.js";
export type { BuyerContactRecorder, BuyerContactRecord } from "./pipeline.js";
export { TaskRegistry, isKnownTaskState, newArtifactId, newTaskId } from "./task-registry.js";
export {
  JSONRPC_CODES,
  ServerProtocolError,
  authError,
  fromNegotiationError,
  internalServerError,
  payloadTooLarge,
  protocolCodeOf,
  protocolError,
  rateLimited,
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
// issue 10：通用（非 KNP）A2A 消息响应器——conformance SUT 注入 TCK 参考场景。
export { defaultGenericResponder, newGenericContextId } from "./generic-responder.js";
export type {
  GenericMessageResponder,
  GenericMessageResponse,
  GenericResponderInput,
  GenericResponderTask,
} from "./generic-responder.js";
