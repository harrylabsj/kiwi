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
 * KiwiBuyerService —— kiwi-buyer-mcp 薄 Buyer Core（战略 v2.5 §5.1/§5.5/§6.2）。
 *
 * 设计原则（§5.1）：Host Agent owns conversation；UCP owns standard commerce
 * primitives；Kiwi owns cross-merchant sourcing and commercial negotiation。
 * 本服务 LLM-independent：宿主 Agent 负责自然语言理解，Kiwi 确定性完成
 * discovery routing、RFQ fan-out、offer normalization、policy evaluation、
 * counteroffer、ledger、recovery 与 agreement。
 *
 * 唯一权威：TaskApprovalStore 持久存储；EffectiveAuthorization 五层交集
 * deny 优先；写操作幂等；AcceptNonbinding/handoff 绑定持久 approval_id。
 *
 * 执行 seam（Phase 2 接线真实 merchant 网络）：MerchantIndex / QuoteFetcher /
 * Negotiator 为可注入接口。v0.1 默认使用 Static 实现或由宿主注入。
 */

import { contentDigest } from "../negotiation/jcs.js";
import { uuidv7 } from "@earendil-works/pi-ai";

import {
  assertNorthboundContractValid,
  validateCommerceIntent,
  validateEffectiveAuthorization,
} from "../contracts/northbound-schema.js";
import { CatalogSourceError } from "../discovery/catalog-source/errors.js";
import type {
  BuyerFollowRecord,
  BuyerFollowUpdateGroup,
} from "../discovery/catalog-source/buyer-follows.js";
import { McpError } from "./errors.js";
import { TaskApprovalStore, type StoredApproval, type StoredTask } from "./store.js";

export type BuyerAction =
  | "discover"
  | "inquiry_rfq"
  | "compare_offers"
  | "counter_offer"
  | "accept_nonbinding"
  | "handoff"
  | "payment";

/** M0 商家公开资料命中摘要（merchant-buddy 第 0 版 §4；工具返回大小控制，不含 faq/summary）。 */
export interface MerchantPublicationSummary {
  publication_id: string;
  /** 命中查询的商品名（商家声明）。 */
  title: string;
  source_kind: "merchant_declared";
  updated_at: string;
  published_at?: string;
  category?: string;
  shop_url?: string;
}

export interface MerchantRecord {
  merchant_id: string;
  name: string;
  verified: boolean;
  category?: string;
  region?: string;
  ucp_profile_url?: string;
  agent_card_url?: string;
  capabilities: string[];
  /**
   * 可实时询价（有可路由 Agent Card，能力来自 Agent 侧）。M0-only 商家恒 false；
   * 未设置时按既有链路处理（marketplace 等 legacy 索引不透出该字段）。
   */
  inquiry_available?: boolean;
  /**
   * 记录仅来自 M0 商家公开资料（无 Agent/Listing 侧命中）——RFQ 硬门依据。
   * v1 商家同时命中公开资料时此字段保持 undefined（实时能力不被降级）。
   */
  source_kind?: "merchant_declared";
  /** M0 公开资料命中（可并列于 v1 Agent 能力；商家声明内容，不是 Kiwi 背书）。 */
  publications?: MerchantPublicationSummary[];
  /** 该商家匹配查询的商品 SKU（marketplace 商品 FTS 路由），供 RFQ 用商家自有 SKU。 */
  matching_skus?: string[];
  /**
   * 配送时效摘要（商家按区域维护，如 `东北 3-4天；华北 1-2天`）。来自 listing
   * 的 commercial_hints.lead_time_hint；买家发现/选择时的重要指标。
   */
  delivery?: string;
}

export interface MerchantIndex {
  search(query: string, opts?: { category?: string; region?: string }): Promise<MerchantRecord[]>;
  /**
   * 按 merchant_id 解析完整记录（含 agent_card_url / matching_skus）。requestQuotes
   * 在 intent query 文本搜索匹配不到商家时用此兜底——不依赖用户意图文本恰好命中
   * catalog 的 title/category LIKE（否则丢 agent_card_url → A2A 无法磋商）。
   */
  resolveById(merchantId: string): Promise<MerchantRecord | undefined>;
  /**
   * 可选：上一次 search 的非致命降级说明（如某数据来源暂不可用但其余来源
   * 仍返回了结果）。service 层拼进 kiwi_search 的 note，供宿主如实转述。
   */
  lastSearchNotes?(): string[];
}

export interface QuoteCandidateInput {
  merchant_id: string;
  status: "succeeded" | "failed";
  provenance?: {
    merchant_reply_id?: string;
    negotiation_id?: string;
    offer_id?: string;
    source?: string;
    /** 商家原回复文本（真实报价/库存/交付事实），用于 kiwi_get_task 展示。 */
    reply_text?: string;
    /** 会话 buyer_token（作用域限该会话），供磋商复用；最小披露。 */
    buyer_token?: string;
    /** 该商家实际报价的 SKU（磋商 proposal 复用）。 */
    sku?: string;
    /** A2A 磋商端点（agent card JSONRPC url），供 A2ANegotiator 复用。 */
    a2a_endpoint?: string;
  };
  failure?: { classification: string; retryable: boolean; detail?: string };
}

export interface QuoteFetcher {
  requestQuotes(intent: Record<string, unknown>, merchants: MerchantRecord[]): Promise<QuoteCandidateInput[]>;
}

/**
 * 买家关注执行 seam（M4 拉取式订阅，merchant-buddy 第 0 版设计 §4/§2 买家
 * 路径 3-5）。生产实现是 discovery/catalog-source 的 BuyerFollowsSource
 * （catalog 账号会话认证）；未注入时关注工具返回"需要先在 Kiwi 目录登录"
 * 的可解释引导（fail-closed，不伪造买家身份）。
 */
export interface BuyerFollowsClient {
  follow(
    merchantId: string,
    opts?: { category?: string; consent_version?: string },
  ): Promise<{ follow: BuyerFollowRecord; created: boolean }>;
  unfollow(merchantId: string): Promise<{ merchant_id: string; following: false }>;
  listFollows(): Promise<BuyerFollowRecord[]>;
  /** 仅响应买家主动查询；水位语义在上游（返回什么再推进 last_seen_at）。 */
  getUpdates(): Promise<BuyerFollowUpdateGroup[]>;
}
export type { BuyerFollowRecord, BuyerFollowUpdateGroup };

export interface NegotiationStep {
  round: number;
  action: "counter_offer" | "clarification";
  summary: string;
  /** 商家对本次还价的回复（真实文本），供 kiwi_get_task 展示。 */
  reply?: string;
}

export interface Negotiator {
  negotiate(
    taskId: string,
    intent: Record<string, unknown>,
    current: NegotiationStep,
    candidates: Array<Record<string, unknown>>,
  ): Promise<NegotiationStep>;
}

export interface KiwiBuyerServiceOptions {
  store: TaskApprovalStore;
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  /** 冻结的 DelegationPolicy（已通过 schema 校验）。 */
  delegationPolicy: Record<string, unknown>;
  merchantIndex?: MerchantIndex;
  quoteFetcher?: QuoteFetcher;
  negotiator?: Negotiator;
  /** 买家关注 seam（M4）；缺省时关注工具返回可解释登录引导。 */
  followsClient?: BuyerFollowsClient;
  now?: () => string;
}

export interface AuthorizationRecord {
  authorization_id: string;
  action: BuyerAction;
  subject: {
    buyer_agent_id: string;
    session_id: string;
    delegation_id: string;
    expires_at: string;
  };
  layers: Record<string, { status: "allowed" | "denied"; reason?: string }>;
  effective_decision: "granted" | "denied";
  approval_id?: string;
  expires_at: string;
  decided_at: string;
}

interface DelegationPolicyLike {
  policy_id: string;
  expires_at: string;
  actions: Record<string, { mode: "auto" | "ask" | "never"; note?: string }>;
  limits?: {
    max_total_price?: { currency: string; amount_minor: number };
    max_unit_price?: { currency: string; amount_minor: number };
    max_quantity?: { value: number; unit: string };
    max_rounds?: number;
    allowed_merchants?: string[];
    allowed_currencies?: string[];
    deadline?: string;
  };
}

function utcNow(): string {
  return new Date().toISOString();
}

function policyActionMode(policy: DelegationPolicyLike, action: string): "auto" | "ask" | "never" {
  return policy.actions[action]?.mode ?? "never";
}

export class KiwiBuyerService {
  private readonly store: TaskApprovalStore;
  private readonly principal: string;
  private readonly buyerAgentId: string;
  private readonly sessionId: string;
  private readonly policy: DelegationPolicyLike;
  private readonly merchantIndex?: MerchantIndex;
  private readonly quoteFetcher?: QuoteFetcher;
  private readonly negotiator?: Negotiator;
  private readonly followsClient?: BuyerFollowsClient;
  private readonly now: () => string;

  constructor(options: KiwiBuyerServiceOptions) {
    this.store = options.store;
    this.principal = options.principal;
    this.buyerAgentId = options.buyerAgentId;
    this.sessionId = options.sessionId;
    const clock = options.now ?? utcNow;
    this.now = () => new Date(Date.parse(clock())).toISOString();
    this.policy = options.delegationPolicy as unknown as DelegationPolicyLike;
    this.merchantIndex = options.merchantIndex;
    this.quoteFetcher = options.quoteFetcher;
    this.negotiator = options.negotiator;
    this.followsClient = options.followsClient;
  }

  // ---- Northbound：kiwi_search ----------------------------------------------

  async search(input: {
    query: string;
    category?: string;
    region?: string;
  }): Promise<{ merchants: MerchantRecord[]; note?: string }> {
    if (this.merchantIndex === undefined) {
      return { merchants: [], note: "merchant index not wired; discovery pending" };
    }
    try {
      const merchants = await this.merchantIndex.search(input.query, {
        category: input.category,
        region: input.region,
      });
      const notes = this.merchantIndex.lastSearchNotes?.() ?? [];
      // 单侧降级（如 M0 公开资料来源暂不可用）如实标注；不静默、不补全。
      return notes.length > 0 ? { merchants, note: notes.join("；") } : { merchants };
    } catch (error) {
      // catalog 不可达：降级为可解释 note，不编造商家（§3.2 Discovery & Routing）。
      return {
        merchants: [],
        note: `merchant index unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ---- Northbound：买家关注（M4 拉取式订阅）-----------------------------------

  /**
   * 显式关注一个商家。仅买家主动调用本方法构成订阅——搜索/浏览/询价不产生
   * 关注行（上游同样只认显式 PUT）。
   */
  async followMerchant(input: {
    merchant_id: string;
    category?: string;
    consent_version?: string;
  }): Promise<{ follow: BuyerFollowRecord; created: boolean }> {
    const merchantId = this.requireMerchantId(input.merchant_id);
    return this.withFollows((client) =>
      client.follow(merchantId, {
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.consent_version !== undefined ? { consent_version: input.consent_version } : {}),
      }),
    );
  }

  /** 取消关注（幂等）；取消后不再出现在关注列表与更新里。 */
  async unfollowMerchant(input: {
    merchant_id: string;
  }): Promise<{ merchant_id: string; following: false }> {
    const merchantId = this.requireMerchantId(input.merchant_id);
    return this.withFollows((client) => client.unfollow(merchantId));
  }

  /** 我的活跃关注列表（买家管理面）。 */
  async listFollows(): Promise<{ follows: BuyerFollowRecord[] }> {
    const follows = await this.withFollows((client) => client.listFollows());
    return { follows };
  }

  /** 主动拉取关注更新（仅响应买家主动询问；事件仅为商家公开动态）。 */
  async getFollowUpdates(): Promise<{ updates: BuyerFollowUpdateGroup[] }> {
    const updates = await this.withFollows((client) => client.getUpdates());
    return { updates };
  }

  private requireMerchantId(raw: string): string {
    const merchantId = String(raw ?? "").trim();
    if (merchantId === "") {
      throw new McpError("invalid_params", "merchant_id 必须是非空字符串");
    }
    return merchantId;
  }

  /**
   * 关注 seam 统一入口：未配置会话 → 可解释登录引导（fail-closed，不伪造
   * 买家身份）；catalog 拒绝会话（401/403）→ 引导重新登录。
   */
  private async withFollows<T>(work: (client: BuyerFollowsClient) => Promise<T>): Promise<T> {
    const client = this.followsClient;
    if (client === undefined) {
      throw new McpError(
        "invalid_request",
        "未配置 Kiwi 目录买家会话：买家关注功能需要先在 Kiwi 目录登录" +
          "（部署方配置 KIWI_CATALOG_SESSION / --catalog-session 后重试）",
      );
    }
    try {
      return await work(client);
    } catch (error) {
      if (error instanceof CatalogSourceError && error.code === "session_rejected") {
        throw new McpError(
          "invalid_request",
          "Kiwi 目录买家会话已过期或无效：请重新登录 Kiwi 目录后重试",
        );
      }
      throw error;
    }
  }

  // ---- Northbound：kiwi_request_quotes --------------------------------------

  async requestQuotes(input: {
    intent: Record<string, unknown>;
    idempotency_key?: string;
    merchant_ids?: string[];
  }): Promise<{ task: Record<string, unknown>; created: boolean }> {
    // 契约校验（§5.2）：CommerceIntent 必须合法；无效即拒绝，不落库。
    const intentErrors = validateCommerceIntent(input.intent);
    if (intentErrors.length > 0) {
      throw new McpError(
        "contract_violation",
        `CommerceIntent 违反冻结契约：${intentErrors.join("; ")}`,
      );
    }
    // M0 硬门（merchant-buddy 第 0 版 §4/§5）：仅有公开资料、无可路由 Agent 的
    // 商家不得进入 RFQ。服务层显式拒绝（不只靠宿主提示词），在创建任务/消息之前。
    await this.assertInquiryAvailable(input.merchant_ids);
    const policyId = this.policy.policy_id;
    const expiresAt = this.policy.expires_at;
    const idempotencyKey = input.idempotency_key ?? `req-${uuidv7()}`;
    const taskId = `task-${uuidv7()}`;
    const created = this.now();

    // 无 fetcher 时记录确定性 fan-out 槽位（§6.2 部分失败可解释）；有 fetcher 时
    // 只写真实结果，不预建槽位，避免候选重复。
    const preCandidates = this.quoteFetcher === undefined
      ? (input.merchant_ids ?? []).map((merchantId) => ({
          candidate_id: `cand-${uuidv7()}`,
          merchant_id: merchantId,
          status: "pending" as const,
          retryable: true,
        }))
      : [];

    const task: StoredTask = {
      task_id: taskId,
      task_kind: "request_quotes",
      status: "in_progress",
      idempotency_key: idempotencyKey,
      intent_id: String(input.intent.intent_id),
      delegation_policy_id: policyId,
      created_at: created,
      updated_at: created,
      expires_at: expiresAt,
      resumable: true,
      payload: JSON.stringify({
        task_id: taskId,
        task_kind: "request_quotes",
        status: "in_progress",
        idempotency_key: idempotencyKey,
        intent_id: input.intent.intent_id,
        delegation_policy_id: policyId,
        created_at: created,
        updated_at: created,
        expires_at: expiresAt,
        resumable: true,
        candidates: preCandidates,
        intent: input.intent,
      }),
    };

    const { task: persisted, created: isCreated } = this.store.createTask(task);
    if (!isCreated) {
      // 幂等命中：相同 idempotency_key 的重复提交返回原任务，不产生重复写入（§6.2）。
      return { task: this.decodeTask(persisted), created: false };
    }
    for (const candidate of preCandidates) {
      this.store.addCandidate(taskId, candidate);
    }

    // 真实 fan-out 交给注入的 QuoteFetcher（Phase 2 接线 A2A/UCP）。v0.1 无 fetcher
    // 时任务保持 in_progress + resumable，可恢复；有 fetcher 时按部分失败语义回写。
    let status = "in_progress";
    if (this.quoteFetcher !== undefined) {
      const merchants = input.merchant_ids ?? [];
      const index = this.merchantIndex;
      // 用意图的商品查询解析商家（拿到各自 matching_skus，供 RFQ 用商家自有 SKU）。
      const resolved =
        index !== undefined ? await index.search(this.firstQuery(input.intent)) : [];
      const merchantRecords = await Promise.all(
        merchants.map(async (m) => {
          const found = resolved.find((r) => r.merchant_id === m);
          if (found !== undefined) return found;
          // intent query 文本未命中 catalog LIKE 时按 merchant_id 直接解析
          // （保 agent_card_url，A2A 才能磋商；host 的 merchant_ids 来自一次
          // 成功的 kiwi_search，不该因意图措辞丢失完整记录）。
          if (index !== undefined) {
            const byId = await index.resolveById(m);
            if (byId !== undefined) return byId;
          }
          return { merchant_id: m, name: m, verified: false, capabilities: [] };
        }),
      );
      const results = await this.quoteFetcher.requestQuotes(input.intent, merchantRecords);
      const successes = results.filter((r) => r.status === "succeeded").length;
      if (results.length > 0) {
        for (const r of results) {
          this.store.addCandidate(taskId, {
            candidate_id: `cand-${uuidv7()}`,
            merchant_id: r.merchant_id,
            status: r.status,
            provenance: r.provenance,
            failure: r.failure,
            retryable: r.status === "failed" ? (r.failure?.retryable ?? false) : false,
          });
        }
        status = successes === results.length ? "succeeded" : "partial_success";
      }
    }

    const updated = this.store.updateTask(taskId, {
      status,
      resumable: true,
      payload: JSON.stringify({
        ...this.decodeTask(task),
        status,
        updated_at: this.now(),
        candidates: this.store.listCandidates(taskId),
      }),
    });
    const decoded = this.decodeTask(updated);
    // 冻结契约强制：持久任务记录必须满足 persistent-task/1.0 schema（§6.2）。
    assertNorthboundContractValid("persistent-task", decoded, "requestQuotes result");
    return { task: decoded, created: true };
  }

  // ---- Northbound：kiwi_get_task --------------------------------------------

  getTask(taskId: string): { task: Record<string, unknown> } {
    const task = this.store.getTask(taskId);
    if (task === undefined) throw new McpError("task_not_found", `task ${taskId} not found`);
    if (task.expires_at !== undefined && Date.parse(task.expires_at) < Date.parse(this.now())) {
      throw new McpError("task_expired", `task ${taskId} expired at ${task.expires_at}`);
    }
    return { task: this.decodeTask(task) };
  }

  // ---- Northbound：kiwi_negotiate -------------------------------------------

  async negotiate(input: {
    task_id: string;
    action: "counter_offer" | "clarification";
    summary: string;
  }): Promise<{ task: Record<string, unknown>; step: NegotiationStep }> {
    const task = this.store.getTask(input.task_id);
    if (task === undefined) throw new McpError("task_not_found", `task ${input.task_id} not found`);
    if (task.expires_at !== undefined && Date.parse(task.expires_at) < Date.parse(this.now())) {
      throw new McpError("task_expired", `task ${input.task_id} expired`);
    }
    const mode = policyActionMode(this.policy, "counter_offer");
    if (mode === "never") {
      throw new McpError("delegation_denied", "counter_offer 未获委托（never）");
    }
    const rounds = this.currentRounds(task);
    const maxRounds = this.policy.limits?.max_rounds ?? 3;
    if (rounds >= maxRounds) {
      throw new McpError(
        "delegation_denied",
        `counter_offer 超出委托轮次上限（max_rounds=${maxRounds}）`,
      );
    }

    let step: NegotiationStep = {
      round: rounds + 1,
      action: input.action,
      summary: input.summary,
    };
    if (this.negotiator !== undefined) {
      step = await this.negotiator.negotiate(input.task_id, {}, step, this.store.listCandidates(input.task_id));
    }

    const decoded = this.decodeTask(task);
    const prior: NegotiationStep[] = Array.isArray(decoded.steps)
      ? (decoded.steps as NegotiationStep[])
      : [];
    const steps = [...prior, step];
    const currentStatus = typeof decoded.status === "string" ? decoded.status : "in_progress";
    const updated = this.store.updateTask(input.task_id, {
      status: currentStatus === "pending" ? "in_progress" : currentStatus,
      payload: JSON.stringify({ ...decoded, steps, updated_at: this.now() }),
    });
    return { task: this.decodeTask(updated), step };
  }

  // ---- Northbound：kiwi_accept_agreement ------------------------------------

  async acceptAgreement(input: {
    task_id: string;
    candidate_id: string;
    approval_id?: string;
  }): Promise<{
    task: Record<string, unknown>;
    agreement: Record<string, unknown>;
    authorization: AuthorizationRecord;
  }> {
    const task = this.store.getTask(input.task_id);
    if (task === undefined) throw new McpError("task_not_found", `task ${input.task_id} not found`);
    if (task.expires_at !== undefined && Date.parse(task.expires_at) < Date.parse(this.now())) {
      throw new McpError("task_expired", `task ${input.task_id} expired`);
    }
    const candidate = this.store
      .listCandidates(input.task_id)
      .find((c) => c.candidate_id === input.candidate_id);
    if (candidate === undefined) {
      throw new McpError("invalid_params", `candidate ${input.candidate_id} not found on task`);
    }
    const termsDigest = contentDigest(candidate);
    const authorization = await this.evaluateAuthorization("accept_nonbinding", {
      taskId: input.task_id,
      candidateId: input.candidate_id,
      candidateDigest: termsDigest,
      approvalId: input.approval_id,
    });
    if (authorization.effective_decision !== "granted") {
      throw new McpError("authorization_denied", "AcceptNonbinding 未获五层授权", {
        authorization,
      });
    }
    const agreementId = `agreement-${uuidv7()}`;
    const now = this.now();
    const agreement = {
      agreement_id: agreementId,
      task_id: input.task_id,
      negotiation_id: (candidate.provenance as { negotiation_id?: string } | undefined)
        ?.negotiation_id,
      terms_digest: termsDigest,
      created_at: now,
      binding_effect: "nonbinding",
      creates_order: false,
      reserves_inventory: false,
      authorizes_payment: false,
      accepted_candidate_id: input.candidate_id,
      authorization_id: authorization.authorization_id,
    };
    this.store.createAgreement({
      agreement_id: agreementId,
      task_id: input.task_id,
      negotiation_id: agreement.negotiation_id,
      terms_digest: termsDigest,
      created_at: now,
      expires_at: undefined,
      payload: JSON.stringify(agreement),
    });
    const updated = this.store.updateTask(input.task_id, {
      status: "succeeded",
      payload: JSON.stringify({
        ...this.decodeTask(task),
        agreement_id: agreementId,
        status: "succeeded",
        updated_at: now,
      }),
    });
    return { task: this.decodeTask(updated), agreement, authorization };
  }

  // ---- Northbound：kiwi_get_agreement ---------------------------------------

  getAgreement(agreementId: string): { agreement: Record<string, unknown> } {
    const stored = this.store.getAgreement(agreementId);
    if (stored === undefined) {
      throw new McpError("agreement_not_found", `agreement ${agreementId} not found`);
    }
    return { agreement: this.parsePayload(stored.payload) };
  }

  // ---- Northbound：kiwi_handoff ---------------------------------------------

  async handoff(input: {
    agreement_id: string;
    /** 缺省触发 ASK 审批创建（approval_required 结构化返回，宿主 kiwi_approve 后重试）。 */
    approval_id?: string;
    destination_type: string;
    url?: string;
  }): Promise<{
    handoff_ref: { handoff_id: string; destination_type: string; url?: string };
    authorization: AuthorizationRecord;
  }> {
    const stored = this.store.getAgreement(input.agreement_id);
    if (stored === undefined) {
      throw new McpError("agreement_not_found", `agreement ${input.agreement_id} not found`);
    }
    const authorization = await this.evaluateAuthorization("handoff", {
      taskId: stored.task_id,
      approvalId: input.approval_id,
    });
    if (authorization.effective_decision !== "granted") {
      throw new McpError("authorization_denied", "Handoff 未获五层授权", { authorization });
    }
    const handoffRef = {
      handoff_id: `handoff-${uuidv7()}`,
      destination_type: input.destination_type,
      ...(input.url !== undefined ? { url: input.url } : {}),
    };
    return { handoff_ref: handoffRef, authorization };
  }

  // ---- 持久审批（宿主适配面；kiwi_approve / kiwi_reject 为 MCP 工具）----------

  /** 创建 pending 审批记录（ASK 动作触发）。返回持久 approval_id。 */
  requestApproval(input: {
    task_id: string;
    action: "accept_nonbinding" | "handoff" | "sensitive_disclosure";
    candidate_digest?: string;
  }): { approval_id: string } {
    const task = this.store.getTask(input.task_id);
    if (task === undefined) throw new McpError("task_not_found", `task ${input.task_id} not found`);
    const approvalId = `approval-${uuidv7()}`;
    const approval: StoredApproval = {
      approval_id: approvalId,
      task_id: input.task_id,
      action: input.action,
      status: "pending",
      candidate_digest: input.candidate_digest,
      expires_at: task.expires_at,
    };
    this.store.setApproval(input.task_id, approval);
    return { approval_id: approvalId };
  }

  /** 批准一个 pending 审批（绑定授权记录）。 */
  approveApproval(input: { approval_id: string; authorization: AuthorizationRecord }): void {
    const stored = this.store.getApproval(input.approval_id);
    if (stored === undefined) throw new McpError("invalid_params", `approval ${input.approval_id} not found`);
    if (stored.expires_at !== undefined && Date.parse(stored.expires_at) < Date.parse(this.now())) {
      throw new McpError("approval_denied", `approval ${input.approval_id} 已过期`);
    }
    this.store.setApproval(stored.task_id, {
      ...stored,
      status: "approved",
      decided_at: this.now(),
      authorization_json: JSON.stringify(input.authorization),
    });
  }

  /** 拒绝一个 pending 审批（deny 路径；deny 优先，§5.5）。 */
  rejectApproval(input: { approval_id: string; reason?: string }): void {
    const stored = this.store.getApproval(input.approval_id);
    if (stored === undefined) throw new McpError("invalid_params", `approval ${input.approval_id} not found`);
    this.store.setApproval(stored.task_id, {
      ...stored,
      status: "denied",
      decided_at: this.now(),
      authorization_json: JSON.stringify({
        reason: input.reason ?? "rejected by operator",
        decided_at: this.now(),
      }),
    });
  }

  /**
   * 宿主批准一个 pending 审批（ASK 门北向面）。自含授权记录——宿主只需给出
   * approval_id（来自 approval_required 结构化结果），无需构造 AuthorizationRecord。
   * 写操作：宿主在向用户呈现协议摘要并获确认后调用；后续携 approval_id 重试
   * kiwi_accept_agreement / kiwi_handoff。
   */
  approve(input: { approval_id: string; note?: string }): {
    approval_id: string;
    status: "approved";
    decided_at: string;
  } {
    const stored = this.store.getApproval(input.approval_id);
    if (stored === undefined) throw new McpError("invalid_params", `approval ${input.approval_id} not found`);
    if (stored.status !== "pending") {
      throw new McpError(
        "approval_denied",
        `approval ${input.approval_id} 状态=${stored.status}，只能批准 pending 审批`,
      );
    }
    const expiresAt = stored.expires_at ?? "2099-12-31T23:59:59Z";
    const decidedAt = this.now();
    const authorization: AuthorizationRecord = {
      authorization_id: `authz-${uuidv7()}`,
      action: stored.action as BuyerAction,
      subject: {
        buyer_agent_id: this.buyerAgentId,
        session_id: this.sessionId,
        delegation_id: this.policy.policy_id,
        expires_at: expiresAt,
      },
      layers: {
        runtime_approval: {
          status: "allowed",
          reason: `approved by host${input.note !== undefined ? `: ${input.note}` : ""}`,
        },
      },
      effective_decision: "granted",
      expires_at: expiresAt,
      decided_at: decidedAt,
    };
    this.approveApproval({ approval_id: input.approval_id, authorization });
    return { approval_id: input.approval_id, status: "approved", decided_at: decidedAt };
  }

  /** 宿主拒绝一个 pending 审批（deny 优先路径；拒绝后不可再批准）。 */
  reject(input: { approval_id: string; reason?: string }): {
    approval_id: string;
    status: "denied";
    decided_at: string;
  } {
    const stored = this.store.getApproval(input.approval_id);
    if (stored === undefined) throw new McpError("invalid_params", `approval ${input.approval_id} not found`);
    if (stored.status !== "pending") {
      throw new McpError(
        "approval_denied",
        `approval ${input.approval_id} 状态=${stored.status}，只能拒绝 pending 审批`,
      );
    }
    this.rejectApproval({ approval_id: input.approval_id, reason: input.reason });
    return { approval_id: input.approval_id, status: "denied", decided_at: this.now() };
  }

  // ---- 五层授权（§5.5 deny 优先）---------------------------------------------

  async evaluateAuthorization(
    action: BuyerAction,
    opts: { taskId: string; candidateId?: string; candidateDigest?: string; approvalId?: string },
  ): Promise<AuthorizationRecord> {
    const layers: Record<string, { status: "allowed" | "denied"; reason?: string }> = {
      package_trust: { status: "allowed", reason: "signed kiwi-buyer-mcp package, version pinned" },
      host_tool_policy: { status: "allowed", reason: "host invoked the tool within its policy" },
      runtime_approval: { status: "allowed", reason: "no approval gate for this action" },
      kiwi_delegation_policy: { status: "allowed" },
      merchant_hard_policy: { status: "allowed", reason: "within merchant hard policy" },
    };

    // 第 4 层：DelegationPolicy
    const mode = policyActionMode(this.policy, action);
    if (mode === "never") {
      layers.kiwi_delegation_policy = { status: "denied", reason: `action=${action} 委托=never` };
    } else if (mode === "ask") {
      // ASK：必须有已批准的持久审批；approval 动作必须与请求动作一致。
      const expectedAction = action === "accept_nonbinding" ? "accept_nonbinding" : "handoff";
      const approval = opts.approvalId !== undefined ? this.store.getApproval(opts.approvalId) : undefined;
      if (opts.approvalId !== undefined && approval === undefined) {
        throw new McpError("approval_required", `approval ${opts.approvalId} 不存在`, {
          approval_id: opts.approvalId,
        });
      }
      if (approval === undefined) {
        const created = this.requestApproval({
          task_id: opts.taskId,
          action: expectedAction,
          candidate_digest: opts.candidateDigest,
        });
        throw new McpError("approval_required", `action=${action} 需要持久审批`, {
          approval_id: created.approval_id,
        });
      }
      if (approval.action !== expectedAction) {
        layers.runtime_approval = {
          status: "denied",
          reason: `approval ${approval.approval_id} 动作=${approval.action} 与请求 ${action} 不一致`,
        };
      } else if (approval.status === "pending") {
        throw new McpError("approval_required", `approval ${approval.approval_id} 待审批`, {
          approval_id: approval.approval_id,
        });
      } else if (approval.status === "denied" || approval.status === "expired") {
        layers.runtime_approval = {
          status: "denied",
          reason: `approval ${approval.approval_id} 状态=${approval.status}`,
        };
      } else {
        layers.runtime_approval = {
          status: "allowed",
          reason: `persistent approval ${approval.approval_id} approved`,
        };
      }
      // ASK 动作的 delegation 层只有在审批存在且有效时才允许。
      if (layers.runtime_approval.status === "allowed") {
        layers.kiwi_delegation_policy = { status: "allowed", reason: `action=${action} ask，审批已批` };
      }
    }
    // AUTO：delegation 层默认 allowed。

    // 硬约束（limits）：只对已解析的约束做 deny。
    const denyReason = this.limitViolation(action, opts);
    if (denyReason !== undefined) {
      layers.merchant_hard_policy = { status: "denied", reason: denyReason };
    }

    const denied = Object.values(layers).some((l) => l.status === "denied");
    const authorization: AuthorizationRecord = {
      authorization_id: `authz-${uuidv7()}`,
      action,
      subject: {
        buyer_agent_id: this.buyerAgentId,
        session_id: this.sessionId,
        delegation_id: this.policy.policy_id,
        expires_at: this.policy.expires_at,
      },
      layers,
      effective_decision: denied ? "denied" : "granted",
      ...(opts.approvalId !== undefined ? { approval_id: opts.approvalId } : {}),
      expires_at: this.policy.expires_at,
      decided_at: this.now(),
    };
    // 冻结 schema 强制 deny-wins 不变量；非法即内部错误。
    const errors = validateEffectiveAuthorization(authorization);
    if (errors.length > 0) {
      throw new McpError(
        "internal_error",
        `EffectiveAuthorization 违反冻结契约：${errors.join("; ")}`,
        { authorization, errors },
      );
    }
    return authorization;
  }

  private limitViolation(action: BuyerAction, _opts: unknown): string | undefined {
    const limits = this.policy.limits;
    if (limits === undefined) return undefined;
    if (
      limits.deadline !== undefined &&
      Date.parse(limits.deadline) < Date.parse(this.now())
    ) {
      return `delegation deadline ${limits.deadline} 已过期`;
    }
    if (action === "payment") return "payment 恒为 never";
    return undefined;
  }

  private firstQuery(intent: Record<string, unknown>): string {    const items = Array.isArray(intent.items) ? (intent.items as Array<Record<string, unknown>>) : [];
    const first = items[0] ?? {};
    if (typeof first.query === "string" && first.query !== "") return first.query;
    if (typeof first.sku === "string" && first.sku !== "") return first.sku;
    return "";
  }

  private currentRounds(task: StoredTask): number {
    const decoded = this.decodeTask(task) as { steps?: NegotiationStep[] };
    return Array.isArray(decoded.steps) ? decoded.steps.length : 0;
  }

  private decodeTask(task: StoredTask): Record<string, unknown> {
    const parsed = this.parsePayload<Record<string, unknown>>(task.payload);
    return {
      ...parsed,
      task_id: task.task_id,
      task_kind: task.task_kind,
      status: task.status,
      idempotency_key: task.idempotency_key,
      created_at: task.created_at,
      updated_at: task.updated_at,
      expires_at: task.expires_at,
      resumable: task.resumable,
      candidates: this.store.listCandidates(task.task_id),
      approval: this.store.listApprovalsByTask(task.task_id)[0],
    };
  }

  /**
   * M0 RFQ 硬门：按 merchant_id 解析，确认目标不是"仅有 M0 公开资料"的商家。
   *
   * 判定依据 source_kind === "merchant_declared" 且无 agent_card_url——该组合只
   * 在商家从未命中 Agent/Listing 侧时由索引标出；v1 商家（含同时发布 M0 资料
   * 的）source_kind 为 undefined，不受此门影响，实时能力不被静态资料降级。
   * 目录暂不可达时不改变既有行为（跳过本门，走 fetcher 的部分失败语义）。
   */
  private async assertInquiryAvailable(merchantIds?: string[]): Promise<void> {
    if (merchantIds === undefined || merchantIds.length === 0) return;
    const index = this.merchantIndex;
    if (index === undefined) return;
    for (const merchantId of merchantIds) {
      let record: MerchantRecord | undefined;
      try {
        record = await index.resolveById(merchantId);
      } catch {
        continue;
      }
      if (
        record !== undefined &&
        record.source_kind === "merchant_declared" &&
        record.agent_card_url === undefined
      ) {
        throw new McpError(
          "merchant_inquiry_unavailable",
          `商家 ${merchantId}（${record.name}）目前仅公开资料，尚未开通 Kiwi 实时询价；` +
            "可查看其公开资料与店铺入口，不能对其发起 kiwi_request_quotes",
          { merchant_id: merchantId },
        );
      }
    }
  }

  private parsePayload<T>(json: string): T {
    try {
      return JSON.parse(json) as T;
    } catch {
      throw new McpError("store_corrupted", "stored payload is not parseable");
    }
  }
}
