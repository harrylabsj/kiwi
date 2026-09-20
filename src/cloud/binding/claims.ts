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
 * 绑定声明（runtime-binding-claims 0.1.2）的构造与**完整 claims 校验**。
 *
 * 只按交接包内的 `contracts/runtime-binding-claims.schema.json` 实现（该 Schema
 * 是权威），不发明字段、不放松格式；`additionalProperties: false` 对应"未知字段
 * 一律拒绝"。
 *
 * 设计约束（§11.4）：声明绑定 agent_id、merchant_id、Card URL、A2A URL、
 * Runtime origin、密钥指纹、binding_version、service_epoch 与有效期；有效期上限
 * 取 §11.5 建议参数（最长 15 分钟）。
 */

export const BINDING_CLAIMS_SCHEMA_VERSION = "0.1.2";

/** §11.5 建议参数：绑定声明最长有效期 15 分钟（需压测后配置，不冒充平台上限）。 */
export const BINDING_CLAIMS_MAX_TTL_SECONDS = 15 * 60;

export interface BindingClaims {
  schema_version: "0.1.2";
  binding_id: string;
  binding_version: number;
  merchant_id: string;
  agent_id: string;
  workload_ref: string;
  runtime_origin: string;
  a2a_endpoint: string;
  card_url: string;
  key_id: string;
  key_thumbprint: string;
  service_epoch: number;
  issued_at: string;
  expires_at: string;
  issuer: string;
  scope: "a2a-runtime";
  status: "active" | "revoked";
}

/**
 * 契约冲突与规范化（**需 Catalog/需求方确认，暂以显式映射落地**）：
 *
 * `runtime-binding-claims.schema.json` 的 `agent_id` 模式是
 * `^[A-Za-z][A-Za-z0-9_-]{2,95}$`——**不允许冒号**；而 Kiwi profile 的 agent_id
 * 形如 `merchant-agent:<owner_id>`（见 examples/profiles/*.yaml）。
 *
 * 这里做**显式、可追溯**的规范化，而不是静默改身份：
 *   - 非法字符（冒号等）→ `-`；长度按模式裁剪到 96；
 *   - 归一结果与原始 agent_id **一并**进入绑定记录（`agent_id_raw`）与审计，
 *     保证可回溯；
 *   - 归一后仍不符合模式 → 抛错（绝不签发一个"看起来合法"的错身份）。
 *
 * 该映射是否被 Catalog/需求方接受，属 M3 前的契约确认项（已记入 M2 证据）。
 */
export function toBindingAgentId(agentId: string): string {
  const normalized = agentId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96);
  if (!ID_PATTERN.test(normalized)) {
    throw new Error(`agent_id 归一后仍不符合绑定声明模式：${agentId} → ${normalized}`);
  }
  return normalized;
}

export type ClaimsValidation =
  | { ok: true; claims: BindingClaims }
  | { ok: false; errors: string[] };

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,95}$/;
const THUMBPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isHttpsUri(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const ALLOWED_KEYS = new Set<keyof BindingClaims>([
  "schema_version",
  "binding_id",
  "binding_version",
  "merchant_id",
  "agent_id",
  "workload_ref",
  "runtime_origin",
  "a2a_endpoint",
  "card_url",
  "key_id",
  "key_thumbprint",
  "service_epoch",
  "issued_at",
  "expires_at",
  "issuer",
  "scope",
  "status",
]);

/** 完整 claims 校验（结构 + 格式 + 有效期关系 + 未知字段拒绝）。 */
export function validateBindingClaims(value: unknown): ClaimsValidation {
  const errors: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["claims 必须是 JSON 对象"] };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key as keyof BindingClaims)) errors.push(`未知字段：${key}`);
  }
  if (record["schema_version"] !== BINDING_CLAIMS_SCHEMA_VERSION) {
    errors.push(`schema_version 必须是 ${BINDING_CLAIMS_SCHEMA_VERSION}`);
  }
  for (const field of ["binding_id", "merchant_id", "agent_id", "workload_ref"] as const) {
    const v = record[field];
    if (typeof v !== "string" || !ID_PATTERN.test(v)) errors.push(`${field} 不符合 id 形状（${String(v)}）`);
  }
  for (const field of ["runtime_origin", "a2a_endpoint", "card_url"] as const) {
    if (!isHttpsUri(record[field])) errors.push(`${field} 必须是 https URL（${String(record[field])}）`);
  }
  if (typeof record["key_id"] !== "string" || record["key_id"].length === 0) {
    errors.push("key_id 必须是非空字符串");
  }
  if (typeof record["key_thumbprint"] !== "string" || !THUMBPRINT_PATTERN.test(record["key_thumbprint"])) {
    errors.push("key_thumbprint 必须是 sha256:<64 hex>");
  }
  for (const field of ["binding_version", "service_epoch"] as const) {
    const v = record[field];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) errors.push(`${field} 必须是 ≥1 的整数`);
  }
  if (!isIsoDate(record["issued_at"])) errors.push("issued_at 必须是 ISO 时间");
  if (!isIsoDate(record["expires_at"])) errors.push("expires_at 必须是 ISO 时间");
  if (isIsoDate(record["issued_at"]) && isIsoDate(record["expires_at"])) {
    const issued = Date.parse(record["issued_at"] as string);
    const expires = Date.parse(record["expires_at"] as string);
    if (expires <= issued) errors.push("expires_at 必须晚于 issued_at");
    else if (expires - issued > BINDING_CLAIMS_MAX_TTL_SECONDS * 1000) {
      errors.push(`有效期超过上限 ${BINDING_CLAIMS_MAX_TTL_SECONDS}s`);
    }
  }
  if (typeof record["issuer"] !== "string" || record["issuer"].length === 0) errors.push("issuer 必须是非空字符串");
  if (record["scope"] !== "a2a-runtime") errors.push('scope 必须是 "a2a-runtime"');
  if (record["status"] !== "active" && record["status"] !== "revoked") errors.push('status 必须是 active|revoked');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, claims: record as unknown as BindingClaims };
}

export interface BuildBindingClaimsInput {
  bindingId: string;
  bindingVersion: number;
  merchantId: string;
  agentId: string;
  workloadRef: string;
  runtimeOrigin: string;
  a2aEndpoint: string;
  cardUrl: string;
  keyId: string;
  keyThumbprint: string;
  serviceEpoch: number;
  issuedAt: string;
  ttlSeconds: number;
  issuer: string;
  status?: "active" | "revoked";
}

/** 构造声明并按 Schema 自检（构造即校验，避免签发非法声明）。 */
export function buildBindingClaims(input: BuildBindingClaimsInput): BindingClaims {
  const issuedAtMs = Date.parse(input.issuedAt);
  if (Number.isNaN(issuedAtMs)) {
    throw new Error(`issuedAt 不是合法时间：${input.issuedAt}`);
  }
  const claims: BindingClaims = {
    schema_version: BINDING_CLAIMS_SCHEMA_VERSION,
    binding_id: input.bindingId,
    binding_version: input.bindingVersion,
    merchant_id: input.merchantId,
    agent_id: input.agentId,
    workload_ref: input.workloadRef,
    runtime_origin: input.runtimeOrigin,
    a2a_endpoint: input.a2aEndpoint,
    card_url: input.cardUrl,
    key_id: input.keyId,
    key_thumbprint: input.keyThumbprint,
    service_epoch: input.serviceEpoch,
    issued_at: input.issuedAt,
    expires_at: new Date(issuedAtMs + input.ttlSeconds * 1000).toISOString(),
    issuer: input.issuer,
    scope: "a2a-runtime",
    status: input.status ?? "active",
  };
  const checked = validateBindingClaims(claims);
  if (!checked.ok) {
    throw new Error(`binding claims 构造失败：${checked.errors.join("；")}`);
  }
  return claims;
}
