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
 * A2A Agent Card 运行时校验（基线 §26 / §43）。
 *
 * 校验采用 fail-closed（§4.6）：无法证明合法即为非法。已知字段严格校验类型，
 * 未知顶层字段保留（extendedAgentCard / forward-compat），但未知不自动通过——
 * 结构校验之外还要过 secret 扫描（secrets.ts）才能被接受为可用 card。
 */

import { AgentCardError, schemaError } from "./error.js";
import type {
  AgentCapabilities,
  AgentCard,
  AgentExtension,
  AgentInterface,
  AgentProvider,
  AgentSecurityRequirement,
  AgentSecurityScheme,
  AgentSkill,
} from "./types.js";

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError(path, `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw schemaError(path, `${path} must be an array`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw schemaError(path, `${path} must be a string`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (s.length === 0) {
    throw schemaError(path, `${path} must be a non-empty string`);
  }
  return s;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw schemaError(path, `${path} must be a boolean`);
  }
  return value;
}

/** 端点 URL 的结构校验：可解析且仅 http(s)。SSRF 由 a2a client 连接时执行。 */
function validateEndpointUrl(value: unknown, path: string): string {
  const url = requireNonEmptyString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw schemaError(path, `${path} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw schemaError(path, `${path} must use http or https (got ${parsed.protocol})`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw schemaError(path, `${path} must not embed credentials (userinfo)`);
  }
  return url;
}

function validateInterface(value: unknown, path: string): AgentInterface {
  const obj = requireObject(value, path);
  return {
    url: validateEndpointUrl(obj.url, `${path}/url`),
    protocolBinding: requireNonEmptyString(obj.protocolBinding, `${path}/protocolBinding`),
    protocolVersion: requireNonEmptyString(obj.protocolVersion, `${path}/protocolVersion`),
  };
}

function validateProvider(value: unknown, path: string): AgentProvider {
  const obj = requireObject(value, path);
  const provider: AgentProvider = {
    organization: requireNonEmptyString(obj.organization, `${path}/organization`),
  };
  const url = optionalString(obj.url, `${path}/url`);
  if (url !== undefined) {
    provider.url = validateEndpointUrl(url, `${path}/url`);
  }
  return provider;
}

function validateExtension(value: unknown, path: string): AgentExtension {
  const obj = requireObject(value, path);
  return {
    uri: requireNonEmptyString(obj.uri, `${path}/uri`),
    required: (() => {
      if (typeof obj.required !== "boolean") {
        throw schemaError(`${path}/required`, `${path}/required must be a boolean`);
      }
      return obj.required;
    })(),
  };
}

function validateExtensions(value: unknown, path: string): AgentExtension[] {
  return requireArray(value, path).map((item, i) => validateExtension(item, `${path}/${i}`));
}

function validateCapabilities(value: unknown, path: string): AgentCapabilities {
  const obj = requireObject(value, path);
  const capabilities: AgentCapabilities = {};
  for (const key of [
    "streaming",
    "pushNotifications",
    "stateTransitionHistory",
    "extendedAgentCard",
  ] as const) {
    const v = optionalBoolean(obj[key], `${path}/${key}`);
    if (v !== undefined) capabilities[key] = v;
  }
  if (obj.extensions !== undefined) {
    capabilities.extensions = validateExtensions(obj.extensions, `${path}/extensions`);
  }
  return capabilities;
}

function validateSkill(value: unknown, path: string): AgentSkill {
  const obj = requireObject(value, path);
  const skill: AgentSkill = {
    id: requireNonEmptyString(obj.id, `${path}/id`),
    name: requireNonEmptyString(obj.name, `${path}/name`),
  };
  const description = optionalString(obj.description, `${path}/description`);
  if (description !== undefined) skill.description = description;
  if (obj.tags !== undefined) {
    skill.tags = requireArray(obj.tags, `${path}/tags`).map((t, i) =>
      requireNonEmptyString(t, `${path}/tags/${i}`),
    );
  }
  return skill;
}

function validateSecurityScheme(value: unknown, path: string): AgentSecurityScheme {
  const obj = requireObject(value, path);
  return { ...obj, type: requireNonEmptyString(obj.type, `${path}/type`) };
}

function validateSecurityRequirement(value: unknown, path: string): AgentSecurityRequirement {
  const obj = requireObject(value, path);
  const requirement: AgentSecurityRequirement = {
    scheme: requireNonEmptyString(obj.scheme, `${path}/scheme`),
  };
  const credential = optionalString(obj.credential, `${path}/credential`);
  if (credential !== undefined) requirement.credential = credential;
  const credentials = optionalString(obj.credentials, `${path}/credentials`);
  if (credentials !== undefined) requirement.credentials = credentials;
  return requirement;
}

/**
 * 结构校验。校验通过返回规范化后的 AgentCard；失败抛 AgentCardError。
 * 注意：此函数只做结构校验，secret 扫描由 parseAgentCard 组合执行。
 */
export function validateAgentCard(value: unknown): AgentCard {
  const obj = requireObject(value, "/");
  const card: AgentCard = {
    name: requireNonEmptyString(obj.name, "/name"),
    description: requireNonEmptyString(obj.description, "/description"),
    provider: validateProvider(obj.provider, "/provider"),
    version: requireNonEmptyString(obj.version, "/version"),
    supportedInterfaces: requireArray(obj.supportedInterfaces, "/supportedInterfaces").map(
      (item, i) => validateInterface(item, `/supportedInterfaces/${i}`),
    ),
  };
  if (card.supportedInterfaces.length === 0) {
    throw schemaError("/supportedInterfaces", "supportedInterfaces must not be empty");
  }

  const url = optionalString(obj.url, "/url");
  if (url !== undefined) card.url = validateEndpointUrl(url, "/url");
  const documentationUrl = optionalString(obj.documentationUrl, "/documentationUrl");
  if (documentationUrl !== undefined) {
    card.documentationUrl = validateEndpointUrl(documentationUrl, "/documentationUrl");
  }
  if (obj.securitySchemes !== undefined) {
    const schemes = requireObject(obj.securitySchemes, "/securitySchemes");
    const out: Record<string, AgentSecurityScheme> = {};
    for (const key of Object.keys(schemes)) {
      out[key] = validateSecurityScheme(schemes[key], `/securitySchemes/${key}`);
    }
    card.securitySchemes = out;
  }
  if (obj.security !== undefined) {
    card.security = requireArray(obj.security, "/security").map((item, i) =>
      validateSecurityRequirement(item, `/security/${i}`),
    );
  }
  if (obj.capabilities !== undefined) {
    card.capabilities = validateCapabilities(obj.capabilities, "/capabilities");
  }
  if (obj.skills !== undefined) {
    card.skills = requireArray(obj.skills, "/skills").map((item, i) =>
      validateSkill(item, `/skills/${i}`),
    );
  }
  if (obj.extensions !== undefined) {
    card.extensions = validateExtensions(obj.extensions, "/extensions");
  }
  // issue 10 / TCK CARD-STRUCT-001：输入/输出模式必填，不得被校验器剥离。
  if (obj.defaultInputModes !== undefined) {
    card.defaultInputModes = requireArray(obj.defaultInputModes, "/defaultInputModes").map((s, i) =>
      requireNonEmptyString(s, `/defaultInputModes/${i}`),
    );
  }
  if (obj.defaultOutputModes !== undefined) {
    card.defaultOutputModes = requireArray(obj.defaultOutputModes, "/defaultOutputModes").map((s, i) =>
      requireNonEmptyString(s, `/defaultOutputModes/${i}`),
    );
  }
  return card;
}

/** 结构校验错误的便捷断言（供调用方诊断）。 */
export function isAgentCardError(err: unknown): err is AgentCardError {
  return err instanceof AgentCardError;
}
