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

import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { loadOrCreateA2aSigningIdentity, toJwsSigningIdentity } from "../a2a/signing-key.js";
import { withEnrollmentStoreLock, reserveEnrollmentCreation } from "./binding/store-lock.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { ProductTableError } from "./product-source.js";
import { LocalShareVault } from "./access/local-share-vault.js";
import { OpenInquiryLocalPolicy } from "./access/open-inquiry-policy.js";
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
  type RuntimeAccessConsent,
  type RuntimeAccessContext,
  type RuntimeAccessProjection,
  type RuntimeSigningIdentity,
} from "./catalog-client.js";
import {
  assertShareLinkMatchesRuntimeOrigin,
  buildWorkbuddyAccessConfig,
  buildWorkbuddyAccessRevocation,
  parseWorkbuddyShareLink,
  WORKBUDDY_CUSTODY_TERMS_VERSION,
  WorkbuddyShareLinkError,
  type WorkbuddyAccessConfig,
} from "./access/workbuddy-share-link.js";
import {
  readAccessMode,
  writeAccessMode,
  type AccessModeState,
  type MerchantAccessMode,
} from "./access/access-mode.js";
import {
  enrollmentStorePath,
  readEnrollmentStore as readEnrollmentStoreRaw,
  type AuthorizedEnrollment,
  type EnrollmentChallengeStore,
} from "./binding/enrollment-challenge.js";

export type { AccessModeState, MerchantAccessMode } from "./access/access-mode.js";

/**
 * 一次公开探测的结论。`direct_ok` / `share_code_ok` 只描述本次 HTTP 观察，
 * **不**表示平台已加白；`uncertain` 是单次 401/403、网络错误、重定向或
 * 不完整响应唯一安全的结论。
 */
export type AccessDetectionStatus = "direct_ok" | "share_code_ok" | "uncertain";
export type AccessDetectionCode =
  | "public_card_readable"
  | "sharecode_public_card_readable"
  | "gate_rejected"
  | "share_code_missing"
  | "unexpected_redirect"
  | "network_error"
  | "response_ambiguous"
  | "http_error";

/**
 * 一次公开探测的脱敏结果。**不含**分享码、带码 URL、远端响应正文或 Cookie。
 * `shareCodeAvailable` 只是布尔值，不能反推凭据内容。
 */
export interface AccessDetectionResult {
  readonly status: AccessDetectionStatus;
  readonly code: AccessDetectionCode;
  readonly checkedAt: string;
  readonly mode: MerchantAccessMode;
  /** 本进程是否持有已授权分享码；只是布尔，绝不回传凭据。 */
  readonly shareCodeAvailable: boolean;
  readonly httpStatus: number | null;
  readonly detail: string;
  readonly guidance: string;
}

const observedSession = Symbol("connect-observed-session");
const sessionDigest = (item: AuthorizedEnrollment) =>
  createHash("sha256")
    .update(canonicalize(JSON.parse(JSON.stringify(item))))
    .digest("hex");
function readEnrollmentStore(dataDir: string): EnrollmentChallengeStore {
  const store = readEnrollmentStoreRaw(dataDir);
  for (const item of store.sessions)
    Object.defineProperty(item, observedSession, {
      value: sessionDigest(item),
      enumerable: true,
      writable: true,
    });
  return store;
}

/**
 * 确定性拒绝（4xx/本地校验失败）已证明**未产生远端副作用**，可以安全释放
 * operation_claim；其余（网络/5xx/未归类）保持 unknown，交给显式恢复
 * （review P1-7：此前所有失败都被打成 unknown，一次 grant 过期即可让会话
 * 永久卡死）。
 */
export const DETERMINISTIC_CONNECT_RELEASE_CODES = new Set([
  "BIND_REJECTED",
  "BIND_CLAIM_INVALID",
  "CARD_PUBLISH_REJECTED",
  "CARD_PUBLISH_INVALID",
  "PUBLICATION_RECEIPT_INVALID",
  "ACTIVATION_RECEIPT_INVALID",
  "STATE_CAS_CONFLICT",
]);

export function isDeterministicConnectRelease(error: unknown): boolean {
  return error instanceof MerchantConnectError && DETERMINISTIC_CONNECT_RELEASE_CODES.has(error.code);
}

export class MerchantConnectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
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
  "PAIRING_DENIED",
  "PUBLICATION_CHECK_FAILED",
  "PRODUCT_TABLE_INVALID",
  "PAIRING_WINDOW_EXPIRED", // 授权窗口（=Catalog grant 窗口）已过：需重新配对
  "BIND_REJECTED", // Catalog 拒绝 bind 请求（grant 过期/不匹配/版本冲突）
  "BIND_CLAIM_INVALID", // bind 已到达但签名声明未通过本地验真
  "CARD_PUBLISH_REJECTED", // 名片发布/激活被 Catalog 拒绝
  "CARD_PUBLISH_INVALID", // 发布/激活回执不完整或不合法
  "PAIRING_COMMUNICATION_FAILED", // 与 Catalog 通信失败（网络/5xx，可重试）
  "RUNTIME_UNREACHABLE",
  "RUNTIME_NOT_READY",
  "RUNTIME_IDENTITY_MISMATCH",
  "ACCESS_MODE_UNCERTAIN",
  "ACCESS_STATE_UNAVAILABLE",
  "CATALOG_RUNTIME_NOT_READY",
  "STATE_CAS_CONFLICT",
  "CONNECTION_OPERATION_PENDING",
  "CONNECTION_OPERATION_UNKNOWN",
  "CONNECT_STEP_FAILED", // 兜底：未归类步骤失败
  "AUTHORIZED_MATERIAL_MISMATCH",
  "GRANT_SCOPE_INVALID",
  "STATE_INVALID",
  "BINDING_KEY_MISMATCH",
  "BINDING_CLAIM_INVALID",
  "PREVIEW_CHANGED",
  "PUBLICATION_RECEIPT_INVALID",
  "ACTIVATION_RECEIPT_INVALID",
  "BIND_CLAIM_CARD_URL_MISMATCH",
  "BIND_CLAIM_FIELD_MISMATCH",
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
  const privateIpv4 =
    ip === 4 &&
    (octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) ||
      (octets[0] ?? 0) >= 224);
  const privateIpv6 =
    ip === 6 &&
    (host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80:") ||
      host.startsWith("::ffff:"));
  return (
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    !host.endsWith(".local") &&
    !host.endsWith(".internal") &&
    !host.endsWith(".lan") &&
    !host.endsWith(".home") &&
    host.includes(".") &&
    !privateIpv4 &&
    !privateIpv6
  );
}

/** 连接会话（merchant-enrollments.json 中单条 session 的完整形状）。 */
export interface ConnectionSession extends AuthorizedEnrollment {
  operation_claim?: {
    token: string;
    stage: string;
    state: "active" | "unknown";
    expires_at: string;
  };
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
  /**
   * WorkBuddy 访问配置的最近一次已知状态（M-03）。只保存脱敏投影：分享码
   * 由 Catalog 受控保存，运行时这一侧从不落盘、从不回显。
   */
  runtime_access?: RuntimeAccessRecord;
  /**
   * 随绑提交的分享码被目录按版本冲突跳过（目录保留既有配置，绝不覆盖）。只存
   * 脱敏元数据：商家要用工作台「提交或更新」（签名 + 权威版本 CAS）显式更换，
   * 不能靠重复绑定把旧码顶上去。
   */
  runtime_access_conflict?: { reason: string; head_version: number };
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
    if (
      state.runtime_origin !== input.runtimeOrigin ||
      state.key_thumbprint !== input.keyThumbprint
    )
      return false;
    if (!["preparing", "authorized", "bound", "published"].includes(state.status)) return false;
    if (state.status === "published") return true;
    const expiry = state.status === "bound" ? state.binding_expires_at : state.expires_at;
    return Number.isFinite(Date.parse(expiry ?? "")) && Date.parse(expiry ?? "") > input.nowMs;
  });
}

/** Keep the Catalog account's single-agent identity through key loss and address migration. */
export function priorPublishedCatalogAgentId(
  sessions: readonly AuthorizedEnrollment[],
): string | undefined {
  const ids = new Set(
    sessions
      .map((session) => session as ConnectionSession)
      .filter(
        (session) => session.status === "published" && typeof session.catalog_agent_id === "string",
      )
      .map((session) => session.catalog_agent_id!),
  );
  if (ids.size > 1)
    throw new MerchantConnectError(
      "AMBIGUOUS_MIGRATION",
      "本Runtime已有多个Catalog Agent历史绑定；请在Catalog先确认要迁移的商家身份。",
    );
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
  /**
   * 可选：WorkBuddy 分享链接（`KIWI_CLOUD_ACCESS_SHARE_LINK`）。设置后首绑会
   * 随绑定提交访问配置（Catalog 暂存并在绑定提交时激活）。后续更新/撤销走
   * 工作台 `PUT runtime-access`。
   */
  accessShareLink?: string;
  /**
   * 入站 A2A 认证模式（G0 §1.1.3）：WorkBuddy 路径只支持 `signature`。
   * `bearer` 下提交访问配置会 fail-closed（平台会改写 Authorization，bearer
   * 身份不可用于业务授权；不静默降级）。
   */
  a2aAuthMode?: "signature" | "bearer";
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
  /** Locally verified binding identity for the synchronous endpoint challenge. */
  getChallengeIdentity(): { merchantId: string; agentId: string } | undefined;
  /** WorkBuddy 访问配置的本地已知状态（M-04：平台门禁是独立于绑定的信号）。 */
  getAccessSummary(): RuntimeAccessSummary;
  /** 当前接入方式偏好（只读、非凭据；损坏文件按 auto 回退）。 */
  getAccessMode(): AccessModeState;
  /**
   * 保存接入方式偏好：本地原子写后，尽力经 active binding 签名同步到
   * Catalog 的公开 `buyer_access` 投影。同步失败不回滚本地选择，也不
   * **撤销 runtime-access、不删除已保存分享码、不清除本进程读卡凭据**；
   * 页面会显示未同步状态。`share_code` 不会自动要求重新同意条款。
   */
  setAccessMode(mode: MerchantAccessMode): Promise<RuntimeAccessSummary>;
  /**
   * 对当前实例（构造时的已验证 publicOrigin）做一次公开、无凭据默认的探测。
   * 不接收目标 URL；单次 401/403/网络错误/坏响应一律返回 `uncertain`。
   */
  detectAccess(): Promise<AccessDetectionResult>;
  /** 向 Catalog 拉取权威状态（签名 GET）；本地状态丢失时用它恢复版本。 */
  refreshAccess(): Promise<RuntimeAccessSummary>;
  /**
   * 商家粘贴分享链接 → 提交/更新访问配置（M-02/M-03）；分享码永不回显。
   * `consentTermsVersion` 必须等于现行代管条款版本，否则拒绝（授权是前置条件）。
   */
  submitAccessShareLink(rawLink: string, consentTermsVersion?: string): Promise<RuntimeAccessSummary>;
  /** 撤销访问配置（M-03）；停止向 Buyer 发放分享码。 */
  revokeAccess(): Promise<RuntimeAccessSummary>;
  readBoundAccount(): Promise<string | null>;
  readPublicInquiryConsent(): Promise<PublicInquiryConsentSummary>;
  setPublicInquiryConsent(granted: boolean): Promise<PublicInquiryConsentSummary>;
}

export interface PublicInquiryConsentSummary {
  granted: boolean;
  policyActive: boolean;
  localEnabled: boolean;
  termsVersion: string;
}

/** WorkBuddy 访问配置对工作台可见的状态（`none` = Catalog 上没有配置）。 */
export type RuntimeAccessStatus = "none" | "pending" | "active" | "invalid" | "revoked";

export interface RuntimeAccessSummary {
  /** 平台门禁是否已配置为 active（不等于运行时健康，也不等于绑定有效）。 */
  configured: boolean;
  status: RuntimeAccessStatus;
  configVersion: number;
  provider: string | null;
  adapterVersion: string | null;
  authMode: string | null;
  updatedAt: string | null;
  /** 目录代管总开关（运营侧止血用，本地只是镜像）。 */
  custodyEnabled: boolean;
  /** 商家对"目录代管并只向已接受的采购方出示"的授权是否有效。 */
  consentGranted: boolean;
  consentTermsVersion: string | null;
  /** 废弃原因：`superseded` / `merchant_revoked` / 空。 */
  statusReason: string;
  /** 近 24h 采购方报告的门禁失败数（0 = 正常）。 */
  recentFaults: number;
  recentFaultsLastAt: string;
  /** 商家选择的接入方式（本地非凭据偏好）；缺省 `auto`。 */
  mode: MerchantAccessMode;
  /** 模式是否来自持久化偏好；false 表示旧实例/未选择，按 auto 运行。 */
  modePersisted: boolean;
  /** 偏好文件存在但不可解析：安全回退 auto，不删除任何已有分享码。 */
  modeInvalid: boolean;
  /** 本进程最近一次显式检测结果；重启后为 null（不持久化过时结论）。 */
  detection: AccessDetectionResult | null;
  /** 最近一次确认写入目录的接入方式；null 表示尚未同步/旧目录。 */
  catalogMode: MerchantAccessMode | null;
  /** 目录侧单调 revision；null 表示尚未成功同步。 */
  catalogRevision: number | null;
  /** 本地模式是否与最近一次确认的目录模式一致。 */
  catalogSynced: boolean;
  /**
   * 目录同步状态：`synced` / `pending`（本地已保存但尚未确认）/
   * `failed`（最近一次同步失败）/ `unsupported`（旧目录无该端点）/
   * `unbound`（尚未完成绑定）。
   */
  catalogSync: "synced" | "pending" | "failed" | "unsupported" | "unbound";
  /** 稳定错误码（不含 URL/分享码/远端正文）；无错误为 null。 */
  catalogSyncError: string | null;
}

/** 会话内持久化的访问配置投影（只有脱敏元数据，没有分享码）。 */
export interface RuntimeAccessRecord {
  config_version: number;
  status: RuntimeAccessStatus;
  status_reason?: string;
  custody_enabled?: boolean;
  recent_faults?: number;
  recent_faults_last_at?: string;
  consent_granted?: boolean;
  consent_terms_version?: string | null;
  consent_granted_at?: string | null;
  provider: string | null;
  access_mode: string | null;
  parameter_name: string | null;
  adapter_version: string | null;
  auth_mode: string | null;
  updated_at: string;
}

/** 会话里的脱敏投影 → 工作台视图；没有记录即"未配置"。 */
function accessSummaryOf(
  session: ConnectionSession | undefined,
  modeState: AccessModeState,
  detection: AccessDetectionResult | null,
  syncError: string | null,
): RuntimeAccessSummary {
  const record = session?.runtime_access;
  const bound = session !== undefined && session.binding_id !== undefined;
  const catalog = modeState.catalog;
  const catalogSynced = catalog !== undefined && catalog.mode === modeState.mode;
  const catalogSync: RuntimeAccessSummary["catalogSync"] = !bound
    ? "unbound"
    : syncError === "UNSUPPORTED"
      ? "unsupported"
      : syncError !== null
        ? "failed"
        : catalogSynced
          ? "synced"
          : "pending";
  return {
    configured: record?.status === "active",
    status: record?.status ?? "none",
    configVersion: record?.config_version ?? 0,
    provider: record?.provider ?? null,
    adapterVersion: record?.adapter_version ?? null,
    authMode: record?.auth_mode ?? null,
    updatedAt: record?.updated_at ?? null,
    custodyEnabled: record?.custody_enabled ?? true,
    consentGranted: record?.consent_granted ?? false,
    consentTermsVersion: record?.consent_terms_version ?? null,
    statusReason: record?.status_reason ?? "",
    recentFaults: record?.recent_faults ?? 0,
    recentFaultsLastAt: record?.recent_faults_last_at ?? "",
    mode: modeState.mode,
    modePersisted: modeState.persisted,
    modeInvalid: modeState.invalid,
    detection,
    catalogMode: catalog?.mode ?? null,
    catalogRevision: catalog?.revision ?? null,
    catalogSynced,
    catalogSync,
    catalogSyncError: syncError,
  };
}

/** 接入方式同步失败 → 稳定码（不含 URL/分享码/远端正文）。 */
function accessSyncErrorCode(error: unknown): string {
  if (error instanceof CatalogClientError) {
    if (error.code === "NOT_FOUND") return "UNSUPPORTED";
    if (error.code === "CATALOG_UNREACHABLE") return "UNREACHABLE";
    if (error.code === "CONFLICT") return "CONFLICT";
    if (error.code === "REQUEST_REJECTED") return "REJECTED";
    if (error.code === "RESPONSE_INVALID") return "RESPONSE_INVALID";
    return error.code;
  }
  return "SYNC_FAILED";
}

/**
 * 访问配置写失败 → 工作台安全码。绝不携带分享码、完整带码 URL 或远端原文：
 * 只保留自有码与一句可展示的说明。
 */
function accessError(error: unknown): MerchantConnectError {
  if (error instanceof WorkbuddyShareLinkError) {
    return new MerchantConnectError(error.code, error.message);
  }
  if (error instanceof CatalogClientError) {
    switch (error.code) {
      case "CONFLICT":
        return new MerchantConnectError(
          "ACCESS_VERSION_CONFLICT",
          "访问配置版本冲突，请刷新状态后重试",
        );
      case "REQUEST_REJECTED":
        return new MerchantConnectError(
          "ACCESS_REJECTED",
          "Catalog 拒绝了访问配置，请确认绑定仍有效后重试",
        );
      case "NOT_FOUND":
        return new MerchantConnectError(
          "ACCESS_NOT_FOUND",
          "Catalog 上没有该 Agent 的活动绑定",
        );
      case "CATALOG_UNREACHABLE":
        return new MerchantConnectError("ACCESS_UNAVAILABLE", "Catalog 暂不可达，请稍后重试");
      default:
        return new MerchantConnectError("ACCESS_REJECTED", "访问配置提交失败");
    }
  }
  return new MerchantConnectError("ACCESS_UNAVAILABLE", "访问配置提交失败");
}

function cardDigest(card: AgentCard): string {
  return `sha256:${createHash("sha256")
    .update(canonicalize(card as unknown as Record<string, unknown>), "utf8")
    .digest("hex")}`;
}

/**
 * 一次公开 Agent Card 请求的原始观察。这里不决定“是否需要分享码”或“是否
 * 加白”，只记录本次 HTTP 事实；解释语义由 `fetchPublicCard` / `detectAccess`
 * 按各自场景收敛，避免把单次 401/403、网络错误或坏响应误报成“未加白”。
 */
type PublicCardProbe =
  | { readonly kind: "ok"; readonly card: AgentCard }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "redirect"; readonly status: number }
  | { readonly kind: "invalid"; readonly code: "timeout" | "network" | "response" };

/**
 * 只对调用方给定的 origin 发一次 GET；固定 well-known 路径，`redirect: "manual"`
 * 且不跟随 3xx，`credentials: "omit"`，响应体读取受同一 AbortController 与大小
 * 上限保护。`shareSecret` 只会追加到本 origin 的固定路径，不参与任何重定向目标。
 */
async function requestPublicCard(
  origin: string,
  fetchImpl: typeof fetch,
  shareSecret?: string,
): Promise<PublicCardProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const url = new URL(`${origin}/.well-known/agent-card.json`);
  if (shareSecret !== undefined) url.searchParams.set("sharecode", shareSecret);
  try {
    const response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (isRedirectResponse(response)) return { kind: "redirect", status: response.status };
    if (!response.ok) return { kind: "http", status: response.status };
    try {
      const card = validateAgentCard(await readJsonBody(response, { signal: controller.signal }));
      return { kind: "ok", card };
    } catch {
      return { kind: "invalid", code: "response" };
    }
  } catch {
    return { kind: "invalid", code: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** 校验公开卡与当前 Runtime 地址/签名身份一致；不涉及平台加白/门禁结论。 */
function assertPublicCard(
  card: AgentCard,
  origin: string,
  expectedEndpoint: string,
  identity: { keyid: string; publicKeyPem: string },
): AgentCard {
  const urls = card.supportedInterfaces.map((entry) => entry.url);
  if (
    typeof card.url !== "string" ||
    new URL(card.url).origin !== origin ||
    !urls.includes(expectedEndpoint)
  ) {
    throw new MerchantConnectError(
      "RUNTIME_NOT_READY",
      "公网入口返回的 Agent Card 与当前 Runtime 地址不一致；未发布名片。请检查反向代理与服务配置后重试。",
    );
  }
  const signatureScheme = card.securitySchemes?.["kiwi-signature"];
  if (
    signatureScheme !== undefined &&
    (signatureScheme.type !== "kiwi-http-message-signature" ||
      signatureScheme.keyid !== identity.keyid ||
      signatureScheme.publicKeyPem !== identity.publicKeyPem ||
      signatureScheme.algorithm !== "ed25519")
  ) {
    throw new MerchantConnectError(
      "RUNTIME_IDENTITY_MISMATCH",
      "公网服务的 A2A 签名声明与当前 Runtime 持久密钥不一致；未发布名片。请在实际承接请求的 Runtime 主机上运行连接命令。",
    );
  }
  return card;
}

/** 门禁拒绝/异常响应的统一安全提示：不推断“未加白”，只给可执行下一步。 */
function uncertainAccessError(
  mode: MerchantAccessMode,
  shareAttempted: boolean,
): MerchantConnectError {
  return new MerchantConnectError(
    "ACCESS_MODE_UNCERTAIN",
    `暂时无法确认本实例的接入方式：本次公开读取${shareAttempted ? "（含已暂存分享码）" : ""}未被接受。` +
      "单次 401/403、网络错误或不完整响应都不能判定实例是否加白。" +
      (mode === "share_code"
        ? "请核对分享码是否已在平台侧更换或失效，然后重新提交分享链接。"
        : mode === "no_share_code"
          ? "当前选择「无分享码」；如平台门禁确实要求分享码，请提交本实例分享链接后切换为自动检测或使用分享码。"
          : "请先确认服务已启动、公网入口与 TLS 正常；如平台门禁确实拦截，可由商家提交本实例分享链接后重试。") +
      "目录里已保存的分享码不会被删除。",
  );
}

/**
 * 把一次探测失败收敛成稳定错误。只有 401/403 是门禁信号但仍不足以判定
 * 加白，所以统一给 `ACCESS_MODE_UNCERTAIN`；其它错误沿用原有运行时就绪码。
 */
function probeFailure(
  probe: Exclude<PublicCardProbe, { kind: "ok" }>,
  mode: MerchantAccessMode,
  shareAttempted: boolean,
): MerchantConnectError {
  if (probe.kind === "http") {
    if (probe.status === 401 || probe.status === 403)
      return uncertainAccessError(mode, shareAttempted);
    return new MerchantConnectError(
      "RUNTIME_UNREACHABLE",
      `暂时无法从外部读取商家服务的 Agent Card（HTTP ${probe.status}）。请确认服务已启动且公网入口可访问，然后重试。`,
    );
  }
  if (probe.kind === "redirect") {
    return new MerchantConnectError(
      "RUNTIME_UNREACHABLE",
      "公网入口返回了重定向；为避免把请求或凭据带到未校验的目标，已停止。请检查反向代理配置后重试。",
    );
  }
  if (probe.code === "response") {
    return new MerchantConnectError(
      "RUNTIME_NOT_READY",
      "公网入口返回的 Agent Card 不完整或不合法；未发布名片。该结果不能用于判断平台加白状态，请检查服务响应后重试。",
    );
  }
  if (shareAttempted) {
    return new MerchantConnectError(
      "RUNTIME_UNREACHABLE",
      "暂时无法通过 WorkBuddy 分享链接读取商家名片。请核对分享链接与服务状态后重试。",
    );
  }
  return new MerchantConnectError(
    "RUNTIME_UNREACHABLE",
    probe.code === "timeout"
      ? "读取商家公开名片超时。请确认服务已启动、TLS 证书有效且允许公网访问，然后重试。"
      : "暂时无法从外部连接你的商家服务。请确认服务已启动、TLS 证书有效且允许公网访问，然后重试。",
  );
}

/**
 * 缺省公开卡加载：与 CLI verifyPublicRuntimeReady 同口径（匿名读 + 签名声明
 * 核对）。接入方式只影响“是否/何时追加分享码”，不放宽地址、身份或签名校验。
 *
 * - `share_code`：显式带码读取；没有码就在任何网络动作前失败。
 * - `no_share_code`：只做无码读取；即使本进程有码也不发送。
 * - `auto`：先无码读取；只有明确 401/403 且本进程有已授权分享码时才带码
 *   重试一次。网络错误/5xx/重定向/坏响应不拿分享码去试探。
 */
async function fetchPublicCard(
  origin: string,
  expectedEndpoint: string,
  identity: { keyid: string; publicKeyPem: string },
  fetchImpl: typeof fetch,
  shareSecret: string | undefined,
  mode: MerchantAccessMode,
): Promise<AgentCard> {
  const verify = (probe: PublicCardProbe, shareAttempted: boolean): AgentCard => {
    if (probe.kind === "ok")
      return assertPublicCard(probe.card, origin, expectedEndpoint, identity);
    throw probeFailure(probe, mode, shareAttempted);
  };

  if (mode === "share_code") {
    if (shareSecret === undefined) {
      throw new MerchantConnectError(
        "ACCESS_SHARE_LINK_REQUIRED",
        "已选择「使用分享码」，但本进程没有可用的分享码。请由商家重新提交本实例的分享链接；目录里已保存的分享码不会被删除。",
      );
    }
    return verify(await requestPublicCard(origin, fetchImpl, shareSecret), true);
  }

  if (mode === "no_share_code") {
    return verify(await requestPublicCard(origin, fetchImpl), false);
  }

  const direct = await requestPublicCard(origin, fetchImpl);
  if (direct.kind === "ok") return verify(direct, false);
  if (
    direct.kind === "http" &&
    (direct.status === 401 || direct.status === 403) &&
    shareSecret !== undefined
  ) {
    return verify(await requestPublicCard(origin, fetchImpl, shareSecret), true);
  }
  return verify(direct, false);
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
  private readonly fetchImpl: typeof fetch;
  private readonly loadPublicCard: () => Promise<AgentCard>;
  private readonly beforePublish: ((binding: VerifiedBinding) => Promise<void>) | undefined;
  /**
   * 首绑时随绑定提交的 WorkBuddy 访问配置（可选，一鍵上云用）。
   * 只在 `stepAuthorized` 的 enrollment 绑定里使用；后续更新/撤销一律走
   * 工作台的 PUT runtime-access（版本可读、可撤销）。
   */
  private firstBindAccessConfig: WorkbuddyAccessConfig | undefined;
  private readonly shareVault: LocalShareVault;
  private readonly inquiryPolicy: OpenInquiryLocalPolicy;
  private localShareInvalid = false;
  private readonly a2aAuthMode: "signature" | "bearer";
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
  /** 本进程最近一次显式检测；不落盘，避免把过时结论当成当前事实。 */
  private lastDetection: AccessDetectionResult | null = null;
  /** 最近一次接入方式同步失败的稳定码（不落盘；重启后重新对账）。 */
  private lastAccessSyncError: string | null = null;

  constructor(options: MerchantConnectionServiceOptions) {
    this.dataDir = options.dataDir;
    this.generation = options.generation ?? 1;
    this.serviceEpoch = options.serviceEpoch ?? 1;
    this.a2aAuthMode = options.a2aAuthMode ?? "signature";
    const shareLink = String(options.accessShareLink ?? "").trim();
    const trimmed = String(options.publicOrigin ?? "")
      .trim()
      .replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new MerchantConnectError(
        "PUBLIC_ORIGIN_INVALID",
        "公网入口不是合法 URL；请设置 KIWI_A2A_PUBLIC_URL=https://你的域名",
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      throw new MerchantConnectError(
        "PUBLIC_ORIGIN_INVALID",
        "公网入口不是合法 URL；请设置 KIWI_A2A_PUBLIC_URL=https://你的域名",
      );
    }
    // 与 CLI parsePublicOrigin 同一白名单口径：生产构造必须提供公网可达 host；
    // 只有显式 allowPrivateOrigin（测试/本地回环）才放宽。
    if (options.allowPrivateOrigin !== true && !isPublicHostAllowed(parsed.hostname)) {
      throw new MerchantConnectError(
        "PUBLIC_ORIGIN_INVALID",
        "商家服务尚未配置可用的公网 HTTPS origin。请运行 `kiwi merchant setup-public` 查看入口配置指引；资料已保留，配置后重新运行连接命令。",
      );
    }
    this.origin = normalizeOrigin(trimmed);
    this.a2aEndpoint = `${this.origin}/a2a`;
    if (shareLink === "") {
      this.firstBindAccessConfig = undefined;
    } else {
      // 认证模式冲突必须显式失败：bearer 模式下分享码登记没有意义。
      this.assertSignatureAuthMode();
      // 配置错误必须显式失败（不静默跳过）：链接不属于本实例就说明商家配错了。
      const link = parseWorkbuddyShareLink(shareLink);
      assertShareLinkMatchesRuntimeOrigin(link, this.origin);
      this.firstBindAccessConfig = buildWorkbuddyAccessConfig(link, 0);
    }
    this.client = new CatalogClient({
      baseUrl: options.catalogUrl,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.identityRaw = loadOrCreateA2aSigningIdentity(this.dataDir, this.origin);
    this.shareVault = new LocalShareVault(this.dataDir, this.identityRaw.privateKeyPem, this.origin);
    this.inquiryPolicy = new OpenInquiryLocalPolicy(this.dataDir, this.origin);
    try {
      const persisted = this.shareVault.get();
      if (persisted !== undefined) {
        const saved = JSON.parse(persisted) as { link?: unknown; consentTermsVersion?: unknown; revoked?: unknown };
        if (saved.revoked === true) {
          // A local revocation overrides any stale process environment on restart.
          this.firstBindAccessConfig = undefined;
        } else {
          if (typeof saved.link !== "string" || saved.consentTermsVersion !== WORKBUDDY_CUSTODY_TERMS_VERSION)
            throw new MerchantConnectError("STATE_INVALID", "分享链接暂存状态无效，请重新配置。");
          const link = parseWorkbuddyShareLink(saved.link);
          assertShareLinkMatchesRuntimeOrigin(link, this.origin);
          this.firstBindAccessConfig = buildWorkbuddyAccessConfig(link, 0, saved.consentTermsVersion);
        }
      }
    } catch {
      // A damaged or wrong-key local vault cannot authorize use of an old environment value.
      // Keep the management page available so the owner can replace or revoke the link.
      this.firstBindAccessConfig = undefined;
      this.localShareInvalid = true;
    }
    this.identity = {
      signingIdentity: toJwsSigningIdentity(this.identityRaw),
      keyId: this.identityRaw.keyid,
    };
    this.keyThumbprint = runtimePublicKey(this.identity).keyThumbprint;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.loadPublicCard =
      options.loadPublicCard ??
      (async () =>
        await fetchPublicCard(
          this.origin,
          this.a2aEndpoint,
          {
            keyid: this.identityRaw.keyid,
            publicKeyPem: this.identityRaw.publicKeyPem,
          },
          this.fetchImpl,
          this.firstBindAccessConfig?.secret_value,
          readAccessMode(this.dataDir).mode,
        ));
    this.beforePublish = options.beforePublish;
  }

  // ── 公开接口 ─────────────────────────────────────────────────────────

  async begin(): Promise<ConnectionSummary> {
    return await this.withLock(async () => {
      if (readAccessMode(this.dataDir).mode === "share_code" &&
          this.firstBindAccessConfig === undefined) {
        throw new MerchantConnectError(
          "ACCESS_SHARE_LINK_REQUIRED",
          "已选择「使用分享码」，但本实例还没有可用的分享码。请先提交并授权本实例的 WorkBuddy 分享链接，再发起目录连接。",
        );
      }
      const card = await this.loadPublicCard();
      const currentDigest = cardDigest(card);
      const store = readEnrollmentStore(this.dataDir);
      const session = this.selectSession(store);
      const catalogOrigin = this.client.catalogOrigin;
      if (session !== undefined) {
        if (session.catalog_origin !== catalogOrigin) {
          throw new MerchantConnectError(
            "CATALOG_MISMATCH",
            "待续办的接入任务属于另一个 Catalog；为防止许可串用，已停止。",
          );
        }
        const frozenDigest = cardDigest(session.frozen_card);
        if (typeof session.preview_digest !== "string" || frozenDigest !== session.preview_digest) {
          throw new MerchantConnectError(
            "STATE_INVALID",
            "持久接入任务缺少冻结的公开名片，已停止。",
          );
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
            this.availability =
              err instanceof MerchantConnectError
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
        throw new MerchantConnectError(
          "CATALOG_MISMATCH",
          "待续办的接入任务属于另一个 Catalog；为防止许可串用，已停止。",
        );
      }
      if (
        store.sessions.some((item) => {
          const s = item as ConnectionSession;
          return (
            s.runtime_origin === this.origin &&
            s.key_thumbprint === this.keyThumbprint &&
            s.operation_claim &&
            s.operation_claim.stage !== "poll"
          );
        })
      )
        throw new MerchantConnectError(
          "CONNECTION_OPERATION_UNKNOWN",
          "Unresolved enrollment effect must be reconciled",
        );
      const expectedCatalogAgentId = priorPublishedCatalogAgentId(store.sessions);
      let creation: ReturnType<typeof reserveEnrollmentCreation>;
      try {
        creation = reserveEnrollmentCreation(
          this.dataDir,
          `${this.origin}|${this.client.catalogOrigin}|${this.keyThumbprint}|${this.generation}`,
        );
      } catch {
        throw new MerchantConnectError(
          "CONNECTION_OPERATION_UNKNOWN",
          "Enrollment creation is claimed; reconcile before retrying",
        );
      }
      let creationSettled = false;
      try {
        if (this.selectSession(readEnrollmentStore(this.dataDir)) !== undefined) {
          creationSettled = true;
          throw new MerchantConnectError(
            "STATE_CAS_CONFLICT",
            "Enrollment was created by another instance",
          );
        }
        const enrollment = await this.client.createDeviceEnrollment(
          {
            runtimeOrigin: this.origin,
            a2aEndpoint: this.a2aEndpoint,
            generation: this.generation,
            serviceEpoch: this.serviceEpoch,
            publicPreview: card as unknown as Record<string, unknown>,
            publicProfileRevision: 1,
          },
          this.identity,
        );
        const next: ConnectionSession = {
          enrollment_id: enrollment.enrollmentId,
          runtime_origin: this.origin,
          key_thumbprint: this.keyThumbprint,
          catalog_origin: catalogOrigin,
          preview_digest: currentDigest,
          frozen_card: card,
          generation: this.generation,
          ...(expectedCatalogAgentId !== undefined
            ? { expected_catalog_agent_id: expectedCatalogAgentId }
            : {}),
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
              old.runtime_origin === this.origin &&
              old.key_thumbprint === this.keyThumbprint &&
              old.status === "preparing"
              ? { ...old, status: "canceled" as const }
              : item;
          }),
          next,
        ]);
        this.nextPollAtMs = 0;
        this.publicationVerified = false;
        this.availability = null;
        creationSettled = true;
        return this.toSummary(next);
      } finally {
        if (creationSettled) creation.complete();
      }
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
          this.persist((fresh) =>
            fresh.sessions.map((item) =>
              item.enrollment_id === stale.enrollment_id ? expired : item,
            ),
          );
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
        if (current.status === "preparing") {
          stage = "preparing";
          current = await this.claimedStep(
            current,
            "poll",
            () => this.stepPreparing(current),
            true,
          );
          stage = current.status;
        }
        if (current.status === "authorized") {
          stage = "authorized";
          current = await this.claimedStep(
            current,
            "bind",
            () => this.stepAuthorized(current),
            false,
          );
          stage = current.status;
        }
        if (current.status === "bound") {
          stage = "bound";
          current = await this.claimedStep(
            current,
            "publish",
            () => this.stepBound(current),
            false,
          );
          stage = current.status;
        }
      } catch (err) {
        // 阶段感知稳定码：绑定被拒 vs 签名声明验真失败 vs 通信失败可被 owner
        // API/UI 辨别；码值恒在本文件导出的固定集合内。
        this.availability = {
          code: this.stepFailureCode(stage, err),
          detail: err instanceof ProductTableError ? "商品表绑定或校验失败，请检查商品表归属与格式。" : "",
        };
        throw err;
      }
      if (current.status === "published") {
        // 显式 reconcile（含用户操作）每次都核对 Catalog；后台轮询节流放在
        // bootstrap 的 tick 层（published 会话 60s 一次，onboarding 仍 5s）。
        try {
          await this.assertPublicationActive(current);
        } catch (err) {
          // 撤回/暂停/网络不可达一律 fail-closed：summary 报未发布（paused/error），
          // 绝不自动恢复营业、不发任何写请求；下趟 reconcile 会重新核对。
          this.publicationVerified = false;
          this.availability =
            err instanceof MerchantConnectError
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
      return (
        session.status === "expired" &&
        session.runtime_origin === this.origin &&
        session.key_thumbprint === this.keyThumbprint &&
        session.catalog_origin === this.client.catalogOrigin &&
        (session.generation ?? 1) === this.generation
      );
    });
    return candidates.at(-1) as ConnectionSession | undefined;
  }

  /** 失败码映射：自有稳定码原样透出；CatalogClientError 按阶段归类到固定安全码。 */
  private stepFailureCode(stage: ConnectionSession["status"], err: unknown): string {
    if (err instanceof MerchantConnectError) {
      return CONNECTION_PAIRING_SAFE_CODES.has(err.code) ? err.code : "CONNECT_STEP_FAILED";
    }
    if (err instanceof ProductTableError) return "PRODUCT_TABLE_INVALID";
    if (err instanceof CatalogClientError) {
      if (err.code === "AUTHORIZATION_DENIED") return "PAIRING_DENIED";
      if (err.code === "CATALOG_UNREACHABLE") return "PAIRING_COMMUNICATION_FAILED";
      if (stage === "authorized") {
        if (err.code === "REQUEST_REJECTED" || err.code === "CONFLICT") return "BIND_REJECTED";
        if (err.code === "RESPONSE_INVALID") return "BIND_CLAIM_INVALID";
        if (err.code === "CLAIM_MISMATCH") {
          const fields = (err as CatalogClientError & { claimFields?: string[] }).claimFields ?? [];
          return fields.includes("card_url")
            ? "BIND_CLAIM_CARD_URL_MISMATCH"
            : "BIND_CLAIM_FIELD_MISMATCH";
        }
      }
      if (stage === "bound") {
        if (err.code === "REQUEST_REJECTED" || err.code === "CONFLICT")
          return "CARD_PUBLISH_REJECTED";
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
      this.availability =
        err instanceof MerchantConnectError
          ? { code: err.code, detail: err.message }
          : {
              code: "PUBLICATION_CHECK_FAILED",
              detail: "Catalog publication could not be verified",
            };
      return null;
    }
  }

  getChallengeIdentity(): { merchantId: string; agentId: string } | undefined {
    const session = this.selectSession(readEnrollmentStore(this.dataDir));
    // These values are written only after the Catalog binding claim is verified.
    // The Catalog rechecks its active binding before accepting the challenge proof.
    if (session === undefined || !["bound", "published"].includes(session.status) ||
        !session.binding_id || !session.binding_version || !session.merchant_id || !session.catalog_agent_id)
      return undefined;
    return { merchantId: session.merchant_id, agentId: session.catalog_agent_id };
  }

  // ── WorkBuddy 访问配置（M-02/M-03/M-04）────────────────────────────

  getAccessSummary(): RuntimeAccessSummary {
    const session = this.selectSession(readEnrollmentStore(this.dataDir));
    const modeState = readAccessMode(this.dataDir);
    // 检测结论只在同一模式内有意义；模式切换后不把旧结论当新选择的结果。
    const detection =
      this.lastDetection !== null && this.lastDetection.mode === modeState.mode
        ? this.lastDetection
        : null;
    const summary = accessSummaryOf(
      session as ConnectionSession | undefined,
      modeState,
      detection,
      this.lastAccessSyncError,
    );
    if (this.localShareInvalid) return { ...summary, configured: false, status: "invalid", statusReason: "local_vault_invalid" };
    // 目录已有分享码、随绑凭据被按版本冲突跳过：不能显示成"已加密暂存，继续
    // 连接即可生效"（那会诱导重复绑定去顶掉目录里的码），要给出唯一的可恢复
    // 路径——商家用工作台「提交或更新」按权威版本显式更换。
    if ((session as ConnectionSession | undefined)?.runtime_access_conflict !== undefined &&
        summary.status === "none") {
      return { ...summary, configured: false, status: "invalid", statusReason: "catalog_access_exists" };
    }
    if (this.firstBindAccessConfig !== undefined && summary.status === "none") {
      if (modeState.mode === "no_share_code") {
        // 本地仍保留已同意的分享码，但当前模式明确不使用：不能显示成
        // “继续连接即会生效”，也不能让首次绑定悄悄把它提交给目录。
        return { ...summary, status: "none", statusReason: "local_saved_not_used",
          consentGranted: true,
          consentTermsVersion: this.firstBindAccessConfig.consent.terms_version };
      }
      return { ...summary, status: "pending", statusReason: "local_staged", consentGranted: true,
        consentTermsVersion: this.firstBindAccessConfig.consent.terms_version };
    }
    return summary;
  }

  getAccessMode(): AccessModeState {
    return readAccessMode(this.dataDir);
  }

  async setAccessMode(mode: MerchantAccessMode): Promise<RuntimeAccessSummary> {
    return await this.withLock(async () => {
      const previous = readAccessMode(this.dataDir);
      try {
        // 只写模式文件（保留已有目录 revision）；绝不调用 Catalog 撤销/更新
        // runtime-access，也不清 firstBindAccessConfig / shareVault。
        writeAccessMode(this.dataDir, mode, previous.catalog);
      } catch {
        throw new MerchantConnectError(
          "ACCESS_STATE_UNAVAILABLE",
          "接入方式未能保存；请刷新后重试。已保存的分享码不会被删除。",
        );
      }
      // 旧检测结论不再代表新选择，清掉以免误导。
      this.lastDetection = null;
      // 经授权把选择同步到目录的公开路由投影；失败不回滚本地选择，页面会
      // 明确显示“目录尚未同步”，买家继续按旧状态路由。
      await this.syncAccessModeUnlocked(mode, false);
      return this.getAccessSummary();
    });
  }

  /**
   * 把本地接入方式对账到目录公开路由投影（必须已持有 withLock）。
   *
   * - `adoptRemote`：目录 revision 比本地已知更新且是另一台设备写入时，采用
   *   目录状态（本地未同步的修改优先推送，不会被远端静默覆盖）。
   * - 任何网络/权限失败都收敛为稳定码，不抛出、不影响本地已保存模式；绝不
   *   触碰 runtime-access 或分享码。
   */
  private async syncAccessModeUnlocked(
    desiredMode?: MerchantAccessMode,
    adoptRemote = false,
  ): Promise<void> {
    let context: RuntimeAccessContext;
    try {
      ({ context } = this.requireAccessTarget());
    } catch {
      this.lastAccessSyncError = "UNBOUND";
      return;
    }
    const modeState = readAccessMode(this.dataDir);
    const mode = desiredMode ?? modeState.mode;
    const localPending =
      modeState.catalog !== undefined && modeState.catalog.mode !== modeState.mode;
    try {
      const remote = await this.client.readBuyerAccess(context, this.identity);
      if (remote.mode === mode) {
        this.recordAccessSync(mode, remote.revision);
        return;
      }
      if (
        adoptRemote &&
        !localPending &&
        remote.mode !== null &&
        (modeState.catalog === undefined || remote.revision > modeState.catalog.revision)
      ) {
        // 另一台设备在本机上次同步之后写入：以目录为准收敛本地，避免两台
        // 设备各自反复覆盖。
        this.recordAccessSync(remote.mode, remote.revision);
        return;
      }
      try {
        const updated = await this.client.updateBuyerAccess(
          context,
          this.identity,
          mode,
          remote.revision,
        );
        this.recordAccessSync(mode, updated.revision);
      } catch (error) {
        if (!(error instanceof CatalogClientError) || error.code !== "CONFLICT") throw error;
        // 并发更新：重读后只重试一次。若目录已经是目标模式则视为成功。
        const head = await this.client.readBuyerAccess(context, this.identity);
        if (head.mode === mode) {
          this.recordAccessSync(mode, head.revision);
          return;
        }
        const updated = await this.client.updateBuyerAccess(
          context,
          this.identity,
          mode,
          head.revision,
        );
        this.recordAccessSync(mode, updated.revision);
      }
    } catch (error) {
      this.lastAccessSyncError = accessSyncErrorCode(error);
    }
  }

  private recordAccessSync(mode: MerchantAccessMode, revision: number): void {
    try {
      writeAccessMode(this.dataDir, mode, {
        mode,
        revision,
        syncedAt: this.now().toISOString(),
      });
      this.lastAccessSyncError = null;
    } catch {
      this.lastAccessSyncError = "LOCAL_WRITE_FAILED";
    }
  }

  async detectAccess(): Promise<AccessDetectionResult> {
    return await this.withLock(async () => {
      const result = await this.detectAccessUnlocked();
      this.lastDetection = result;
      return result;
    });
  }

  async refreshAccess(): Promise<RuntimeAccessSummary> {
    // 与 setAccessMode / begin / reconcile 串行，避免一次刷新与一次保存交错
    // 后本地 mode 与目录 revision 指向不同版本。
    return await this.withLock(async () => {
      const current = this.selectSession(readEnrollmentStore(this.dataDir)) as ConnectionSession | undefined;
      if (current === undefined || (current.binding_id === undefined &&
          (current.status === "preparing" || current.status === "authorized"))) return this.getAccessSummary();
      const { session, context } = this.requireAccessTarget();
      const { configVersion, runtimeAccess, custodyEnabled, consent, recentFaults } =
        await this.client.readRuntimeAccess(context, this.identity);
      this.recordAccess(session.enrollment_id, configVersion, runtimeAccess, {
        custodyEnabled,
        consent,
        recentFaults,
      });
      // 对账接入方式：目录更新则采纳，本地未同步则补推；失败只记状态。
      await this.syncAccessModeUnlocked(undefined, true);
      return this.getAccessSummary();
    });
  }

  async submitAccessShareLink(
    rawLink: string,
    consentTermsVersion?: string,
  ): Promise<RuntimeAccessSummary> {
    this.assertSignatureAuthMode();
    // 代管授权是必填的前置条件：没有商家明确同意，不向目录提交任何凭据。
    if (consentTermsVersion !== WORKBUDDY_CUSTODY_TERMS_VERSION) {
      throw new MerchantConnectError(
        "ACCESS_CONSENT_REQUIRED",
        "需要先勾选并同意《分享码代管授权》后才能提交分享链接",
      );
    }
    // 解析先于任何网络动作：非法链接不会产生请求，也不会把链接内容带进日志。
    const link = parseWorkbuddyShareLink(rawLink);
    assertShareLinkMatchesRuntimeOrigin(link, this.origin);
    const current = this.selectSession(readEnrollmentStore(this.dataDir)) as ConnectionSession | undefined;
    if (current === undefined || (current.binding_id === undefined &&
        (current.status === "preparing" || current.status === "authorized"))) {
      // First binding needs the credential before Catalog has issued a binding id.
      // Persist it encrypted, bound to this origin and the runtime's existing identity key.
      this.shareVault.put(JSON.stringify({ link: rawLink, consentTermsVersion }));
      this.localShareInvalid = false;
      this.firstBindAccessConfig = buildWorkbuddyAccessConfig(link, 0, consentTermsVersion);
      return this.getAccessSummary();
    }
    const { session, context } = this.requireAccessTarget();
    const expectedVersion = session.runtime_access?.config_version ?? 0;
    let projection: RuntimeAccessProjection;
    try {
      projection = await this.client.updateRuntimeAccess(
        context,
        this.identity,
        buildWorkbuddyAccessConfig(link, expectedVersion, consentTermsVersion),
      );
    } catch (error) {
      if (!(error instanceof CatalogClientError) || error.code !== "CONFLICT") {
        throw accessError(error);
      }
      // 本地版本落后（重装/恢复/并发）：以 Catalog 权威读校正后**只重试一次**。
      const authoritative = await this.client.readRuntimeAccess(context, this.identity);
      try {
        projection = await this.client.updateRuntimeAccess(
          context,
          this.identity,
          buildWorkbuddyAccessConfig(link, authoritative.configVersion, consentTermsVersion),
        );
      } catch (retryError) {
        throw accessError(retryError);
      }
    }
    this.recordAccess(session.enrollment_id, projection.configVersion, projection, {
      custodyEnabled: true,
      consent: { granted: true, termsVersion: consentTermsVersion },
    });
    this.firstBindAccessConfig = undefined;
    this.shareVault.put(JSON.stringify({ link: rawLink, consentTermsVersion }));
    this.localShareInvalid = false;
    this.firstBindAccessConfig = buildWorkbuddyAccessConfig(link, 0, consentTermsVersion);
    return this.getAccessSummary();
  }

  async revokeAccess(): Promise<RuntimeAccessSummary> {
    const current = this.selectSession(readEnrollmentStore(this.dataDir)) as ConnectionSession | undefined;
    if (current === undefined || (current.binding_id === undefined &&
        (current.status === "preparing" || current.status === "authorized"))) {
      this.firstBindAccessConfig = undefined;
      this.shareVault.put(JSON.stringify({ revoked: true }));
      this.localShareInvalid = false;
      return this.getAccessSummary();
    }
    const { session, context } = this.requireAccessTarget();
    let version = session.runtime_access?.config_version ?? 0;
    if (version < 1) {
      // 本地没有版本：读 Catalog 权威值，避免"明明已配置却撤不掉"。
      version = (await this.client.readRuntimeAccess(context, this.identity)).configVersion;
    }
    if (version < 1) {
      throw new MerchantConnectError("ACCESS_NOT_CONFIGURED", "当前没有可撤销的访问配置");
    }
    let projection: RuntimeAccessProjection;
    // Record the local revocation before the remote call so a restart can never
    // resurrect a credential from an older environment after a partial failure.
    this.firstBindAccessConfig = undefined;
    this.shareVault.put(JSON.stringify({ revoked: true }));
    try {
      projection = await this.client.updateRuntimeAccess(
        context,
        this.identity,
        buildWorkbuddyAccessRevocation(version),
      );
    } catch (error) {
      throw accessError(error);
    }
    // 撤销 = 撤回代管授权：目录会同时清空密文。
    this.recordAccess(session.enrollment_id, projection.configVersion, projection, {
      custodyEnabled: true,
      consent: { granted: false },
    });
    this.firstBindAccessConfig = undefined;
    this.localShareInvalid = false;
    return this.getAccessSummary();
  }

  async readBoundAccount(): Promise<string | null> {
    const binding = await this.getVerifiedBinding();
    if (binding === null) throw new MerchantConnectError("STATE_INVALID", "尚未建立有效的 Catalog 绑定");
    return this.client.readBoundAccount({ agentId: binding.agentId, bindingId: binding.bindingId,
      keyId: this.identity.keyId, runtimeOrigin: this.origin, serviceEpoch: this.serviceEpoch }, this.identity);
  }

  async readPublicInquiryConsent(): Promise<PublicInquiryConsentSummary> {
    return await this.withLock(async () => {
      const binding = await this.getVerifiedBinding();
      if (binding === null) throw new MerchantConnectError("STATE_INVALID", "尚未建立有效的 Catalog 绑定");
      const context: RuntimeAccessContext = { agentId: binding.agentId, bindingId: binding.bindingId,
        keyId: this.identity.keyId, runtimeOrigin: this.origin, serviceEpoch: this.serviceEpoch };
      const remote = await this.client.readPublicInquiryConsent(context, this.identity);
      const intent = this.inquiryPolicy.intent(binding);
      if (intent === "grant") this.inquiryPolicy.set(binding, true, remote.granted && remote.policyActive);
      else if (intent === "revoke" && !remote.granted) this.inquiryPolicy.set(binding, false, true);
      return { ...remote, localEnabled: this.inquiryPolicy.isEnabled() };
    });
  }

  async setPublicInquiryConsent(granted: boolean): Promise<PublicInquiryConsentSummary> {
    return await this.withLock(async () => {
      const binding = await this.getVerifiedBinding();
      if (binding === null) throw new MerchantConnectError("STATE_INVALID", "尚未建立有效的 Catalog 绑定");
      const context: RuntimeAccessContext = { agentId: binding.agentId, bindingId: binding.bindingId,
        keyId: this.identity.keyId, runtimeOrigin: this.origin, serviceEpoch: this.serviceEpoch };
      // An unconfirmed grant and every revoke immediately disable local access.
      this.inquiryPolicy.set(binding, granted, false);
      await this.client.setPublicInquiryConsent(context, this.identity, granted);
      const remote = await this.client.readPublicInquiryConsent(context, this.identity);
      if (remote.granted !== granted) throw new MerchantConnectError("STATE_INVALID", "目录授权状态尚未确认");
      this.inquiryPolicy.set(binding, granted, granted ? remote.policyActive : true);
      return { ...remote, localEnabled: this.inquiryPolicy.isEnabled() };
    });
  }

  /**
   * 公开检测只面向构造时的已验证 publicOrigin；**不接受任何目标 URL**。
   * 每次只发 GET well-known，`redirect: "manual"`，分享码只在内存中已存在
   * 且明确观察到 401/403 时追加，绝不用探测去试探其它部署或绕过授权。
   */
  private async detectAccessUnlocked(): Promise<AccessDetectionResult> {
    const modeState = readAccessMode(this.dataDir);
    const mode = modeState.mode;
    const shareCodeAvailable = this.firstBindAccessConfig !== undefined;
    const checkedAt = this.now().toISOString();
    const uncertainGuidance =
      "单次 401/403、网络错误、重定向或不完整响应都不能判定实例未加白。" +
      "请先确认服务已启动、公网入口与 TLS 正常；如仍被平台拦截，可提交本实例分享链接后重试，或稍后重新检测。" +
      "切换接入方式或重新检测都不会删除已保存的分享码。";
    const result = (
      status: AccessDetectionStatus,
      code: AccessDetectionCode,
      httpStatus: number | null,
      detail: string,
      guidance: string,
    ): AccessDetectionResult => ({
      status,
      code,
      checkedAt,
      mode,
      shareCodeAvailable,
      httpStatus,
      detail,
      guidance,
    });
    const cardMatches = (card: AgentCard): boolean => {
      try {
        assertPublicCard(
          card,
          this.origin,
          this.a2aEndpoint,
          { keyid: this.identityRaw.keyid, publicKeyPem: this.identityRaw.publicKeyPem },
        );
        return true;
      } catch {
        return false;
      }
    };

    const direct = await requestPublicCard(this.origin, this.fetchImpl);
    if (direct.kind === "ok") {
      if (!cardMatches(direct.card)) {
        return result(
          "uncertain",
          "response_ambiguous",
          200,
          "公开名片可读取，但与当前实例地址或签名身份不一致。",
          "该响应不足以判断平台加白状态；请检查反向代理、公开入口和签名密钥配置后重试。",
        );
      }
      return result(
        "direct_ok",
        "public_card_readable",
        200,
        "本次无码读取公开名片成功。",
        "本次探测只证明无码可读取公开名片，不等于平台已加白，检测本身不改写已保存的接入方式或买家路由状态；如后续仍被门禁拦截，请重新检测或改用分享码。",
      );
    }

    if (direct.kind === "http" && (direct.status === 401 || direct.status === 403)) {
      if (!shareCodeAvailable || mode === "no_share_code") {
        return result(
          "uncertain",
          mode === "share_code" && !shareCodeAvailable ? "share_code_missing" : "gate_rejected",
          direct.status,
          `无码读取公开名片被拒绝（HTTP ${direct.status}）。`,
          mode === "share_code"
            ? "已选择「使用分享码」，但当前进程没有可用分享码。请由商家提交本实例分享链接后重试；目录里已保存的分享码不会被删除。"
            : mode === "no_share_code"
              ? "当前选择「无分享码」，检测没有发送已保存的分享码。单次 401/403 不能判定实例未加白；如平台门禁确实要求分享码，请提交本实例分享链接后切换为自动检测或使用分享码。"
              : uncertainGuidance,
        );
      }
      const withCode = await requestPublicCard(
        this.origin,
        this.fetchImpl,
        this.firstBindAccessConfig?.secret_value,
      );
      if (withCode.kind === "ok") {
        if (!cardMatches(withCode.card)) {
          return result(
            "uncertain",
            "response_ambiguous",
            200,
            "带分享码读取到的公开名片与当前实例地址或签名身份不一致。",
            uncertainGuidance,
          );
        }
        return result(
          "share_code_ok",
          "sharecode_public_card_readable",
          200,
          "无码读取被拒绝，但已暂存的分享码可以读取公开名片。",
          "本次探测只证明已保存的分享码可通过平台门禁；平台是否加白仍未确认。切换接入方式或重新检测都不会删除已保存的分享码。",
        );
      }
      const codeStatus = withCode.kind === "http" ? withCode.status : null;
      return result(
        "uncertain",
        "gate_rejected",
        codeStatus,
        `无码读取被拒绝（HTTP ${direct.status}），带分享码读取也未成功。`,
        "这可能是分享码已更换/失效、门禁形态变化或服务暂时异常，不能据此判定未加白。" +
          "请核对分享码后在下方重新提交，或稍后重新检测；已保存的分享码不会被删除。",
      );
    }

    if (direct.kind === "redirect") {
      return result(
        "uncertain",
        "unexpected_redirect",
        direct.status,
        `公开名片请求返回重定向（HTTP ${direct.status}），已停止且未跟随。`,
        "为避免把请求带到未校验目标，检测不会跟随重定向。请检查反向代理配置后重新检测。",
      );
    }
    if (direct.kind === "invalid") {
      return result(
        "uncertain",
        direct.code === "response" ? "response_ambiguous" : "network_error",
        null,
        direct.code === "timeout"
          ? "公开名片请求超时。"
          : direct.code === "network"
            ? "公开名片请求未能建立连接。"
            : "公开名片响应不完整或不合法。",
        uncertainGuidance,
      );
    }
    return result(
      "uncertain",
      "http_error",
      direct.status,
      `公开名片请求返回 HTTP ${direct.status}。`,
      uncertainGuidance,
    );
  }

  /**
   * WorkBuddy 访问配置要求签名认证（G0 §1.1.3）：平台会改写 Authorization，
   * bearer 身份不能当业务凭据。不静默降级，直接给出可执行的修复提示。
   */
  private assertSignatureAuthMode(): void {
    if (this.a2aAuthMode !== "signature") {
      throw new MerchantConnectError(
        "ACCESS_AUTH_MODE_CONFLICT",
        "WorkBuddy 分享码要求 A2A 入站使用签名认证；当前是 bearer 模式，请改为 KIWI_CLOUD_A2A_AUTH=signature",
      );
    }
  }

  /** 访问配置只对已建立绑定的会话有意义；拿到 (session, 签名上下文) 或明确失败。 */
  private requireAccessTarget(): {
    session: ConnectionSession;
    context: RuntimeAccessContext;
  } {
    const session = this.selectSession(readEnrollmentStore(this.dataDir)) as
      | ConnectionSession
      | undefined;
    if (session === undefined) {
      throw new MerchantConnectError("STATE_INVALID", "尚未建立 Catalog 连接");
    }
    const agentId = session.catalog_agent_id;
    const bindingId = session.binding_id;
    if (agentId === undefined || bindingId === undefined) {
      throw new MerchantConnectError("STATE_INVALID", "尚未完成 Catalog 绑定，暂不能配置访问凭据");
    }
    return {
      session,
      context: {
        agentId,
        bindingId,
        keyId: this.identity.keyId,
        runtimeOrigin: this.origin,
        serviceEpoch: this.serviceEpoch,
      },
    };
  }

  /** 持久化脱敏投影；`projection === null` 表示 Catalog 上没有配置（记 none）。 */
  private recordAccess(
    enrollmentId: string,
    configVersion: number,
    projection: RuntimeAccessProjection | null,
    consent?: {
      custodyEnabled: boolean;
      consent: RuntimeAccessConsent;
      recentFaults?: { count: number; lastAt: string };
    },
  ): void {
    const record: RuntimeAccessRecord = {
      config_version: configVersion,
      status: (projection?.status ?? "none") as RuntimeAccessStatus,
      ...(projection !== null ? { status_reason: projection.statusReason } : {}),
      ...(consent !== undefined
        ? {
            custody_enabled: consent.custodyEnabled,
            consent_granted: consent.consent.granted,
            consent_terms_version: consent.consent.termsVersion ?? null,
            consent_granted_at: consent.consent.grantedAt ?? null,
            recent_faults: consent.recentFaults?.count ?? 0,
            recent_faults_last_at: consent.recentFaults?.lastAt ?? "",
          }
        : {}),
      provider: projection?.provider ?? null,
      access_mode: projection?.accessMode ?? null,
      parameter_name: projection?.parameterName ?? null,
      adapter_version: projection?.adapterVersion ?? null,
      auth_mode: projection?.authMode ?? null,
      updated_at: projection?.updatedAt ?? this.now().toISOString(),
    };
    this.persist((fresh) =>
      fresh.sessions.map((item) => {
        if (item.enrollment_id !== enrollmentId) return item;
        const updated = { ...(item as ConnectionSession), runtime_access: record };
        // 拿到目录权威状态后，"随绑凭据被按版本冲突跳过"的提示就过时了：改按
        // record 里的真实状态展示（active/pending/invalid 都在 record 中）。
        delete updated.runtime_access_conflict;
        return updated;
      }),
    );
  }

  // ── 协议单步（自 CLI 状态机原样搬移，顺序与校验一致）──────────────────

  /** begin/reconcile 后本趟已确认 published 健康（发布成功即视为已验证）。 */
  private markPublishedVerified(): void {
    this.publicationVerified = true;
    this.availability = null;
  }

  private async stepPreparing(session: ConnectionSession): Promise<ConnectionSession> {
    const nowMs = this.now().getTime();
    if (
      !Number.isFinite(Date.parse(session.expires_at)) ||
      Date.parse(session.expires_at) <= nowMs
    ) {
      // 授权已过期：不再轮询，显式标记；下一次 begin() 会为同 origin+key 新建。
      const expired = { ...session, status: "expired" as const };
      this.persist((fresh) =>
        fresh.sessions.map((item) =>
          item.enrollment_id === session.enrollment_id ? expired : item,
        ),
      );
      return expired;
    }
    if (nowMs < this.nextPollAtMs) return session;
    const poll = await this.client.pollDeviceEnrollment(session.device_code, this.identity);
    if (poll.status !== "authorized") {
      const intervalMs =
        poll.status === "slow_down"
          ? Math.max(session.interval * 1000 + 5_000, poll.intervalSeconds * 1000)
          : Math.max(session.interval, poll.intervalSeconds) * 1000;
      this.nextPollAtMs = nowMs + intervalMs;
      const updated = { ...session, interval: Math.round(intervalMs / 1000) };
      this.persist((fresh) =>
        fresh.sessions.map((item) =>
          item.enrollment_id === session.enrollment_id ? updated : item,
        ),
      );
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
    this.persist((fresh) =>
      fresh.sessions.map((item) =>
        item.enrollment_id === session.enrollment_id ? authorized : item,
      ),
    );
    return authorized;
  }

  private verifyAuthorizedPoll(
    session: ConnectionSession,
    poll: Extract<DeviceEnrollmentPoll, { status: "authorized" }>,
  ): void {
    if (
      poll.enrollmentId !== session.enrollment_id ||
      poll.runtimeOrigin !== this.origin ||
      poll.a2aEndpoint !== this.a2aEndpoint ||
      poll.merchantId.trim() === "" ||
      (session.expected_catalog_agent_id !== undefined &&
        poll.catalogAgentId !== session.expected_catalog_agent_id)
    ) {
      throw new MerchantConnectError(
        "AUTHORIZED_MATERIAL_MISMATCH",
        "Catalog 授权材料与当前 Runtime 不一致，已停止连接。",
      );
    }
    if (
      poll.authorizationEpoch < 1 ||
      poll.approvedCardDigest !== session.preview_digest ||
      !poll.scopes.includes("runtime:bind") ||
      !poll.scopes.includes("card:publish") ||
      !poll.scopes.includes("heartbeat")
    ) {
      throw new MerchantConnectError(
        "GRANT_SCOPE_INVALID",
        "Catalog 接入许可缺少有效授权代次或必要范围，已停止。",
      );
    }
  }

  /**
   * 首绑随附的访问配置是**一次性**的：目录侧 runtime-access 按 agent 单调递增并
   * 严格 CAS（`stage_runtime_access` 要求 `expected_version == head`），而本地暂存
   * 配置恒为 `expected_version: 0`。首次绑定成功时该配置已在同一事务里激活
   * （head 变为 ≥1）；此后 `stepBound` 会把超过首签 TTL（15 分钟）的 bound 会话
   * 显式置 expired（"下一次 begin() 重开"），重新绑定若继续随绑提交同一份配置，
   * 目录按版本冲突 409 拒绝 → 整个重绑失败（BIND_REJECTED），而重新粘贴分享码
   * 只会在本地重建同一份 `expected_version: 0` 的配置，商家无法自行恢复。
   * 因此只有"本 origin/key/Catalog 从未成功绑定过"才随绑提交；已交付过的配置
   * 更新一律走工作台的 PUT runtime-access（带权威版本、409 校正后只重试一次）。
   */
  private firstBindAccessForFreshBinding(): WorkbuddyAccessConfig | undefined {
    if (this.firstBindAccessConfig === undefined) return undefined;
    // 显式“无分享码”模式不得把已暂存的凭据随首次绑定提交给目录；凭据仍
    // 保留在本地，切换回 auto/share_code 后可继续使用，且不会被自动删除。
    if (readAccessMode(this.dataDir).mode === "no_share_code") return undefined;
    const boundBefore = readEnrollmentStore(this.dataDir).sessions.some((item) => {
      const previous = item as ConnectionSession;
      return typeof previous.binding_id === "string" && previous.binding_id !== "" &&
        previous.runtime_origin === this.origin &&
        previous.key_thumbprint === this.keyThumbprint &&
        previous.catalog_origin === this.client.catalogOrigin;
    });
    return boundBefore ? undefined : this.firstBindAccessConfig;
  }

  private async stepAuthorized(session: ConnectionSession): Promise<ConnectionSession> {
    // 兼容旧 CLI 写入的会话（当时 merchant_id 存的是 poll 断言）：优先
    // offered_merchant_id，缺失时回落旧字段，语义相同（都只是 bind 入参）。
    const offeredMerchantId = session.offered_merchant_id ?? session.merchant_id;
    if (
      session.catalog_agent_id === undefined ||
      session.grant === undefined ||
      session.authorization_epoch === undefined ||
      offeredMerchantId === undefined
    ) {
      throw new MerchantConnectError(
        "STATE_INVALID",
        "本地授权状态缺少许可、授权代次、merchant_id或 catalog_agent_id",
      );
    }
    this.effectStarted = true;
    const firstBindAccessConfig = this.firstBindAccessForFreshBinding();
    const binding = await this.client.bindEnrollment(
      {
        enrollmentId: session.enrollment_id,
        grant: session.grant,
        catalogAgentId: session.catalog_agent_id,
        merchantId: offeredMerchantId,
        runtimeOrigin: this.origin,
        a2aEndpoint: this.a2aEndpoint,
        generation: session.generation ?? this.generation,
        serviceEpoch: this.serviceEpoch,
        authorizationEpoch: session.authorization_epoch,
        ...(firstBindAccessConfig !== undefined
          ? { accessConfig: firstBindAccessConfig }
          : {}),
      },
      this.identity,
    );
    if (binding.keyThumbprint !== this.keyThumbprint) {
      throw new MerchantConnectError(
        "BINDING_KEY_MISMATCH",
        "Catalog 绑定回执的密钥与本 Runtime 不一致",
      );
    }
    const rawClaims = binding.bindingClaim["claims"];
    const claimMerchantId =
      rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
        ? (rawClaims as Record<string, unknown>)["merchant_id"]
        : undefined;
    const claimExpiry =
      rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
        ? (rawClaims as Record<string, unknown>)["expires_at"]
        : undefined;
    if (typeof claimMerchantId !== "string" || claimMerchantId.trim() === "") {
      throw new MerchantConnectError(
        "BINDING_CLAIM_INVALID",
        "Catalog已签名绑定声明缺少merchant_id；名片保持未发布。",
      );
    }
    if (typeof claimExpiry !== "string" || !Number.isFinite(Date.parse(claimExpiry))) {
      throw new MerchantConnectError(
        "BINDING_CLAIM_INVALID",
        "Catalog已签名绑定声明缺少有效expires_at；名片保持未发布。",
      );
    }
    const accessOutcome = binding.runtimeAccess;
    const bound = {
      ...session,
      status: "bound" as const,
      binding_id: binding.bindingId,
      binding_version: binding.bindingVersion,
      merchant_id: claimMerchantId,
      binding_expires_at: claimExpiry,
      expected_card_revision: binding.activeCardRevision ?? 0,
      // 目录因版本冲突跳过随绑凭据：绑定本身成功，但本地不能假装码已生效。
      // 记下可恢复信号，由工作台的访问摘要提示商家用权威版本显式更新。
      ...(accessOutcome !== undefined && accessOutcome.applied === false
          && accessOutcome.reason === "runtime_access_version_conflict"
        ? { runtime_access_conflict: {
            reason: "catalog_access_exists",
            head_version: accessOutcome.headVersion ?? 0,
          } }
        : {}),
    };
    this.persist((fresh) =>
      fresh.sessions.map((item) => (item.enrollment_id === session.enrollment_id ? bound : item)),
    );
    // 绑定已持久化后补一次接入方式对账（旧目录 404 会记为 unsupported；
    // 失败绝不影响绑定/发布本身）。
    await this.syncAccessModeUnlocked(undefined, true);
    // 绑定已持久化：发布交给 reconcile 的 bound 分支——失败阶段归类
    // （CARD_PUBLISH_* + stage=publish）由该分支的阶段标记正确给出，
    // 首配级联路径不再把发布失败误报成 BIND_REJECTED。
    return bound;
  }

  private async stepBound(session: ConnectionSession): Promise<ConnectionSession> {
    if (
      session.catalog_agent_id === undefined ||
      session.binding_id === undefined ||
      session.binding_version === undefined ||
      session.merchant_id === undefined ||
      session.binding_expires_at === undefined
    ) {
      throw new MerchantConnectError("STATE_INVALID", "绑定状态缺少回执字段");
    }
    // 重启续办/长等待后重新验证：绑定授权已过期的绝不允许带过期绑定调
    // beforePublish 钩子或发布名片；显式标记 expired，下一次 begin() 重开。
    if (
      !Number.isFinite(Date.parse(session.binding_expires_at)) ||
      Date.parse(session.binding_expires_at) <= this.now().getTime()
    ) {
      const expired = { ...session, status: "expired" as const };
      this.persist((fresh) =>
        fresh.sessions.map((item) =>
          item.enrollment_id === session.enrollment_id ? expired : item,
        ),
      );
      return expired;
    }
    // 重启续办/长等待后重新验证：公开卡必须与冻结预览一致才允许发布。
    const currentCard = await this.loadPublicCard();
    if (canonicalize(currentCard) !== canonicalize(session.frozen_card)) {
      throw new MerchantConnectError(
        "PREVIEW_CHANGED",
        "公网服务的公开 Agent Card 已不同于商家批准的预览；未发布名片。请重新检查并授权新的公开信息。",
      );
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
    if (this.beforePublish !== undefined) {
      try {
        await this.beforePublish(verified);
      } catch (error) {
        if (error instanceof MerchantConnectError && error.code === "CATALOG_RUNTIME_NOT_READY")
          this.preEffectReadinessFailure = true;
        throw error;
      }
    }
    const expectedRevision = session.expected_card_revision ?? 0;
    let cardRevision = session.card_revision;
    if (cardRevision === undefined) {
      this.effectStarted = true;
      const publication = await this.client.publishCard(
        {
          agentId: catalogAgentId,
          bindingId,
          generation: session.generation ?? this.generation,
          expectedRevision,
          agentCard: session.frozen_card,
          a2aEndpoint: this.a2aEndpoint,
          runtimeOrigin: this.origin,
        },
        this.identity,
      );
      if (publication.revision === null) {
        throw new MerchantConnectError(
          "PUBLICATION_RECEIPT_INVALID",
          "Catalog 未返回名片 revision；绑定已保留，重试可续办",
        );
      }
      cardRevision = publication.revision;
      const publishedCard = { ...session, card_revision: cardRevision };
      this.persist((fresh) =>
        fresh.sessions.map((item) =>
          item.enrollment_id === session.enrollment_id ? publishedCard : item,
        ),
      );
      session = publishedCard;
    }
    this.effectStarted = true;
    const activated = await this.client.activateCard(
      {
        agentId: catalogAgentId,
        bindingId,
        cardRevision,
        expectedRevision,
      },
      this.identity,
    );
    if (activated.revision === null) {
      throw new MerchantConnectError(
        "ACTIVATION_RECEIPT_INVALID",
        "Catalog 未确认名片激活；绑定已保留，重试可续办",
      );
    }
    const published = {
      ...session,
      status: "published" as const,
      card_revision: activated.revision,
    };
    // 同 catalog agent 的旧 published 会话由新绑定取代（标 replaced）；其余一律保留。
    this.persist((fresh) =>
      fresh.sessions.map((item) => {
        if (item.enrollment_id === session.enrollment_id) return published;
        const old = item as ConnectionSession;
        return old.status === "published" &&
          old.catalog_agent_id === published.catalog_agent_id &&
          old.binding_id !== published.binding_id
          ? { ...old, status: "replaced" as const }
          : item;
      }),
    );
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
      if (session.runtime_origin !== this.origin || session.key_thumbprint !== this.keyThumbprint)
        continue;
      if (!["preparing", "authorized", "bound", "published"].includes(session.status)) continue;
      if (session.status !== "published") {
        // published 永不在本地按首签 claim 的 TTL 判死（Catalog 每次公开读都会
        // 重签短期声明；长期绑定是否有效由 Catalog 复核把关），其余状态按各自
        // 过期口径：bound 看验真绑定 binding_expires_at，preparing/authorized
        // 看授权窗口 expires_at。
        const expiry = session.status === "bound" ? session.binding_expires_at : session.expires_at;
        if (!(Number.isFinite(Date.parse(expiry ?? "")) && Date.parse(expiry ?? "") > nowMs))
          continue;
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
      return (
        session.runtime_origin === this.origin &&
        session.key_thumbprint === this.keyThumbprint &&
        (session.generation ?? 1) === this.generation &&
        session.catalog_origin === this.client.catalogOrigin &&
        ["preparing", "authorized"].includes(session.status) &&
        (!Number.isFinite(Date.parse(session.expires_at)) ||
          Date.parse(session.expires_at) <= this.now().getTime())
      );
    });
    return candidate as ConnectionSession | undefined;
  }

  /**
   * 同 origin+key 可续、但属于**其他 Catalog** 的会话（begin 创建新 enrollment
   * 前的显式守卫；selection 本身已按 catalog 过滤，这里只是给出明确拒绝）。
   */
  private findForeignCatalogSession(
    store: EnrollmentChallengeStore,
  ): ConnectionSession | undefined {
    const nowMs = this.now().getTime();
    for (const item of store.sessions) {
      const session = item as ConnectionSession;
      if (session.runtime_origin !== this.origin || session.key_thumbprint !== this.keyThumbprint)
        continue;
      if (!["preparing", "authorized", "bound", "published"].includes(session.status)) continue;
      if (session.status !== "published") {
        const expiry = session.status === "bound" ? session.binding_expires_at : session.expires_at;
        if (!(Number.isFinite(Date.parse(expiry ?? "")) && Date.parse(expiry ?? "") > nowMs))
          continue;
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
    if (
      active === null ||
      active.bindingId !== session.binding_id ||
      session.binding_version === undefined ||
      active.bindingVersion !== session.binding_version ||
      active.keyThumbprint !== this.keyThumbprint ||
      active.keyId !== this.identity.keyId ||
      active.serviceEpoch !== this.serviceEpoch ||
      active.runtimeOrigin.replace(/\/+$/, "") !== this.origin ||
      active.a2aEndpoint !== this.a2aEndpoint ||
      active.cardRevision !== session.card_revision ||
      !Number.isFinite(Date.parse(active.expiresAt)) ||
      Date.parse(active.expiresAt) <= this.now().getTime() ||
      !["ACTIVE", "active"].includes(active.publicationState)
    ) {
      throw new MerchantConnectError(
        "PUBLICATION_NOT_ACTIVE",
        "Catalog 当前没有返回这条绑定和已激活名片；服务可能已暂停或撤回。请到Catalog恢复服务后再检查，Runtime不会自动恢复营业。",
      );
    }
    if (session.merchant_id === undefined) {
      const backfilled = { ...session, merchant_id: active.merchantId };
      this.persist((fresh) =>
        fresh.sessions.map((item) =>
          item.enrollment_id === session.enrollment_id ? backfilled : item,
        ),
      );
      return active;
    }
    if (session.merchant_id !== active.merchantId) {
      throw new MerchantConnectError(
        "BINDING_MERCHANT_MISMATCH",
        "Catalog binding的merchant_id与本地Enrollment不一致，已停止。",
      );
    }
    return active;
  }

  /** 用当次重签的公开声明构造已验证绑定投影（期限取新鲜声明）。 */
  private verifiedFromPublication(
    session: ConnectionSession,
    active: PublicBinding,
  ): VerifiedBinding {
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
    if (
      session.catalog_agent_id === undefined ||
      session.binding_id === undefined ||
      session.binding_version === undefined ||
      session.merchant_id === undefined ||
      session.binding_expires_at === undefined
    )
      return null;
    if (
      !Number.isFinite(Date.parse(session.binding_expires_at)) ||
      Date.parse(session.binding_expires_at) <= this.now().getTime()
    ) {
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
      return {
        status: "idle",
        stage: this.stageOf("idle"),
        published: false,
        agentId: null,
        bindingId: null,
        bindingExpiresAt: null,
        cardRevision: null,
        code: null,
        detail: null,
      };
    }
    if (session.status !== "published") {
      // 非 published 阶段也透出最近一次步骤失败的自有稳定码（availability 仅由
      // reconcile 的失败路径写入；已知本地类型可给固定说明，其余为空，绝不携带远端原文/凭据）。
      // availability 只在失败/发布核对路径写入：非 published 时非空即最近一次失败。
      const stepFailure =
        this.availability !== null
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
        detail:
          this.availability?.detail ?? "本实例尚未完成 Catalog 发布核对；published 暂报未确认。",
      };
    }
    return {
      status: "published",
      stage: "publish",
      published: true,
      agentId: session.catalog_agent_id ?? null,
      bindingId: session.binding_id ?? null,
      bindingExpiresAt: session.binding_expires_at ?? null,
      cardRevision: session.card_revision ?? null,
      code: null,
      detail: null,
    };
  }

  private persist(
    mutate: (fresh: EnrollmentChallengeStore) => EnrollmentChallengeStore["sessions"],
  ): void {
    withEnrollmentStoreLock(this.dataDir, () => {
      const fresh = readEnrollmentStore(this.dataDir),
        sessions = mutate(fresh),
        byId = new Map(fresh.sessions.map((s) => [s.enrollment_id, s]));
      for (const item of sessions) {
        const before = byId.get(item.enrollment_id);
        if (item === before) continue;
        const expected = item.store_revision ?? 0,
          current = before?.store_revision ?? 0;
        const observed = (item as AuthorizedEnrollment & { [observedSession]?: string })[
          observedSession
        ];
        if (
          (before && observed !== sessionDigest(before)) ||
          expected !== current ||
          !Number.isSafeInteger(current)
        )
          throw new MerchantConnectError(
            "STATE_CAS_CONFLICT",
            "Enrollment changed; reread before continuing",
          );
        item.store_revision = current + 1;
        Object.defineProperty(item, observedSession, {
          value: sessionDigest(item),
          enumerable: true,
          writable: true,
        });
      }
      writeFileAtomic(
        enrollmentStorePath(this.dataDir),
        JSON.stringify({ ...fresh, sessions }) + "\n",
        { mode: 0o600 },
      );
    });
  }
  private async claimedStep(
    session: ConnectionSession,
    stage: string,
    step: () => Promise<ConnectionSession>,
    readOnly: boolean,
  ): Promise<ConnectionSession> {
    const token = randomUUID();
    this.persist((fresh) =>
      fresh.sessions.map((item) => {
        if (item.enrollment_id !== session.enrollment_id) return item;
        const live = item as ConnectionSession;
        if (live.operation_claim)
          throw new MerchantConnectError(
            live.operation_claim.state === "unknown" ||
              Date.parse(live.operation_claim.expires_at) <= this.now().getTime()
              ? "CONNECTION_OPERATION_UNKNOWN"
              : "CONNECTION_OPERATION_PENDING",
            "Enrollment operation is already claimed",
          );
        if (
          live.status !== session.status ||
          (live.store_revision ?? 0) !== (session.store_revision ?? 0)
        )
          throw new MerchantConnectError("STATE_CAS_CONFLICT", "Enrollment changed");
        session.operation_claim = {
          token,
          stage,
          state: "active",
          expires_at: new Date(this.now().getTime() + 60000).toISOString(),
        };
        return session;
      }),
    );
    let result: ConnectionSession | undefined;
    let deterministicRelease = false;
    let failure: unknown;
    this.effectStarted = false;
    try {
      result = await step();
    } catch (error) {
      failure = error;
      deterministicRelease = isDeterministicConnectRelease(error);
    }
    // Effect uncertainty is durable. Only read-only calls or known pre-effect
    // readiness failures release a claim automatically; no stale lease stealing.
    const safe = result !== undefined || readOnly || !this.effectStarted || deterministicRelease;
    this.preEffectReadinessFailure = false;
    let persistError: unknown;
    try {
      this.persist((fresh) =>
        fresh.sessions.map((item) => {
          const live = item as ConnectionSession;
          if (live.enrollment_id !== session.enrollment_id || live.operation_claim?.token !== token)
            return item;
          const updated = { ...live };
          if (safe) delete updated.operation_claim;
          else updated.operation_claim = { ...live.operation_claim, state: "unknown" };
          if (result !== undefined) {
            if (safe) delete result.operation_claim;
            Object.assign(result, updated);
          }
          return result ?? updated;
        }),
      );
    } catch (error) {
      persistError = error;
    }
    // 审查 P2：清理写入抛错不得吞掉原始错误；没有原始错误时上抛（claim
    // 清理失败不能静默），有原始错误时保留原错误并把失败附在其上。
    if (failure !== undefined) {
      if (persistError !== undefined && failure !== null && typeof failure === "object") {
        Object.assign(failure as Record<string, unknown>, { persist_error: persistError });
      }
      throw failure;
    }
    if (persistError !== undefined) throw persistError;
    if (result === undefined) {
      throw new MerchantConnectError(
        "CONNECTION_OPERATION_UNKNOWN",
        "connection step completed without a session",
      );
    }
    return result;
  }
  private preEffectReadinessFailure = false;
  private effectStarted = false;

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
