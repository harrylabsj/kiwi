/**
 * A2A Message / Task / Artifact 领域类型（§43 pin A2A v1.0.x）。
 *
 * 本 WP1 只建模出站 client 需要的子集：Message（Text Part + Data Part）、Task
 * 状态、Artifact。file part 等未建模 kind 在响应解析时 fail-closed
 * （parse.ts），不静默吞掉。
 */

export type A2APart =
  { kind: "text"; text: string } | { kind: "data"; data: Record<string, unknown> };

export interface A2AMessage {
  role: "agent" | "user";
  parts: A2APart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** A2A Task 状态枚举（A2A v1.0）。 */
export const A2A_TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "unknown",
] as const;
export type A2ATaskState = (typeof A2A_TASK_STATES)[number];

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  parts: A2APart[];
  artifactId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * 出站签名挂点（WP5，RFC 9421 HTTP Message Signature）。
 *
 * client 在发起请求前调用 signer.sign(input)，把返回的请求头（content-digest /
 * signature-input / signature）合并进 fetch 请求。signer 是结构性接口 ——
 * trust/identity 的 HttpMessageSigner 直接满足该形状，client 不依赖 trust。
 */
export interface A2AOutboundRequest {
  method: string;
  /** 绝对 endpoint URL（@target-uri 与 @authority 由它派生）。 */
  url: string;
  /** 请求体字节。 */
  body: Buffer;
  /** 已有请求头（content-type 等），签名器可能把 content-digest 加入其中。 */
  headers: Record<string, string>;
}

/** 出站签名器：返回要合并进请求的头。 */
export interface A2AOutboundSigner {
  readonly keyid: string;
  sign(input: A2AOutboundRequest): Record<string, string>;
}

export interface A2AClientOptions {
  /** 选定 binding 的端点 URL（来自 capability intersection 的 remote interface url）。 */
  url: string;
  /** 每请求超时 ms。默认 15000。 */
  timeoutMs?: number;
  /** 注入 fetch（测试用）。默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 允许打到私网/保留网段（SSRF 逃生门，默认 false）。 */
  allowPrivateRanges?: boolean;
  /** 跳过 DNS 解析后的保留网段复查（仅测试/本机直连）。 */
  skipDnsCheck?: boolean;
  /** 注入 DNS 解析器（测试用）。默认 node:dns lookup all。 */
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** 附加请求头（如认证）。 */
  headers?: Record<string, string>;
  /**
   * UCP-Agent 宣告（基线 §25.1）：配置后出站请求携带
   * `UCP-Agent: profile="<uri>"`（RFC 8941 Dictionary），声明本方的 UCP
   * platform profile URI。HTTP-based A2A binding 用；可选。
   */
  ucpAgentProfile?: string;
  /** 出站 HTTP Message Signature 签名器（可选；配置后每个请求都被签名）。 */
  signer?: A2AOutboundSigner;
}
