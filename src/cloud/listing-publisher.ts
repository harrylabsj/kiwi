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

/** Signed listing publication context sourced only from a completed Runtime enrollment. */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadA2aSigningIdentityFromFile, toJwsSigningIdentity } from "../a2a/signing-key.js";
import type { AgentProfile } from "../config/profile.js";
import { readEnrollmentStore, enrollmentStorePath } from "./binding/enrollment-challenge.js";
import { CatalogClient, runtimePublicKey, type RuntimeSigningIdentity } from "./catalog-client.js";
import { canonicalize } from "../negotiation/jcs.js";
import { DESTINATION_TYPES } from "../handoff/destination.js";

const LISTING_KEYS = new Set([
  "listing_type", "owner_agent_id", "merchant_id", "source_product_ref", "publisher_listing_key",
  "source_revision", "title", "summary", "category", "brand", "attributes", "regions", "tags",
  "commercial_hints", "handoff_destination_types", "handoff_destination_ref", "fresh_until",
]);
const COMMERCIAL_HINT_KEYS = new Set([
  "moq", "price_range_hint", "availability_hint", "lead_time_hint", "supports_bulk_quote",
  "supports_customization", "fulfillment_regions",
]);

function requireText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `${field} must be a string`);
  const normalized = value.trim();
  if ((!allowEmpty && normalized === "") || normalized.length > 4096) {
    throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `${field} is empty or too long`);
  }
  return normalized;
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `${field} must be an array of at most 256 strings`);
  return value.map((item, index) => requireText(item, `${field}[${index}]`));
}

/** Mirror Catalog validate_publish_payload so the signed digest covers exactly its canonical fields. */
export function canonicalizeCatalogListing(
  payload: Record<string, unknown>,
  ownerAgentId: string,
  merchantId: string,
): Record<string, unknown> {
  const unknown = Object.keys(payload).filter((key) => !LISTING_KEYS.has(key));
  if (unknown.length > 0) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `unknown listing fields: ${unknown.join(", ")}`);
  const listingType = requireText(payload["listing_type"], "listing_type");
  if (listingType !== "product" && listingType !== "capability") throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "listing_type must be product or capability");
  const canonical: Record<string, unknown> = {
    listing_type: listingType,
    owner_agent_id: requireText(ownerAgentId, "owner_agent_id"),
    merchant_id: requireText(merchantId, "merchant_id"),
    title: requireText(payload["title"], "title"),
    category: requireText(payload["category"], "category"),
  };
  if (listingType === "product") canonical["source_product_ref"] = requireText(payload["source_product_ref"], "source_product_ref");
  else {
    if (payload["source_product_ref"] !== undefined) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "capability listing cannot contain source_product_ref");
    if (payload["publisher_listing_key"] !== undefined) canonical["publisher_listing_key"] = requireText(payload["publisher_listing_key"], "publisher_listing_key");
  }
  for (const key of ["summary", "brand", "source_revision"] as const) {
    if (payload[key] !== undefined && payload[key] !== null) canonical[key] = requireText(payload[key], key, true);
  }
  if (payload["attributes"] !== undefined) {
    const raw = payload["attributes"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 64) {
      throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "attributes must be an object with at most 64 keys");
    }
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || !["string", "number", "boolean"].includes(typeof value) ||
          typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && value.length > 4096) {
        throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `attributes.${key} has an invalid value`);
      }
      attributes[key] = value as string | number | boolean;
    }
    canonical["attributes"] = attributes;
  }
  for (const key of ["regions", "tags"] as const) {
    if (payload[key] !== undefined) canonical[key] = normalizeStringArray(payload[key], key);
  }
  if (payload["commercial_hints"] !== undefined) {
    const raw = payload["commercial_hints"];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "commercial_hints must be an object");
    const hints: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!COMMERCIAL_HINT_KEYS.has(key)) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `commercial_hints.${key} is unknown`);
      if (key === "moq") {
        if (!Number.isInteger(value) || (value as number) < 1) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "commercial_hints.moq must be a positive integer");
        hints[key] = value;
      } else if (key === "supports_bulk_quote" || key === "supports_customization") {
        if (typeof value !== "boolean") throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `commercial_hints.${key} must be boolean`);
        hints[key] = value;
      } else if (key === "fulfillment_regions") hints[key] = normalizeStringArray(value, `commercial_hints.${key}`);
      else hints[key] = requireText(value, `commercial_hints.${key}`);
    }
    canonical["commercial_hints"] = hints;
  }
  if (payload["handoff_destination_types"] !== undefined) {
    if (listingType !== "product") throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "capability listing cannot contain handoff_destination_types");
    const types = normalizeStringArray(payload["handoff_destination_types"], "handoff_destination_types");
    const invalid = types.filter((value) => !(DESTINATION_TYPES as readonly string[]).includes(value));
    if (invalid.length > 0) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", `unknown handoff destination type: ${invalid.join(", ")}`);
    canonical["handoff_destination_types"] = types;
  }
  if (payload["handoff_destination_ref"] !== undefined) canonical["handoff_destination_ref"] = requireText(payload["handoff_destination_ref"], "handoff_destination_ref");
  if (payload["fresh_until"] !== undefined) {
    const raw = requireText(payload["fresh_until"], "fresh_until");
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "fresh_until must include a timezone");
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "fresh_until must be ISO-8601");
    const normalizedSeconds = Math.floor(timestamp / 1000) * 1000;
    const nowSeconds = Math.floor(Date.now() / 1000) * 1000;
    const ttl = normalizedSeconds - nowSeconds;
    if (ttl <= 0 || ttl > 30 * 24 * 60 * 60 * 1000) throw new ListingEnrollmentError("LISTING_PROJECTION_INVALID", "fresh_until is expired or exceeds 30 days");
    canonical["fresh_until"] = new Date(normalizedSeconds).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }
  return canonical;
}

export class ListingEnrollmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ListingEnrollmentError";
  }
}

export interface SignedListingContext {
  agentId: string;
  merchantId: string;
  bindingId: string;
  keyId: string;
  runtimeOrigin: string;
  signingIdentity: RuntimeSigningIdentity;
}

interface StoredEnrollment {
  status: string;
  runtime_origin?: string;
  key_thumbprint?: string;
  catalog_origin?: string;
  catalog_agent_id?: string;
  merchant_id?: string;
  binding_id?: string;
}

function assertPrivateFile(file: string): void {
  const stats = lstatSync(file);
  const mode = stats.mode & 0o777;
  if (!stats.isFile() || (mode & 0o077) !== 0) {
    throw new ListingEnrollmentError("ENROLLMENT_STORAGE_PERMISSIONS", `${path.basename(file)} 权限过宽；请设置为 0600 后重试`);
  }
}

/**
 * Resolve a signed publisher only when a current, locally persisted enrollment exists.
 * An enrollment file that is pending, stale, rotated, paused or revoked blocks fallback
 * to owner credentials so the CLI cannot silently change authorization modes.
 */
export async function resolveSignedListingContext(input: {
  dataDir: string;
  profile: AgentProfile;
  catalogBaseUrl: string;
  runtimeOrigin?: string;
  client: CatalogClient;
}): Promise<SignedListingContext | null> {
  const storeFile = enrollmentStorePath(input.dataDir);
  if (!existsSync(storeFile)) return null;
  const directory = lstatSync(input.dataDir);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
    throw new ListingEnrollmentError("ENROLLMENT_STORAGE_PERMISSIONS", "Runtime dataDir 必须是权限为 0700 的普通目录，已拒绝读取接入密钥状态");
  }
  assertPrivateFile(storeFile);
  const enrollmentStore = readEnrollmentStore(input.dataDir);
  if (enrollmentStore.sessions.length === 0) return null;

  const pending = enrollmentStore.sessions.find((entry) => ["preparing", "authorized", "bound"].includes(entry.status));
  if (pending !== undefined) {
    throw new ListingEnrollmentError(
      "ENROLLMENT_NOT_PUBLISHED",
      `接入任务状态为 ${pending.status}；请先运行 kiwi merchant connect 完成授权、绑定和名片发布。不会回退到 owner token。`,
    );
  }

  const keyFile = path.join(input.dataDir, "a2a-signing-key.json");
  if (!existsSync(keyFile)) {
    throw new ListingEnrollmentError("ENROLLMENT_KEY_MISSING", "已发布接入对应的 Runtime 私钥文件不存在；请在实际 Runtime 主机重新登录并授权连接。不会使用 owner token 替代。");
  }
  assertPrivateFile(keyFile);
  let runtimeKey;
  try {
    runtimeKey = loadA2aSigningIdentityFromFile(keyFile);
  } catch (err) {
    throw new ListingEnrollmentError("ENROLLMENT_KEY_INVALID", `Runtime 持久密钥无法读取：${err instanceof Error ? err.message : String(err)}`);
  }
  const signingIdentity = { signingIdentity: toJwsSigningIdentity(runtimeKey), keyId: runtimeKey.keyid };
  const { keyThumbprint } = runtimePublicKey(signingIdentity);
  const expectedOrigin = input.runtimeOrigin ?? input.profile.merchant_public?.public_url;
  if (expectedOrigin === undefined || expectedOrigin.trim() === "") {
    throw new ListingEnrollmentError("PUBLIC_ORIGIN_REQUIRED", "已连接 Runtime 必须保留 merchant_public.public_url 或 KIWI_A2A_PUBLIC_URL；不能确认是否发生地址迁移。");
  }
  let runtimeOrigin: string;
  try {
    const parsed = new URL(expectedOrigin);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "" && parsed.pathname !== "/") {
      throw new Error("expected a bare public HTTPS origin");
    }
    runtimeOrigin = parsed.origin;
  } catch {
    throw new ListingEnrollmentError("PUBLIC_ORIGIN_INVALID", "公网 HTTPS origin 配置不合法；请重新运行 kiwi merchant connect。");
  }
  const catalogOrigin = new URL(input.catalogBaseUrl).origin;
  const matching = (enrollmentStore.sessions as unknown as StoredEnrollment[]).filter((entry) =>
    entry.status === "published" && entry.runtime_origin === runtimeOrigin &&
    entry.key_thumbprint === keyThumbprint && entry.catalog_origin === catalogOrigin &&
    typeof entry.catalog_agent_id === "string" && typeof entry.binding_id === "string",
  );
  if (matching.length !== 1) {
    throw new ListingEnrollmentError(
      "ENROLLMENT_REAUTH_REQUIRED",
      "已保存的发布接入与当前 Runtime 密钥、地址或 Catalog 不匹配；请在 Runtime 主机重新登录并授权迁移/恢复。不会自动激活旧绑定，也不会回退到 owner token。",
    );
  }
  const enrollment = matching[0]!;
  const active = await input.client.fetchPublicBinding(enrollment.catalog_agent_id!);
  if (typeof enrollment.merchant_id !== "string" || enrollment.merchant_id.trim() === "") {
    throw new ListingEnrollmentError("ENROLLMENT_CLAIM_MISSING", "Enrollment里未保存已验签binding claim的merchant_id；请重新运行kiwi merchant connect完成绑定声明校验。");
  }
  if (active === null || active.bindingId !== enrollment.binding_id || active.keyThumbprint !== keyThumbprint ||
      active.keyId !== runtimeKey.keyid || active.merchantId !== enrollment.merchant_id ||
      active.runtimeOrigin.replace(/\/+$/, "") !== runtimeOrigin ||
      !Number.isFinite(Date.parse(active.expiresAt)) || Date.parse(active.expiresAt) <= Date.now() ||
      !["ACTIVE", "active"].includes(active.publicationState)) {
    throw new ListingEnrollmentError(
      "ENROLLMENT_BINDING_NOT_ACTIVE",
      "Catalog 未确认当前接入绑定处于 ACTIVE 状态（可能暂停、撤回或密钥/地址已轮换）；请先在 Catalog 恢复或重新授权。不会自动恢复营业。",
    );
  }
  return {
    agentId: enrollment.catalog_agent_id!,
    merchantId: enrollment.merchant_id,
    bindingId: active.bindingId,
    keyId: runtimeKey.keyid,
    runtimeOrigin,
    signingIdentity,
  };
}

/** Catalog validator-equivalent canonical listing digest: canonical fields only, JCS SHA-256. */
export function signedListingDigest(listing: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalize(listing), "utf8").digest("hex")}`;
}
