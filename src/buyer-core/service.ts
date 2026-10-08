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
import {
  failedSearchDiagnostics,
  legacySearchDiagnostics,
  notSearchedDiagnostics,
  type NetworkSearchDiagnostics,
} from "./network-search.js";
import type { MerchantProductSummary } from "./product-summary.js";
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

/** 离线态（与 merchant-index 同口径）：未设置按 fresh 处理（向后兼容）。 */
function agentIsFresh(record: MerchantRecord): boolean {
  const state = record.freshness_state;
  return state === undefined || (state !== "stale" && state !== "unreachable");
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
   * 可实时询价（有可路由 Agent Card **且 agent 新鲜**，能力来自 Agent 侧）。
   * M0-only 商家恒 false；未设置时按既有链路处理（marketplace 等 legacy 索引
   * 不透出该字段）。
   */
  inquiry_available?: boolean;
  /**
   * Agent 新鲜度（catalog 读时按 last_seen_at + TTL 派生，见 WP6）：`stale`/
   * `unreachable` 表示商家服务可能已离线——不标"可实时询价"，但公开资料仍可查。
   * 未设置（旧 catalog / legacy 索引）按 fresh 处理，向后兼容。
   */
  freshness_state?: "fresh" | "stale" | "unreachable";
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
  /**
   * 命中商品摘要（catalog listing 的真实字段投影，每商家≤
   * MAX_PRODUCTS_PER_MERCHANT 条）；宿主据此展示商品名/规格/商家资料价/起订量/
   * 交期。只有 listing 命中才有——仅 Agent/M0 公开资料的商家不设置（不补造）。
   */
  products?: MerchantProductSummary[];
}

export interface MerchantIndex {
  search(query: string, opts?: { category?: string; region?: string }): Promise<MerchantRecord[]>;
  /**
   * 可选：与 `search` 同源，但把**本次**查询的组件状态随结果返回——诊断不依赖
   * 可被并发搜索覆盖的实例级 `lastSearchNotes`（设计 v1.1 §17）。实现了本方法的
   * 索引由 service 优先使用；未实现时 service 回退到 `search` + `lastSearchNotes`
   * 并按保守口径汇总。
   *
   * 约定：全侧失败**不抛错**——失败/超时是必须如实上报的状态，由返回的
   * `diagnostics.status`/`result_state` 表达（`search` 保留原 fail-closed 抛错）。
   */
  searchWithDiagnostics?(
    query: string,
    opts?: { category?: string; region?: string },
  ): Promise<{ merchants: MerchantRecord[]; diagnostics: NetworkSearchDiagnostics }>;
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

/**
 * review P1-2（返修）：结构化权威报价事实——委托约束核验的唯一来源。
 * reply_text 正则/parseFloat 不是权威报价（格式可变、无单位/币种约束）。
 * money 一律安全整数 minor；quantity_value 为 KNP number>0（允许小数数量）。
 */
export interface CandidateQuoteItem {
  sku: string;
  quantity_value: number;
  quantity_unit?: string;
  unit_price_minor: number;
}
export interface CandidateQuoteTerms {
  currency: string;
  items: CandidateQuoteItem[];
  total_price_minor: number;
}

export interface QuoteCandidateInput {
  merchant_id: string;
  status: "succeeded" | "failed";
  /** 结构化报价（KNP offer terms 投影）；缺失时带约束的 accept fail-closed。 */
  terms?: CandidateQuoteTerms;
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

import type { ProtocolTaskContext } from "./protocol-recovery.js";

export interface QuoteFetcher {
  requestQuotes(intent: Record<string, unknown>, merchants: MerchantRecord[], context?: ProtocolTaskContext): Promise<QuoteCandidateInput[]>;
  recoverQuotes?: (context: ProtocolTaskContext) => Promise<QuoteCandidateInput[]>;
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
    context?: ProtocolTaskContext,
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

/** review P1-2：宽容 JSON 解析（非 JSON 返回 undefined，不抛）。 */
function safeParseJson(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  }): Promise<{
    merchants: MerchantRecord[];
    note?: string;
    /** Network 一路的结构化查询状态（双来源搜索设计 v1.1 §17）；互联网一路由宿主自答。 */
    network_search: NetworkSearchDiagnostics;
  }> {
    const index = this.merchantIndex;
    if (index === undefined) {
      return {
        merchants: [],
        note: "merchant index not wired; discovery pending",
        network_search: notSearchedDiagnostics(),
      };
    }
    const searchedAt = this.now();
    try {
      if (index.searchWithDiagnostics !== undefined) {
        const { merchants, diagnostics } = await index.searchWithDiagnostics(input.query, {
          category: input.category,
          region: input.region,
        });
        // 单侧降级/离线说明如实标注；不静默、不补全。
        return {
          merchants,
          ...(diagnostics.notes.length > 0 ? { note: diagnostics.notes.join("；") } : {}),
          network_search: diagnostics,
        };
      }
      // 旧版/第三方索引：只有 merchants + 实例级 lastSearchNotes（可被并发覆盖）。
      const merchants = await index.search(input.query, {
        category: input.category,
        region: input.region,
      });
      const notes = index.lastSearchNotes?.() ?? [];
      const diagnostics = legacySearchDiagnostics({
        candidateCount: merchants.length,
        searchedAt,
        notes,
      });
      return {
        merchants,
        ...(notes.length > 0 ? { note: notes.join("；") } : {}),
        network_search: diagnostics,
      };
    } catch (error) {
      // 目录不可达/查询失败：如实报错，不编造商家、也不表述为无匹配。
      const note = `merchant index unreachable: ${error instanceof Error ? error.message : String(error)}`;
      return {
        merchants: [],
        note,
        network_search: failedSearchDiagnostics({ searchedAt, error, note }),
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
      if(this.quoteFetcher?.recoverQuotes!==undefined){
        const original=this.decodeTask(persisted).intent;
        if(original!==undefined && contentDigest(original)!==contentDigest(input.intent))throw new McpError("idempotency_conflict","same task key has different intent");
        if(persisted.status!=="in_progress"){
          const selected=[...new Set(this.store.listCandidates(persisted.task_id).map(c=>String(c.merchant_id)))].sort();
          const requested=[...new Set(input.merchant_ids??[])].sort();
          if(contentDigest(selected)!==contentDigest(requested))throw new McpError("idempotency_conflict","same task key has different selected merchants");
        }
      }
      // Recovery can only read previously persisted protocol receipts/results, never send.
      if(this.quoteFetcher?.recoverQuotes !== undefined && ["in_progress","partial_success"].includes(persisted.status) && !this.store.hasAgreementForTask(persisted.task_id)) {
        const originalCandidates=this.store.listCandidates(persisted.task_id);
        const results=await this.quoteFetcher.recoverQuotes(this.protocolContext(persisted,input.merchant_ids??[]));
        if(results.length>0)return this.store.transaction(()=>{
          if(this.store.hasAgreementForTask(persisted.task_id) || contentDigest(this.store.listCandidates(persisted.task_id))!==contentDigest(originalCandidates))throw new McpError("idempotency_conflict","task candidates or accepted agreement changed during recovery");
          for(const result of results)this.store.replaceRecoveredCandidate(persisted.task_id,result);
          const candidates=this.northboundCandidates(persisted.task_id);
          const status=candidates.length>0 && candidates.every(c=>c.status==="succeeded")?"succeeded":"partial_success";
          const updated=this.store.updateTask(persisted.task_id,{status,payload:JSON.stringify({...this.decodeTask(persisted),status,updated_at:this.now(),candidates})},persisted);
          const decoded=this.decodeTask(updated);assertNorthboundContractValid("persistent-task",decoded,"recovered quotes result");return {task:decoded,created:false};
        });
      }
      return { task: this.decodeTask(persisted), created: false };
    }
    for (const candidate of preCandidates) {
      this.store.addCandidate(taskId, candidate);
    }

    // 真实 fan-out 交给注入的 QuoteFetcher（Phase 2 接线 A2A/UCP）。v0.1 无 fetcher
    // 时任务保持 in_progress + resumable，可恢复；有 fetcher 时按部分失败语义回写。
    let status = "in_progress";
    let quotedResults:QuoteCandidateInput[]=[];
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
      const results = await this.quoteFetcher.requestQuotes(input.intent, merchantRecords, this.protocolContext(persisted,input.merchant_ids??[]));
      const successes = results.filter((r) => r.status === "succeeded").length;
      if (results.length > 0) {
        quotedResults=results;
        status = successes === results.length ? "succeeded" : "partial_success";
      }
    }

    return this.store.transaction(()=>{
    for(const r of quotedResults)this.store.addCandidate(taskId,{candidate_id:`cand-${uuidv7()}`,merchant_id:r.merchant_id,status:r.status,provenance:r.provenance,terms:r.terms,failure:r.failure,retryable:r.status==="failed"?(r.failure?.retryable??false):false});
    const updated = this.store.updateTask(taskId, {
      status,
      resumable: true,
      payload: JSON.stringify({
        ...this.decodeTask(task),
        status,
        updated_at: this.now(),
        candidates: this.northboundCandidates(taskId),
      }),
    }, persisted);
    const decoded = this.decodeTask(updated);
    // 冻结契约强制：持久任务记录必须满足 persistent-task/1.0 schema（§6.2）。
    assertNorthboundContractValid("persistent-task", decoded, "requestQuotes result");
    return { task: decoded, created: true };
    });
  }

  private protocolContext(task:StoredTask,requestedMerchants?:string[]):ProtocolTaskContext {
    const intent=this.decodeTask(task).intent;
    return {taskId:task.task_id,createdAt:task.created_at,intentBindingDigest:contentDigest({task_id:task.task_id,created_at:task.created_at,intent:intent??null,requested_merchants:requestedMerchants??null,policy:this.policy,principal:this.principal,buyer:this.buyerAgentId})};
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
      // review P1-2（A316 补充校准）：counter 外发前的限额闸口——succeeded
      // 候选逐一过 limitViolation（结构化事实），仅放行未被约束阻断的候选；
      // 全部被阻断时显式拒绝（不存在合法还价对象）。clarification 无商业
      // 承诺，不过商业闸。
      let gated = this.store.listCandidates(input.task_id);
      if (input.action === "counter_offer") {
        const succeeded = gated.filter((c) => c.status === "succeeded");
        const passable = succeeded.filter(
          (c) =>
            this.limitViolation("counter_offer", {
              taskId: input.task_id,
              candidateId: String(c.candidate_id),
            }) === undefined,
        );
        if (succeeded.length > 0 && passable.length === 0) {
          throw new McpError(
            "delegation_denied",
            "counter_offer 被委托约束阻断：全部报价候选超出 limits（fail-closed）",
          );
        }
        const passableIds = new Set(passable.map((c) => String(c.candidate_id)));
        gated = gated.filter((c) => c.status !== "succeeded" || passableIds.has(String(c.candidate_id)));
      }
      // review P1-2（A327 校准）：negotiator 需要任务**真实意图**（quantity
      // 与 unit 从 intent 透传到外发 wire）——此前传空 intent {}，gate 拿到
      // quantity=1/unit=undefined，max_quantity.unit 可能误拒或漏配。
      const decodedForIntent = this.decodeTask(task) as { intent?: Record<string, unknown> };
      step = await this.negotiator.negotiate(
        input.task_id,
        (decodedForIntent.intent ?? {}) as Record<string, unknown>,
        step,
        gated,
        this.protocolContext(task),
      );
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
    }, task);
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
    // review P1-2（A316 校准）：消费绑定 = 结构化 canonical digest（无分隔符
    // 歧义）；同逻辑重放的唯一判据，换候选/摘要/任务都是不同绑定。
    const consumedBinding = this.consumeBinding({
      task_id: input.task_id,
      candidate_id: input.candidate_id,
      terms_digest: termsDigest,
    });
    const authorization = await this.evaluateAuthorization("accept_nonbinding", {
      taskId: input.task_id,
      candidateId: input.candidate_id,
      candidateDigest: termsDigest,
      approvalId: input.approval_id,
      approvalConsumedBinding: consumedBinding,
    });
    if (authorization.effective_decision !== "granted") {
      throw new McpError("authorization_denied", "AcceptNonbinding 未获五层授权", {
        authorization,
      });
    }
    const now = this.now();
    // review P1-2（A316 校准）：短事务原子消费——事务内重读授权、写
    // agreement/task/used 及可重放结果；任何失败 ROLLBACK（无部分提交、
    // 无事后补偿、不烧毁有效批准——同绑定重试重新进入本事务）。node:sqlite
    // 同步执行 + BEGIN IMMEDIATE 写锁，进程内/跨连接均互斥。
    return this.store.transaction(() => {
      const freshTask = this.store.getTask(input.task_id);
      if (freshTask === undefined) {
        throw new McpError("task_not_found", `task ${input.task_id} not found`);
      }
      if (input.approval_id !== undefined) {
        const fresh = this.store.getApproval(input.approval_id);
        if (fresh === undefined) {
          throw new McpError("approval_required", `approval ${input.approval_id} 不存在`, {
            approval_id: input.approval_id,
          });
        }
        // review P1-2（A325 收口）：事务内 **fresh 授权强核**——同短事务
        // （无外部 await）重核 approved 状态/task/action/digest/有效期与
        // 候选最新状态；跨连接 await 窗口的撤销/改绑在此收口（源审纵深：
        // 不宣称 BEGIN 本身等于权限重核，这里是显式逐项复核）。
        if (fresh.task_id !== input.task_id) {
          throw new McpError(
            "approval_denied",
            `approval ${input.approval_id} 属于任务 ${fresh.task_id}，与请求任务 ${input.task_id} 不一致`,
          );
        }
        if (fresh.action !== "accept_nonbinding") {
          throw new McpError(
            "approval_denied",
            `approval ${input.approval_id} 动作=${fresh.action} 与 accept 不一致`,
          );
        }
        // review P1-2（A327 校准）：审批未绑定候选摘要（undefined）不得跳过
        // 校验放行——fail-closed。
        if (fresh.candidate_digest === undefined) {
          throw new McpError(
            "approval_denied",
            `approval ${input.approval_id} 未绑定候选摘要（digest 缺失，fail-closed）`,
          );
        }
        if (fresh.candidate_digest !== termsDigest) {
          throw new McpError(
            "approval_denied",
            `approval ${input.approval_id} 绑定候选摘要与当前候选不一致`,
          );
        }
        if (
          fresh.expires_at !== undefined &&
          Date.parse(fresh.expires_at) < Date.parse(this.now())
        ) {
          throw new McpError("approval_denied", `approval ${input.approval_id} 已过期`);
        }
        // review P1-2（A327 校准）：候选**内容与状态**重核——some(ID) 只证
        // 明 ID 存在，不证明内容/状态未变；事务内重取候选、重算摘要并核对
        // 仍为 succeeded（锁外 termsDigest 不能默认仍是最新）。
        const freshCandidates = this.store.listCandidates(input.task_id);
        const freshCandidate = freshCandidates.find(
          (c) => c.candidate_id === input.candidate_id,
        );
        if (freshCandidate === undefined) {
          throw new McpError(
            "invalid_params",
            `candidate ${input.candidate_id} 已不存在于任务（候选状态已推进）`,
          );
        }
        if (freshCandidate.status !== "succeeded") {
          throw new McpError(
            "authorization_denied",
            `候选状态已推进为 ${freshCandidate.status}，不再可接受`,
          );
        }
        if (contentDigest(freshCandidate) !== termsDigest) {
          throw new McpError(
            "approval_denied",
            "候选内容已变化（fresh 摘要与审批绑定不一致），需重新审批",
          );
        }
        if (fresh.status === "used") {
          const consumed = this.approvalConsumed(fresh);
          if (
            consumed !== undefined &&
            consumed.binding === consumedBinding
          ) {
            // 同逻辑重放：返回库里既有的同一 agreement（非虚构结果）。
            const existing =
              consumed.ref.startsWith("agreement-")
                ? this.store.getAgreement(consumed.ref)
                : undefined;
            if (existing === undefined) {
              throw new McpError(
                "approval_denied",
                `approval ${input.approval_id} 已消费但绑定效果不可读；需要人工对账`,
              );
            }
            return {
              task: this.decodeTask(this.store.getTask(input.task_id)!),
              agreement: JSON.parse(existing.payload) as Record<string, unknown>,
              authorization,
            };
          }
          throw new McpError(
            "approval_denied",
            `approval ${input.approval_id} 已被消费（一次性），且请求内容不同`,
          );
        }
        if (fresh.status !== "approved") {
          // review P1-2（A325 收口）：消费时点必须仍是 approved——跨连接
          // await 窗口内被 deny/回退到 pending 的审批不得消费。
          throw new McpError(
            "approval_denied",
            `approval ${input.approval_id} 状态=${fresh.status}，消费时点必须为 approved`,
          );
        }
      }
      // review P1-2（A331 校准）：候选 fresh 强核对**所有真实消费分支**生效
      //——此前仅 approval 分支覆盖，合法 auto（无审批）路径仍旧 snapshot。
      // 同短事务内重取候选：ID 仍在、状态仍 succeeded、**重算 contentDigest
      // 与本次绑定 termsDigest 一致**（锁外旧 snapshot 不能默认最新）。
      // 任务/候选 expiry 按既有合同（上方 task.expires_at 检查）核，不新加 TTL。
      const freshCandidate = this.store
        .listCandidates(input.task_id)
        .find((c) => c.candidate_id === input.candidate_id);
      if (freshCandidate === undefined) {
        throw new McpError(
          "invalid_params",
          `candidate ${input.candidate_id} 已不存在于任务（候选状态已推进）`,
        );
      }
      if (freshCandidate.status !== "succeeded") {
        throw new McpError(
          "authorization_denied",
          `候选状态已推进为 ${freshCandidate.status}，不再可接受`,
        );
      }
      if (contentDigest(freshCandidate) !== termsDigest) {
        throw new McpError(
          "approval_denied",
          "候选内容已变化（fresh 摘要与本次绑定不一致），需重新获取报价",
        );
      }
      // 崩溃孤儿复用：事务内查同 (task, terms_digest) 既有 agreement（此前
      // 崩溃留下的已提交行）——复用同一 ID，效果恰一次。
      const orphan = this.store.findAgreementByTerms(input.task_id, termsDigest);
      const agreementId = orphan !== undefined ? orphan.agreement_id : `agreement-${uuidv7()}`;
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
      if (orphan === undefined) {
        this.store.createAgreement({
          agreement_id: agreementId,
          task_id: input.task_id,
          negotiation_id: agreement.negotiation_id,
          terms_digest: termsDigest,
          created_at: now,
          expires_at: undefined,
          payload: JSON.stringify(agreement),
        });
      }
      const updated = this.store.updateTask(input.task_id, {
        status: "succeeded",
        payload: JSON.stringify({
          ...this.decodeTask(freshTask),
          agreement_id: agreementId,
          status: "succeeded",
          updated_at: now,
        }),
      }, freshTask);
      if (input.approval_id !== undefined) {
        const approval = this.store.getApproval(input.approval_id);
        if (approval !== undefined) {
          this.store.setApproval(approval.task_id, {
            ...approval,
            status: "used",
            authorization_json: JSON.stringify({
              ...safeParseJson(approval.authorization_json),
              consumed: { ref: agreementId, binding: consumedBinding, kind: "agreement" },
            }),
          });
        }
      }
      return { task: this.decodeTask(updated), agreement, authorization };
    });  }

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
    // review P1-2（A316 校准）：handoff 消费绑定 = 结构化 canonical digest
    //（agreement/destination/url），无分隔符歧义。
    const consumedBinding = this.consumeBinding({
      agreement_id: input.agreement_id,
      destination_type: input.destination_type,
      url: input.url ?? null,
    });
    const authorization = await this.evaluateAuthorization("handoff", {
      taskId: stored.task_id,
      approvalId: input.approval_id,
      approvalConsumedBinding: consumedBinding,
    });
    if (authorization.effective_decision !== "granted") {
      throw new McpError("authorization_denied", "Handoff 未获五层授权", { authorization });
    }
    if (input.approval_id === undefined) {
      const handoffRef = {
        handoff_id: `handoff-${uuidv7()}`,
        destination_type: input.destination_type,
        ...(input.url !== undefined ? { url: input.url } : {}),
      };
      return { handoff_ref: handoffRef, authorization };
    }
    // review P1-2（A316 校准）：短事务原子消费——事务内重读审批、生成 ref、
    // 消费；同绑定重放返回**库里记录的同一 ref**（非虚构）；失败 ROLLBACK
    // 不烧毁审批。
    return this.store.transaction(() => {
      const approval = this.store.getApproval(input.approval_id as string);
      if (approval === undefined) {
        throw new McpError("invalid_params", `approval ${input.approval_id} 不存在`);
      }
      if (approval.status === "used") {
        const consumed = this.approvalConsumed(approval);
        if (consumed !== undefined && consumed.binding === consumedBinding) {
          return {
            handoff_ref: {
              handoff_id: consumed.ref,
              destination_type: input.destination_type,
              ...(input.url !== undefined ? { url: input.url } : {}),
            },
            authorization,
          };
        }
        throw new McpError(
          "approval_denied",
          `approval ${input.approval_id} 已被消费（一次性），且请求内容不同`,
        );
      }
      const handoffRef = {
        handoff_id: `handoff-${uuidv7()}`,
        destination_type: input.destination_type,
        ...(input.url !== undefined ? { url: input.url } : {}),
      };
      this.store.setApproval(approval.task_id, {
        ...approval,
        status: "used",
        authorization_json: JSON.stringify({
          ...safeParseJson(approval.authorization_json),
          consumed: { ref: handoffRef.handoff_id, binding: consumedBinding, kind: "handoff" },
        }),
      });
      return { handoff_ref: handoffRef, authorization };
    });
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
    opts: {
      taskId: string;
      candidateId?: string;
      candidateDigest?: string;
      approvalId?: string;
      /** review P1-2（返修）：已消费审批的安全重放绑定——匹配时放行（返回
       *  同一效果），不匹配照旧拒绝。 */
      approvalConsumedBinding?: string;
    },
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
      } else if (approval.task_id !== opts.taskId) {
        // review P1-2：审批必须属于当前任务——跨任务重放他任务的批准即拒。
        layers.runtime_approval = {
          status: "denied",
          reason: `approval ${approval.approval_id} 属于任务 ${approval.task_id}，与请求任务 ${opts.taskId} 不一致`,
        };
      } else if (
        // review P1-2：候选绑定——批准时的 digest 与当前候选不一致（含批准时
        // 未绑定候选）即拒；对照 auth/merchant-oauth.ts 的既有比对纪律。
        (opts.candidateDigest !== undefined &&
          (approval.candidate_digest === undefined ||
            approval.candidate_digest !== opts.candidateDigest))
      ) {
        layers.runtime_approval = {
          status: "denied",
          reason: `approval ${approval.approval_id} 未绑定当前候选（digest 不一致）`,
        };
      } else if (approval.status === "used") {
        // review P1-2（A316 校准）：一次性消费——已消费审批只在「同逻辑重放」
        //（canonical digest 绑定完全一致）时放行，调用方返回**库里既有**的
        // 同一效果；换 candidate/digest/action/target 一律拒绝。
        const consumed = this.approvalConsumed(approval);
        if (
          opts.approvalConsumedBinding !== undefined &&
          consumed !== undefined &&
          consumed.binding === opts.approvalConsumedBinding
        ) {
          layers.runtime_approval = {
            status: "allowed",
            reason: `idempotent replay of consumed approval ${approval.approval_id} (same binding)`,
          };
        } else {
          layers.runtime_approval = {
            status: "denied",
            reason: `approval ${approval.approval_id} 已被消费（一次性），且请求内容不同`,
          };
        }
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

    // 硬约束（limits）：review P1-2 起对 accept 类动作核验候选价格/商家/币种/数量。
    const denyReason = this.limitViolation(action, {
      taskId: opts.taskId,
      candidateId: opts.candidateId,
    });
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

  /**
   * review P1-2（A319 校准）：**实际外发 counter 提案**的限额门——对最终
   * 结构化提案（而非旧候选）核验币种/单位/数量总量/单价/合计/安全 minor/
   * 商家白名单/deadline。由 negotiator 在 sendMessage 前调用；返回 undefined
   * = 放行。
   */
  checkCounterProposalLimits(proposal: {
    merchant_id: string;
    sku: string;
    currency: string;
    quantity_value: number;
    quantity_unit?: string;
    unit_price_minor: number;
    total_price_minor: number;
  }): string | undefined {
    const limits = this.policy.limits;
    if (limits === undefined) return undefined;
    if (
      limits.deadline !== undefined &&
      Date.parse(limits.deadline) < Date.parse(this.now())
    ) {
      return `delegation deadline ${limits.deadline} 已过期`;
    }
    if (
      limits.allowed_merchants !== undefined &&
      !limits.allowed_merchants.includes(proposal.merchant_id)
    ) {
      return `merchant ${proposal.merchant_id} 不在 allowed_merchants`;
    }
    const terms: CandidateQuoteTerms = {
      currency: proposal.currency,
      items: [
        {
          sku: proposal.sku,
          quantity_value: proposal.quantity_value,
          ...(proposal.quantity_unit !== undefined ? { quantity_unit: proposal.quantity_unit } : {}),
          unit_price_minor: proposal.unit_price_minor,
        },
      ],
      total_price_minor: proposal.total_price_minor,
    };
    return this.termsFactsViolation(terms);
  }

  /** 结构化报价事实的约束核验（accept/counter 共用；缺事实 fail-closed）。 */
  private termsFactsViolation(terms: CandidateQuoteTerms): string | undefined {
    const limits = this.policy.limits;
    if (limits === undefined) return undefined;
    if (typeof terms.currency !== "string" || terms.currency === "") {
      return "结构化报价缺币种，无法核验委托约束（fail-closed）";
    }
    if (
      limits.allowed_currencies !== undefined &&
      !limits.allowed_currencies.includes(terms.currency)
    ) {
      return `币种 ${terms.currency} 不在 allowed_currencies`;
    }
    if (!Array.isArray(terms.items) || terms.items.length === 0) {
      return "结构化报价无明细行，无法核验委托约束（fail-closed）";
    }
    for (const item of terms.items) {
      if (!Number.isSafeInteger(item.unit_price_minor) || item.unit_price_minor < 0) {
        return "明细单价不是安全整数 minor（拒绝非整数货币）";
      }
      if (
        typeof item.quantity_value !== "number" ||
        !Number.isFinite(item.quantity_value) ||
        item.quantity_value <= 0
      ) {
        return "明细数量必须为正数（KNP number>0）";
      }
    }
    if (!Number.isSafeInteger(terms.total_price_minor) || terms.total_price_minor < 0) {
      return "总价不是安全整数 minor（拒绝非整数货币）";
    }
    if (
      limits.max_quantity !== undefined &&
      typeof limits.max_quantity.unit === "string" &&
      limits.max_quantity.unit !== ""
    ) {
      const bad = terms.items.find(
        (it) =>
          typeof it.quantity_unit !== "string" ||
          it.quantity_unit === "" ||
          it.quantity_unit !== limits.max_quantity!.unit,
      );
      if (bad !== undefined) {
        return `明细数量单位缺失或与 max_quantity.unit(${limits.max_quantity.unit}) 不一致`;
      }
    }
    if (limits.max_unit_price !== undefined) {
      if (limits.max_unit_price.currency !== terms.currency) {
        return `max_unit_price 币种(${limits.max_unit_price.currency})与报价币种(${terms.currency})不绑定`;
      }
      const over = terms.items.find(
        (it) => it.unit_price_minor > limits.max_unit_price!.amount_minor,
      );
      if (over !== undefined) {
        return `单价 ${over.unit_price_minor} minor 超过 max_unit_price ${limits.max_unit_price.amount_minor}`;
      }
    }
    if (limits.max_total_price !== undefined) {
      if (limits.max_total_price.currency !== terms.currency) {
        return `max_total_price 币种(${limits.max_total_price.currency})与报价币种(${terms.currency})不绑定`;
      }
      const computed = terms.items.reduce(
        (sum, it) => sum + it.unit_price_minor * it.quantity_value,
        0,
      );
      if (!Number.isSafeInteger(computed)) {
        return "总价明细合计不是安全整数 minor（拒绝非整数货币）";
      }
      if (computed !== terms.total_price_minor) {
        return "结构化报价总价与明细合计不一致（不可信报价）";
      }
      if (terms.total_price_minor > limits.max_total_price.amount_minor) {
        return `总价 ${terms.total_price_minor} minor 超过 max_total_price ${limits.max_total_price.amount_minor}`;
      }
    }
    if (limits.max_quantity !== undefined) {
      const totalQty = terms.items.reduce((sum, it) => sum + it.quantity_value, 0);
      if (!Number.isFinite(totalQty) || totalQty > limits.max_quantity.value) {
        return `数量总量 ${totalQty} 超过 max_quantity ${limits.max_quantity.value}`;
      }
    }
    return undefined;
  }

  private limitViolation(
    action: BuyerAction,
    opts: { taskId?: string; candidateId?: string } = {},
  ): string | undefined {
    const limits = this.policy.limits;
    if (limits === undefined) return undefined;
    if (
      limits.deadline !== undefined &&
      Date.parse(limits.deadline) < Date.parse(this.now())
    ) {
      return `delegation deadline ${limits.deadline} 已过期`;
    }
    if (action === "payment") return "payment 恒为 never";

    // review P1-2（返修）：accept 类动作的约束核验**只信结构化报价事实**
    // （候选.terms，KNP offer 投影）。reply_text 正则/parseFloat 不是权威
    // 报价——格式可变、无币种/单位约束；缺事实即 fail-closed 拒绝。
    if (action === "accept_nonbinding" || action === "counter_offer") {
      // review P1-2（A316 补充校准）：counter_offer 外发与 accept 同一限额
      // 闸口——还价同样不得越委托约束。
      const { taskId, candidateId } = opts;
      if (taskId === undefined || candidateId === undefined) {
        return "accept 缺少任务/候选上下文，无法核验 limits";
      }
      const candidate = this.store
        .listCandidates(taskId)
        .find((c) => c.candidate_id === candidateId);
      if (candidate === undefined) return `候选 ${candidateId} 不存在于任务 ${taskId}`;
      const merchantId =
        typeof candidate.merchant_id === "string" ? candidate.merchant_id : undefined;
      if (
        limits.allowed_merchants !== undefined &&
        !limits.allowed_merchants.includes(merchantId ?? "")
      ) {
        return `merchant ${merchantId ?? "unknown"} 不在 allowed_merchants`;
      }

      const needsFacts =
        limits.max_unit_price !== undefined ||
        limits.max_total_price !== undefined ||
        limits.allowed_currencies !== undefined ||
        limits.max_quantity !== undefined;
      if (!needsFacts) return undefined;

      const terms = candidate.terms as CandidateQuoteTerms | undefined;
      if (terms === undefined) {
        return "候选无结构化报价事实（terms 缺失），无法核验委托约束（fail-closed）";
      }
      if (typeof terms.currency !== "string" || terms.currency === "") {
        return "结构化报价缺币种，无法核验委托约束（fail-closed）";
      }
      if (
        limits.allowed_currencies !== undefined &&
        !limits.allowed_currencies.includes(terms.currency)
      ) {
        return `币种 ${terms.currency} 不在 allowed_currencies`;
      }
      if (!Array.isArray(terms.items) || terms.items.length === 0) {
        return "结构化报价无明细行，无法核验委托约束（fail-closed）";
      }
      // money 必须安全整数 minor；quantity 为 KNP number>0（允许小数数量）
      for (const item of terms.items) {
        if (
          !Number.isSafeInteger(item.unit_price_minor) ||
          item.unit_price_minor < 0
        ) {
          return "明细单价不是安全整数 minor（拒绝非整数货币）";
        }
        if (typeof item.quantity_value !== "number" || !Number.isFinite(item.quantity_value) || item.quantity_value <= 0) {
          return "明细数量必须为正数（KNP number>0）";
        }
      }
      if (
        !Number.isSafeInteger(terms.total_price_minor) ||
        terms.total_price_minor < 0
      ) {
        return "总价不是安全整数 minor（拒绝非整数货币）";
      }
      // 单位绑定：声明了 limit 单位时，明细**缺失 unit 也拒**（缺失不能视
      // 为匹配——否则无单位行绕过声明单位约束）；不一致同样拒。
      if (
        limits.max_quantity !== undefined &&
        typeof limits.max_quantity.unit === "string" &&
        limits.max_quantity.unit !== ""
      ) {
        const bad = terms.items.find(
          (it) =>
            typeof it.quantity_unit !== "string" ||
            it.quantity_unit === "" ||
            it.quantity_unit !== limits.max_quantity!.unit,
        );
        if (bad !== undefined) {
          return `明细数量单位缺失或与 max_quantity.unit(${limits.max_quantity.unit}) 不一致`;
        }
      }
      if (limits.max_unit_price !== undefined) {
        if (limits.max_unit_price.currency !== terms.currency) {
          return `max_unit_price 币种(${limits.max_unit_price.currency})与报价币种(${terms.currency})不绑定`;
        }
        const over = terms.items.find(
          (it) => it.unit_price_minor > limits.max_unit_price!.amount_minor,
        );
        if (over !== undefined) {
          return `单价 ${over.unit_price_minor} minor 超过 max_unit_price ${limits.max_unit_price.amount_minor}`;
        }
      }
      if (limits.max_total_price !== undefined) {
        if (limits.max_total_price.currency !== terms.currency) {
          return `max_total_price 币种(${limits.max_total_price.currency})与报价币种(${terms.currency})不绑定`;
        }
        const computed = terms.items.reduce(
          (sum, it) => sum + it.unit_price_minor * it.quantity_value,
          0,
        );
        if (!Number.isSafeInteger(computed)) {
          return "总价明细合计不是安全整数 minor（拒绝非整数货币）";
        }
        if (computed !== terms.total_price_minor) {
          return "结构化报价总价与明细合计不一致（不可信报价）";
        }
        if (terms.total_price_minor > limits.max_total_price.amount_minor) {
          return `总价 ${terms.total_price_minor} minor 超过 max_total_price ${limits.max_total_price.amount_minor}`;
        }
      }
      if (limits.max_quantity !== undefined) {
        // review P1-2（A316 补充校准）：max_quantity 按**总量**聚合（多明细
        // 行合计），不是逐行放行。
        const totalQty = terms.items.reduce((sum, it) => sum + it.quantity_value, 0);
        if (!Number.isFinite(totalQty) || totalQty > limits.max_quantity.value) {
          return `数量总量 ${totalQty} 超过 max_quantity ${limits.max_quantity.value}`;
        }
      }
    }
    return undefined;
  }

  /**
   * review P1-2（A316 校准）：消费记录复用既有 authorization_json 私有字段
   *（不新增列/不迁移）。binding 是结构化 canonical digest（无分隔符歧义）。
   */
  private approvalConsumed(stored: { authorization_json?: string } | undefined):
    | { ref: string; binding: string }
    | undefined {
    if (stored?.authorization_json === undefined) return undefined;
    try {
      const parsed = JSON.parse(stored.authorization_json) as {
        consumed?: { ref?: unknown; binding?: unknown };
      };
      const consumed = parsed.consumed;
      if (
        consumed !== undefined &&
        typeof consumed === "object" &&
        consumed !== null &&
        typeof consumed.ref === "string" &&
        consumed.ref !== "" &&
        typeof consumed.binding === "string" &&
        consumed.binding !== ""
      ) {
        return { ref: consumed.ref, binding: consumed.binding };
      }
    } catch {
      // authorization_json 非 JSON（如宿主写入的其他形状）→ 视为无消费记录
    }
    return undefined;
  }

  /** 消费绑定：结构化 canonical digest（contentDigest，无分隔符歧义）。 */
  private consumeBinding(parts: Record<string, unknown>): string {
    return contentDigest(parts);
  }

  /** 北向候选投影：剥离内部结构化报价事实（persistent-task 冻结契约
   *  additionalProperties:false；terms 只在授权层内部使用，不出 wire）。 */
  private northboundCandidates(taskId: string): Array<Record<string, unknown>> {
    return this.store.listCandidates(taskId).map(({ terms: _terms, ...rest }) => rest);
  }

  private firstQuery(intent: Record<string, unknown>): string {
    const items = Array.isArray(intent.items) ? (intent.items as Array<Record<string, unknown>>) : [];
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
      candidates: this.northboundCandidates(task.task_id),
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
      // WP6 离线门：agent 存在但服务已离线（catalog 按 TTL 派生 freshness_state）。
      // 与上一门区分：这里商家**开通过**实时询价，只是当前不在线——错误码不同，
      // 处置也不同（稍后重试/联系商家，而不是"从未开通"）。
      if (record !== undefined && !agentIsFresh(record)) {
        throw new McpError(
          "merchant_offline",
          `商家 ${merchantId}（${record.name}）的服务当前不在线（未在有效期内上报心跳），` +
            "暂不可实时询价；其公开资料仍可查看，可稍后重试",
          { merchant_id: merchantId, freshness_state: record.freshness_state ?? "stale" },
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
