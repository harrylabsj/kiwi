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

/** 独立 Merchant Runtime 的设备授权、自动绑定和名片发布。 */
import { isIP } from "node:net";
import type { AgentProfile } from "../config/profile.js";
import { validateAgentCard } from "../discovery/agent-card/validate.js";
import { loadOrCreateA2aSigningIdentity, toJwsSigningIdentity } from "../a2a/signing-key.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { canonicalize } from "../negotiation/jcs.js";
import type { AgentCard } from "../discovery/agent-card/types.js";
import { CatalogClient, runtimePublicKey, type DeviceEnrollmentSession } from "./catalog-client.js";
import { enrollmentStorePath, readEnrollmentStore, type AuthorizedEnrollment, type EnrollmentChallengeStore } from "./binding/enrollment-challenge.js";
import { createHash } from "node:crypto";
import { isRedirectResponse, readJsonBody } from "../net/safe-http.js";

export class MerchantConnectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MerchantConnectError";
  }
}

interface ConnectState extends AuthorizedEnrollment {
  catalog_origin: string;
  preview_digest: string;
  frozen_card: AgentCard;
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  catalog_agent_id?: string;
  expected_catalog_agent_id?: string;
  merchant_id?: string;
  grant?: string;
  authorization_epoch?: number;
  binding_id?: string;
  active_card_revision?: number;
  expected_card_revision?: number;
  card_revision?: number;
}

function parsePublicOrigin(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new MerchantConnectError("PUBLIC_ORIGIN_MISSING", "商家服务还没有可用的公网 HTTPS 入口，买家暂时无法连接并询价。请先运行 `kiwi merchant setup-public` 查看 DNS/Caddy 配置指引，或使用 WorkBuddy 云端应用；完成后重新运行 `kiwi merchant connect`，已有资料会保留。地址格式通过不代表外部可访问，Catalog 还会执行真实端点挑战。");
  }
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "公网入口不是合法 URL；请设置 KIWI_A2A_PUBLIC_URL=https://你的域名");
  }
  const host = url.hostname.toLowerCase();
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  const ip = isIP(normalizedHost);
  const octets = ip === 4 ? normalizedHost.split(".").map(Number) : [];
  const privateIpv4 = ip === 4 && (
    octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 ||
    octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31 ||
    octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127 || (octets[0] ?? 0) >= 224
  );
  const privateIpv6 = ip === 6 && (
    normalizedHost === "::" || normalizedHost === "::1" || normalizedHost.startsWith("fc") ||
    normalizedHost.startsWith("fd") || normalizedHost.startsWith("fe80:") || normalizedHost.startsWith("::ffff:")
  );
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home") ||
      !host.includes(".") || privateIpv4 || privateIpv6) {
    throw new MerchantConnectError("PUBLIC_ORIGIN_INVALID", "商家服务尚未配置可用的公网 HTTPS origin。请运行 `kiwi merchant setup-public` 查看入口配置指引；资料已保留，配置后重新运行连接命令。");
  }
  return url.origin;
}

function writeState(dataDir: string, state: EnrollmentChallengeStore): void {
  writeFileAtomic(enrollmentStorePath(dataDir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function stateSession(dataDir: string, enrollmentId: string): ConnectState | undefined {
  const store = readEnrollmentStore(dataDir);
  const value = store.sessions.find((s) => s.enrollment_id === enrollmentId);
  return value as ConnectState | undefined;
}

/** Pure resume selection: only the same thumbprint+origin can reuse a grant/device code. */
export function selectReusableEnrollment(
  sessions: readonly AuthorizedEnrollment[],
  input: { runtimeOrigin: string; keyThumbprint: string; nowMs: number },
): AuthorizedEnrollment | undefined {
  return sessions.find((session) => {
    const state = session as ConnectState;
    return state.runtime_origin === input.runtimeOrigin && state.key_thumbprint === input.keyThumbprint &&
      ["preparing", "authorized", "bound", "published"].includes(state.status) &&
      (state.status === "published" || Number.isFinite(Date.parse(state.expires_at)) && Date.parse(state.expires_at) > input.nowMs);
  });
}

/** Keep the Catalog account's single-agent identity through key loss and address migration. */
export function priorPublishedCatalogAgentId(sessions: readonly AuthorizedEnrollment[]): string | undefined {
  const ids = new Set(sessions
    .map((session) => session as ConnectState)
    .filter((session) => session.status === "published" && typeof session.catalog_agent_id === "string")
    .map((session) => session.catalog_agent_id!));
  if (ids.size > 1) throw new MerchantConnectError("AMBIGUOUS_MIGRATION", "本Runtime已有多个Catalog Agent历史绑定；请在Catalog先确认要迁移的商家身份。");
  return ids.values().next().value as string | undefined;
}

async function verifyPublicRuntimeReady(
  origin: string,
  expectedEndpoint: string,
  identity: { keyid: string; publicKeyPem: string },
  fetchImpl: typeof fetch = globalThis.fetch,
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

export interface MerchantConnectOptions {
  profile: AgentProfile;
  dataDir: string;
  catalogUrl: string;
  publicOrigin?: string;
  openBrowser?: (url: string) => void;
  output?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 失败时保留设备状态、许可与绑定回执；重跑命令按相同 enrollment 继续。 */
export async function connectMerchant(options: MerchantConnectOptions): Promise<{ agentId: string; bindingId: string; cardRevision: number }> {
  if (options.profile.role !== "merchant") throw new MerchantConnectError("PROFILE_NOT_MERCHANT", "kiwi merchant connect 需要 merchant profile");
  const origin = parsePublicOrigin(options.publicOrigin ?? process.env.KIWI_A2A_PUBLIC_URL);
  const endpoint = `${origin}/a2a`;
  const identityRaw = loadOrCreateA2aSigningIdentity(options.dataDir, origin);
  const identity = { signingIdentity: toJwsSigningIdentity(identityRaw), keyId: identityRaw.keyid };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const client = new CatalogClient({ baseUrl: options.catalogUrl, fetchImpl });
  const output = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { keyThumbprint } = runtimePublicKey(identity);
  // 公开预览直接取运行中的真实 Agent Card，避免按 CLI 配置猜测 bearer/signature 能力。
  let card = await verifyPublicRuntimeReady(origin, endpoint, identityRaw, fetchImpl);
  const catalogOrigin = new URL(options.catalogUrl).origin;
  const store = readEnrollmentStore(options.dataDir);
  let state = selectReusableEnrollment(store.sessions, { runtimeOrigin: origin, keyThumbprint, nowMs: now().getTime() }) as ConnectState | undefined;

  if (state !== undefined) {
    if (state.catalog_origin !== catalogOrigin) throw new MerchantConnectError("CATALOG_MISMATCH", "待续办的接入任务属于另一个 Catalog；为防止许可串用，已停止。");
    if (state.frozen_card === undefined || typeof state.preview_digest !== "string") throw new MerchantConnectError("STATE_INVALID", "持久接入任务缺少冻结的公开名片，已停止。");
    const frozenDigest = `sha256:${createHash("sha256").update(canonicalize(state.frozen_card), "utf8").digest("hex")}`;
    if (frozenDigest !== state.preview_digest) throw new MerchantConnectError("STATE_INVALID", "持久化的已批准名片摘要不匹配，已停止。");
    const currentDigest = `sha256:${createHash("sha256").update(canonicalize(card), "utf8").digest("hex")}`;
    if (currentDigest !== state.preview_digest) {
      throw new MerchantConnectError(
        state.status === "published" ? "RUNTIME_CARD_CHANGED" : "PREVIEW_CHANGED",
        "公网服务当前的 Agent Card 与已批准预览不同；请核对变更并重新授权，Runtime不会静默更改已公开信息。",
      );
    }
    card = state.frozen_card;
    const existingAgentId = state.catalog_agent_id;
    const existingBindingId = state.binding_id;
    const existingCardRevision = state.card_revision;
    if (state.status === "published" && existingAgentId !== undefined && existingBindingId !== undefined && existingCardRevision !== undefined) {
      const active = await client.fetchPublicBinding(existingAgentId);
      if (active === null || active.bindingId !== existingBindingId || active.keyThumbprint !== keyThumbprint ||
          active.runtimeOrigin.replace(/\/+$/, "") !== origin || active.cardRevision !== existingCardRevision ||
          !Number.isFinite(Date.parse(active.expiresAt)) || Date.parse(active.expiresAt) <= now().getTime() ||
          !["ACTIVE", "active"].includes(active.publicationState)) {
        throw new MerchantConnectError("PUBLICATION_NOT_ACTIVE", "Catalog 当前没有返回这条绑定和已激活名片；服务可能已暂停或撤回。请到Catalog恢复服务后再检查，Runtime不会自动恢复营业。");
      }
      if (state.merchant_id === undefined) {
        state = { ...state, merchant_id: active.merchantId };
        const latest = readEnrollmentStore(options.dataDir);
        latest.sessions = latest.sessions.map((s) => s.enrollment_id === state?.enrollment_id ? state as ConnectState : s);
        writeState(options.dataDir, latest);
      } else if (state.merchant_id !== active.merchantId) {
        throw new MerchantConnectError("BINDING_MERCHANT_MISMATCH", "Catalog binding的merchant_id与本地Enrollment不一致，已停止。");
      }
      return { agentId: existingAgentId, bindingId: existingBindingId, cardRevision: existingCardRevision };
    }
  }

  if (state === undefined) {
    const expectedCatalogAgentId = priorPublishedCatalogAgentId(store.sessions);
    const session: DeviceEnrollmentSession = await client.createDeviceEnrollment({
      runtimeOrigin: origin,
      a2aEndpoint: endpoint,
      generation: 1,
      serviceEpoch: 1,
      publicPreview: card as unknown as Record<string, unknown>,
      publicProfileRevision: 1,
    }, identity);
    state = {
      enrollment_id: session.enrollmentId,
      runtime_origin: origin,
      key_thumbprint: keyThumbprint,
      catalog_origin: catalogOrigin,
      preview_digest: `sha256:${createHash("sha256").update(canonicalize(card), "utf8").digest("hex")}`,
      frozen_card: card,
      ...(expectedCatalogAgentId !== undefined ? { expected_catalog_agent_id: expectedCatalogAgentId } : {}),
      expires_at: session.expiresAt,
      status: "preparing",
      device_code: session.deviceCode,
      user_code: session.userCode,
      verification_uri: session.verificationUri,
      interval: session.intervalSeconds,
    };
    store.sessions = [...store.sessions.filter((s) => s.status === "bound" || s.status === "published"), state];
    writeState(options.dataDir, store);
  }

  if (state.status === "preparing") {
    output(`即将授权连接 ${options.profile.name ?? options.profile.agent_id}（配对码 ${state.user_code}）。请在 Catalog 页面确认店铺公开信息；不要把配对码发给他人。`);
    options.openBrowser?.(state.verification_uri);
    output(`授权页面：${state.verification_uri}`);
    output(`Runtime 已开始等待登录与一次「连接此服务并发布」确认；可 Ctrl+C 后重新运行命令继续。`);
    const deadline = Math.min(Date.parse(state.expires_at), now().getTime() + (options.timeoutMs ?? 10 * 60_000));
    let interval = state.interval * 1000;
    while (now().getTime() < deadline) {
      const result = await client.pollDeviceEnrollment(state.device_code, identity);
      if (result.status === "slow_down") interval = Math.max(interval + 5_000, result.intervalSeconds * 1000);
      else if (result.status === "authorization_pending") interval = Math.max(interval, result.intervalSeconds * 1000);
      else if (result.status === "authorized") {
        if (result.enrollmentId !== state.enrollment_id || result.runtimeOrigin !== origin || result.a2aEndpoint !== endpoint ||
            result.merchantId.trim() === "" ||
            state.expected_catalog_agent_id !== undefined && result.catalogAgentId !== state.expected_catalog_agent_id) {
          throw new MerchantConnectError("AUTHORIZED_MATERIAL_MISMATCH", "Catalog 授权材料与当前 Runtime 不一致，已停止连接。");
        }
        if (result.authorizationEpoch < 1 || result.approvedCardDigest !== state.preview_digest ||
            !result.scopes.includes("runtime:bind") || !result.scopes.includes("card:publish") ||
            !result.scopes.includes("heartbeat")) {
          throw new MerchantConnectError("GRANT_SCOPE_INVALID", "Catalog 接入许可缺少有效授权代次或必要范围，已停止。");
        }
        state = { ...state, status: "authorized", catalog_agent_id: result.catalogAgentId, merchant_id: result.merchantId, grant: result.grant, authorization_epoch: result.authorizationEpoch, expires_at: result.expiresAt };
        const latest = readEnrollmentStore(options.dataDir);
        latest.sessions = latest.sessions.map((s) => s.enrollment_id === state?.enrollment_id ? state as ConnectState : s);
        writeState(options.dataDir, latest);
        break;
      }
      await sleep(interval);
    }
  }

  state = stateSession(options.dataDir, state.enrollment_id) ?? state;
  if (state.status === "preparing") throw new MerchantConnectError("AUTHORIZATION_PENDING", "尚未完成商家授权。会话已保存，运行 kiwi merchant connect 可继续。");
  if (state.status === "authorized") {
    if (state.grant === undefined || state.catalog_agent_id === undefined || state.authorization_epoch === undefined || state.merchant_id === undefined) throw new MerchantConnectError("STATE_INVALID", "本地授权状态缺少许可、授权代次、merchant_id或 catalog_agent_id");
    const binding = await client.bindEnrollment({
      enrollmentId: state.enrollment_id,
      grant: state.grant,
      catalogAgentId: state.catalog_agent_id,
      merchantId: state.merchant_id,
      runtimeOrigin: origin,
      a2aEndpoint: endpoint,
      generation: 1,
      serviceEpoch: 1,
      authorizationEpoch: state.authorization_epoch,
    }, identity);
    if (binding.keyThumbprint !== keyThumbprint) throw new MerchantConnectError("BINDING_KEY_MISMATCH", "Catalog 绑定回执的密钥与本 Runtime 不一致");
    const rawClaims = binding.bindingClaim["claims"];
    const claimMerchantId = rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
      ? (rawClaims as Record<string, unknown>)["merchant_id"]
      : undefined;
    if (typeof claimMerchantId !== "string" || claimMerchantId.trim() === "") {
      throw new MerchantConnectError("BINDING_CLAIM_INVALID", "Catalog已签名绑定声明缺少merchant_id；名片保持未发布。");
    }
    state = {
      ...state,
      status: "bound",
      binding_id: binding.bindingId,
      merchant_id: claimMerchantId,
      expected_card_revision: binding.activeCardRevision ?? 0,
    };
    const latest = readEnrollmentStore(options.dataDir);
    latest.sessions = latest.sessions.map((s) => {
      if (s.enrollment_id === state?.enrollment_id) return state as ConnectState;
      const old = s as ConnectState;
      return old.status === "published" && old.catalog_agent_id === state?.catalog_agent_id &&
        old.binding_id !== state?.binding_id
        ? { ...old, status: "replaced" as const }
        : s;
    });
    writeState(options.dataDir, latest);
  }

  if (state.status === "bound") {
    if (state.catalog_agent_id === undefined || state.binding_id === undefined) throw new MerchantConnectError("STATE_INVALID", "绑定状态缺少回执字段");
    const catalogAgentId = state.catalog_agent_id;
    const bindingId = state.binding_id;
    const expectedRevision = state.expected_card_revision ?? 0;
    const currentCard = await verifyPublicRuntimeReady(origin, endpoint, identityRaw, fetchImpl);
    if (canonicalize(currentCard) !== canonicalize(card)) {
      throw new MerchantConnectError("PREVIEW_CHANGED", "公网服务的公开 Agent Card 已不同于商家批准的预览；未发布名片。请重新检查并授权新的公开信息。");
    }
    let cardRevision = state.card_revision;
    if (cardRevision === undefined) {
      const publication = await client.publishCard({
        agentId: catalogAgentId,
        bindingId,
        generation: 1,
        expectedRevision,
        agentCard: card,
        a2aEndpoint: endpoint,
        runtimeOrigin: origin,
      }, identity);
      if (publication.revision === null) throw new MerchantConnectError("PUBLICATION_RECEIPT_INVALID", "Catalog 未返回名片 revision；绑定已保留，重试可续办");
      cardRevision = publication.revision;
      state = { ...state, card_revision: cardRevision };
      const latest = readEnrollmentStore(options.dataDir);
      latest.sessions = latest.sessions.map((s) => s.enrollment_id === state?.enrollment_id ? state as ConnectState : s);
      writeState(options.dataDir, latest);
    }
    if (cardRevision === undefined) throw new MerchantConnectError("STATE_INVALID", "持久名片状态缺 revision");
    const activated = await client.activateCard({
      agentId: catalogAgentId,
      bindingId,
      cardRevision,
      expectedRevision,
    }, identity);
    if (activated.revision === null) throw new MerchantConnectError("ACTIVATION_RECEIPT_INVALID", "Catalog 未确认名片激活；绑定已保留，重试可续办");
    state = { ...state, status: "published", card_revision: activated.revision };
    const latest = readEnrollmentStore(options.dataDir);
    latest.sessions = latest.sessions.map((s) => s.enrollment_id === state?.enrollment_id ? state as ConnectState : s);
    writeState(options.dataDir, latest);
  }
  if (state.status !== "published" || state.catalog_agent_id === undefined || state.binding_id === undefined || state.card_revision === undefined) {
    throw new MerchantConnectError("STATE_INCOMPLETE", "连接流程尚未完成，未显示已上线。");
  }
  return { agentId: state.catalog_agent_id, bindingId: state.binding_id, cardRevision: state.card_revision };
}
