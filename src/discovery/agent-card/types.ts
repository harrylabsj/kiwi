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
 * A2A Agent Card 领域类型（基线 §26，外部标准 pin §43：A2A v1.0.x）。
 *
 * 形状以架构基线 §26 的完整示例为准：`supportedInterfaces` 是数组，每一项至少
 * 含 `url` + `protocolBinding` + `protocolVersion`。`protocolBinding` 的 core 值
 * 对齐 A2A 1.0 核心 binding：JSONRPC / GRPC / HTTP+JSON；未来 compliant binding
 * 使用正式 URI namespace（§26）。本模块不拒绝未知 binding 值，但 capability
 * intersection 不选择它们（§3.1）。
 *
 * 安全不变量 24：Agent Card / public metadata 不得包含静态 secret。结构校验只
 * 负责字段形状；secret 扫描由 secrets.ts 单独负责（含 merchant cost/floor 等
 * 私有数据，基线 §4.4）。
 */

/** A2A 1.0 核心 protocol binding 集合（基线 §3.1 / §26 / §43）。 */
export const CORE_PROTOCOL_BINDINGS = ["JSONRPC", "GRPC", "HTTP+JSON"] as const;
export type CoreProtocolBinding = (typeof CORE_PROTOCOL_BINDINGS)[number];

/** Kiwi Negotiation A2A Extension URI 路径（基线 §8.2）。 */
export const KIWI_NEGOTIATION_EXTENSION_PATH = "/a2a/extensions/negotiation/1.0";

/** 判断一个 binding 值是否是 A2A 1.0 核心 binding。未知 binding 不拒绝但不选择。 */
export function isCoreProtocolBinding(value: string): value is CoreProtocolBinding {
  return (CORE_PROTOCOL_BINDINGS as readonly string[]).includes(value);
}

/**
 * 单个 binding 的端点声明。§26 示例：
 * `{ "url": "https://merchant.example/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" }`
 */
export interface AgentInterface {
  /** 该 binding 的端点 URL。连接时由 a2a client 做 SSRF/URL 安全校验。 */
  url: string;
  /** JSONRPC | GRPC | HTTP+JSON，或未来 compliant binding 的正式 URI。 */
  protocolBinding: string;
  /** binding 协议版本，例如 "1.0"。未知版本 fail-closed（§4.6）。 */
  protocolVersion: string;
}

export interface AgentProvider {
  organization: string;
  /** 组织主页（可选）。 */
  url?: string;
}

/** capabilities.extensions 或顶层 extensions 中的扩展引用。 */
export interface AgentExtension {
  uri: string;
  required: boolean;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  /** true 表示允许 card 含未冻结的扩展字段（A2A extendedAgentCard）。 */
  extendedAgentCard?: boolean;
  /** 扩展引用；Kiwi 通过 isNegotiationExtensionUri 识别 negotiation extension（§8.2）。 */
  extensions?: AgentExtension[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

/**
 * securitySchemes 的单个值（A2A v1.0）。`type` 为 scheme 类型；其余字段按类型
 * 各异。本模块宽松建模（未知 scheme type 允许），静态 secret 由 secrets.ts 拒绝。
 */
export interface AgentSecurityScheme {
  type: string;
  [key: string]: unknown;
}

/**
 * security 项：`scheme` 引用 securitySchemes 中的名字；`credential` /
 * `credentials` 是凭据标识的引用（不是 secret 本身）。A2A 规范禁止在 card 中
 * 携带真实凭据（不变量 24）。两种拼写都接受以兼容不同 A2A 实现。
 */
export interface AgentSecurityRequirement {
  scheme: string;
  credential?: string;
  credentials?: string;
}

/**
 * A2A Agent Card（基线 §26 字段清单）。字段集合允许未来扩展（extendedAgentCard），
 * 因此结构校验只约束已知字段，未知顶层字段按 forward-compat 保留。
 */
export interface AgentCard {
  name: string;
  description: string;
  provider: AgentProvider;
  version: string;
  /** 标准 Agent Card 的 canonical URL（可选；连接走 supportedInterfaces）。 */
  url?: string;
  documentationUrl?: string;
  supportedInterfaces: AgentInterface[];
  securitySchemes?: Record<string, AgentSecurityScheme>;
  security?: AgentSecurityRequirement[];
  capabilities?: AgentCapabilities;
  skills?: AgentSkill[];
  /** 声明的输入/输出模式（issue 10 / TCK CARD-STRUCT-001 必填）。 */
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  /** §26 字段清单中的顶层 extensions；capabilities.extensions 是规范位置。 */
  extensions?: AgentExtension[];
}
