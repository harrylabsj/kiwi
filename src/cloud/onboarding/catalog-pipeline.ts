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
 * 开通向导的 Catalog 串联（Kiwi v0.5 device enrollment）。
 *
 * 由 Catalog 登录页完成一次业务确认；Runtime 自动持钥绑定、真实就绪检查和签名名片激活：
 *
 *   DEPLOYED_UNBOUND ──reconcileBinding()──▶ BOUND ─▶ VERIFYING ─▶ READY_TO_PUBLISH ─▶ PUBLISHED
 *        （设备授权页 + 自动绑定）                          （真实检查）             （自动发卡）
 *
 * 纪律（与向导骨架同口径）：
 *
 * 1. **状态只经 OnboardingStore 推进**：CAS + 迁移合法性 + 证据分级全部由 store
 *    把关；本模块只负责"把目录侧的真实结果变成权威证据"。
 * 2. **断点续办**：设备码、授权、绑定与发布revision落在0600本地状态文件；
 *    服务进程与CLI重启后从原阶段继续，不重复请求商家确认。
 * 3. **不谎报**：目录不可达 → 证据流标 `pending_publication` / 不可达留痕，
 *    记录停在原状态按退避重跑（FAILED_RETRYABLE 经向导通道回不来，不把记录
 *    推进死胡同）；CAS 冲突重试一次后仍 409 → BLOCKED 报人工。
 *    只有 activate 成功才允许进 PUBLISHED。
 * 4. **未确认不发布**：公开卡片只能由已登录Catalog页批准的设备grant绑定，
 *    并且Catalog对批准digest、运行时公钥与外部挑战逐项校验。
 */

import { buildAgentCard } from "../../a2a/server/card.js";
import { createHash } from "node:crypto";
import { canonicalize } from "../../negotiation/jcs.js";
import { writeFileAtomic } from "../../fs/atomic-write.js";
import { readEnrollmentStore, enrollmentStorePath, type AuthorizedEnrollment } from "../binding/enrollment-challenge.js";
import { withEnrollmentStoreLock } from "../binding/store-lock.js";
import type { AgentCard } from "../../discovery/agent-card/types.js";
import { platformEvidence, type OnboardingStore } from "./store.js";
import type { AuthoritativeEvidence, OnboardingRecord } from "./types.js";
import {
  CatalogClient,
  CatalogClientError,
  runtimePublicKey,
  type PublicBinding,
  type RuntimeSigningIdentity,
} from "../catalog-client.js";

/** 云端 A2A 端点路径（与 bootstrap.ts 的 CLOUD_A2A_PATH 同值；避免模块环依赖在此复制常量）。 */
const DEFAULT_A2A_PATH = "/a2a";

/** 证据流里的断点标记（summary 前缀；只留痕，不作状态依据）。 */
export const BINDING_REQUESTED_MARKER = "catalog:binding-requested";
export const AWAITING_CONFIRMATION_MARKER = "catalog:awaiting-portal-confirmation";
export const PENDING_PUBLICATION_MARKER = "pending_publication";

export type CatalogPipelineErrorCode =
  /** 记录状态不在本动作的准入集合里。 */
  | "STATE_NOT_ADMISSIBLE"
  /** 记录还没有平台 applicationId（平台授权步骤未完成）——不构成权威证据。 */
  | "MISSING_PLATFORM_IDENTITY"
  /** 公开读地址上没有与本实例匹配的已确认绑定——未确认不发布。 */
  | "BINDING_NOT_CONFIRMED"
  /** 发布回执缺 card_revision（契约违例）——无法激活，需人工核对。 */
  | "PUBLISH_RECEIPT_INVALID"
  /** 服务检查能力未配置——禁止成功空实现。 */
  | "SERVICE_CHECK_UNAVAILABLE"
  /** review P1-3（返修）：enrollment 会话 CAS 冲突——其他持锁写者已推进，
   *  调用方必须重读快照后再试；绝不自动覆盖未知推进。 */
  | "STATE_CAS_CONFLICT";

export class CatalogPipelineError extends Error {
  readonly code: CatalogPipelineErrorCode;

  constructor(code: CatalogPipelineErrorCode, message: string) {
    super(message);
    this.name = "CatalogPipelineError";
    this.code = code;
  }
}

export interface CatalogPipelineDeps {
  store: OnboardingStore;
  client: CatalogClient;
  /** Runtime 自持身份（与 CatalogClient 同一把 Ed25519 钥匙）。 */
  identity: RuntimeSigningIdentity;
  /** 运行时公开 origin——**只取自 KIWI_CLOUD_PUBLIC_ORIGIN**。 */
  runtimeOrigin: string;
  /** 独立授权会话及挑战状态的 0700/0600 持久目录。 */
  dataDir?: string;
  generation: number;
  serviceEpoch: number;
  /** 名片内容（与 Runtime 自发的 well-known 卡同源）。 */
  card: {
    name: string;
    description: string;
    providerOrganization: string;
    version: string;
    securityScheme?: {
      name: string;
      type: string;
      keyid?: string;
      publicKeyPem?: string;
      algorithm?: string;
    };
  };
  /**
   * 服务检查（VERIFYING → READY_TO_PUBLISH 的判定）。未配置即抛
   * SERVICE_CHECK_UNAVAILABLE——绝不做空实现假装检查通过。
   */
  serviceCheck?: () => Promise<{ ok: boolean; detail?: string }>;
  /** 等待门户确认的轮询参数（测试注入短超时）。 */
  awaitOptions?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
  };
  /** A2A 路径（缺省 /a2a，与云端路由一致）。 */
  a2aPath?: string;
}

export type BindingReconcileOutcome =
  /** Catalog 接受后端已确认的商家许可，绑定及发卡完成；服务检查通过才推进上线。 */
  | { kind: "advanced"; record: OnboardingRecord; confirmed: PublicBinding }
  /** 商家还没完成唯一一次业务授权：记录停在 DEPLOYED_UNBOUND，给出登录确认页和短码。 */
  | { kind: "awaiting_portal_confirmation"; record: OnboardingRecord; hint: string };

export const PORTAL_CONFIRMATION_HINT =
  "请打开 Catalog 提供的安全授权页，核对店铺公开信息与配对码，并点击「连接此服务并发布」。这一次确认同时授权 Runtime 绑定和名片发布。";

function requirePlatformIdentity(record: OnboardingRecord): string {
  if (record.applicationId === null || record.applicationId.trim() === "") {
    throw new CatalogPipelineError(
      "MISSING_PLATFORM_IDENTITY",
      "记录缺少平台 applicationId（平台授权未完成）——不能据此构造权威证据",
    );
  }
  return record.applicationId;
}

function catalogEvidence(record: OnboardingRecord, source: string): AuthoritativeEvidence {
  return platformEvidence({
    applicationId: requirePlatformIdentity(record),
    generation: record.generation,
    source,
  });
}

interface WorkbuddyEnrollment extends AuthorizedEnrollment {
  owner_ref: string;
  catalog_origin: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  preview_digest: string;
  frozen_card: AgentCard;
  catalog_agent_id?: string;
  expected_catalog_agent_id?: string;
  merchant_id?: string;
  binding_expires_at?: string;
  grant?: string;
  authorization_epoch?: number;
  binding_id?: string;
  binding_version?: number;
  expected_card_revision?: number;
  card_revision?: number;
}

// Symbol 键：Object spread 会携带（调用方 {...state, status} 不丢戳），
// JSON.stringify 忽略 symbol —— 落盘文件不含该戳。
const SNAPSHOT_DIGEST: unique symbol = Symbol("enrollment.snapshotDigest");

function enrollmentSnapshotDigest(session: WorkbuddyEnrollment): string {
  return createHash("sha256").update(JSON.stringify(session)).digest("hex");
}

export function workbuddyEnrollment(dataDir: string, ownerRef: string): WorkbuddyEnrollment | undefined {
  const found = readEnrollmentStore(dataDir).sessions
    .map((session) => session as WorkbuddyEnrollment)
    .filter((session) => session.owner_ref === ownerRef)
    .at(-1);
  if (found === undefined) return undefined;
  // review P1-3（A319 校准）：读取时打**pristine 快照摘要**（非枚举属性，
  // 不入 JSON）——legacy 会话（无 store_revision）的调用方据此在 save 时
  // 证明「我读的就是这份」，首轮推进 revision；不能仅 undefined==undefined
  // 放行陈旧写者（会重开 legacy 丢 operation_claim 窗口）。
  Object.defineProperty(found, SNAPSHOT_DIGEST, {
    value: enrollmentSnapshotDigest(found),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return found;
}

export function saveWorkbuddyEnrollment(
  dataDir: string,
  state: WorkbuddyEnrollment,
  /** review P1-3（返修）：调用方快照的 store_revision——锁内强比较的真 CAS
   *  期望值。缺省（undefined）视为「期望不存在」。 */
  expectedPriorRevision?: number,
): void {
  // review P1-3：与 connect-service persist / challenge responder 同锁。原返修
  // 的「同锁 + prior+1」不是 CAS——state 是锁外旧快照，锁内读到的 fresh 若
  // 已被其他持锁写者推进（新 operation_claim / consumed 推进 / 会话字段更新），
  // 旧 state 整体覆盖仍会回滚他人效果（Kimi C2 网络窗口实证）。现在锁内对
  // prior.store_revision 与调用方期望做强比较：不一致即抛 CAS 冲突，绝不
  // 覆盖未知推进；fresh 里他人新增/推进的其余会话原样保留。
  withEnrollmentStoreLock(dataDir, () => {
    const current = readEnrollmentStore(dataDir);
    const prior = current.sessions.find((s) => s.enrollment_id === state.enrollment_id) as
      | WorkbuddyEnrollment
      | undefined;
    const priorRevision = prior?.store_revision;
    // review P1-3（A319 校准）：legacy 快照可信匹配——expected 未声明但
    // state 带 pristine 快照摘要且与锁内 prior **逐字节一致** → 证明调用方
    // 读到的就是当前这份，允许首轮推进 revision（legacy 恢复不再永远
    // CAS 拒）；摘要不一致（await 窗口内他人已推进/换会话）→ 冲突不写。
    const legacyDigest = (state as unknown as { [SNAPSHOT_DIGEST]?: unknown })[SNAPSHOT_DIGEST];
    const matches =
      prior === undefined
        ? expectedPriorRevision === undefined || expectedPriorRevision === 0
        : expectedPriorRevision === undefined
          ? typeof legacyDigest === "string" &&
            legacyDigest === enrollmentSnapshotDigest(prior)
          : priorRevision === expectedPriorRevision;
    if (!matches) {
      throw new CatalogPipelineError(
        "STATE_CAS_CONFLICT",
        "enrollment 会话已被其他写入方推进；请重读后重试（review P1-3 真 CAS）",
      );
    }
    const filtered = current.sessions
      .filter((session) => session.enrollment_id !== state.enrollment_id)
      .map((session) => {
        const old = session as WorkbuddyEnrollment;
        return state.status === "published" && old.status === "published" &&
          old.catalog_agent_id === state.catalog_agent_id && old.binding_id !== state.binding_id
          ? { ...old, status: "replaced" as const, store_revision: (old.store_revision ?? 0) + 1 }
          : session;
      });
    const saved: WorkbuddyEnrollment = {
      ...state,
      store_revision: (priorRevision ?? 0) + 1,
    };
    writeFileAtomic(
      enrollmentStorePath(dataDir),
      `${JSON.stringify({ ...current, sessions: [...filtered, saved] })}\n`,
      { mode: 0o600 },
    );
    // 同一调用方顺序多次保存：把新 revision 反映回调用方持有的 state，
    // 下一次保存的期望值即为本轮刚落盘值（同写者连续推进不误报 CAS）；
    // pristine 摘要同步刷新为落盘后的内容（下一轮 legacy 分支也成立）。
    state.store_revision = saved.store_revision;
    Object.defineProperty(state, SNAPSHOT_DIGEST, {
      value: enrollmentSnapshotDigest(saved),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
}

function frozenCard(deps: CatalogPipelineDeps, origin: string): AgentCard {
  return buildAgentCard({
    name: deps.card.name,
    description: deps.card.description,
    providerOrganization: deps.card.providerOrganization,
    version: deps.card.version,
    baseUrl: origin,
    a2aPath: deps.a2aPath ?? DEFAULT_A2A_PATH,
    ...(deps.card.securityScheme !== undefined ? { securityScheme: deps.card.securityScheme } : {}),
  });
}

/**
 * S3 串联（后台对账）：DEPLOYED_UNBOUND → BOUND → VERIFYING →（服务检查）→
 * READY_TO_PUBLISH。
 *
 * 幂等与断点：先匿名读公开绑定——已确认则跳过请求直接推进；未确认则看证据流，
 * 没发过请求才发（不重复制造未决请求），随后按超时轮询。轮询超时不是失败：
 * 返回 `awaiting_portal_confirmation`，记录原处等待，商家确认后重跑即续办。
 *
 * 目录不可达：记录 FAILED_RETRYABLE（可重试），不推进、不谎报。
 */
export async function reconcileBinding(
  record: OnboardingRecord,
  deps: CatalogPipelineDeps,
): Promise<BindingReconcileOutcome> {
  if (!["DEPLOYED_UNBOUND", "BOUND", "VERIFYING", "READY_TO_PUBLISH"].includes(record.status)) {
    throw new CatalogPipelineError(
      "STATE_NOT_ADMISSIBLE",
      `reconcileBinding 不可在当前状态执行（${record.status}）`,
    );
  }
  if (deps.dataDir === undefined) {
    throw new CatalogPipelineError("SERVICE_CHECK_UNAVAILABLE", "WorkBuddy enrollment 需要持久状态目录；未配置时必须停止，不能退回旧门户确认流程");
  }
  requirePlatformIdentity(record);
  const { keyThumbprint } = runtimePublicKey(deps.identity);
  const origin = deps.runtimeOrigin.replace(/\/+$/, "");
  const a2aEndpoint = `${origin}${deps.a2aPath ?? DEFAULT_A2A_PATH}`;
  const agentId = record.catalogAgentId;
  const expectedCatalogOrigin = deps.client.catalogOrigin;
  const now = deps.awaitOptions?.now ?? (() => new Date());
  const card = frozenCard(deps, origin);
  const previewDigest = `sha256:${createHash("sha256").update(canonicalize(card), "utf8").digest("hex")}`;
  let state = workbuddyEnrollment(deps.dataDir, record.recordId);
  const materialChanged = state !== undefined && (
    state.catalog_origin !== expectedCatalogOrigin || state.key_thumbprint !== keyThumbprint ||
    state.runtime_origin !== origin || state.preview_digest !== previewDigest
  );
  if (materialChanged && state?.status !== "published") {
    throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "仍有一个未完成的接入任务，其Catalog、密钥、地址或公开名片不同；必须先完成或取消该任务。");
  }
  if (materialChanged) state = undefined; // 原绑定留存；新密钥/地址/资料必须新授权。
  if (state !== undefined && state.status !== "published" && (!Number.isFinite(Date.parse(state.expires_at)) || Date.parse(state.expires_at) <= now().getTime())) {
    state = undefined;
  }

  if (state === undefined && record.status !== "DEPLOYED_UNBOUND") {
    throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "恢复记录缺少持久 enrollment 状态；禁止重复创建许可或猜测绑定。");
  }

  if (state === undefined) {
    const session = await deps.client.createDeviceEnrollment({
      runtimeOrigin: origin,
      a2aEndpoint,
      generation: deps.generation,
      serviceEpoch: deps.serviceEpoch,
      publicPreview: card as unknown as Record<string, unknown>,
      publicProfileRevision: 1,
    }, deps.identity);
    const priorCatalogAgents = new Set(readEnrollmentStore(deps.dataDir).sessions
      .map((item) => item as WorkbuddyEnrollment)
      .filter((item) => item.owner_ref === record.recordId && item.status === "published" &&
        item.catalog_origin === expectedCatalogOrigin && typeof item.catalog_agent_id === "string")
      .map((item) => item.catalog_agent_id!));
    if (priorCatalogAgents.size > 1) throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "Catalog中有多个历史Agent身份，必须人工选择迁移目标。");
    const expectedAgentId = priorCatalogAgents.values().next().value as string | undefined;
    state = {
      owner_ref: record.recordId,
      catalog_origin: expectedCatalogOrigin,
      enrollment_id: session.enrollmentId,
      runtime_origin: origin,
      key_thumbprint: keyThumbprint,
      expires_at: session.expiresAt,
      status: "preparing",
      device_code: session.deviceCode,
      user_code: session.userCode,
      verification_uri: session.verificationUri,
      interval: session.intervalSeconds,
      preview_digest: previewDigest,
      frozen_card: card,
      ...(expectedAgentId !== undefined ? { expected_catalog_agent_id: expectedAgentId } : {}),
    };
    saveWorkbuddyEnrollment(deps.dataDir, state, state.store_revision);
    deps.store.recordPendingEvidence(record.recordId, {
      kind: "text_claim",
      summary: `catalog:device-authorization ${session.verificationUri} 配对码=${session.userCode}`,
      observedAt: now().toISOString(),
    });
  }

  if (state.status === "preparing") {
    const poll = await deps.client.pollDeviceEnrollment(state.device_code, deps.identity);
    if (poll.status !== "authorized") {
      state = { ...state, interval: poll.intervalSeconds };
      saveWorkbuddyEnrollment(deps.dataDir, state, state.store_revision);
      return {
        kind: "awaiting_portal_confirmation",
        record: deps.store.getRecord(record.recordId) ?? record,
        hint: `${PORTAL_CONFIRMATION_HINT} 配对码：${state.user_code}。授权页：${state.verification_uri}`,
      };
    }
    if (poll.enrollmentId !== state.enrollment_id || poll.runtimeOrigin !== origin || poll.a2aEndpoint !== a2aEndpoint ||
        state.expected_catalog_agent_id !== undefined && poll.catalogAgentId !== state.expected_catalog_agent_id ||
        poll.merchantId.trim() === "" ||
        poll.authorizationEpoch < 1 || poll.approvedCardDigest !== state.preview_digest ||
        !poll.scopes.includes("runtime:bind") || !poll.scopes.includes("card:publish") || !poll.scopes.includes("heartbeat")) {
      throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "Catalog 授权材料、授权代次或范围与待接入 Runtime 不一致，已停止。");
    }
    state = { ...state, status: "authorized", catalog_agent_id: poll.catalogAgentId, grant: poll.grant,
      merchant_id: poll.merchantId, authorization_epoch: poll.authorizationEpoch, expires_at: poll.expiresAt } as WorkbuddyEnrollment;
    saveWorkbuddyEnrollment(deps.dataDir, state, state.store_revision);
  }

  if (state.status === "authorized") {
    if (state.catalog_agent_id !== agentId || state.grant === undefined || state.authorization_epoch === undefined || state.merchant_id === undefined) {
      throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "Catalog 授权的 Agent 与开通记录不匹配，已停止。");
    }
    const binding = await deps.client.bindEnrollment({
      enrollmentId: state.enrollment_id,
      grant: state.grant,
      catalogAgentId: state.catalog_agent_id,
      merchantId: state.merchant_id,
      runtimeOrigin: origin,
      a2aEndpoint,
      generation: deps.generation,
      serviceEpoch: deps.serviceEpoch,
      authorizationEpoch: state.authorization_epoch,
    }, deps.identity);
    if (binding.keyThumbprint !== keyThumbprint) throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "Catalog 绑定回执指纹不匹配");
    const rawClaims = binding.bindingClaim["claims"];
    const claimMerchantId = rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
      ? (rawClaims as Record<string, unknown>)["merchant_id"]
      : undefined;
    const claimExpiry = rawClaims !== null && typeof rawClaims === "object" && !Array.isArray(rawClaims)
      ? (rawClaims as Record<string, unknown>)["expires_at"]
      : undefined;
    if (typeof claimMerchantId !== "string" || claimMerchantId.trim() === "" || typeof claimExpiry !== "string") {
      throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "Catalog签名绑定声明缺少merchant_id/expires_at");
    }
    state = { ...state, status: "bound", binding_id: binding.bindingId, binding_version: binding.bindingVersion,
      merchant_id: claimMerchantId, binding_expires_at: claimExpiry, expected_card_revision: binding.activeCardRevision ?? 0 };
    saveWorkbuddyEnrollment(deps.dataDir, state, state.store_revision);
  }

  let current = deps.store.getRecord(record.recordId) ?? record;
  if (current.status === "DEPLOYED_UNBOUND") {
    current = deps.store.advance({ recordId: current.recordId, expectedRevision: current.revision, nextStatus: "BOUND",
      evidence: catalogEvidence(current, "catalog:runtime-binding"), runtimeOriginHost: new URL(origin).hostname });
  }
  if (current.status === "BOUND") {
    current = deps.store.advance({ recordId: current.recordId, expectedRevision: current.revision, nextStatus: "VERIFYING",
      evidence: catalogEvidence(current, "catalog:runtime-binding") });
  }

  if (current.status === "VERIFYING") {
    if (deps.serviceCheck === undefined) throw new CatalogPipelineError("SERVICE_CHECK_UNAVAILABLE", "服务检查能力未配置，拒绝假报上线");
    const check = await deps.serviceCheck();
    if (!check.ok) {
      deps.store.recordPendingEvidence(current.recordId, {
        kind: "adapter_return",
        summary: `Runtime readiness 未通过，保留当前授权并稍后重试：${check.detail ?? "readiness not ready"}`,
        observedAt: now().toISOString(),
      });
      throw new CatalogPipelineError("SERVICE_CHECK_UNAVAILABLE", `服务检查未通过：${check.detail ?? "readiness not ready"}`);
    }
    current = deps.store.advance({ recordId: current.recordId, expectedRevision: current.revision, nextStatus: "READY_TO_PUBLISH",
      step: "service-check", evidence: catalogEvidence(current, "kiwi-cloud:service-check") });
  }

  if (state.status === "bound") {
    if (state.catalog_agent_id !== agentId || state.binding_id === undefined) throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "持久绑定状态字段不完整");
    const bindingId = state.binding_id;
    const expectedRevision = state.expected_card_revision ?? 0;
    let revision = state.card_revision;
    if (revision === undefined) {
      const publication = await deps.client.publishCard({ agentId, bindingId, generation: deps.generation,
        expectedRevision, agentCard: state.frozen_card, a2aEndpoint, runtimeOrigin: origin }, deps.identity);
      if (publication.revision === null) throw new CatalogPipelineError("PUBLISH_RECEIPT_INVALID", "名片发布回执缺少 revision");
      revision = publication.revision;
      state = { ...state, card_revision: revision };
      saveWorkbuddyEnrollment(deps.dataDir, state, state.store_revision);
    }
    if (revision === undefined) throw new CatalogPipelineError("PUBLISH_RECEIPT_INVALID", "持久名片状态缺 revision");
    const activated = await deps.client.activateCard({ agentId, bindingId, cardRevision: revision, expectedRevision }, deps.identity);
    if (activated.revision === null) throw new CatalogPipelineError("PUBLISH_RECEIPT_INVALID", "名片激活回执缺少 revision");
    state = { ...state, status: "published", card_revision: activated.revision };
    saveWorkbuddyEnrollment(deps.dataDir, state, state.store_revision);
  }

  current = deps.store.getRecord(record.recordId) ?? current;
  if (current.status === "READY_TO_PUBLISH") {
    current = deps.store.advance({ recordId: current.recordId, expectedRevision: current.revision, nextStatus: "PUBLISHED",
      step: "public-profile", evidence: catalogEvidence(current, "catalog:authorized-card-publication") });
  }
  if (state.status !== "published" || state.binding_id === undefined || state.binding_version === undefined || state.merchant_id === undefined || state.binding_expires_at === undefined) {
    throw new CatalogPipelineError("BINDING_NOT_CONFIRMED", "商家许可后的自动绑定/发卡尚未完成。");
  }
  return {
    kind: "advanced",
    record: current,
    confirmed: {
      bindingId: state.binding_id,
      bindingVersion: state.binding_version,
      merchantId: state.merchant_id,
      expiresAt: state.binding_expires_at,
      runtimeOrigin: origin,
      a2aEndpoint,
      keyId: deps.identity.keyId,
      keyThumbprint,
      cardRevision: state.card_revision ?? null,
      cardEtag: null,
      publicationState: "ACTIVE",
    },
  };
}

/**
 * S4 串联（向导「确认公开信息」步的副作用部分）：构造名片 → 发布 → CAS 激活。
 *
 * **不做状态推进**：返回权威证据，由调用方（向导 advance 通道）经
 * `store.advance(..., step: "public-profile")` 推进到 PUBLISHED——状态写入只走
 * 既有通道，保持 CAS 与证据分级单点把关。
 *
 * 失败语义（§4.6）：
 *   - 未确认绑定 → BINDING_NOT_CONFIRMED（不发出任何发布请求）；
 *   - 目录不可达 → 记录 FAILED_RETRYABLE + `pending_publication` 标记，抛原错误；
 *   - CAS 冲突（客户端已重读 + 重试一次）→ 记录 BLOCKED，报人工。
 */
export async function publishCardForRecord(
  record: OnboardingRecord,
  deps: CatalogPipelineDeps,
): Promise<AuthoritativeEvidence> {
  if (record.status !== "READY_TO_PUBLISH") {
    throw new CatalogPipelineError(
      "STATE_NOT_ADMISSIBLE",
      `publishCardForRecord 只在 READY_TO_PUBLISH 可执行（当前 ${record.status}）`,
    );
  }
  const { keyThumbprint } = runtimePublicKey(deps.identity);
  const origin = deps.runtimeOrigin.replace(/\/+$/, "");
  const a2aEndpoint = `${origin}${deps.a2aPath ?? DEFAULT_A2A_PATH}`;
  const agentId = record.catalogAgentId;

  // 未确认不发布：公开绑定必须与本实例逐字匹配。
  const binding = await deps.client.fetchPublicBinding(agentId);
  if (
    binding === null ||
    binding.keyThumbprint !== keyThumbprint ||
    binding.runtimeOrigin.replace(/\/+$/, "") !== origin
  ) {
    throw new CatalogPipelineError(
      "BINDING_NOT_CONFIRMED",
      "公开读地址上没有与本实例匹配的已确认绑定——未确认不发布",
    );
  }

  // 名片与 Runtime 自发的 well-known 卡同源：url = 运行时 origin，
  // supportedInterfaces[0].url = 绑定的 a2a_endpoint（客户端会再自查一遍）。
  const card: AgentCard = buildAgentCard({
    name: deps.card.name,
    description: deps.card.description,
    providerOrganization: deps.card.providerOrganization,
    version: deps.card.version,
    baseUrl: origin,
    a2aPath: deps.a2aPath ?? DEFAULT_A2A_PATH,
    ...(deps.card.securityScheme !== undefined ? { securityScheme: deps.card.securityScheme } : {}),
  });

  // 重复提交同一 card_digest 前，先读当前 expected_revision。
  const expectedRevision = binding.cardRevision ?? 0;
  try {
    const published = await deps.client.publishCard(
      {
        agentId,
        bindingId: binding.bindingId,
        generation: deps.generation,
        expectedRevision,
        agentCard: card,
        a2aEndpoint,
        runtimeOrigin: origin,
      },
      deps.identity,
    );
    // 激活需要发布回执里的 card_revision（catalog `create_card_revision` 返回
    // {card_revision, digest, etag}）；回执缺 revision 是契约违例，绝不猜。
    if (published.revision === null) {
      throw new CatalogPipelineError(
        "PUBLISH_RECEIPT_INVALID",
        "发布回执缺少 card_revision——无法激活（契约违例，需人工核对）",
      );
    }
    await deps.client.activateCard(
      {
        agentId,
        bindingId: binding.bindingId,
        cardRevision: published.revision,
        expectedRevision,
      },
      deps.identity,
    );
  } catch (err) {
    if (err instanceof CatalogClientError && err.code === "CATALOG_UNREACHABLE") {
      // 目录不可达：标 pending_publication（证据流留痕），**不推进、不谎报已发布**。
      // 不 store.fail：记录停在 READY_TO_PUBLISH，商家按退避重新提交本步即可重试
      // （FAILED_RETRYABLE 无法经向导 advance 通道回到 READY_TO_PUBLISH，会把向导卡死）。
      deps.store.recordPendingEvidence(record.recordId, {
        kind: "adapter_return",
        summary: `${PENDING_PUBLICATION_MARKER}: catalog 不可达（${err.message}），按退避重试`,
        observedAt: new Date().toISOString(),
      });
    } else if (err instanceof CatalogClientError && err.code === "CONFLICT") {
      // 客户端已重读 + 重试一次：仍冲突 → 停下来报人工。
      deps.store.fail(record.recordId, record.revision, {
        reason: `CAS 冲突（已重试一次）：${err.message}——需人工核对门户/其他写者`,
        retryable: false,
      });
    } else if (err instanceof CatalogClientError) {
      deps.store.fail(record.recordId, record.revision, {
        reason: `catalog 拒绝（${err.code}）：${err.message}`,
        retryable: false,
      });
    } else if (err instanceof CatalogPipelineError) {
      // 契约违例等本地判定（如发布回执缺 card_revision）：确定失败，报人工。
      deps.store.fail(record.recordId, record.revision, {
        reason: `发布流水线阻断（${err.code}）：${err.message}`,
        retryable: false,
      });
    }
    throw err;
  }
  return catalogEvidence(record, "catalog:card-publication");
}

/**
 * 向导 advance 通道的 `platformEvidence` 适配器（M4 api.ts 的形状）。
 *
 * 只接管本模块负责的两步：「服务检查」（服务检查回执）与「确认公开信息」
 * （S4 发布 + 激活）；其余步骤返回 undefined（维持"适配器未配置 → 503"的
 * 既有行为，绝不代答）。状态不对（如记录不在 READY_TO_PUBLISH）同样返回
 * undefined——准入判定由向导通道的 checkStepSubmission 给出，本适配器
 * 不在错误状态下产生副作用。
 */
export function catalogPlatformEvidenceAdapter(
  deps: CatalogPipelineDeps,
): (input: { stepId: string; recordId: string }) => Promise<
  AuthoritativeEvidence | { kind: "platform_failure"; code: string; detail?: string } | undefined
> {
  return async ({ stepId, recordId }) => {
    const record = deps.store.getRecord(recordId);
    if (record === undefined) return undefined;

    if (stepId === "service-check") {
      if (record.status !== "VERIFYING" || deps.serviceCheck === undefined) return undefined;
      const check = await deps.serviceCheck();
      if (!check.ok) {
        return {
          kind: "platform_failure",
          code: "service_check_failed",
          detail: check.detail ?? "readiness not ready",
        };
      }
      return catalogEvidence(record, "kiwi-cloud:service-check");
    }

    if (stepId === "public-profile") {
      if (record.status !== "READY_TO_PUBLISH") return undefined;
      try {
        return await publishCardForRecord(record, deps);
      } catch (err) {
        if (err instanceof CatalogClientError && err.code === "CATALOG_UNREACHABLE") {
          return { kind: "platform_failure", code: "catalog_unreachable", detail: err.message };
        }
        if (err instanceof CatalogClientError && err.code === "CONFLICT") {
          return { kind: "platform_failure", code: "cas_conflict", detail: err.message };
        }
        if (err instanceof CatalogPipelineError && err.code === "BINDING_NOT_CONFIRMED") {
          return { kind: "platform_failure", code: "binding_not_confirmed", detail: err.message };
        }
        throw err;
      }
    }

    return undefined;
  };
}
