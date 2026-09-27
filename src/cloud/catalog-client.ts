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
 * Runtime 侧 Catalog 控制面客户端（设计 §4.6；写路径）。
 *
 * `src/cloud/` 此前只有绑定的**声明与证明材料**（binding/proofs.ts 等），没有任何
 * 对 Catalog 的 HTTP 调用；本模块补上商家侧发布闭环的四个方法：
 *
 *   - `requestBinding()`            POST /v1/agents/{cagt}/runtime-bindings
 *   - `awaitBindingConfirmation()`  GET  /v1/agents/{cagt}/runtime-binding（匿名轮询）
 *   - `publishCard()`               POST /v1/agents/{cagt}/card-publications
 *   - `activateCard()`              POST /v1/agents/{cagt}/publish（CAS）
 *
 * 纪律（§4.6 实现约束与失败语义，逐条落实）：
 *
 * 1. **身份 = 绑定签名**：Runtime 不持有 owner token；所有写请求以
 *    `x-kiwi-binding-jws`（EdDSA compact JWS）背书，签名覆盖该端点的全部安全相关
 *    字段 + `issued_at`（服务端 300s 时钟偏差窗，kiwi-catalog
 *    `request_signature.py` 强制，缺了即 400）+ 每次请求**新生成的唯一 nonce**
 *    （重放由服务端 `control_plane_nonces` 判 409/400，客户端绝不复用 nonce）。
 * 2. **runtime_origin 只来自平台配置**：由调用方从 `KIWI_CLOUD_PUBLIC_ORIGIN`
 *    （loadCloudConfig().publicOrigin）传入；本模块不从别处推导、不猜默认值。
 * 3. **确认前不发布**：`awaitBindingConfirmation()` 走**匿名公开读**（绝不带任何
 *    凭据），逐次比对 `binding_id` / `runtime_origin` / `key_thumbprint`，三者
 *    不全符就继续等——服务端同样会拒（签名校验要求活动绑定），客户端先挡住。
 *    注意 catalog 现状：确认后、首张名片激活前，公开读返回 **403**
 *    （"agent is not publishable"，SIG-02 不签发），本模块把它与 404 区分成
 *    `BINDING_UNREADABLE`——此时绑定已存在但文档不可读，binding_id 拿不到，
 *    首发布需要 catalog 提供确认后的 binding_id 通道（见仓库汇报记录）。
 * 4. **失败语义**：目录不可达（网络/超时/5xx/429）→ `CATALOG_UNREACHABLE`，
 *    调用方标 `pending_publication` 按退避重试，**不谎报已发布**；CAS 冲突（409）
 *    → 重新匿名读公开绑定取最新 revision 后**重试一次**，仍冲突抛 `CONFLICT`
 *    停下来报人工；重复提交同一 card_digest 前先读当前 expected_revision
 *    （`fetchPublicBinding()` 信封顶层的 `card_revision`——契约
 *    `runtime-binding/0.1.2/document.schema.json` 的公开元数据，不是 claims 字段）。
 * 5. **fail-closed**：本地产物发出前用 `contracts/{runtime-binding,card-publication}/
 *    0.1.2/*.schema.json` 做结构自检；名片接口全部在自身 origin 内、至少一项等于
 *    绑定的 a2a_endpoint——**发出前**自查，不把坏卡交给服务端。
 *
 * 零新运行时依赖（裸 fetch）；出站加固与 `discovery/catalog-source/cloud-card.ts`
 * 同口径（redirect: manual、超时覆盖 body 读取、响应体上限）。
 */

import { createHash, createPublicKey, randomBytes } from "node:crypto";

import { validateCloudContract } from "../contracts/cloud-contracts.js";
import { validateAgentCard } from "../discovery/agent-card/validate.js";
import type { AgentCard } from "../discovery/agent-card/types.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../net/safe-http.js";
import { canonicalize } from "../negotiation/jcs.js";
import { PRODUCT_VERSION } from "../product-cli.js";
import { validateBindingClaims, type BindingClaims } from "../trust/binding/claims.js";
import { jwkThumbprint } from "../trust/binding/thumbprint.js";
import { signCompactJws, type JwsSigningIdentity } from "../trust/identity/jws.js";
import { verifyCompactJws } from "../trust/identity/jws.js";
import type { JsonWebKey } from "../trust/identity/jwk.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIRM_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CONFIRM_POLL_MS = 5_000;

export type CatalogClientErrorCode =
  /** 调用方输入非法（缺 runtime_origin、非 https、代次非法等）。 */
  | "INVALID_INPUT"
  /** 本地产物不符合 0.1.2 契约 schema（发出前自检）。 */
  | "SCHEMA_VIOLATION"
  /** 名片的 url / supportedInterfaces 不在自身 runtime origin 内。 */
  | "CARD_ORIGIN_VIOLATION"
  /** 名片没有任何一个接口等于绑定的 a2a_endpoint。 */
  | "CARD_ENDPOINT_NOT_BOUND"
  /** 目录不可达（网络失败/超时/5xx/429）——可重试，标 pending_publication。 */
  | "CATALOG_UNREACHABLE"
  /** 4xx（非 409/404）：请求被拒绝，重试不会变好。 */
  | "REQUEST_REJECTED"
  /** CAS 冲突（重读 + 重试一次后仍 409）——停下来报人工。 */
  | "CONFLICT"
  /** 响应体非法（非 JSON / 结构不符 / 重定向）。 */
  | "RESPONSE_INVALID"
  /**
   * 绑定存在但公开文档暂不可读（catalog 在"无活动名片/绑定过期/已撤回"时
   * 对公开读返回 403，不签发声明）。首绑确认后到首发布之间就是这个窗口。
   */
  | "BINDING_UNREADABLE"
  /** 等待门户确认超时（不是失败：商家还没在门户确认）。 */
  | "CONFIRMATION_TIMEOUT";

export class CatalogClientError extends Error {
  readonly code: CatalogClientErrorCode;
  readonly status?: number;
  readonly remoteCode?: string;

  constructor(code: CatalogClientErrorCode, message: string, status?: number, remoteCode?: string) {
    super(message);
    this.name = "CatalogClientError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (remoteCode !== undefined) this.remoteCode = remoteCode;
  }
}

/** Runtime 自持签名身份（私钥不出进程；公钥 JWK 由私钥导出，杜绝不一致）。 */
export interface RuntimeSigningIdentity {
  signingIdentity: JwsSigningIdentity;
  /** 绑定声明里的 key_id（与 JWS 头 kid 同值）。 */
  keyId: string;
}

export interface CatalogClientOptions {
  /** Catalog 控制面根 URL（https；末尾斜杠容忍并剥离）。 */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** nonce 工厂（测试注入；缺省每次随机 24 字节 base64url，绝不复用）。 */
  nonceFactory?: () => string;
  /** 签名负载 `issued_at` 的时钟（测试注入；服务端要求 300s 时钟偏差窗内）。 */
  now?: () => Date;
}

export interface DeviceEnrollmentInput {
  runtimeOrigin: string;
  a2aEndpoint: string;
  generation: number;
  serviceEpoch: number;
  publicPreview: Record<string, unknown>;
  publicProfileRevision: number;
}

export interface DeviceEnrollmentSession {
  enrollmentId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  keyThumbprint: string;
}

export type DeviceEnrollmentPoll =
  | { status: "authorization_pending" | "slow_down"; intervalSeconds: number }
  | {
      status: "authorized";
      enrollmentId: string;
      grant: string;
      catalogAgentId: string;
      merchantId: string;
      runtimeOrigin: string;
      a2aEndpoint: string;
      expiresAt: string;
      authorizationEpoch: number;
      approvedCardDigest: string;
      scopes: string[];
    };

export interface GrantBindingResult {
  bindingId: string;
  bindingVersion: number;
  keyThumbprint: string;
  activeCardRevision: number | null;
  bindingClaim: Record<string, unknown>;
}

export interface SignedListingPublicationInput {
  catalogAgentId: string;
  merchantId: string;
  bindingId: string;
  idempotencyKey: string;
  listingDigest: string;
  listing: Record<string, unknown>;
}

export interface SignedListingPublicationResult {
  listingId: string;
  idempotent: boolean;
}

export interface SignedListingContext {
  catalogAgentId: string;
  merchantId: string;
  bindingId: string;
  keyId: string;
}

export interface SignedListingPage {
  results: Array<Record<string, unknown>>;
  nextCursor?: string;
}

export interface RequestBindingInput {
  /** catalog_agent_id（cagt_…，路由段）。 */
  agentId: string;
  /** 运行时公开 origin——**只取自 KIWI_CLOUD_PUBLIC_ORIGIN**。 */
  runtimeOrigin: string;
  /** A2A 端点（必须在 runtimeOrigin 域内）。 */
  a2aEndpoint: string;
  generation: number;
  serviceEpoch: number;
  /** 可选：受控注册闸门（门户确认流程下由服务端另行处理，Runtime 默认不带）。 */
  adminToken?: string;
  /** 可选：绑定到期时间（ISO 8601）。 */
  expiresAt?: string;
}

export interface RequestBindingResult {
  /** 服务端回执里的 binding_request_id（未返回则 null）。 */
  bindingRequestId: string | null;
  keyThumbprint: string;
  /** 本次请求的 nonce（审计/对账用；下次请求必然不同）。 */
  nonce: string;
}

/** 公开读到的绑定文档中，与 Runtime 自身核对所需的字段。 */
export interface PublicBinding {
  bindingId: string;
  bindingVersion: number;
  merchantId: string;
  runtimeOrigin: string;
  a2aEndpoint: string;
  keyId: string;
  keyThumbprint: string;
  expiresAt: string;
  /** 当前活动名片 revision（CAS 的 expected_revision 来源；未发布过为 null）。 */
  cardRevision: number | null;
  cardEtag: string | null;
  publicationState: string;
}

export interface AwaitBindingInput {
  agentId: string;
  /** 只取自 KIWI_CLOUD_PUBLIC_ORIGIN；与公开文档逐字比对。 */
  runtimeOrigin: string;
  keyThumbprint: string;
  /** 已知 binding_id 时强制比对（轮换场景）；缺省接受首个匹配的绑定。 */
  bindingId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** 测试注入。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface PublishCardInput {
  agentId: string;
  bindingId: string;
  generation: number;
  /** CAS 前置条件：当前活动 revision（首发布为 0）。 */
  expectedRevision: number;
  agentCard: AgentCard;
  /** 绑定的 a2a_endpoint：名片至少一个接口必须等于它（提前自查）。 */
  a2aEndpoint: string;
  /** 只取自 KIWI_CLOUD_PUBLIC_ORIGIN；名片全部 URL 必须在它域内。 */
  runtimeOrigin: string;
  /** 409 时重读公开绑定后重试一次（缺省 true）。 */
  casRetry?: boolean;
}

export interface PublishCardResult {
  /** 服务端回执里的 revision（未返回则 null）。 */
  revision: number | null;
  cardDigest: string;
  nonce: string;
}

export interface ActivateCardInput {
  agentId: string;
  /** 发布由当前活动绑定背书（catalog 验签要求签名覆盖它）。 */
  bindingId: string;
  /** 要激活的名片 revision（publish 回执的 card_revision；顶层必填，缺了 400）。 */
  cardRevision: number;
  /** CAS：必须等于当前活动 revision。 */
  expectedRevision: number;
  /** 409 时重读公开绑定后重试一次（缺省 true）。 */
  casRetry?: boolean;
}

export interface ActivateCardResult {
  revision: number | null;
  nonce: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CatalogClientError("RESPONSE_INVALID", "catalog 响应必须是 JSON 对象");
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CatalogClientError("RESPONSE_INVALID", `catalog 响应缺少 ${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function sha256Json(value: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

function requireCatalogVerificationUri(baseUrl: string, raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw, baseUrl); } catch {
    throw new CatalogClientError("RESPONSE_INVALID", "verification_uri 不是合法 URL");
  }
  const base = new URL(baseUrl);
  if (parsed.origin !== base.origin || parsed.protocol !== base.protocol || parsed.username !== "" || parsed.password !== "") {
    throw new CatalogClientError("RESPONSE_INVALID", "verification_uri 必须属于配置的 Catalog origin");
  }
  return parsed.toString();
}

function defaultNonce(): string {
  return randomBytes(24).toString("base64url");
}

function requireHttpsUrl(value: string, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("https://")) {
    throw new CatalogClientError("INVALID_INPUT", `${field} 必须是 https URL：${trimmed}`);
  }
  try {
    new URL(trimmed);
  } catch {
    throw new CatalogClientError("INVALID_INPUT", `${field} 不是合法 URL：${trimmed}`);
  }
  return trimmed;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/** 规范化 origin（去掉末尾斜杠，逐字比对前的统一口径）。 */
export function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, "");
}

export class CatalogClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly nonceFactory: () => string;
  private readonly now: () => Date;

  constructor(options: CatalogClientOptions) {
    const trimmed = String(options.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://127.0.0.1") && !trimmed.startsWith("http://localhost")) {
      throw new CatalogClientError(
        "INVALID_INPUT",
        `catalog baseUrl 必须是 https（本地联调仅放行 loopback）：${trimmed}`,
      );
    }
    this.baseUrl = trimmed;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nonceFactory = options.nonceFactory ?? defaultNonce;
    this.now = options.now ?? (() => new Date());
  }

  /** Catalog origin is pinned by constructor configuration and remains the only control-plane trust anchor. */
  get catalogOrigin(): string {
    return new URL(this.baseUrl).origin;
  }

  /** 创建独立 Runtime 设备授权会话；仅绑定本机持久密钥和锁定的公开预览。 */
  async createDeviceEnrollment(
    input: DeviceEnrollmentInput,
    identity: RuntimeSigningIdentity,
  ): Promise<DeviceEnrollmentSession> {
    const origin = normalizeOrigin(requireHttpsUrl(input.runtimeOrigin, "runtime_origin"));
    const endpoint = requireHttpsUrl(input.a2aEndpoint, "a2a_endpoint");
    if (originOf(origin) !== originOf(endpoint)) {
      throw new CatalogClientError("INVALID_INPUT", "a2a_endpoint 必须与 runtime_origin 同源");
    }
    const { keyJwk, keyThumbprint } = runtimePublicKey(identity);
    const body = {
      binding: {
        runtime_origin: origin,
        a2a_endpoint: endpoint,
        key_jwk: { kty: keyJwk.kty, crv: keyJwk.crv, x: keyJwk.x },
        key_id: identity.keyId,
        generation: input.generation,
        service_epoch: input.serviceEpoch,
      },
      public_preview: input.publicPreview,
      public_profile_revision: input.publicProfileRevision,
    };
    const nonce = this.nonceFactory();
    const issuedAt = this.now();
    const signed = {
      method: "POST",
      path: "/v1/enrollments/device",
      audience: "kiwi-catalog",
      body_digest: sha256Json(body),
      key_id: identity.keyId,
      key_thumbprint: keyThumbprint,
      generation: input.generation,
      service_epoch: input.serviceEpoch,
      issued_at: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + 30_000).toISOString(),
      nonce,
    };
    const { json } = await this.request("POST", "/v1/enrollments/device", {
      body,
      jws: signCompactJws(signed, identity.signingIdentity, { extraHeader: { typ: "kiwi-runtime-request" } }),
    });
    const result = recordOrEmpty(json);
    const session: DeviceEnrollmentSession = {
      enrollmentId: requiredString(result["enrollment_id"], "enrollment_id"),
      deviceCode: requiredString(result["device_code"], "device_code"),
      userCode: requiredString(result["user_code"], "user_code"),
      verificationUri: requireCatalogVerificationUri(this.baseUrl, requiredString(result["verification_uri"], "verification_uri")),
      expiresAt: requiredString(result["expires_at"], "expires_at"),
      intervalSeconds: positiveInteger(result["interval"], 5),
      keyThumbprint,
    };
    return session;
  }

  /** 以匹配设备私钥轮询；user_code 不是取回 grant 的凭据。 */
  async pollDeviceEnrollment(
    deviceCode: string,
    identity: RuntimeSigningIdentity,
  ): Promise<DeviceEnrollmentPoll> {
    if (deviceCode.length < 32) throw new CatalogClientError("INVALID_INPUT", "device_code 形状非法");
    const { keyThumbprint } = runtimePublicKey(identity);
    const nonce = this.nonceFactory();
    const issuedAt = this.now();
    const signed = {
      method: "POST",
      path: "/v1/enrollments/device/token",
      audience: "kiwi-catalog",
      device_code_hash: createHash("sha256").update(deviceCode).digest("hex"),
      key_id: identity.keyId,
      key_thumbprint: keyThumbprint,
      issued_at: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + 30_000).toISOString(),
      nonce,
    };
    const { json } = await this.request("POST", "/v1/enrollments/device/token", {
      body: { device_code: deviceCode },
      jws: signCompactJws(signed, identity.signingIdentity, { extraHeader: { typ: "kiwi-runtime-request" } }),
    });
    const result = recordOrEmpty(json);
    const state = result["status"] ?? result["error"];
    if (state === "authorization_pending" || state === "pending") {
      return { status: "authorization_pending", intervalSeconds: positiveInteger(result["interval"], 5) };
    }
    if (state === "slow_down") {
      return { status: "slow_down", intervalSeconds: positiveInteger(result["interval"], 10) };
    }
    if (state !== "authorized" && typeof result["grant"] !== "string") {
      throw new CatalogClientError("RESPONSE_INVALID", "设备轮询响应既非等待状态也非授权结果");
    }
    return {
      status: "authorized",
      enrollmentId: requiredString(result["enrollment_id"], "enrollment_id"),
      grant: requiredString(result["grant"], "grant"),
      catalogAgentId: requiredString(result["catalog_agent_id"], "catalog_agent_id"),
      merchantId: requiredString(result["merchant_id"], "merchant_id"),
      runtimeOrigin: normalizeOrigin(requireHttpsUrl(requiredString(result["runtime_origin"], "runtime_origin"), "runtime_origin")),
      a2aEndpoint: requireHttpsUrl(requiredString(result["a2a_endpoint"], "a2a_endpoint"), "a2a_endpoint"),
      expiresAt: requiredString(result["expires_at"], "expires_at"),
      authorizationEpoch: positiveInteger(result["authorization_epoch"], 0),
      approvedCardDigest: requiredString(result["approved_card_digest"], "approved_card_digest"),
      scopes: Array.isArray(result["scopes"]) ? result["scopes"].filter((v): v is string => typeof v === "string") : [],
    };
  }

  /** 一次性许可换取活动绑定；Catalog 的挑战和签发结果是绑定权威。 */
  async bindEnrollment(input: {
    enrollmentId: string;
    grant: string;
    catalogAgentId: string;
    runtimeOrigin: string;
    a2aEndpoint: string;
    generation: number;
    serviceEpoch: number;
    authorizationEpoch: number;
    merchantId: string;
  }, identity: RuntimeSigningIdentity): Promise<GrantBindingResult> {
    const origin = normalizeOrigin(requireHttpsUrl(input.runtimeOrigin, "runtime_origin"));
    const endpoint = requireHttpsUrl(input.a2aEndpoint, "a2a_endpoint");
    const { keyJwk, keyThumbprint } = runtimePublicKey(identity);
    const body = {
      enrollment_id: input.enrollmentId,
      grant: input.grant,
      binding: {
        runtime_origin: origin,
        a2a_endpoint: endpoint,
        key_jwk: { kty: keyJwk.kty, crv: keyJwk.crv, x: keyJwk.x },
        key_id: identity.keyId,
        generation: input.generation,
        service_epoch: input.serviceEpoch,
      },
    };
    const nonce = this.nonceFactory();
    const issuedAt = this.now();
    const signed = {
      method: "POST",
      path: `/v1/agents/${encodeURIComponent(input.catalogAgentId)}/runtime-bindings`,
      audience: "kiwi-catalog",
      body_digest: sha256Json(body),
      enrollment_id: input.enrollmentId,
      grant_hash: createHash("sha256").update(input.grant).digest("hex"),
      catalog_agent_id: input.catalogAgentId,
      key_id: identity.keyId,
      key_thumbprint: keyThumbprint,
      runtime_origin: origin,
      a2a_endpoint: endpoint,
      generation: input.generation,
      service_epoch: input.serviceEpoch,
      authorization_epoch: input.authorizationEpoch,
      issued_at: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + 30_000).toISOString(),
      nonce,
    };
    const { json } = await this.request("POST", `/v1/agents/${encodeURIComponent(input.catalogAgentId)}/runtime-bindings`, {
      body,
      jws: signCompactJws(signed, identity.signingIdentity, { extraHeader: { typ: "kiwi-runtime-request" } }),
    });
    const result = recordOrEmpty(json);
    const claim = result["binding_claim"];
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
      throw new CatalogClientError("RESPONSE_INVALID", "绑定回执缺少 Catalog 签发的 binding_claim");
    }
    const checkedClaim = await this.verifyCatalogBindingClaim(claim as Record<string, unknown>, {
      bindingId: requiredString(result["binding_id"], "binding_id"),
      bindingVersion: positiveInteger(result["binding_version"], 0),
      keyThumbprint,
      runtimeOrigin: origin,
      a2aEndpoint: endpoint,
      catalogAgentId: input.catalogAgentId,
      merchantId: input.merchantId,
      keyId: identity.keyId,
      serviceEpoch: input.serviceEpoch,
    });
    return {
      bindingId: checkedClaim.binding_id,
      bindingVersion: checkedClaim.binding_version,
      keyThumbprint: requiredString(result["key_thumbprint"], "key_thumbprint"),
      activeCardRevision: typeof (claim as Record<string, unknown>)["card_revision"] === "number"
        && Number.isInteger((claim as Record<string, unknown>)["card_revision"])
        ? (claim as Record<string, unknown>)["card_revision"] as number
        : null,
      bindingClaim: claim as Record<string, unknown>,
    };
  }

  /** Catalog origin 固定来自部署配置；JWKS仅经其标准HTTPS/TLS读取后用于验声明。 */
  /** Publish one already-approved public listing with the active Runtime binding key. */
  async publishSignedListing(
    input: SignedListingPublicationInput,
    identity: RuntimeSigningIdentity,
  ): Promise<SignedListingPublicationResult> {
    const agentId = this.requireAgentId(input.catalogAgentId);
    if (input.listing["owner_agent_id"] !== agentId || input.listing["merchant_id"] !== input.merchantId) {
      throw new CatalogClientError("INVALID_INPUT", "signed listing body identity does not match its route/claims");
    }
    if (typeof input.bindingId !== "string" || input.bindingId.trim() === "") {
      throw new CatalogClientError("INVALID_INPUT", "binding_id must be non-empty");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.listingDigest)) {
      throw new CatalogClientError("INVALID_INPUT", "listing_digest must be sha256:<64 lowercase hex>");
    }
    if (input.idempotencyKey.trim() === "" || input.idempotencyKey.length > 160) {
      throw new CatalogClientError("INVALID_INPUT", "Idempotency-Key must contain 1 to 160 characters");
    }
    const issuedAt = this.now();
    const jws = signCompactJws({
      method: "POST",
      path: "/v1/listings/publish",
      audience: "kiwi-catalog",
      agent_id: agentId,
      merchant_id: input.merchantId,
      binding_id: input.bindingId,
      key_id: identity.keyId,
      listing_digest: input.listingDigest,
      idempotency_key: input.idempotencyKey,
      issued_at: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + 90_000).toISOString(),
      nonce: this.nonceFactory(),
    }, identity.signingIdentity, { extraHeader: { typ: "kiwi-runtime-request" } });
    const { json } = await this.request("POST", "/v1/listings/publish", {
      body: input.listing,
      jws,
      headers: { "Idempotency-Key": input.idempotencyKey },
    });
    const receipt = recordOrEmpty(json);
    const listing = recordOrEmpty(receipt["listing"]);
    if (receipt["ok"] !== true || typeof listing["listing_id"] !== "string" || listing["listing_id"] === "") {
      throw new CatalogClientError("RESPONSE_INVALID", "Catalog signed listing publish response lacks a listing receipt");
    }
    return { listingId: listing["listing_id"], idempotent: receipt["idempotent"] === true };
  }

  /** Owner-token-free self-list, authenticated by the current binding JWS. */
  async listSignedListings(
    context: SignedListingContext,
    identity: RuntimeSigningIdentity,
    input: { limit: number; cursor?: string; freshnessState?: string },
  ): Promise<SignedListingPage> {
    const agentId = this.requireAgentId(context.catalogAgentId);
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 20;
    const cursor = input.cursor?.trim() ?? "";
    const freshnessState = input.freshnessState?.trim() ?? "";
    const queryDigest = sha256Json({ limit, cursor, freshness_state: freshnessState });
    const path = `/v1/agents/${encodeURIComponent(agentId)}/listings`;
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== "") query.set("cursor", cursor);
    if (freshnessState !== "") query.set("freshness_state", freshnessState);
    const issuedAt = this.now();
    const jws = signCompactJws({
      method: "GET",
      path,
      audience: "kiwi-catalog",
      agent_id: agentId,
      merchant_id: context.merchantId,
      binding_id: context.bindingId,
      key_id: context.keyId,
      query_digest: queryDigest,
      issued_at: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + 90_000).toISOString(),
      nonce: this.nonceFactory(),
    }, identity.signingIdentity, { extraHeader: { typ: "kiwi-runtime-request" } });
    const { json } = await this.request("GET", `${path}?${query.toString()}`, { jws });
    const response = recordOrEmpty(json);
    if (response["ok"] !== true || !Array.isArray(response["results"])) {
      throw new CatalogClientError("RESPONSE_INVALID", "Catalog signed self-list response lacks results");
    }
    const results = response["results"].filter(isRecord);
    if (results.some((item) => item["owner_agent_id"] !== agentId || item["merchant_id"] !== context.merchantId)) {
      throw new CatalogClientError("RESPONSE_INVALID", "Catalog signed self-list returned a listing outside the current enrollment identity");
    }
    return {
      results,
      ...(typeof response["next_cursor"] === "string" && response["next_cursor"] !== "" ? { nextCursor: response["next_cursor"] } : {}),
    };
  }

  /** Withdraw one disappeared product projection with the current binding. */
  async withdrawSignedListing(
    context: SignedListingContext,
    identity: RuntimeSigningIdentity,
    input: { listingId: string; idempotencyKey: string },
  ): Promise<void> {
    const listingId = String(input.listingId ?? "").trim();
    if (listingId === "" || listingId.includes("/") || listingId.includes("..")) {
      throw new CatalogClientError("INVALID_INPUT", "listing_id is invalid");
    }
    if (input.idempotencyKey.trim() === "" || input.idempotencyKey.length > 160) {
      throw new CatalogClientError("INVALID_INPUT", "Idempotency-Key must contain 1 to 160 characters");
    }
    const path = `/v1/listings/${encodeURIComponent(listingId)}/withdraw`;
    const body = {};
    const issuedAt = this.now();
    const jws = signCompactJws({
      method: "POST",
      path,
      audience: "kiwi-catalog",
      agent_id: context.catalogAgentId,
      merchant_id: context.merchantId,
      binding_id: context.bindingId,
      key_id: context.keyId,
      listing_id: listingId,
      idempotency_key: input.idempotencyKey,
      body_digest: sha256Json(body),
      issued_at: issuedAt.toISOString(),
      exp: new Date(issuedAt.getTime() + 90_000).toISOString(),
      nonce: this.nonceFactory(),
    }, identity.signingIdentity, { extraHeader: { typ: "kiwi-runtime-request" } });
    const { json } = await this.request("POST", path, {
      body,
      jws,
      headers: { "Idempotency-Key": input.idempotencyKey },
    });
    const response = recordOrEmpty(json);
    if (response["ok"] !== true) throw new CatalogClientError("RESPONSE_INVALID", "Catalog signed withdraw response is not ok");
  }

  private async verifyCatalogBindingClaim(
    envelope: Record<string, unknown>,
    expected: {
      bindingId: string;
      bindingVersion: number;
      keyThumbprint: string;
      runtimeOrigin: string;
      a2aEndpoint: string;
      catalogAgentId: string;
      merchantId: string;
      keyId: string;
      serviceEpoch: number;
    },
  ): Promise<BindingClaims> {
    const claimsJws = requiredString(envelope["claims_jws"], "binding_claim.claims_jws");
    const issuerKid = requiredString(envelope["issuer_kid"], "binding_claim.issuer_kid");
    const issuerThumbprint = requiredString(envelope["issuer_thumbprint"], "binding_claim.issuer_thumbprint");
    const keysResponse = recordOrEmpty((await this.request("GET", "/v1/issuer-keys", {})).json);
    if (!Array.isArray(keysResponse["keys"])) throw new CatalogClientError("RESPONSE_INVALID", "Catalog issuer-keys 响应缺 keys 数组");
    const key = keysResponse["keys"].find((candidate) => isRecord(candidate) && candidate["kid"] === issuerKid);
    if (!isRecord(key) || (key["state"] !== "ACTIVE" && key["state"] !== "VERIFY_ONLY") || !isRecord(key["jwk"])) {
      throw new CatalogClientError("RESPONSE_INVALID", `Catalog issuer-keys 未提供可信的活动发行密钥 ${issuerKid}`);
    }
    if (typeof key["thumbprint"] !== "string" || key["thumbprint"] !== issuerThumbprint || jwkThumbprint(key["jwk"] as JsonWebKey) !== key["thumbprint"]) {
      throw new CatalogClientError("RESPONSE_INVALID", "Catalog issuer JWK thumbprint 不匹配");
    }
    let verified: ReturnType<typeof verifyCompactJws>;
    try { verified = verifyCompactJws(claimsJws, key["jwk"] as JsonWebKey); }
    catch (err) { throw new CatalogClientError("RESPONSE_INVALID", `Catalog binding 声明验签失败：${err instanceof Error ? err.message : String(err)}`); }
    if (verified.keyid !== issuerKid) throw new CatalogClientError("RESPONSE_INVALID", "Catalog binding JWS protected kid 与 issuer-keys 不一致");
    let parsed: unknown;
    try { parsed = JSON.parse(verified.payload.toString("utf8")); }
    catch { throw new CatalogClientError("RESPONSE_INVALID", "Catalog binding claims 不是合法 JSON"); }
    const validated = validateBindingClaims(parsed);
    if (!validated.ok) throw new CatalogClientError("RESPONSE_INVALID", `Catalog binding claims 非法：${validated.errors.join("；")}`);
    const claims = validated.claims;
    const currentTime = this.now().getTime();
    const mismatches: string[] = [];
    if (keysResponse["issuer"] !== claims.issuer) mismatches.push("issuer");
    if (claims.merchant_id !== expected.merchantId) mismatches.push("merchant_id");
    if (claims.binding_id !== expected.bindingId) mismatches.push("binding_id");
    if (claims.binding_version !== expected.bindingVersion) mismatches.push("binding_version");
    if (claims.key_thumbprint !== expected.keyThumbprint) mismatches.push("key_thumbprint");
    if (normalizeOrigin(claims.runtime_origin) !== expected.runtimeOrigin) mismatches.push("runtime_origin");
    if (claims.a2a_endpoint !== expected.a2aEndpoint) mismatches.push("a2a_endpoint");
    if (claims.agent_id !== expected.catalogAgentId) mismatches.push("agent_id");
    if (claims.key_id !== expected.keyId) mismatches.push("key_id");
    if (claims.service_epoch !== expected.serviceEpoch) mismatches.push("service_epoch");
    if (claims.status !== "active") mismatches.push("status");
    if (claims.card_url !== `${this.baseUrl}/v1/agents/${encodeURIComponent(expected.catalogAgentId)}/agent-card.json`) mismatches.push("card_url");
    if (!Number.isFinite(Date.parse(claims.issued_at)) || Date.parse(claims.issued_at) > currentTime + 60_000) mismatches.push("issued_at");
    if (!Number.isFinite(Date.parse(claims.expires_at)) || Date.parse(claims.expires_at) <= currentTime) mismatches.push("expires_at");
    if (mismatches.length > 0) {
      throw new CatalogClientError("RESPONSE_INVALID", `Catalog 已签名绑定声明与本次 Runtime 请求不一致（${mismatches.join(", ")}）`);
    }
    return claims;
  }

  // ── 公开读（匿名，绝不带任何凭据）────────────────────────────────────

  /**
   * 匿名读公开绑定文档。404（未确认/不存在）返回 null；其它失败抛类型化错误。
   *
   * 这是**公开读**：名片与绑定是"任何人都能核验"的公开事实，一旦需要凭据，
   * 验证就退化成"相信持有凭据的那个人"（与 cloud-card.ts 同一纪律）。
   *
   * catalog 现状（kiwi-catalog `binding_claims.py::read_runtime_binding`）：
   * 绑定已确认但**没有活动名片**时（首绑确认后 → 首发布之间的窗口），公开读
   * 返回 403 而不是文档——此时抛 `BINDING_UNREADABLE`，调用方据此区分
   * "还没确认"（404 → null）与"已确认但文档暂不可读"（403）。
   */
  async fetchPublicBinding(agentId: string): Promise<PublicBinding | null> {
    const id = this.requireAgentId(agentId);
    try {
      const { status, json } = await this.request("GET", `/v1/agents/${encodeURIComponent(id)}/runtime-binding`, {});
      if (status === 404) return null;
      return parsePublicBinding(json);
    } catch (err) {
      if (err instanceof CatalogClientError && err.code === "REQUEST_REJECTED" && err.status === 403) {
        throw new CatalogClientError(
          "BINDING_UNREADABLE",
          `绑定文档暂不可读（403）：Catalog 可能处于未发布、暂停、过期或撤回状态（agent=${id}）`,
          403,
        );
      }
      throw err;
    }
  }

  // ── S3：发起绑定请求（签名头覆盖七个字段 + 唯一 nonce）────────────────

  async requestBinding(
    input: RequestBindingInput,
    identity: RuntimeSigningIdentity,
  ): Promise<RequestBindingResult> {
    const agentId = this.requireAgentId(input.agentId);
    const runtimeOrigin = normalizeOrigin(requireHttpsUrl(input.runtimeOrigin, "runtime_origin"));
    const a2aEndpoint = requireHttpsUrl(input.a2aEndpoint, "a2a_endpoint");
    if (originOf(a2aEndpoint) !== originOf(runtimeOrigin)) {
      throw new CatalogClientError(
        "INVALID_INPUT",
        `a2a_endpoint（${a2aEndpoint}）必须在 runtime_origin（${runtimeOrigin}）域内`,
      );
    }
    if (!Number.isInteger(input.generation) || input.generation < 0) {
      throw new CatalogClientError("INVALID_INPUT", `generation 必须是非负整数：${input.generation}`);
    }
    if (!Number.isInteger(input.serviceEpoch) || input.serviceEpoch < 1) {
      throw new CatalogClientError("INVALID_INPUT", `service_epoch 必须是正整数：${input.serviceEpoch}`);
    }
    const { keyJwk, keyThumbprint } = runtimePublicKey(identity);
    const nonce = this.nonceFactory();

    // 签名头覆盖设计钉死的七个字段 + issued_at（服务端 300s 时钟窗强制）+ 唯一 nonce。
    const jws = signCompactJws(
      {
        agent_id: agentId,
        key_id: identity.keyId,
        key_thumbprint: keyThumbprint,
        runtime_origin: runtimeOrigin,
        a2a_endpoint: a2aEndpoint,
        generation: input.generation,
        service_epoch: input.serviceEpoch,
        issued_at: this.now().toISOString(),
        nonce,
      },
      identity.signingIdentity,
      { extraHeader: { typ: "kiwi-runtime-request" } },
    );

    const binding: Record<string, unknown> = {
      runtime_origin: runtimeOrigin,
      a2a_endpoint: a2aEndpoint,
      key_jwk: { kty: keyJwk.kty, crv: keyJwk.crv, x: keyJwk.x },
      key_id: identity.keyId,
      generation: input.generation,
      service_epoch: input.serviceEpoch,
    };
    if (input.expiresAt !== undefined) binding["expires_at"] = input.expiresAt;
    const body: Record<string, unknown> = { binding };
    if (input.adminToken !== undefined && input.adminToken !== "") {
      body["admin_token"] = input.adminToken;
    }
    assertContract("runtime-binding-request", body);

    const { json } = await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/runtime-bindings`,
      { body, jws },
    );
    const receipt = isRecord(json) ? json : {};
    const requestId = receipt["binding_request_id"] ?? receipt["request_id"] ?? receipt["binding_id"];
    return {
      bindingRequestId: typeof requestId === "string" && requestId !== "" ? requestId : null,
      keyThumbprint,
      nonce,
    };
  }

  // ── S3：等待商家在门户确认（匿名轮询；未确认绝不放行发布）─────────────

  /**
   * 轮询公开读地址，直到出现与本实例**逐字匹配**的绑定（runtime_origin +
   * key_thumbprint，给了 binding_id 还要逐字匹配 binding_id）。
   *
   * 超时不是失败：商家可能还没看到门户上的待确认卡片。抛 `CONFIRMATION_TIMEOUT`，
   * 由调用方提示商家到门户「我的名片」页确认后再继续（断点续办）。
   */
  async awaitBindingConfirmation(input: AwaitBindingInput): Promise<PublicBinding> {
    const agentId = this.requireAgentId(input.agentId);
    const runtimeOrigin = normalizeOrigin(requireHttpsUrl(input.runtimeOrigin, "runtime_origin"));
    const timeoutMs = input.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const pollMs = input.pollIntervalMs ?? DEFAULT_CONFIRM_POLL_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new CatalogClientError("INVALID_INPUT", `timeoutMs 必须是正数：${timeoutMs}`);
    }
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new CatalogClientError("INVALID_INPUT", `pollIntervalMs 必须是正数：${pollMs}`);
    }
    const now = input.now ?? (() => new Date());
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now().getTime() + timeoutMs;

    let observed: string | null = null;
    for (;;) {
      let binding: PublicBinding | null;
      try {
        binding = await this.fetchPublicBinding(agentId);
      } catch (err) {
        // 403（BINDING_UNREADABLE）：绑定可能已确认但首张名片未激活——继续等，
        // 但记入观测信息（超时时如实带上）。其它错误（不可达/拒绝）原样抛出。
        if (err instanceof CatalogClientError && err.code === "BINDING_UNREADABLE") {
          observed = "公开读 403：绑定已存在但文档暂不可读（首绑确认后、首发布前的窗口）";
          binding = null;
        } else {
          throw err;
        }
      }
      if (binding !== null) {
        if (
          normalizeOrigin(binding.runtimeOrigin) === runtimeOrigin &&
          binding.keyThumbprint === input.keyThumbprint &&
          (input.bindingId === undefined || binding.bindingId === input.bindingId)
        ) {
          return binding;
        }
        observed = `binding_id=${binding.bindingId} origin=${binding.runtimeOrigin} thumbprint=${binding.keyThumbprint}`;
      }
      if (now().getTime() >= deadline) {
        throw new CatalogClientError(
          "CONFIRMATION_TIMEOUT",
          observed === null
            ? `等待门户确认超时（${timeoutMs}ms）：公开读地址上还没有本实例的绑定`
            : `等待门户确认超时（${timeoutMs}ms）：${observed}`,
        );
      }
      await sleep(pollMs);
    }
  }

  // ── S4：构造并发布名片（不可变 revision；发出前自查 origin 与端点）─────

  async publishCard(
    input: PublishCardInput,
    identity: RuntimeSigningIdentity,
  ): Promise<PublishCardResult> {
    const agentId = this.requireAgentId(input.agentId);
    const runtimeOrigin = normalizeOrigin(requireHttpsUrl(input.runtimeOrigin, "runtime_origin"));
    const a2aEndpoint = requireHttpsUrl(input.a2aEndpoint, "a2a_endpoint");
    if (typeof input.bindingId !== "string" || input.bindingId.trim() === "") {
      throw new CatalogClientError("INVALID_INPUT", "binding_id 必须是非空字符串（发布由活动绑定背书）");
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new CatalogClientError(
        "INVALID_INPUT",
        `expected_revision 必须是非负整数：${input.expectedRevision}`,
      );
    }

    // 提前自查（服务端也会拦，但坏卡不该出门）：结构 + secret 扫描。
    let card: AgentCard;
    try {
      card = validateAgentCard(input.agentCard);
    } catch (err) {
      throw new CatalogClientError(
        "SCHEMA_VIOLATION",
        `agent_card 未通过结构校验：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    assertCardWithinOrigin(card, runtimeOrigin, a2aEndpoint);

    // card_digest 由发布方计算（JCS 规范化后 sha256）；Catalog 只存不算。
    const cardDigest = `sha256:${createHash("sha256").update(canonicalize(card), "utf8").digest("hex")}`;

    const attempt = async (expectedRevision: number): Promise<{ json: unknown; nonce: string }> => {
      const nonce = this.nonceFactory();
      const jws = signCompactJws(
        {
          agent_id: agentId,
          binding_id: input.bindingId,
          generation: input.generation,
          expected_revision: expectedRevision,
          card_digest: cardDigest,
          issued_at: this.now().toISOString(),
          nonce,
        },
        identity.signingIdentity,
        { extraHeader: { typ: "kiwi-runtime-request" } },
      );
      const body = {
        publication: {
          schema_version: "0.1.2",
          agent_id: agentId,
          binding_id: input.bindingId,
          generation: input.generation,
          expected_revision: expectedRevision,
          wire_profile: "a2a-1.0",
          card_digest: cardDigest,
          agent_card: card,
        },
      };
      assertContract("card-publication-request", body);
      const { json } = await this.request(
        "POST",
        `/v1/agents/${encodeURIComponent(agentId)}/card-publications`,
        { body, jws },
      );
      return { json, nonce };
    };

    const outcome = await this.withCasRetry(agentId, input.expectedRevision, attempt, input.casRetry);
    const receipt = isRecord(outcome.json) ? outcome.json : {};
    const revision = receipt["revision"] ?? receipt["card_revision"];
    return {
      revision: typeof revision === "number" && Number.isInteger(revision) ? revision : null,
      cardDigest,
      nonce: outcome.nonce,
    };
  }

  // ── S4：CAS 激活（body 平铺：card_revision + expected_revision + binding_id）──

  /**
   * 激活指定名片 revision（kiwi-catalog `activate_card_publication` 的实际契约）：
   * body 是**平铺**的 `{agent_id, binding_id, card_revision, expected_revision}`
   * （`card_revision`/`expected_revision` 都是顶层必填整数，缺 card_revision 直接 400）；
   * JWS 覆盖 `agent_id/binding_id/card_revision/expected_revision` + `issued_at` + nonce。
   */
  async activateCard(
    input: ActivateCardInput,
    identity: RuntimeSigningIdentity,
  ): Promise<ActivateCardResult> {
    const agentId = this.requireAgentId(input.agentId);
    if (typeof input.bindingId !== "string" || input.bindingId.trim() === "") {
      throw new CatalogClientError("INVALID_INPUT", "binding_id 必须是非空字符串（激活由活动绑定背书）");
    }
    if (!Number.isInteger(input.cardRevision) || input.cardRevision < 1) {
      throw new CatalogClientError(
        "INVALID_INPUT",
        `card_revision 必须是正整数（要激活的版本号）：${input.cardRevision}`,
      );
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new CatalogClientError(
        "INVALID_INPUT",
        `expected_revision 必须是非负整数：${input.expectedRevision}`,
      );
    }

    const attempt = async (expectedRevision: number): Promise<{ json: unknown; nonce: string }> => {
      const nonce = this.nonceFactory();
      const jws = signCompactJws(
        {
          agent_id: agentId,
          binding_id: input.bindingId,
          card_revision: input.cardRevision,
          expected_revision: expectedRevision,
          issued_at: this.now().toISOString(),
          nonce,
        },
        identity.signingIdentity,
        { extraHeader: { typ: "kiwi-runtime-request" } },
      );
      const { json } = await this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/publish`, {
        body: {
          agent_id: agentId,
          binding_id: input.bindingId,
          card_revision: input.cardRevision,
          expected_revision: expectedRevision,
        },
        jws,
      });
      return { json, nonce };
    };

    const outcome = await this.withCasRetry(agentId, input.expectedRevision, attempt, input.casRetry);
    const receipt = isRecord(outcome.json) ? outcome.json : {};
    // catalog `activate_card` 回执是 {active_revision, etag}；兼容 revision/card_revision 命名。
    const revision = receipt["active_revision"] ?? receipt["revision"] ?? receipt["card_revision"];
    return {
      revision: typeof revision === "number" && Number.isInteger(revision) ? revision : null,
      nonce: outcome.nonce,
    };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  /**
   * CAS 冲突处理（§4.6）：409 → 匿名重读公开绑定文档信封的 `card_revision`
   * （契约 `document.schema.json` 的公开元数据，= catalog `card_publications.
   * active_revision`；不在 claims 里）→ 用**新 nonce** 重试一次；仍冲突抛
   * CONFLICT 停下来报人工。重读到的 revision 与手头相同说明冲突不是"版本旧了"，
   * 重试无意义，直接报人工。文档不可读（BINDING_UNREADABLE，首发布前窗口）时
   * 无从取新版本，同样直接报人工。
   */
  private async withCasRetry<T extends { json: unknown; nonce: string }>(
    agentId: string,
    expectedRevision: number,
    attempt: (expectedRevision: number) => Promise<T>,
    casRetry: boolean | undefined,
  ): Promise<T> {
    try {
      return await attempt(expectedRevision);
    } catch (err) {
      if (!(err instanceof CatalogClientError) || err.code !== "CONFLICT" || casRetry === false) {
        throw err;
      }
    }
    let current: PublicBinding | null;
    try {
      current = await this.fetchPublicBinding(agentId);
    } catch (err) {
      if (err instanceof CatalogClientError && err.code === "BINDING_UNREADABLE") {
        throw new CatalogClientError(
          "CONFLICT",
          "CAS 冲突且公开绑定文档暂不可读（403 窗口），无法重读最新 revision——停下来报人工核对",
          409,
        );
      }
      throw err;
    }
    const fresh = current?.cardRevision ?? 0;
    if (fresh === expectedRevision) {
      throw new CatalogClientError(
        "CONFLICT",
        `CAS 冲突：expected_revision=${expectedRevision} 与目录当前活动版本一致但仍被拒，停下来报人工核对`,
        409,
      );
    }
    try {
      return await attempt(fresh);
    } catch (err) {
      if (err instanceof CatalogClientError && err.code === "CONFLICT") {
        throw new CatalogClientError(
          "CONFLICT",
          `CAS 冲突：重读（revision=${fresh}）后重试一次仍 409，停下来报人工核对`,
          409,
        );
      }
      throw err;
    }
  }

  private requireAgentId(agentId: string): string {
    const trimmed = String(agentId ?? "").trim();
    if (trimmed === "") {
      throw new CatalogClientError("INVALID_INPUT", "agentId 必须是非空字符串");
    }
    if (trimmed.includes("/") || trimmed.includes("..")) {
      throw new CatalogClientError("INVALID_INPUT", `agentId 含非法字符：${trimmed}`);
    }
    return trimmed;
  }

  /**
   * 统一出站：redirect: manual、超时覆盖 body 读取、响应体上限（与
   * cloud-card.ts 同口径）。错误映射：网络/超时/5xx/429 → CATALOG_UNREACHABLE；
   * 409 → CONFLICT；404 原样上报（匿名读用）；其余 4xx → REQUEST_REJECTED。
   */
  private async request(
    method: "GET" | "POST",
    requestPath: string,
    options: { body?: Record<string, unknown>; jws?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; json: unknown }> {
    const url = `${this.baseUrl}${requestPath}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `kiwi-runtime/${PRODUCT_VERSION}`,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.jws !== undefined) headers["x-kiwi-binding-jws"] = options.jws;
    Object.assign(headers, options.headers ?? {});

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const detail = err instanceof Error ? err.message : String(err);
        throw new CatalogClientError(
          "CATALOG_UNREACHABLE",
          name === "AbortError"
            ? `catalog 请求超时（${this.timeoutMs}ms）：${url}`
            : `catalog 不可达：${url}（${detail}）`,
        );
      }
      if (isRedirectResponse(response)) {
        throw new CatalogClientError(
          "RESPONSE_INVALID",
          `catalog 控制面不得重定向（HTTP ${response.status} from ${url}）`,
          response.status,
        );
      }
      if (response.status === 404) {
        return { status: 404, json: undefined };
      }
      if (response.status === 409) {
        throw new CatalogClientError("CONFLICT", `catalog 拒绝（409 冲突）：${method} ${url}`, 409);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new CatalogClientError(
          "CATALOG_UNREACHABLE",
          `catalog 暂不可用（HTTP ${response.status}）：${method} ${url}`,
          response.status,
        );
      }
      if (!response.ok) {
        let remoteCode: string | undefined;
        try {
          const errorPayload = await readJsonBody(response, { signal: controller.signal, maxBytes: 16 * 1024 });
          if (isRecord(errorPayload)) {
            const rawCode = errorPayload["error"] ?? errorPayload["code"];
            if (typeof rawCode === "string") {
              const match = /^([A-Z][A-Z0-9_]{1,79})(?::|$)/.exec(rawCode);
              if (match) remoteCode = match[1];
            }
          }
        } catch {
          // Error bodies are advisory; the HTTP status remains authoritative.
        }
        throw new CatalogClientError(
          "REQUEST_REJECTED",
          `catalog 拒绝（HTTP ${response.status}${remoteCode ? ` ${remoteCode}` : ""}）：${method} ${url}`,
          response.status,
          remoteCode,
        );
      }
      let json: unknown;
      try {
        json = await readJsonBody(response, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new CatalogClientError(
            "CATALOG_UNREACHABLE",
            `catalog 响应读取超时（${this.timeoutMs}ms）：${url}`,
          );
        }
        throw new CatalogClientError(
          "RESPONSE_INVALID",
          err instanceof SafeHttpError && err.code === "response_too_large"
            ? `catalog 响应超限（${url}）：${err.message}`
            : `catalog 响应不是合法 JSON：${url}`,
        );
      }
      return { status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 由自持私钥导出公钥 JWK 与指纹（私钥不出进程；公钥随绑定请求公开）。 */
export function runtimePublicKey(identity: RuntimeSigningIdentity): {
  keyJwk: JsonWebKey;
  keyThumbprint: string;
} {
  const keyJwk = createPublicKey(identity.signingIdentity.privateKey).export({
    format: "jwk",
  }) as JsonWebKey;
  return { keyJwk, keyThumbprint: jwkThumbprint(keyJwk) };
}

/** 名片域内自查（§4.6：发出前客户端先拦，服务端也会拦）。 */
export function assertCardWithinOrigin(
  card: AgentCard,
  runtimeOrigin: string,
  a2aEndpoint: string,
): void {
  const origin = originOf(normalizeOrigin(runtimeOrigin));
  if (typeof card.url !== "string" || card.url === "") {
    throw new CatalogClientError("CARD_ORIGIN_VIOLATION", "agent_card.url 缺失（必须等于运行时 origin）");
  }
  if (originOf(card.url) !== origin) {
    throw new CatalogClientError(
      "CARD_ORIGIN_VIOLATION",
      `agent_card.url（${card.url}）不在运行时 origin（${origin}）内`,
    );
  }
  if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length === 0) {
    throw new CatalogClientError("CARD_ENDPOINT_NOT_BOUND", "agent_card.supportedInterfaces 为空");
  }
  let bound = false;
  for (const [index, entry] of card.supportedInterfaces.entries()) {
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://")) {
      throw new CatalogClientError(
        "CARD_ORIGIN_VIOLATION",
        `supportedInterfaces[${index}].url 必须是 https URL：${String(entry.url)}`,
      );
    }
    if (originOf(entry.url) !== origin) {
      throw new CatalogClientError(
        "CARD_ORIGIN_VIOLATION",
        `supportedInterfaces[${index}].url（${entry.url}）不在运行时 origin（${origin}）内`,
      );
    }
    if (entry.url === a2aEndpoint) bound = true;
  }
  if (!bound) {
    throw new CatalogClientError(
      "CARD_ENDPOINT_NOT_BOUND",
      `名片没有任何接口等于绑定的 a2a_endpoint（${a2aEndpoint}）——不得指向 Catalog 或他域`,
    );
  }
}

/** 本地产物结构自检：发出前用仓内 0.1.2 契约 schema 校验。 */
function assertContract(name: "runtime-binding-request" | "card-publication-request", body: unknown): void {
  const errors = validateCloudContract(name, body);
  if (errors.length > 0) {
    throw new CatalogClientError(
      "SCHEMA_VIOLATION",
      `本地产物不符合 ${name} 契约：${errors.join("；")}`,
    );
  }
}

/** 解析公开绑定文档（只取与自身核对所需字段；claims 过完整校验，fail-closed）。 */
function parsePublicBinding(raw: unknown): PublicBinding {
  if (!isRecord(raw)) {
    throw new CatalogClientError("RESPONSE_INVALID", "runtime-binding 响应必须是 JSON 对象");
  }
  const check = validateBindingClaims(raw["claims"]);
  if (!check.ok) {
    throw new CatalogClientError(
      "RESPONSE_INVALID",
      `runtime-binding 的 claims 不符合 schema：${check.errors.join("；")}`,
    );
  }
  const claims: BindingClaims = check.claims;
  const revision = raw["card_revision"];
  const etag = raw["card_etag"];
  const governance = raw["governance"];
  return {
    bindingId: claims.binding_id,
    bindingVersion: claims.binding_version,
    merchantId: claims.merchant_id,
    runtimeOrigin: claims.runtime_origin,
    a2aEndpoint: claims.a2a_endpoint,
    keyId: claims.key_id,
    keyThumbprint: claims.key_thumbprint,
    expiresAt: claims.expires_at,
    cardRevision: typeof revision === "number" && Number.isInteger(revision) ? revision : null,
    cardEtag: typeof etag === "string" && etag !== "" ? etag : null,
    publicationState: isRecord(governance) ? String(governance["publication_state"] ?? "") : "",
  };
}
