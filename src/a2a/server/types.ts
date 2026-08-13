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
 * A2A Server（入站侧，WP2）契约类型。
 *
 * 边界（基线 §4.5 / §36）：入站内容一律 untrusted。这里的类型只描述「校验通过
 * 之后」的域对象；raw 入站数据必须先经 inbound-message.ts 的严格解析、
 * pipeline.ts 的 schema/digest/幂等检查，才允许进入这些类型。
 *
 * 三个接缝（本 WP 定义，后续 WP 接线）：
 *   - AuthVerifier        请求路径上的认证接缝（WP5 完整认证）。
 *   - NegotiationHandler  校验通过后的业务路由（后续 WP 接真正的 Negotiation Engine）。
 *   - AgentCardConfig     本地 discovery 配置（基线 §26）。
 */

import type { A2AMessage, A2APart, A2ATaskState } from "../client/index.js";
import type { NegotiationEnvelope } from "../../negotiation/domain/envelope.js";
import type { ProtocolErrorCode } from "../../negotiation/domain/common.js";
import type { AgentSkill } from "../../discovery/agent-card/index.js";
import type { IdempotencyStore } from "../../negotiation/idempotency/index.js";
import type { LedgerStore } from "../../negotiation/ledger/index.js";
import type { UcpPublishOptions } from "./ucp.js";
import type { A2AServerThrottle, ThrottleOptions } from "./throttle.js";
import type { TrustLevel } from "../../trust/identity/trust-policy.js";
import type { GenericMessageResponder } from "./generic-responder.js";

/** Agent Card 本地配置（基线 §26 / 子规范 §24.1 Discovery）。 */
export interface AgentCardConfig {
  /** Agent 名称。 */
  name: string;
  /** Agent 描述。 */
  description: string;
  /** 提供方组织名。 */
  providerOrganization: string;
  /** 提供方主页（可选，http(s)）。 */
  providerUrl?: string;
  /** Agent Card 的 version 字段（semver-ish）。 */
  version: string;
  /** 本 server 可达的 base URL（http(s)），用于派生 supportedInterfaces[].url。 */
  baseUrl: string;
  /** JSON-RPC A2A endpoint 路径（默认 "/"）。 */
  a2aPath?: string;
  /**
   * KNP negotiation extension URI。默认取 baseUrl origin 拼
   * `/a2a/extensions/negotiation/1.0`（基线 §8.2 / §26）。
   */
  negotiationExtensionUri?: string;
  /** 附加技能声明（可选）。 */
  skills?: AgentSkill[];
  /** 安全方案声明（仅元数据，不得含 secret；不变量 24）。 */
  securityScheme?: { name: string; type: string };
}

/** card 配置可静态提供，也可用 provider 函数（测试/部署时 baseUrl 动态确定）。 */
export type AgentCardConfigProvider = AgentCardConfig | (() => AgentCardConfig);

/** 认证接缝输入：请求路径上可获得的、与身份判定相关的安全上下文。 */
export interface AuthContext {
  /** 对端 socket 地址（node 原样，可能是 "::ffff:127.0.0.1"）。 */
  remoteAddress: string | undefined;
  /** 原始 Authorization 头（如有）。 */
  authorizationHeader: string | undefined;
  /** 请求方法。 */
  method: string;
  /** 请求 URL（path；node 原样，origin-form）。 */
  url: string;
  /** 原始请求头（node 小写名）。WP5 HTTP Message Signature 验签需要。 */
  headers?: Record<string, string | string[] | undefined>;
  /** 请求体字节（WP5 content-digest 重算需要；POST 路径在认证前读取）。 */
  body?: Buffer;
  /** 请求 scheme（@target-uri 重建用）；缺省按 "http" 处理。 */
  scheme?: "http" | "https";
}

export interface AuthResult {
  authenticated: boolean;
  /** 认证通过时的调用方身份；用作协议幂等主键 (sender_identity, message_id) 的一半。 */
  identity?: string;
  /**
   * 失败时的协议错误码（缺省按 authorization_failed 处理）。§32 词表里与认证
   * 相关的还有 identity_rejected（身份绑定冲突）与 replay_detected（重放）。
   */
  protocolCode?:
    "authentication_required" | "authorization_failed" | "identity_rejected" | "replay_detected";
  /** 失败原因（内部日志用，不回显给远端；§4.5）。 */
  reason?: string;
  /**
   * 对端 trust level（T0-T3，基线 §28）。WP3 throttle 用它映射限流档位
   * （T0 最严 / T3 最宽）；缺省按 T0 处理（最严，fail-closed）。
   */
  trustLevel?: TrustLevel;
  /** 身份是否经过验签（false/缺省 = 匿名/回落，throttle 按 remoteAddress 且限额更严）。 */
  identityVerified?: boolean;
  /** WP1 对端 Agent Card 指纹近期变更信号：生效期间 throttle 短期降档。 */
  fingerprintChanged?: boolean;
}

/**
 * AuthVerifier 接缝。本 WP 提供三种参考实现（auth.ts）：
 * `none` / `static-bearer` / `loopback-only`（未配置 verifier 时的 fail-closed 默认）。
 * 完整认证在 WP5 接入。
 */
export interface AuthVerifier {
  readonly name: string;
  verify(ctx: AuthContext): AuthResult | Promise<AuthResult>;
}

/** 入站 KNP 消息通过校验后的处理上下文（路由给 NegotiationHandler）。 */
export interface InboundNegotiationContext {
  /** 已通过 schema / digest / 幂等检查的 KNP envelope（§8 / §19）。 */
  envelope: NegotiationEnvelope;
  /** 完整入站 A2A Message（含 text part；untrusted 但已结构化，引擎不得回写 Principal Memory）。 */
  message: A2AMessage;
  /** 本 server 为该入站消息生成的任务 id（§24.5：KNP MUST NOT 伪造远端 task id）。 */
  taskId: string;
  /** 远端 A2A contextId（params.contextId 优先，回落 message.contextId；§24.4）。 */
  contextId?: string;
  /** 认证身份（幂等主键的 sender 侧）。 */
  senderIdentity: string;
  /** 对端 socket 地址。 */
  remoteAddress?: string;
  /**
   * 对端 UCP-Agent 头声明的 platform profile URI（基线 §25.1，WP3）。
   * HTTP-based binding 的 service parameter 宣告；只读暴露给 handler，
   * 不强制 —— 头缺失时缺省 undefined，请求照常处理。
   */
  ucpAgentProfile?: string;
}

export type NegotiationHandlerResult =
  | { kind: "accepted"; taskState?: A2ATaskState; message?: A2AMessage; artifactParts?: A2APart[] }
  | { kind: "declined"; reasonCode?: string; taskState?: A2ATaskState }
  | { kind: "error"; protocolCode: ProtocolErrorCode; message: string };

/**
 * NegotiationHandler 接缝：上层注入的「真正的」Negotiation Engine（后续 WP）。
 * 本 WP 提供安全桩（handler.ts）：echoHandler（原样回显）与 declineHandler
 * （全部拒绝，fail-closed 默认）。
 *
 * 约定：`kind: "error"` 映射为 JSON-RPC 协议错误（§18，不得当作商业 Decline）；
 * `kind: "declined"` 是合法的商业结果，任务以 completed 结束并携带 decline 消息。
 */
export interface NegotiationHandler {
  readonly name: string;
  handle(ctx: InboundNegotiationContext): Promise<NegotiationHandlerResult>;
}

export interface A2AServerOptions {
  /** Agent Card 配置（provider 函数在每次 well-known 请求时求值）。 */
  card: AgentCardConfigProvider;
  /** 落账（基线 §22）：入站处理证据 append-only 记录。 */
  ledger: LedgerStore;
  /** 协议幂等（子规范 §20）：(sender_identity, message_id) 三态判定。 */
  idempotency: IdempotencyStore;
  /** 业务路由；缺省用 declineHandler（fail-closed，未接线引擎时拒绝一切）。 */
  handler?: NegotiationHandler;
  /** 认证；缺省用 loopback-only（未配置 verifier 时拒绝非 loopback 请求）。 */
  authVerifier?: AuthVerifier;
  /** JSON-RPC body 大小上限（字节，默认 1 MiB）；超限 fail-closed。 */
  maxPayloadBytes?: number;
  /** 可注入时钟（RFC 3339）；用于任务时间戳。 */
  now?: () => string;
  /** well-known Agent Card 路径（默认 "/.well-known/agent-card.json"）。 */
  wellKnownPath?: string;
  /**
   * UCP Profile 发布（WP3，基线 §25）：true = 用默认选项在
   * `GET /.well-known/ucp` 上发布；对象 = 自定义发布选项。缺省不发布。
   * 响应头 Cache-Control 为 `public, max-age=N`（N>=60，UCP 规范强制）。
   */
  ucp?: boolean | UcpPublishOptions;
  /**
   * WP3 §31 反滥用限流。缺省不配置 → 不限流（保持既有行为）；配置后判定发生在
   * 认证之后、schema 校验之前（InboundPipeline.sendMessage 顶部）。
   * 传 ThrottleOptions 由 server 构造；也可直接注入 A2AServerThrottle 实例（测试用）。
   */
  throttle?: ThrottleOptions | A2AServerThrottle;
  /**
   * 通用（非 KNP）A2A 消息响应器（issue 10 / TCK）。缺省用 spec 一致的回显；
   * conformance SUT 注入 TCK 参考场景（messageId 前缀路由）。
   */
  genericResponder?: GenericMessageResponder;
}
