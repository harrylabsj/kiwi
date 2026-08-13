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
  /**
   * 线协议版本（issue 06/09）：缺省 `"1.0"`（Card 声明 1.0 ↔ 默认 client 讲 1.0）
   * ——发 `A2A-Version` + `A2A-Extensions` + 1.0 方法名（SendMessage/GetTask）
   * + 1.0 Part 编码。`"0.3"` 走 legacy 帧（message/send/tasks/get + kind Part）。
   */
  version?: "1.0" | "0.3";
  /**
   * 1.0 模式声明 KNP 扩展的 URI（A2A-Extensions 头）；缺省从端点 origin 派生
   * （`${origin}${KNP_EXTENSION_PATH}`），与 server Card 默认对齐；显式可覆盖。
   */
  knpExtensionUri?: string;
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
