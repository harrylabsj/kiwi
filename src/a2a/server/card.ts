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
 * Agent Card 本地构建（基线 §26 / 子规范 §24.1 Discovery）。
 *
 * 从本地配置生成 well-known Agent Card，并声明 Kiwi Negotiation A2A extension
 * （基线 §8.2）。生成结果过 validateAgentCard 结构校验（fail-closed：
 * supportedInterfaces 非空、URL http(s)、无 userinfo）。不变量 24：card 只含
 * 元数据，绝不含静态 secret —— 本模块构造的字段全部来自配置，不读 env secret。
 */

import {
  KIWI_NEGOTIATION_EXTENSION_PATH,
  validateAgentCard,
} from "../../discovery/agent-card/index.js";
import type { AgentCard } from "../../discovery/agent-card/index.js";
import type { AgentCardConfig } from "./types.js";

function requireHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`AgentCardConfig: ${field} must be a valid URL (got "${value}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`AgentCardConfig: ${field} must use http or https (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`AgentCardConfig: ${field} must not embed credentials (userinfo)`);
  }
  return url;
}

/** 规范化 JSON-RPC endpoint 路径：确保以 "/" 开头（默认 "/"）。 */
function normalizePath(p: string | undefined): string {
  if (p === undefined || p === "") return "/";
  return p.startsWith("/") ? p : `/${p}`;
}

/** 从本地配置构建 Agent Card（每次调用重新求值，支持动态 baseUrl）。 */
export function buildAgentCard(config: AgentCardConfig): AgentCard {
  const baseUrl = requireHttpUrl(config.baseUrl, "baseUrl");
  const a2aPath = normalizePath(config.a2aPath);
  const endpointUrl = new URL(a2aPath, baseUrl).href;
  const negotiationExtensionUri =
    config.negotiationExtensionUri ?? `${baseUrl.origin}${KIWI_NEGOTIATION_EXTENSION_PATH}`;

  const card: AgentCard = {
    name: config.name,
    description: config.description,
    provider: { organization: config.providerOrganization },
    version: config.version,
    url: config.baseUrl,
    supportedInterfaces: [{ url: endpointUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: {
      extendedAgentCard: true,
      extensions: [{ uri: negotiationExtensionUri, required: false }],
    },
    // issue 10 / TCK CARD-STRUCT-001：A2A 1.0 必填字段。
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  if (config.providerUrl !== undefined) {
    requireHttpUrl(config.providerUrl, "providerUrl");
    card.provider.url = config.providerUrl;
  }
  if (config.skills !== undefined && config.skills.length > 0) {
    card.skills = config.skills;
  }
  if (config.securityScheme !== undefined) {
    card.securitySchemes = {
      [config.securityScheme.name]: { type: config.securityScheme.type },
    };
    card.security = [{ scheme: config.securityScheme.name }];
  }

  // 结构校验兜底：构造有误立即暴露，而不是把坏 card 发给远端。
  return validateAgentCard(card);
}

/**
 * 扩展 Agent Card（issue 10 / TCK CARD-EXT-001）：`GetExtendedAgentCard` 返回的
 * snake_case 形状（`default_input_modes`/`documentation_url`/`supported_interfaces`
 * 等），与标准 card 的 camelCase 不同。
 */
export function buildExtendedAgentCard(config: AgentCardConfig): Record<string, unknown> {
  const base = buildAgentCard(config);
  const ext: Record<string, unknown> = {
    name: base.name,
    description: base.description,
    version: base.version,
    provider: base.provider,
    supported_interfaces: base.supportedInterfaces.map((i) => ({
      url: i.url,
      protocol_binding: i.protocolBinding,
      protocol_version: i.protocolVersion,
    })),
  };
  // TCK CARD-EXT-001：扩展 card 的 Agent Card schema `additionalProperties:false`，
  // 顶层不允许 `url`/`extensions`——只输出 schema 列出的字段。
  if (base.documentationUrl !== undefined) ext.documentation_url = base.documentationUrl;
  if (base.capabilities !== undefined) ext.capabilities = base.capabilities;
  if (base.securitySchemes !== undefined) ext.security_schemes = base.securitySchemes;
  if (base.security !== undefined) ext.security_requirements = base.security;
  if (base.defaultInputModes !== undefined) ext.default_input_modes = base.defaultInputModes;
  if (base.defaultOutputModes !== undefined) ext.default_output_modes = base.defaultOutputModes;
  if (base.skills !== undefined) ext.skills = base.skills;
  if (base.extensions !== undefined) ext.extensions = base.extensions;
  return ext;
}
