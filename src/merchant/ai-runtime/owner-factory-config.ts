/** Private host factory references. Parsing never grants execution or reads credentials. */
import { readFileSync } from "node:fs";
import { parseOwnerBusinessConfig, type OwnerBusinessConfig } from "./owner-business-config.js";
export class OwnerFactoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface OwnerFactoryConfig {
  readonly version: 1;
  readonly references: OwnerBusinessConfig;
  readonly source: Readonly<{ endpoint: string; tenant: string; timeoutMs: number }>;
  readonly provider: Readonly<{
    endpoint: string;
    tenant: string;
    api: "openai-responses";
    timeoutMs: number;
    maxRequests: number;
    maxOutputTokens: number;
  }>;
}
function obj(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    v === null ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new OwnerFactoryError("factory_config_invalid");
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v ||
    /\s/.test(v) ||
    [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  )
    throw new OwnerFactoryError("factory_reference_invalid");
  return v;
}
function positive(v: unknown, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max)
    throw new OwnerFactoryError("factory_limit_invalid");
  return v;
}
function endpoint(v: unknown): string {
  const raw = string(v);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OwnerFactoryError("factory_endpoint_invalid");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw new OwnerFactoryError("factory_endpoint_invalid");
  return raw.replace(/\/+$/, "");
}
export function parseOwnerFactoryConfig(
  input: unknown,
  binding: { merchantId: string; principal: string },
): OwnerFactoryConfig {
  const raw = obj(input, ["version", "references", "source", "provider"]);
  if (raw.version !== 1) throw new OwnerFactoryError("factory_config_version_unknown");
  const references = parseOwnerBusinessConfig(raw.references, binding),
    s = obj(raw.source, ["endpoint", "tenant", "timeoutMs"]),
    p = obj(raw.provider, [
      "endpoint",
      "tenant",
      "api",
      "timeoutMs",
      "maxRequests",
      "maxOutputTokens",
    ]);
  const sourceEndpoint = endpoint(s.endpoint),
    tenant = string(s.tenant);
  if (
    sourceEndpoint !== endpoint(references.source.baseUrl) ||
    tenant !== references.source.merchantId
  )
    throw new OwnerFactoryError("factory_source_binding_mismatch");
  if (p.api !== "openai-responses" || references.model.provider !== "openai")
    throw new OwnerFactoryError("factory_api_unsupported");
  string(references.model.model);
  string(references.source.catalogTokenEnv);
  string(references.model.apiKeyEnv);
  return Object.freeze({
    version: 1,
    references,
    source: Object.freeze({
      endpoint: sourceEndpoint,
      tenant,
      timeoutMs: positive(s.timeoutMs, 60000),
    }),
    provider: Object.freeze({
      endpoint: endpoint(p.endpoint),
      tenant: string(p.tenant),
      api: p.api,
      timeoutMs: positive(p.timeoutMs, 30000),
      maxRequests: positive(p.maxRequests, 4),
      maxOutputTokens: positive(p.maxOutputTokens, 32768),
    }),
  });
}
export function readOwnerFactoryConfig(
  file: string,
  binding: { merchantId: string; principal: string },
) {
  try {
    return parseOwnerFactoryConfig(JSON.parse(readFileSync(file, "utf8")), binding);
  } catch (error) {
    if (error instanceof OwnerFactoryError) throw error;
    throw new OwnerFactoryError("factory_config_invalid");
  }
}
