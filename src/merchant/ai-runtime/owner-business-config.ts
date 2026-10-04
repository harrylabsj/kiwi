/** A221 reference-only configuration. Never resolves credentials or instantiates model/network. */
import { readFileSync } from "node:fs";
export interface OwnerBusinessConfig {
  readonly version: 1;
  readonly runtimeMerchantId: string;
  readonly principal: string;
  readonly source: Readonly<{
    kind: "shopping-cli-exact";
    baseUrl: string;
    merchantId: string;
    catalogTokenEnv: string;
  }>;
  readonly model: Readonly<{ provider: string; model: string; apiKeyEnv: string }>;
  readonly budget: Readonly<{ dbPath: string; dailyTokenLimit: number; reservationTokens: number }>;
}
export class OwnerBusinessConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const ENV = /^[A-Z][A-Z0-9_]*$/;
function object(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new OwnerBusinessConfigError("owner_config_invalid");
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new OwnerBusinessConfigError("owner_config_unexpected_field");
}
function text(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.trim().length === 0)
    throw new OwnerBusinessConfigError("owner_config_missing_field");
  return v;
}
function number(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
    throw new OwnerBusinessConfigError("owner_config_invalid_budget");
  return v;
}
export function parseOwnerBusinessConfig(
  input: unknown,
  binding: { merchantId: string; principal: string },
): OwnerBusinessConfig {
  const raw = object(input);
  keys(raw, ["version", "runtimeMerchantId", "principal", "source", "model", "budget"]);
  if (raw.version !== 1) throw new OwnerBusinessConfigError("owner_config_version_unknown");
  const runtimeMerchantId = text(raw.runtimeMerchantId),
    principal = text(raw.principal);
  if (runtimeMerchantId !== binding.merchantId || principal !== binding.principal)
    throw new OwnerBusinessConfigError("owner_config_binding_mismatch");
  const source = object(raw.source);
  keys(source, ["kind", "baseUrl", "merchantId", "catalogTokenEnv"]);
  if (source.kind !== "shopping-cli-exact")
    throw new OwnerBusinessConfigError("owner_source_kind_unsupported");
  const baseUrl = text(source.baseUrl);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OwnerBusinessConfigError("owner_source_url_invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new OwnerBusinessConfigError("owner_source_url_invalid");
  const catalogTokenEnv = text(source.catalogTokenEnv);
  if (!ENV.test(catalogTokenEnv))
    throw new OwnerBusinessConfigError("owner_credential_ref_invalid");
  const model = object(raw.model);
  keys(model, ["provider", "model", "apiKeyEnv"]);
  const apiKeyEnv = text(model.apiKeyEnv);
  if (!ENV.test(apiKeyEnv)) throw new OwnerBusinessConfigError("owner_credential_ref_invalid");
  const budget = object(raw.budget);
  keys(budget, ["dbPath", "dailyTokenLimit", "reservationTokens"]);
  const dailyTokenLimit = number(budget.dailyTokenLimit),
    reservationTokens = number(budget.reservationTokens);
  if (reservationTokens > dailyTokenLimit)
    throw new OwnerBusinessConfigError("owner_config_invalid_budget");
  return Object.freeze({
    version: 1,
    runtimeMerchantId,
    principal,
    source: Object.freeze({
      kind: "shopping-cli-exact",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      merchantId: text(source.merchantId),
      catalogTokenEnv,
    }),
    model: Object.freeze({ provider: text(model.provider), model: text(model.model), apiKeyEnv }),
    budget: Object.freeze({ dbPath: text(budget.dbPath), dailyTokenLimit, reservationTokens }),
  });
}
export function readOwnerBusinessConfig(
  file: string,
  binding: { merchantId: string; principal: string },
): OwnerBusinessConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new OwnerBusinessConfigError("owner_config_unreadable");
  }
  return parseOwnerBusinessConfig(raw, binding);
}
