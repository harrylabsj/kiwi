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
 * Catalog 连接服务内核（A2 直连 device enrollment）。
 *
 * 把 `merchant-connect.ts` 里既有的签名 device enrollment 协议
 * （create → poll → bind → publish → activate，CatalogClient 承载）抽成
 * 可供工作台/云端 bootstrap 调用的服务，CLI 变为本服务之上的薄适配。
 * **协议步骤只有这一套**——本文件是从 CLI 实现原样搬移的状态机，不是重写。
 *
 * 与 CLI 的差异只在"驱动方式"：
 *
 * - `begin()` 是**唯一**允许创建 enrollment 的入口（幂等：同 origin/公钥/
 *   Catalog/冻结卡直接复用），且永远不会被 GET 触发；
 * - `reconcile()` 是单趟短执行（至多一次 poll，随后级联 authorized→bound→
 *   published 中已就绪的格），尊重 interval/slow_down 节流，不创建新会话、
 *   不轮询已过期授权、**不输出配对码/授权链接/grant**；
 * - 状态经 `getSummary()`（助手安全层：状态枚举/published/agentId/bindingId/
 *   bindingExpiresAt/可用性错误码，永无 user_code/device_code/grant）与
 *   `getPairing()`（仅商家本人层：user_code/verification_uri/expires_at）分层外露；
 * - `options.beforePublish(binding)` 钩子在**绑定回执经 Catalog 验签之后、
 *   发名片之前**调用（cloud bootstrap 用它拿已验证 merchantId 盖戳商品表并跑
 *   真实 readiness）；钩子失败保留 bound，不发布。
 *
 * 身份纪律（全部沿用 CLI 既有校验，不新增信任根）：
 *
 * - 首次 Catalog 服务端回执里的 `catalog_agent_id` 是权威身份；只与"历史已
 *   发布身份"（expected_catalog_agent_id）做迁移约束，**不与本地 cagt_* 假定比较**；
 * - `merchantId` 只能来自 CatalogClient 验真的 binding claim（bind 时写入并
 *   持久化 binding_expires_at 等已验证声明以便重启），authorized 轮询结果
 *   **绝不**足以盖戳商品；
 * - 代次固定为配置值（当前 1），会话按 generation 选择，拒绝悄悄迁移；
 *   绝不把 applicationId 字符串当权威证据（本服务根本不经过开通向导）。
 *
 * 持久化仍是 0600 `merchant-enrollments.json` 原子写；任何失败路径只改
 * 目标会话的格，不删除其他会话。
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { loadOrCreateA2aSigningIdentity, toJwsSigningIdentity } from "../a2a/signing-key.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { canonicalize } from "../negotiation/jcs.js";
import { validateAgentCard } from "../discovery/agent-card/validate.js";
import type { AgentCard } from "../discovery/agent-card/types.js";
import { isRedirectResponse, readJsonBody } from "../net/safe-http.js";
import {
  CatalogClient,
  CatalogClientError,
  normalizeOrigin,
  runtimePublicKey,
  type DeviceEnrollmentPoll,
  type PublicBinding,
  type RuntimeSigningIdentity,
} from "./catalog-client.js";
import {
  enrollmentStorePath,
  readEnrollmentStore,
  type AuthorizedEnrollment,
  type EnrollmentChallengeStore,
} from "./binding/enrollment-challenge.js";

export class MerchantConnectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MerchantConnectError";
  }
}

/**
 * 配对诊断固定安全码（A15）：reconcile 各阶段失败只允许透出本集合内的自有
 * 稳定码——绝不反射远端错误原文/grant/device_code/JWS/头/私钥。工作台 API
 * 白名单（CATALOG_CONNECTION_SAFE_CODES）以此单源扩展。
 */
export const CONNECTION_PAIRING_SAFE_CODES = new Set([
  "PAIRING_WINDOW_EXPIRED",       // 授权窗口（=Catalog grant 窗口）已过：需重新配对
  "BIND_REJECTED",                // Catalog 拒绝 bind 请求（grant 过期/不匹配/版本冲突）
  "BIND_CLAIM_INVALID",           // bind 已到达但签名声明未通过本地验真
  "CARD_PUBLISH_REJECTED",        // 名片发布/激活被 Catalog 拒绝
  "CARD_PUBLISH_INVALID",         // 发布/激活回执不完整或不合法
  "PAIRING_COMMUNICATION_FAILED", // 与 Catalog 通信失败（网络/5xx，可重试）
  "CONNECT_STEP_FAILED",          // 兜底：未归类步骤失败
  "AUTHORIZED_MATERIAL_MISMATCH", "GRANT_SCOPE_INVALID", "STATE_INVALID",
  "BINDING_KEY_MISMATCH", "BINDING_CLAIM_INVALID", "PREVIEW_CHANGED",
  "PUBLICATION_RECEIPT_INVALID", "ACTIVATION_RECEIPT_INVALID",
  "BIND_CLAIM_CARD_URL_MISMATCH", "BIND_CLAIM_FIELD_MISMATCH",
]);

/**
 * 公网入口 host 白名单口径（CLI parsePublicOrigin 与服务构造器共用，
 * 两边边界一致，谁也不放宽）：拒绝 localhost/私网 IP/链路本地域名/无点主机。
 * 只判 host；协议与路径形态由各自调用点另行校验。
 */
export function isPublicHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ip = isIP(host);
  const octets = ip === 4 ? host.split(".").map(Number) : [];
  const privateIpv4 = ip === 4 && (
    octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 ||
    octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31 ||
    octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127 || (octets[0] ?? 0) >= 224
  );
  const privateIpv6 = ip === 6 && (
    host === "::" || host === "::1" || host.startsWith("fc") ||
    host.startsWith("fd") || host.startsWith("fe80:") || host.startsWith("::ffff:")
  );
  return host !== "localhost" && !host.endsWith(".localhost") &&
    !host.endsWith(".local") && !host.endsWith(".internal") && !host.endsWith(".lan") && !host.endsWith(".home") &&
    host.includes(".") && !privateIpv4 && !privateIpv6;
}

/** 连接会话（merchant-enrollments.json 中单条 session 的完整形状）。 */
export interface ConnectionSession extends AuthorizedEnrollment {
  catalog_origin: string;
  preview_digest: string;
  frozen_card: AgentCard;
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  generation?: number;
  catalog_agent_id?: string;
  expected_catalog_agent_id?: string;
  /** 仅由验真 binding claim 写入；authorized 轮询结果不写入本字段。 */
  merchant_id?: string;
  grant?: string;
  authorization_epoch?: number;
  /**
   * authorized 轮询里的 merchant_id 断言（**未验真**）：仅供 bind 请求的
   * 入参一致性校验，CatalogClient 会核对签名 claim 与它一致；商品盖戳等
   * 任何权威用途都只认 claim 写入的 merchant_id。
   */
  offered_merchant_id?: string;
  binding_id?: string;
  binding_version?: number;
  /** claim 里的 expires_at（已验证）：**首签声明的短期 TTL**（Catalog 每次
   * 公开读会重签新声明）；bound 未发布时作有效期门槛，published 的续验以
   * Catalog 当次重签的公开声明为准，不用它判死。 */
  binding_expires_at?: string;
  active_card_revision?: number;
  expected_card_revision?: number;
  card_revision?: number;
}

/**
 * 纯 resume 选择：只有同 origin + 同公钥指纹 + 可续状态 + 未过期才复用。
 * （自 merchant-connect.ts 原样搬移，行为被 tests/merchant-connect-migration.test.ts 钉住。）
 *
 * 过期口径按状态区分：preparing/authorized 看授权窗口 expires_at；
 * **bound/published 看已验真绑定的 binding_expires_at**——绑定已建立后
 * 授权 grant 过期不影响续办（用户无需重新授权），反过来绑定过期必须拒绝。
 */
export function selectReusableEnrollment(
  sessions: readonly AuthorizedEnrollment[],
  input: { runtimeOrigin: string; keyThumbprint: string; nowMs: number },
): AuthorizedEnrollment | undefined {
  return sessions.find((session) => {
    const state = session as ConnectionSession;
    if (state.runtime_origin !== input.runtimeOrigin || state.key_thumbprint !== input.keyThumbprint) return false;
    if (!["preparing", "authorized", "bound", "published"].includes(state.status)) return false;
    if (state.status === "published") return true;
    const expiry = state.status === "bound" ? state.binding_expires_at : state.expires_at;
    return Number.isFinite(Date.parse(expiry ?? "")) && Date.parse(expiry ?? "") > input.nowMs;
  });
}

/** Keep the Catalog account's single-agent identity through key loss and address migration. */
export function priorPublishedCatalogAgentId(sessions: readonly AuthorizedEnrollment[]): string | undefined {
  const ids = new Set(sessions
    .map((session) => session as ConnectionSession)
    .filter((session) => session.status === "published" && typeof session.catalog_agent_id === "string")
    .map((session) => session.catalog_agent_id!));
  if (ids.size > 1) throw new MerchantConnectError("AMBIGUOUS_MIGRATION", "本Runtime已有多个Catalog Agent历史绑定；请在Catalog先确认要迁移的商家身份。");
  return ids.values().next().value as string | undefined;
}

/** 助手/工作台安全摘要：永不含 user_code/device_code/grant/授权链接。 */
export type ConnectionSummaryStatus =
  | "idle"
  | "awaiting_confirmation"
  | "authorized"
  | "bound"
  | "published"
  | "replaced"
  | "revoked"
  | "paused"
  | "expired"
  | "canceled"
  // published 会话的 fail-closed 视图：本实例尚未核对（unknown）、
  // Catalog 确认撤回/暂停（paused）、核对本身出错含网络不可达（error）。
  | "unknown"
  | "error";

export type ConnectionStage = "prepare" | "authorize" | "publish";

export interface ConnectionSummary {
  status: ConnectionSummaryStatus;
  /** 自有固定阶段词（A15）：preparing→prepare，authorized→authorize，bound/published→publish。 */
  stage: ConnectionStage;
  published: boolean;
  agentId: string | null;
  bindingId: string | null;
  bindingExpiresAt: string | null;
  cardRevision: number | null;
  /** 可用性/安全错误码（如 PUBLICATION_NOT_ACTIVE）；健康为 null。 */
  code: string | null;
  detail: string | null;
}

/** 仅商家本人可见的配对信息；只在 preparing/awaiting 阶段存在。 */
export interface ConnectionPairing {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

/**
 * 已验证绑定投影：merchantId 只来自 CatalogClient 验真的 binding claim
 * （或 published 会话经公开绑定复核一致的结果）。
 */
export interface VerifiedBinding {
  agentId: string;
  bindingId: string;
  bindingVersion: number;
  merchantId: string;
  keyThumbprint: string;
  runtimeOrigin: string;
  a2aEndpoint: string;
  expiresAt: string;
  cardRevision: number | null;
}

export interface MerchantConnectionServiceOptions {
  /** 权威状态目录（merchant-enrollments.json 所在）。 */
  dataDir: string;
  /** Catalog 控制面根 URL（https；loopback 仅测试）。 */
  catalogUrl: string;
  /** 运行时公开 origin（只取自 KIWI_CLOUD_PUBLIC_ORIGIN 或 CLI 已校验值）。 */
  publicOrigin: string;
  /** 部署代次（当前 1）；会话按此选择，拒绝悄悄迁移。 */
  generation?: number;
  serviceEpoch?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * 公开名片提供者（缺省：匿名读自身 origin 的 well-known 卡并核对签名声明，
   * 与 CLI 的 verifyPublicRuntimeReady 同口径）。云端可注入本地构建的同名卡。
   */
  loadPublicCard?: () => Promise<AgentCard>;
  /** 绑定验真后、发名片前调用；失败保留 bound、不发布。 */
  beforePublish?: (binding: VerifiedBinding) => Promise<void>;
  /** 仅测试/本地回环：放宽公网 host 白名单（默认绝不放宽 CLI 的私网边界）。 */
  allowPrivateOrigin?: boolean;
}

export interface MerchantConnectionService {
  /** 唯一允许创建 enrollment 的入口；同 origin/key/catalog/冻结卡幂等复用。 */
  begin(): Promise<ConnectionSummary>;
  /** 单趟短执行：至多一次 poll + 已就绪格级联；后台调用绝不创建新会话。 */
  reconcile(): Promise<ConnectionSummary>;
  /** 本地状态摘要（便宜、不触发 Catalog 写）；可用性码来自最近一次 reconcile。 */
  getSummary(): Promise<ConnectionSummary>;
  /** 本人配对信息（preparing 阶段）；无会话或已过该阶段返回 null。 */
  getPairing(): ConnectionPairing | null;
  /** 已验证绑定（bound/published 且未过期；published 另经 Catalog 复核）；无则 null。 */
  getVerifiedBinding(): Promise<VerifiedBinding | null>;
}

function cardDigest(card: AgentCard): string {
  return `sha256:${createHash("sha256").update(canonicalize(card as unknown as Record<string, unknown>), "utf8").digest("hex")}`;
}

/** 缺省公开卡加载：与 CLI verifyPublicRuntimeReady 同口径（匿名读 + 签名声明核对）。 */
async function fetchPublicCard(
  origin: string,
  expectedEndpoint: string,
  identity: { keyid: string; publicKeyPem: string },
  fetchImpl: typeof fetch,
): Promise<AgentCard> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const url = `${origin}/.well-known/agent-card.json`;
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/json" } });
    if (isRedirectResponse(response) || !response.ok) {
      throw new MerchantConnectError("RUNTIME_UNREACHABLE", `暂时无法从外部读取商家服务的 Agent Card（HTTP ${response.status}）。请确认服务已启动且公网入口可访问，然后重新运行 kiwi merchant connect。`);
    }
    const card = validateAgentCard(await readJsonBody(response, { signal: controller.signal }));
    const urls = card.supportedInterfaces.map((entry) => entry.url);
    if (typeof card.url !== "string" || new URL(card.url).origin !== origin || !urls.includes(expectedEndpoint)) {
      throw new MerchantConnectError("RUNTIME_NOT_READY", "公网入口返回的 Agent Card 与当前 Runtime 地址不一致；未发布名片。请检查反向代理与服务配置后重试。");
    }
    const signatureScheme = card.securitySchemes?.["kiwi-signature"];
    if (signatureScheme !== undefined && (
      signatureScheme.type !== "kiwi-http-message-signature" ||
      signatureScheme.keyid !== identity.keyid ||
      signatureScheme.publicKeyPem !== identity.publicKeyPem ||
      signatureScheme.algorithm !== "ed25519"
    )) {
      throw new MerchantConnectError("RUNTIME_IDENTITY_MISMATCH", "公网服务的 A2A 签名声明与当前 Runtime 持久密钥不一致；未发布名片。请在实际承接请求的 Runtime 主机上运行连接命令。");
    }
    return card;
  } catch (err) {
    if (err instanceof MerchantConnectError) throw err;
    throw new MerchantConnectError("RUNTIME_UNREACHABLE", `暂时无法从外部连接你的商家服务（${err instanceof Error ? err.message : String(err)}）。请确认服务已启动、TLS 证书有效且允许公网访问，然后重试。`);
  } finally {
    clearTimeout(timer);
  }
}

class ConnectionServiceImpl implements MerchantConnectionService {
  private readonly dataDir: string;
  private readonly origin: string;
  private readonly a2aEndpoint: string;
  private readonly generation: number;
  private readonly serviceEpoch: number;
  private readonly client: CatalogClient;
  private readonly identityRaw: ReturnType<typeof loadOrCreateA2aSigningIdentity>;
  private readonly identity: RuntimeSigningIdentity;
  private readonly keyThumbprint: string;
  private readonly now: () => Date;
  private readonly loadPublicCard: () => Promise<AgentCard>;
  private readonly beforePublish: ((binding: VerifiedBinding) => Promise<void>) | undefined;
  /** begin/reconcile 串行（排队不交错）。 */
  private mutex: Promise<unknown> = Promise.resolve();
  /** poll 节流（内存态；重启后首趟允许立即 poll）。 */
  private nextPollAtMs = 0;
  /**
   * published 会话的"本次已验证"结论（fail-closed，getSummary 只读它）：
   * publicationVerified=false 表示本实例还没从 Catalog 核对过当前绑定/名片，
   * 此时绝不允许把本地历史 published 记录当当前发布回执；
   * availability 非 null 表示核对给出否定/出错结论（撤回、网络不可达等）。
   */
  private publicationVerified = false;
  private availability: { code: string; detail: string } | null = null;

  constructor(options: MerchantConnectionServiceOptions) {
    this.dataDir = options.dataDir;
    this.generation = options.generation ?? 1;
    this.serviceEpoch = options.serviceEpoch ?? 1;
    const trimmed = String(options.publicOrigin ?? "").trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "公网入口不是合法 URL；请设置 KIWI_A2A_PUBLIC_URL=https://你的域名");
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
        parsed.search !== "" || parsed.hash !== "" || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "公网入口不是合法 URL；请设置 KIWI_A2A_PUBLIC_URL=https://你的域名");
    }
    // 与 CLI parsePublicOrigin 同一白名单口径：生产构造必须提供公网可达 host；
    // 只有显式 allowPrivateOrigin（测试/本地回环）才放宽。
    if (options.allowPrivateOrigin !== true && !isPublicHostAllowed(parsed.hostname)) {
      throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "商家服务尚未配置可用的公网 HTTPS origin。请运行 `kiwi merchant setup-public` 查看入口配置指引；资料已保留，配置后重新运行连接命令。");
    }
    this.origin = normalizeOrigin(trimmed);
    this.a2aEndpoint = `${this.origin}/a2a`;
    this.client = new CatalogClient({ baseUrl: options.catalogUrl, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) });
    this.identityRaw = loadOrCreateA2aSigningIdentity(this.dataDir, this.origin);
    this.identity = { signingIdentity: toJwsSigningIdentity(this.identityRaw), keyId: this.identityRaw.keyid };
    this.keyThumbprint = runtimePublicKey(this.identity).keyThumbprint;
    this.now = options.now ?? (() => new Date());
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.loadPublicCard = options.loadPublicCard ??
      (async () => await fetchPublicCard(this.origin, this.a2aEndpoint, {
        keyid: this.identityRaw.keyid,
        publicKeyPem: this.identityRaw.publicKeyPem,
      }, fetchImpl));
    this.beforePublish = options.beforePublish;
  }

  // ── 公开接口 ─────────────────────────────────────────────────────────

  async begin(): Promise<ConnectionSummary> {
    return await this.withLock(async () => {
      const card = await this.loadPublicCard();
      const currentDigest = cardDigest(card);
      const store = readEnrollmentStore(this.dataDir);
      const session = this.selectSession(store);
      const catalogOrigin = this.client.catalogOrigin;
      if (session !== undefined) {
        if (session.catalog_origin !== catalogOrigin) {
          throw new MerchantConnectError("CATALOG_MISMATCH", "待续办的接入任务属于另一个 Catalog；为防止许可串用，已停止。");
        }
        const frozenDigest = cardDigest(session.frozen_card);
        if (typeof session.preview_digest !== "string" || frozenDigest !== session.preview_digest) {
          throw new MerchantConnectError("STATE_INVALID", "持久接入任务缺少冻结的公开名片，已停止。");
        }
        if (currentDigest !== session.preview_digest) {
          throw new MerchantConnectError(
            session.status === "published" ? "RUNTIME_CARD_CHANGED" : "PREVIEW_CHANGED",
            "公网服务当前的 Agent Card 与已批准预览不同；请核对变更并重新授权，Runtime不会静默更改已公开信息。",
          );
        }
        if (session.status === "published") {
          try {
            await this.assertPublicationActive(session);
          } catch (err) {
            // 撤回/暂停如实留痕（summary fail-closed 为未发布）并继续向上抛；
            // begin 是显式动作，保持与旧 CLI 一致的抛错语义。
            this.publicationVerified = false;
            this.availability = err instanceof MerchantConnectError
              ? { code: err.code, detail: err.message }
              : { code: "PUBLICATION_CHECK_FAILED", detail: String(err) };
            throw err;
          }
          this.publicationVerified = true;
          this.availability = null;
          const fresh = this.selectSession(readEnrollmentStore(this.dataDir));
          return this.toSummary(fresh ?? session);
        }
        return this.toSummary(session);
      }

      // 无可用会话：只有这里允许创建 enrollment。但若同 origin+key 还存在
      // **其他 Catalog** 的活会话，说明配置指向变了——明确拒绝而不是 silently
      // 在新 Catalog 重建（防止许可串用/悄悄迁移）。
      const foreign = this.findForeignCatalogSession(store);
      if (foreign !== undefined) {
        throw new MerchantConnectError("CATALOG_MISMATCH", "待续办的接入任务属于另一个 Catalog；为防止许可串用，已停止。");
      }
      const expectedCatalogAgentId = priorPublishedCatalogAgentId(store.sessions);
      const enrollment = await this.client.createDeviceEnrollment({
        runtimeOrigin: this.origin,
        a2aEndpoint: this.a2aEndpoint,
        generation: this.generation,
        serviceEpoch: this.serviceEpoch,
        publicPreview: card as unknown as Record<string, unknown>,
        publicProfileRevision: 1,
      }, this.identity);
      const next: ConnectionSession = {
        enrollment_id: enrollment.enrollmentId,
        runtime_origin: this.origin,
        key_thumbprint: this.keyThumbprint,
        catalog_origin: catalogOrigin,
        preview_digest: currentDigest,
        frozen_card: card,
        generation: this.generation,
        ...(expectedCatalogAgentId !== undefined ? { expected_catalog_agent_id: expectedCatalogAgentId } : {}),
        expires_at: enrollment.expiresAt,
        status: "preparing",
        device_code: enrollment.deviceCode,
        user_code: enrollment.userCode,
        verification_uri: enrollment.verificationUri,
        interval: enrollment.intervalSeconds,
      };
      // 同 origin+key 的旧 preparing 会话被本任务取代（标 canceled 留痕），
      // 其余会话（含其他 origin/key、bound/published 历史）一律保留。
      this.persist((fresh) => [
        ...fresh.sessions.map((item) => {
          const old = item as ConnectionSession;
          return old.enrollment_id !== next.enrollment_id &&
            old.runtime_origin === this.origin && old.key_thumbprint === this.keyThumbprint &&
            old.status === "preparing"
            ? { ...old, status: "canceled" as const }
            : item;
        }),
        next,
      ]);
      this.nextPollAtMs = 0;
      this.publicationVerified = false;
      this.availability = null;
      return this.toSummary(next);
    });
  }

  async reconcile(): Promise<ConnectionSummary> {
    return await this.withLock(async () => {
      const store = readEnrollmentStore(this.dataDir);
      const session = this.selectSession(store);
      if (session === undefined) {
        // 过期授权显式标记：不再轮询，下一次 begin() 为同 origin+key 新建。
        const stale = this.findStaleSession(store);
        if (stale !== undefined) {
          const expired = { ...stale, status: "expired" as const };
          this.persist((fresh) => fresh.sessions.map((item) =>
            item.enrollment_id === stale.enrollment_id ? expired : item));
          // 授权窗口过期的显式可重试提示：粘性展示，直到下一次 begin() 取代。
          this.availability = { code: "PAIRING_WINDOW_EXPIRED", detail: "" };
          return this.toSummary(expired);
        }
        const expiredSession = this.latestExpiredSession(store);
        if (expiredSession !== undefined) {
          this.availability = { code: "PAIRING_WINDOW_EXPIRED", detail: "" };
          return this.toSummary(expiredSession);
        }
        return this.toSummary(null);
      }
      // 单趟级联：preparing →（poll）authorized →（bind）bound →（钩子+publish）
      // published，每格已就绪就顺势走完；poll 节流保证至多一次出站 poll。
      // 步骤失败不得静默：错误码进摘要（code/detail 只含自有稳定码，绝无
      // 远端原文/凭据），否则 authorized 会卡满 grant 窗口而工作台无从诊断。
      let current = session;
      this.availability = null;
      if (current.status !== "published") this.publicationVerified = false;
      let stage = current.status;
      try {
        // stage 跟随“即将执行的步骤”：失败码按真正抛错的阶段归类。
        if (current.status === "preparing") { stage = "preparing"; current = await this.stepPreparing(current); stage = current.status; }
        if (current.status === "authorized") { stage = "authorized"; current = await this.stepAuthorized(current); stage = current.status; }
        if (current.status === "bound") { stage = "bound"; current = await this.stepBound(current); stage = current.status; }
      } catch (err) {
        // 阶段感知稳定码：绑定被拒 vs 签名声明验真失败 vs 通信失败可被 owner
        // API/UI 辨别；码值恒在本文件导出的固定集合内。
        this.availability = { code: this.stepFailureCode(stage, err), detail: "" };
        throw err;
      }
      if (current.status === "published") {
        try {
          await this.assertPublicationActive(current);
        } catch (err) {
          // 撤回/暂停/网络不可达一律 fail-closed：summary 报未发布（paused/error），
          // 绝不自动恢复营业、不发任何写请求；下趟 reconcile 会重新核对。
          this.publicationVerified = false;
          this.availability = err instanceof MerchantConnectError
            ? { code: err.code, detail: err.message }
            : { code: "PUBLICATION_CHECK_FAILED", detail: String(err) };
          return this.toSummary(current);
        }
        this.publicationVerified = true;
        this.availability = null;
      }
      return this.toSummary(current);
    });
  }

  async getSummary(): Promise<ConnectionSummary> {
    const store = readEnrollmentStore(this.dataDir);
    const session = this.selectSession(store);
    if (session !== undefined) {
      // 跨进程（CLI begin + 服务 getSummary 共用 dataDir）：另一进程新建的
      // 健康会话不应遗留上一进程的过期提示；只清 PAIRING_WINDOW_EXPIRED，
      // 真正的绑定/发布失败码仍由 reconcile 结果决定。
      if (this.availability?.code === "PAIRING_WINDOW_EXPIRED") this.availability = null;
      return this.toSummary(session);
    }
    const stale = this.findStaleSession(store);
    if (stale !== undefined) {
      // 授权窗口已过：报告 expired（粘性），不再无提示回落 idle。
      this.availability = { code: "PAIRING_WINDOW_EXPIRED", detail: "" };
      return this.toSummary({ ...stale, status: "expired" });
    }
    const expired = this.latestExpiredSession(store);
    if (expired !== undefined) {
      this.availability = { code: "PAIRING_WINDOW_EXPIRED", detail: "" };
      return this.toSummary(expired);
    }
    return this.toSummary(null);
  }

  /** 最近一次同 origin/key/catalog/generation 的过期会话（粘性过期提示用）。 */
  private latestExpiredSession(store: EnrollmentChallengeStore): ConnectionSession | undefined {
    const candidates = store.sessions.filter((item) => {
      const session = item as ConnectionSession;
      return session.status === "expired" && session.runtime_origin === this.origin &&
        session.key_thumbprint === this.keyThumbprint &&
        session.catalog_origin === this.client.catalogOrigin &&
        (session.generation ?? 1) === this.generation;
    });
    return candidates.at(-1) as ConnectionSession | undefined;
  }

  /** 失败码映射：自有稳定码原样透出；CatalogClientError 按阶段归类到固定安全码。 */
  private stepFailureCode(stage: ConnectionSession["status"], err: unknown): string {
    if (err instanceof MerchantConnectError) {
      return CONNECTION_PAIRING_SAFE_CODES.has(err.code) ? err.code : "CONNECT_STEP_FAILED";
    }
    if (err instanceof CatalogClientError) {
      if (err.code === "CATALOG_UNREACHABLE") return "PAIRING_COMMUNICATION_FAILED";
      if (stage === "authorized") {
        if (err.code === "REQUEST_REJECTED" || err.code === "CONFLICT") return "BIND_REJECTED";
        if (err.code === "RESPONSE_INVALID") return "BIND_CLAIM_INVALID";
        if (err.code === "CLAIM_MISMATCH") {
          const fields = (err as CatalogClientError & { claimFields?: string[] }).claimFields ?? [];
          return fields.includes("card_url") ? "BIND_CLAIM_CARD_URL_MISMATCH" : "BIND_CLAIM_FIELD_MISMATCH";
        }
      }
      if (stage === "bound") {
        if (err.code === "REQUEST_REJECTED" || err.code === "CONFLICT") return "CARD_PUBLISH_REJECTED";
        if (err.code === "RESPONSE_INVALID") return "CARD_PUBLISH_INVALID";
      }
    }
    return "CONNECT_STEP_FAILED";
  }

  getPairing(): ConnectionPairing | null {
    const store = readEnrollmentStore(this.dataDir);
    const session = this.selectSession(store);
    if (session === undefined || session.status !== "preparing") return null;
    return {
      userCode: session.user_code,
      verificationUri: session.verification_uri,
      expiresAt: session.expires_at,
    };
  }

  /**
   * 已验证绑定投影（bound 与 published 两条口径）：
   *
   * - **bound（尚未公开发布）**：只认 bind 时验真并持久化的签名 claim，
   *   且该 claim 未过期——绝不无条件延长旧凭据；
   * - **published**：先从 Catalog 公开端点读取**当次重签**的绑定声明
   *   （Catalog 每次公开读都会重新签发 expires_at=now+ttl≤900s 的短期声明，
   *   本地 binding_expires_at 只是首签 TTL、不是长期绑定的终点），逐字段核对
   *   merchant/origin/key/binding id/version/card revision 后，用新鲜声明的
   *   期限刷新投影。历史 claim 过期绝不阻断只读续验，也不触发重建 enrollment。
   */
  async getVerifiedBinding(): Promise<VerifiedBinding | null> {
    const store = readEnrollmentStore(this.dataDir);
    const session = this.selectSession(store);
    if (session === undefined) return null;
    if (session.status === "bound") {
      // 未发布：必须用本地已验证且未过期的签名 claim。
      return this.verifiedFromSession(session);
    }
    if (session.status !== "published") return null;
    try {
      const active = await this.assertPublicationActive(session);
      this.markPublishedVerified();
      return this.verifiedFromPublication(session, active);
    } catch (err) {
      this.publicationVerified = false;
      this.availability = err instanceof MerchantConnectError
        ? { code: err.code, detail: err.message }
        : { code: "PUBLICATION_CHECK_FAILED", detail: "Catalog publication could not be verified" };
      return null;
    }
  }

  // ── 协议单步（自 CLI 状态机原样搬移，顺序与校验一致）──────────────────

  /** begin/reconcile 后本趟已确认 published 健康（发布成功即视为已验证）。 */
  private markPublishedVerified(): void {
    this.publicationVerified = true;
    this.availability = null;
  }

  private async stepPreparing(session: ConnectionSession): Promise<ConnectionSession> {
    const nowMs = this.now().getTime();
    if (!Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= nowMs) {
      // 授权已过期：不再轮询，显式标记；下一次 begin() 会为同 origin+key 新建。
      const expired = { ...session, status: "expired" as const };
      this.persist((fresh) => fresh.sessions.map((item) =>
        item.enrollment_id === session.enrollment_id ? expired : item));
      return expired;
    }
    if (nowMs < this.nextPollAtMs) return session;
    const poll = await this.client.pollDeviceEnrollment(session.device_code, this.identity);
    if (poll.status !== "authorized") {
      const intervalMs = poll.status === "slow_down"
        ? Math.max(session.interval * 1000 + 5_000, poll.intervalSeconds * 1000)
        : Math.max(session.interval, poll.intervalSeconds) * 1000;
      this.nextPollAtMs = nowMs + intervalMs;
      const updated = { ...session, interval: Math.round(intervalMs / 1000) };
      this.persist((fresh) => fresh.sessions.map((item) =>
        item.enrollment_id === session.enrollment_id ? updated : item));
      return updated;
    }
    this.verifyAuthorizedPoll(session, poll);
    const authorized = {
      ...session,
      status: "authorized" as const,
      catalog_agent_id: poll.catalogAgentId,
      grant: poll.grant,
      authorization_epoch: poll.authorizationEpoch,
      expires_at: poll.expiresAt,
      // poll.merchantId 是未验真断言，只存 offered_merchant_id 供 bind 入参
      // 一致性校验（CatalogClient 会核对签名 claim 与它一致）；
      // 权威的 merchant_id 只在 bind 阶段由 Catalog 签名 claim 写入。
      offered_merchant_id: poll.merchantId,
    };
    this.persist((fresh) => fresh.sessions.map((item) =>
      item.enrollment_id === session.enrollment_id ? authorized : item));
    return authorized;
  }

  private verifyAuthorizedPoll(session: ConnectionSession, poll: Extract<DeviceEnrollmentPoll, { status: "authorized" }>): void {
    if (poll.enrollmentId !== session.enrollment_id || poll.runtimeOrigin !== this.origin || poll.a2aEndpoint !== this.a2aEndpoint ||
        poll.merchantId.trim() === "" ||
        session.expected_catalog_agent_id !== undefined && poll.catalogAgentId !== session.expected_catalog_agent_id) {
      throw new MerchantConnectError("AUTHORIZED_MATERIAL_MISMATCH", "Catalog 授权材料与当前 Runtime 不一致，已停止连接。");
    }
    if (poll.authorizationEpoch < 1 || poll.approvedCardDigest !== session.preview_digest ||
        !poll.scopes.includes("runtime:bind") || !poll.scopes.includes("card:publish") ||
        !poll.scopes.includes("heartbeat")) {
      throw new MerchantConnectError("GRANT_SCOPE_INVALID", "Catalog 接入许可缺少有效授权代次或必要范围，已停止。");
    }
  }

  private async stepAuthorized(session: ConnectionSession): Promise<ConnectionSession> {
    // 兼容旧 CLI 写入的会话（当时 merchant_id 存的是 poll 断言）：优先
    // offered_merchant_id，缺失时回落旧字段，语义相同（都只是 bind 入参）。
    const offeredMerchantId = session.offered_merchant_id ?? session.merchant_id;
    if (session.catalog_agent_id === undefined || session.grant === undefined ||
        session.authorization_epoch === undefined || offeredMerchantId === undefined) {
      throw new MerchantConnectError("STATE_INVALID", "本地授权状态缺少许可、授权代次、merchant_id或 catalog_agent_id");
    }
    const binding = await this.client.bindEnrollment({
      enrollmentId: session.enrollment_id,
      grant: session.grant,
      catalogAgentId: session.catalog_agent_id,
      merchantId: offeredMerchantId,
      runtimeOrigin: this.origin,
      a2aEndpoint: this.a2aEndpoint,
      generation: session.generation ?? this.generation,
      serviceEpoch: this.serviceEpoch,
      authorizationEpoch: session.authorization_epoch,
    }, this.identity);
    if (binding.keyThumbprint !== this.keyThumbprint) {
      throw new MerchantConnectError("BINDING_KEY_MISMATCH", "Catalog 绑定回执的密钥与本 Runtime 不一致");
    }
    const rawClaims = binding.bindingClaim["claims"];
    const claimMerchantId = rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
      ? (rawClaims as Record<string, unknown>)["merchant_id"]
      : undefined;
    const claimExpiry = rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
      ? (rawClaims as Record<string, unknown>)["expires_at"]
      : undefined;
    if (typeof claimMerchantId !== "string" || claimMerchantId.trim() === "") {
      throw new MerchantConnectError("BINDING_CLAIM_INVALID", "Catalog已签名绑定声明缺少merchant_id；名片保持未发布。");
    }
    if (typeof claimExpiry !== "string" || !Number.isFinite(Date.parse(claimExpiry))) {
      throw new MerchantConnectError("BINDING_CLAIM_INVALID", "Catalog已签名绑定声明缺少有效expires_at；名片保持未发布。");
    }
    const bound = {
      ...session,
      status: "bound" as const,
      binding_id: binding.bindingId,
      binding_version: binding.bindingVersion,
      merchant_id: claimMerchantId,
      binding_expires_at: claimExpiry,
      expected_card_revision: binding.activeCardRevision ?? 0,
    };
    this.persist((fresh) => fresh.sessions.map((item) =>
      item.enrollment_id === session.enrollment_id ? bound : item));
    // 绑定已持久化：发布交给 reconcile 的 bound 分支——失败阶段归类
    // （CARD_PUBLISH_* + stage=publish）由该分支的阶段标记正确给出，
    // 首配级联路径不再把发布失败误报成 BIND_REJECTED。
    return bound;
  }

  private async stepBound(session: ConnectionSession): Promise<ConnectionSession> {
    if (session.catalog_agent_id === undefined || session.binding_id === undefined ||
        session.binding_version === undefined || session.merchant_id === undefined ||
        session.binding_expires_at === undefined) {
      throw new MerchantConnectError("STATE_INVALID", "绑定状态缺少回执字段");
    }
    // 重启续办/长等待后重新验证：绑定授权已过期的绝不允许带过期绑定调
    // beforePublish 钩子或发布名片；显式标记 expired，下一次 begin() 重开。
    if (!Number.isFinite(Date.parse(session.binding_expires_at)) || Date.parse(session.binding_expires_at) <= this.now().getTime()) {
      const expired = { ...session, status: "expired" as const };
      this.persist((fresh) => fresh.sessions.map((item) =>
        item.enrollment_id === session.enrollment_id ? expired : item));
      return expired;
    }
    // 重启续办/长等待后重新验证：公开卡必须与冻结预览一致才允许发布。
    const currentCard = await this.loadPublicCard();
    if (canonicalize(currentCard) !== canonicalize(session.frozen_card)) {
      throw new MerchantConnectError("PREVIEW_CHANGED", "公网服务的公开 Agent Card 已不同于商家批准的预览；未发布名片。请重新检查并授权新的公开信息。");
    }
    const catalogAgentId = session.catalog_agent_id;
    const bindingId = session.binding_id;
    const verified: VerifiedBinding = {
      agentId: catalogAgentId,
      bindingId,
      bindingVersion: session.binding_version,
      merchantId: session.merchant_id,
      keyThumbprint: this.keyThumbprint,
      runtimeOrigin: this.origin,
      a2aEndpoint: this.a2aEndpoint,
      expiresAt: session.binding_expires_at,
      cardRevision: session.card_revision ?? null,
    };
    if (this.beforePublish !== undefined) await this.beforePublish(verified);
    const expectedRevision = session.expected_card_revision ?? 0;
    let cardRevision = session.card_revision;
    if (cardRevision === undefined) {
      const publication = await this.client.publishCard({
        agentId: catalogAgentId,
        bindingId,
        generation: session.generation ?? this.generation,
        expectedRevision,
        agentCard: session.frozen_card,
        a2aEndpoint: this.a2aEndpoint,
        runtimeOrigin: this.origin,
      }, this.identity);
      if (publication.revision === null) {
        throw new MerchantConnectError("PUBLICATION_RECEIPT_INVALID", "Catalog 未返回名片 revision；绑定已保留，重试可续办");
      }
      cardRevision = publication.revision;
      const publishedCard = { ...session, card_revision: cardRevision };
      this.persist((fresh) => fresh.sessions.map((item) =>
        item.enrollment_id === session.enrollment_id ? publishedCard : item));
      session = publishedCard;
    }
    const activated = await this.client.activateCard({
      agentId: catalogAgentId,
      bindingId,
      cardRevision,
      expectedRevision,
    }, this.identity);
    if (activated.revision === null) {
      throw new MerchantConnectError("ACTIVATION_RECEIPT_INVALID", "Catalog 未确认名片激活；绑定已保留，重试可续办");
    }
    const published = { ...session, status: "published" as const, card_revision: activated.revision };
    // 同 catalog agent 的旧 published 会话由新绑定取代（标 replaced）；其余一律保留。
    this.persist((fresh) => fresh.sessions.map((item) => {
      if (item.enrollment_id === session.enrollment_id) return published;
      const old = item as ConnectionSession;
      return old.status === "published" && old.catalog_agent_id === published.catalog_agent_id &&
        old.binding_id !== published.binding_id
        ? { ...old, status: "replaced" as const }
        : item;
    }));
    this.markPublishedVerified();
    return published;
  }

  // ── 内部 ─────────────────────────────────────────────────────────────

  /**
   * 选择当前（origin, key, catalog_origin, generation）可续的会话。
   * published 永不过期；其余状态按各自过期口径（bound 看 binding_expires_at）。
   * 逐条扫描而非取首条：第一条 catalog/generation 不匹配不得遮挡后面正确的会话；
   * 任何路径都不得把别的 Catalog 的 device_code/grant 发给当前 Catalog。
   */
  private selectSession(store: EnrollmentChallengeStore): ConnectionSession | undefined {
    const nowMs = this.now().getTime();
    for (const item of store.sessions) {
      const session = item as ConnectionSession;
      if (session.runtime_origin !== this.origin || session.key_thumbprint !== this.keyThumbprint) continue;
      if (!["preparing", "authorized", "bound", "published"].includes(session.status)) continue;
      if (session.status !== "published") {
        // published 永不在本地按首签 claim 的 TTL 判死（Catalog 每次公开读都会
        // 重签短期声明；长期绑定是否有效由 Catalog 复核把关），其余状态按各自
        // 过期口径：bound 看验真绑定 binding_expires_at，preparing/authorized
        // 看授权窗口 expires_at。
        const expiry = session.status === "bound" ? session.binding_expires_at : session.expires_at;
        if (!(Number.isFinite(Date.parse(expiry ?? "")) && Date.parse(expiry ?? "") > nowMs)) continue;
      }
      if (session.catalog_origin !== this.client.catalogOrigin) continue;
      if (session.generation !== undefined && session.generation !== this.generation) continue;
      return session;
    }
    return undefined;
  }

  /** 同 origin/key/catalog/generation、但授权窗口已过的 preparing/authorized 会话。 */
  private findStaleSession(store: EnrollmentChallengeStore): ConnectionSession | undefined {
    const candidate = store.sessions.find((item) => {
      const session = item as ConnectionSession;
      return session.runtime_origin === this.origin && session.key_thumbprint === this.keyThumbprint &&
        (session.generation ?? 1) === this.generation &&
        session.catalog_origin === this.client.catalogOrigin &&
        ["preparing", "authorized"].includes(session.status) &&
        (!Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= this.now().getTime());
    });
    return candidate as ConnectionSession | undefined;
  }

  /**
   * 同 origin+key 可续、但属于**其他 Catalog** 的会话（begin 创建新 enrollment
   * 前的显式守卫；selection 本身已按 catalog 过滤，这里只是给出明确拒绝）。
   */
  private findForeignCatalogSession(store: EnrollmentChallengeStore): ConnectionSession | undefined {
    const nowMs = this.now().getTime();
    for (const item of store.sessions) {
      const session = item as ConnectionSession;
      if (session.runtime_origin !== this.origin || session.key_thumbprint !== this.keyThumbprint) continue;
      if (!["preparing", "authorized", "bound", "published"].includes(session.status)) continue;
      if (session.status !== "published") {
        const expiry = session.status === "bound" ? session.binding_expires_at : session.expires_at;
        if (!(Number.isFinite(Date.parse(expiry ?? "")) && Date.parse(expiry ?? "") > nowMs)) continue;
      }
      if (session.catalog_origin === this.client.catalogOrigin) continue;
      if (session.generation !== undefined && session.generation !== this.generation) continue;
      return session;
    }
    return undefined;
  }

  /**
   * published 会话核对 Catalog **当次重签**的公开绑定声明；不符即
   * PUBLICATION_NOT_ACTIVE（不自动恢复）。返回核对通过的公开文档，
   * 其 expiresAt 是新鲜短期声明的期限（Catalog 每次公开读重签，
   * expires_at=now+ttl≤900s），不是长期绑定的终止时间——长期绑定过期由
   * Catalog 拒签（403）体现。
   */
  private async assertPublicationActive(session: ConnectionSession): Promise<PublicBinding> {
    if (session.catalog_agent_id === undefined || session.binding_id === undefined) {
      throw new MerchantConnectError("STATE_INVALID", "已发布接入缺少 Catalog/绑定信息。");
    }
    const active = await this.client.fetchPublicBinding(session.catalog_agent_id);
    if (active === null || active.bindingId !== session.binding_id ||
        (session.binding_version !== undefined && active.bindingVersion !== session.binding_version) ||
        active.keyThumbprint !== this.keyThumbprint ||
        active.runtimeOrigin.replace(/\/+$/, "") !== this.origin || active.a2aEndpoint !== this.a2aEndpoint ||
        active.cardRevision !== session.card_revision ||
        !Number.isFinite(Date.parse(active.expiresAt)) || Date.parse(active.expiresAt) <= this.now().getTime() ||
        !["ACTIVE", "active"].includes(active.publicationState)) {
      throw new MerchantConnectError("PUBLICATION_NOT_ACTIVE", "Catalog 当前没有返回这条绑定和已激活名片；服务可能已暂停或撤回。请到Catalog恢复服务后再检查，Runtime不会自动恢复营业。");
    }
    if (session.merchant_id === undefined) {
      const backfilled = { ...session, merchant_id: active.merchantId };
      this.persist((fresh) => fresh.sessions.map((item) =>
        item.enrollment_id === session.enrollment_id ? backfilled : item));
      return active;
    }
    if (session.merchant_id !== active.merchantId) {
      throw new MerchantConnectError("BINDING_MERCHANT_MISMATCH", "Catalog binding的merchant_id与本地Enrollment不一致，已停止。");
    }
    return active;
  }

  /** 用当次重签的公开声明构造已验证绑定投影（期限取新鲜声明）。 */
  private verifiedFromPublication(session: ConnectionSession, active: PublicBinding): VerifiedBinding {
    return {
      agentId: session.catalog_agent_id as string,
      bindingId: active.bindingId,
      bindingVersion: active.bindingVersion,
      merchantId: active.merchantId,
      keyThumbprint: active.keyThumbprint,
      runtimeOrigin: active.runtimeOrigin,
      a2aEndpoint: active.a2aEndpoint,
      expiresAt: active.expiresAt,
      cardRevision: active.cardRevision,
    };
  }

  private verifiedFromSession(session: ConnectionSession): VerifiedBinding | null {
    if (session.catalog_agent_id === undefined || session.binding_id === undefined ||
        session.binding_version === undefined || session.merchant_id === undefined ||
        session.binding_expires_at === undefined) return null;
    if (!Number.isFinite(Date.parse(session.binding_expires_at)) || Date.parse(session.binding_expires_at) <= this.now().getTime()) {
      return null;
    }
    return {
      agentId: session.catalog_agent_id,
      bindingId: session.binding_id,
      bindingVersion: session.binding_version,
      merchantId: session.merchant_id,
      keyThumbprint: session.key_thumbprint,
      runtimeOrigin: session.runtime_origin,
      a2aEndpoint: this.a2aEndpoint,
      expiresAt: session.binding_expires_at,
      cardRevision: session.card_revision ?? null,
    };
  }

  /**
   * published 的 summary 视图是 fail-closed 的，仅限"本次已验证"的当前绑定/名片：
   * 本实例尚未核对 → unknown/published=false；撤回暂停 → paused/published=false；
   * 核对出错（含网络不可达、长期绑定过期被 Catalog 拒签）→ error/published=false。
   * 绝不把读取本地历史记录当作当前发布回执，也绝不用首签声明的短期 TTL 在本地判死。
   */
  /** 自有固定阶段词（白名单字面量，绝无动态内容）。 */
  private stageOf(status: string): ConnectionStage {
    if (status === "authorized") return "authorize";
    if (status === "bound" || status === "published") return "publish";
    return "prepare";
  }

  private toSummary(session: ConnectionSession | null): ConnectionSummary {
    if (session === null) {
      return { status: "idle", stage: this.stageOf("idle"), published: false, agentId: null, bindingId: null, bindingExpiresAt: null, cardRevision: null, code: null, detail: null };
    }
    if (session.status !== "published") {
      // 非 published 阶段也透出最近一次步骤失败的自有稳定码（availability 仅由
      // reconcile 的失败路径写入；detail 恒为空串，绝不携带远端原文/凭据）。
      // availability 只在失败/发布核对路径写入：非 published 时非空即最近一次失败。
      const stepFailure = this.availability !== null
        ? { code: this.availability.code, detail: this.availability.detail }
        : { code: null, detail: null };
      return {
        status: session.status === "preparing" ? "awaiting_confirmation" : session.status,
        stage: this.stageOf(session.status),
        published: false,
        agentId: session.catalog_agent_id ?? null,
        bindingId: session.binding_id ?? null,
        bindingExpiresAt: session.binding_expires_at ?? null,
        cardRevision: session.card_revision ?? null,
        code: stepFailure.code,
        detail: stepFailure.detail,
      };
    }
    // published 绝不在本地按首签 claim 的 TTL 判死：binding_expires_at 只是
    // 首次绑定声明的短期期限（Catalog 每次公开读重签 expires_at=now+ttl≤900s
    // 的新声明），长期绑定是否有效只由 Catalog 复核结论决定。
    if (!this.publicationVerified || this.availability !== null) {
      const paused = this.availability?.code === "PUBLICATION_NOT_ACTIVE";
      return {
        status: this.availability === null ? "unknown" : paused ? "paused" : "error",
        stage: "publish" as const,
        published: false,
        agentId: session.catalog_agent_id ?? null,
        bindingId: session.binding_id ?? null,
        bindingExpiresAt: session.binding_expires_at ?? null,
        cardRevision: session.card_revision ?? null,
        code: this.availability?.code ?? null,
        detail: this.availability?.detail ?? "本实例尚未完成 Catalog 发布核对；published 暂报未确认。",
      };
    }
    return {
      status: "published", stage: "publish", published: true,
      agentId: session.catalog_agent_id ?? null,
      bindingId: session.binding_id ?? null,
      bindingExpiresAt: session.binding_expires_at ?? null,
      cardRevision: session.card_revision ?? null,
      code: null,
      detail: null,
    };
  }



  /** 0600 原子写；mutator 在**新鲜重读**的 store 上操作，保留 consumed 与其他会话。 */
  private persist(
    mutate: (fresh: EnrollmentChallengeStore) => EnrollmentChallengeStore["sessions"],
  ): void {
    const fresh = readEnrollmentStore(this.dataDir);
    const sessions = mutate(fresh);
    writeFileAtomic(enrollmentStorePath(this.dataDir), `${JSON.stringify({ ...fresh, sessions })}\n`, { mode: 0o600 });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutex.then(fn);
    this.mutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** 构造连接服务（幂等工厂；同一 dataDir 可由 CLI 与服务实例先后使用）。 */
export function createMerchantConnectionService(
  options: MerchantConnectionServiceOptions,
): MerchantConnectionService {
  return new ConnectionServiceImpl(options);
}
