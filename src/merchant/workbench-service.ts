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
 * Merchant Workbench Facade（WorkBuddy Buddy 应用开发计划 阶段一）。
 *
 * 从 src/agent/merchant/merchant-tools.ts 抽取的**不依赖 Pi Agent Core** 的
 * 业务服务层，供现有 Pi 工具与后续 MCP Server（阶段二）共同复用。分层对齐
 * buyer 侧先例（src/buyer-core/service.ts 承载业务、src/mcp 只放协议层）：
 * 本服务放 src/merchant/，src/mcp 不被 src/agent 反向依赖。
 *
 * 横切约定：
 *   - 租户校验：服务持有 expectedMerchantId（= profile.owner_id），入参带
 *     merchant_id 必须匹配，否则 validation 错误；
 *   - 白名单/脱敏：所有对外返回显式 pick 公开字段；私有值（底价/成本/利润/
 *     凭据）只留在 profile.merchant_policy 与 Vault，绝不进入返回值；
 *   - 统一错误映射：MerchantClientError / CommerceError / 底层异常统一映射为
 *     MerchantWorkbenchError（auth / not_found / validation / unavailable）；
 *   - fail-closed：商品源故障、未配置 ledger / intelligence 一律抛错，绝不
 *     回退演示数据；
 *   - 模型面关注点（fenceModelPayload、中文文案）留在工具层，不进本服务。
 */

import type { AgentProfile } from "../config/profile.js";
import type { CommerceDataSource } from "../commerce/data-source.js";
import { CommerceError } from "../commerce/data-source.js";
import { LedgerStore } from "../negotiation/ledger/index.js";
import { TERMINAL_PHASES } from "../negotiation/state/phase.js";
import type { AgentMode } from "../agent/mode.js";
import type {
  ApprovalExecutionResult,
  WriteApprovalCandidateStore,
} from "../agent/merchant/action-candidate.js";
import {
  executeApprovedCandidate,
  WriteApprovalCandidateError,
} from "../agent/merchant/action-candidate.js";
import type {
  InventorySnapshot,
  MerchantCatalogProduct,
  MerchantClient,
  MerchantProductPatch,
} from "../agent/merchant/types.js";
import { MerchantClientError } from "../agent/merchant/types.js";
import type { MerchantIntelligenceBackend } from "../agent/merchant/intelligence/backend.js";
import type { MerchantBusinessSnapshot } from "../agent/merchant/intelligence/types.js";
import type { WriteGateDeps, WriteGateResult } from "../agent/write-gate.js";
import { routeWriteCandidate } from "../agent/write-gate.js";

/** Facade 统一错误（kind 为跨调用方语义不变量）。 */
export class MerchantWorkbenchError extends Error {
  readonly kind: "auth" | "not_found" | "validation" | "unavailable";
  constructor(kind: MerchantWorkbenchError["kind"], message: string) {
    super(message);
    this.name = "MerchantWorkbenchError";
    this.kind = kind;
  }
}

/** MerchantClientError / CommerceError / WriteApprovalCandidateError / 底层异常 → MerchantWorkbenchError。 */
function toWorkbenchError(err: unknown): MerchantWorkbenchError {
  if (err instanceof MerchantWorkbenchError) return err;
  if (err instanceof MerchantClientError) {
    const kind = err.kind === "transient" ? "unavailable" : err.kind;
    return new MerchantWorkbenchError(kind, err.message);
  }
  if (err instanceof CommerceError) {
    return new MerchantWorkbenchError("unavailable", err.message);
  }
  if (err instanceof WriteApprovalCandidateError) {
    return new MerchantWorkbenchError(
      err.code === "not_found" ? "not_found" : "validation",
      err.message,
    );
  }
  return new MerchantWorkbenchError(
    "unavailable",
    err instanceof Error ? err.message : String(err),
  );
}

/** 商品公开字段白名单（无私有值；显式 pick，不透传整个对象）。
 *  用 type alias 而非 interface：保留隐式索引签名，可直接作为写门 preconditions
 *  （Record<string, unknown>）参与 content hash。 */
export type PublicProductView = {
  sku: string;
  merchant_id: string;
  title: string;
  price: number;
  /** 精确库存仅在持有商户凭据时存在；匿名读为 undefined，数据源路径为 null。 */
  stock?: number | null;
  paused: boolean;
};

/** Public precondition snapshot of a product (no private values). */
export function publicProductView(product: MerchantCatalogProduct): PublicProductView {
  return {
    sku: product.sku,
    merchant_id: product.merchant_id,
    title: product.title,
    price: product.price,
    stock: product.stock,
    paused: product.paused,
  };
}

/** 解析商品变更 patch（等价于原 merchant-tools.parseChanges；静默忽略未知字段）。 */
export function parseProductPatch(value: unknown): MerchantProductPatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MerchantWorkbenchError("validation", "changes 必须是对象");
  }
  const v = value as Record<string, unknown>;
  const patch: MerchantProductPatch = {};
  if (typeof v.title === "string") patch.title = v.title;
  if (typeof v.price === "number" && Number.isFinite(v.price)) patch.price = v.price;
  if (typeof v.stock === "number" && Number.isInteger(v.stock)) patch.stock = v.stock;
  if (typeof v.currency === "string") patch.currency = v.currency;
  if (typeof v.category === "string") patch.category = v.category;
  if (Array.isArray(v.tags)) patch.tags = v.tags.map(String);
  if (typeof v.description === "string") patch.description = v.description;
  if (Array.isArray(v.delivery_attributes))
    patch.delivery_attributes = v.delivery_attributes.map(String);
  if (typeof v.paused === "boolean") patch.paused = v.paused;
  return patch;
}

/** A2A 磋商结构化行（格式化留给调用方）。 */
export interface A2aNegotiationRow {
  negotiation_id: string;
  /** 当前相位（无 state_transition 事件时为 "OPEN"）。 */
  phase: string;
  /** 最后一条 message_sent 的 action（无则为 ""）。 */
  last_action: string;
  sku: string;
  quantity?: number;
  price_minor?: number;
  agreement: boolean;
  /** 最近一条事件的落账时间（排序键）。 */
  recorded_at: string;
}

/** 人工审核队列白名单行。 */
export interface HumanReviewRow {
  review_id: string | number;
  conversation_id: string;
  sku: string;
  severity: string;
  reason: string;
}

export interface DraftProductChangeInput {
  sku: string;
  changes: unknown;
  reason?: string;
  /** 可选租户标识；提供时必须等于本商家 owner_id。 */
  merchant_id?: string;
}

export interface DraftProductChangeResult {
  /** 写门结果；force_pending 下绝不自动执行（manual→advice_only，其余→pending_approval）。 */
  outcome: WriteGateResult;
  /** 生成候选时读取的当前商品公开快照。 */
  product: PublicProductView;
}

/** draft 候选的进程内执行钩子（与 WriteGateDeps.registerPending 的 hooks 同形）。 */
type PendingDraftHooks = {
  readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export interface MerchantWorkbenchServiceDeps {
  profile: AgentProfile;
  merchantClient: MerchantClient;
  /** 经营事实数据源；提供时目录列表优先走数据源（本地商品库 / ERP 适配器）。 */
  dataSource?: CommerceDataSource;
  approvals: WriteApprovalCandidateStore;
  mode: () => AgentMode;
  now: () => string;
  /** Register /approve execution hooks for pending candidates. */
  registerPending?: WriteGateDeps["registerPending"];
  /** 商家 A2A 节点 ledger 目录；缺失时磋商记录方法 fail-closed 抛 unavailable。 */
  a2aLedgerDir?: string;
  /** 经营指标后端；缺失时 getAnalytics fail-closed 抛 unavailable（不返回演示数据）。 */
  intelligence?: MerchantIntelligenceBackend;
}

export class MerchantWorkbenchService {
  private readonly profile: AgentProfile;
  private readonly merchantClient: MerchantClient;
  private readonly dataSource?: CommerceDataSource;
  private readonly approvals: WriteApprovalCandidateStore;
  private readonly mode: () => AgentMode;
  private readonly now: () => string;
  private readonly registerPending?: WriteGateDeps["registerPending"];
  private readonly a2aLedgerDir?: string;
  private readonly intelligence?: MerchantIntelligenceBackend;
  private readonly ownerId: string;
  /**
   * 本进程内的候选执行钩子（draft_product_change）。钩子是进程级的，但
   * draft 候选的参数在 store 里、钩子可从参数确定性重建——因此本服务
   * （MCP 进程）内也能批准并执行自己的候选（阶段四最小闭环）。
   * 外部 registerPending（如 chat kernel）照常透传。
   */
  private readonly pendingHooks = new Map<string, PendingDraftHooks>();

  constructor(deps: MerchantWorkbenchServiceDeps) {
    this.profile = deps.profile;
    this.merchantClient = deps.merchantClient;
    this.approvals = deps.approvals;
    this.mode = deps.mode;
    this.now = deps.now;
    this.ownerId = deps.profile.owner_id;
    if (deps.dataSource !== undefined) this.dataSource = deps.dataSource;
    if (deps.registerPending !== undefined) this.registerPending = deps.registerPending;
    if (deps.a2aLedgerDir !== undefined) this.a2aLedgerDir = deps.a2aLedgerDir;
    if (deps.intelligence !== undefined) this.intelligence = deps.intelligence;
  }

  /** 列出本商家目录商品（白名单）；dataSource 优先，否则公开搜索端点按 owner 过滤。 */
  async listPublicProducts(): Promise<{
    items: PublicProductView[];
    source: "data_source" | "merchant_client";
  }> {
    try {
      if (this.dataSource !== undefined) {
        const facts = await this.dataSource.getProducts({ limit: 100 });
        return {
          items: facts.map((p) => ({
            sku: p.sku,
            merchant_id: this.ownerId,
            title: p.title ?? "",
            price: p.price_minor ?? 0,
            stock: p.stock ?? null,
            paused: false,
          })),
          source: "data_source",
        };
      }
      const products = await this.merchantClient.listProducts(this.ownerId);
      return { items: products.map(publicProductView), source: "merchant_client" };
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /** 按 SKU 读取一个商品（白名单）。 */
  async getPublicProduct(sku: string, merchantId?: string): Promise<PublicProductView> {
    try {
      this.assertMerchantId(merchantId);
      const product = await this.merchantClient.getProduct(sku);
      return publicProductView(product);
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /** 读取一个商品的当前库存快照（含观察时间，不是永恒事实）。 */
  async getInventorySnapshot(sku: string): Promise<InventorySnapshot> {
    try {
      const snapshot = await this.merchantClient.getInventorySnapshot(sku);
      return { sku: snapshot.sku, stock: snapshot.stock, observed_at: snapshot.observed_at };
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /**
   * 列出商家节点的 A2A 磋商记录（结构化行，按最近落账时间倒序）。
   * limit 缺省 20，clamp 1..100。未配置 ledger 目录时 fail-closed 抛 unavailable。
   */
  async listA2aNegotiations(limit?: unknown): Promise<{
    total: number;
    items: A2aNegotiationRow[];
  }> {
    const clamped = Math.min(Math.max(Number(limit ?? 20) || 20, 1), 100);
    const rows = this.scanLedger(false);
    return { total: rows.length, items: rows.slice(0, clamped) };
  }

  /** 只留**进行中**（非终态）的磋商。未配置 ledger 目录时 fail-closed 抛 unavailable。 */
  async listActiveConsultations(): Promise<A2aNegotiationRow[]> {
    return this.scanLedger(true);
  }

  /** 商家人工处理队列（白名单：review_id / conversation_id / sku / severity / reason）。 */
  async listHumanReviews(): Promise<HumanReviewRow[]> {
    try {
      const reviews = await this.merchantClient.getHumanReviewQueue(this.ownerId);
      return reviews.map((r) => ({
        review_id: r.review_id,
        conversation_id: r.conversation_id,
        sku: r.sku,
        severity: r.severity,
        reason: r.reason,
      }));
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /** 经营摘要（intelligence）；未配置时 fail-closed 抛 unavailable，不返回演示数据。 */
  async getAnalytics(period?: string): Promise<MerchantBusinessSnapshot> {
    try {
      if (this.intelligence === undefined) {
        throw new MerchantWorkbenchError("unavailable", "未配置经营指标后端，无法读取经营摘要。");
      }
      if (period !== undefined && !/^(?:[1-9]|[1-8][0-9]|90)d$/.test(period)) {
        throw new MerchantWorkbenchError(
          "validation",
          "period 必须是 1d 到 90d，例如 7d、14d、30d",
        );
      }
      return await this.intelligence.getBusinessSnapshot({
        merchant_id: this.ownerId,
        ...(period === undefined ? {} : { period }),
      });
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /**
   * 商品变更草稿：校验 changes、确认商品存在，经 approvals + routeWriteCandidate
   * 以 force_pending 生成审批候选（任何模式都不自动执行）。只返回候选元数据
   * 与当前商品公开快照。
   */
  async draftProductChange(input: DraftProductChangeInput): Promise<DraftProductChangeResult> {
    try {
      this.assertMerchantId(input.merchant_id);
      if (typeof input.sku !== "string" || input.sku === "") {
        throw new MerchantWorkbenchError("validation", "sku 必须是非空字符串");
      }
      const patch = parseProductPatch(input.changes);
      if (Object.keys(patch).length === 0) {
        throw new MerchantWorkbenchError("validation", "changes 没有任何可修改字段。");
      }
      const current = await this.merchantClient.getProduct(input.sku);
      const args = { sku: input.sku, changes: { ...patch }, reason: input.reason ?? "" };
      const hooks = this.buildDraftHooks(input.sku);
      const outcome = await routeWriteCandidate(
        {
          mode: this.mode,
          approvals: this.approvals,
          profile: this.profile,
          now: this.now,
          registerPending: (candidateId, pendingHooks) => {
            this.pendingHooks.set(candidateId, pendingHooks);
            this.registerPending?.(candidateId, pendingHooks);
          },
        },
        {
          tool: "draft_product_change",
          arguments: args,
          preconditions: publicProductView(current),
          risk: "write_catalog",
          // Drafts are ALWAYS pending (never auto-execute), even in autopilot.
          force_pending: true,
          execute: hooks.execute,
          readPreconditions: hooks.readPreconditions,
        },
      );
      return { outcome, product: publicProductView(current) };
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /** draft 候选的执行钩子（execute 只执行库内已批准参数；preconditions 重读重哈希）。 */
  private buildDraftHooks(sku: string): PendingDraftHooks {
    return {
      readPreconditions: async () => {
        const fresh = await this.merchantClient.getProduct(sku);
        return publicProductView(fresh);
      },
      execute: (approvedArgs) => {
        const a = approvedArgs as { sku: string; changes: MerchantProductPatch };
        return this.merchantClient.updateProduct(a.sku, a.changes);
      },
    };
  }

  /**
   * 启动恢复（MCP 进程重启后）：为 store 里本服务可执行工具
   * （draft_product_change）的 pending 候选从库存参数重建执行钩子，返回恢复
   * 条数。其他工具的候选不处理（由调用方按 expireForRecovery 语义失效）。
   */
  recoverPendingDrafts(): number {
    let recovered = 0;
    for (const candidate of this.approvals.listPending()) {
      if (candidate.tool !== "draft_product_change") continue;
      const sku = typeof candidate.arguments.sku === "string" ? candidate.arguments.sku : undefined;
      if (sku === undefined || sku === "") {
        // 参数缺 sku 的候选无法重建钩子——fail-closed 失效，不留死候选。
        this.approvals.expireCandidate(candidate.candidate_id);
        continue;
      }
      this.pendingHooks.set(candidate.candidate_id, this.buildDraftHooks(sku));
      recovered += 1;
    }
    return recovered;
  }

  /**
   * 批准并执行一个 pending 候选（语义对齐 chat kernel 的 /approve：重读前置
   * 状态并重哈希，stale/expired 的候选 supersede、绝不执行；只执行库内已
   * 批准参数）。候选没有本进程执行钩子时按恢复语义失效（fail-closed）。
   * 幂等：重复批准不会重复执行（executed 后返回 not_approvable）。
   */
  async approveCandidate(candidateId: string): Promise<ApprovalExecutionResult> {
    try {
      const candidate = this.approvals.get(candidateId);
      if (candidate === undefined) {
        throw new MerchantWorkbenchError("not_found", `未知审批候选 ${candidateId}`);
      }
      // manual 模式语义（对齐 kernel 评审项 P3-3）：manual = advice only。
      if (this.mode() === "manual") {
        return {
          kind: "not_approvable",
          candidate,
          reason: "manual 模式只提供建议，不自动执行（批准拒绝 advice-only 候选）",
        };
      }
      const hooks = this.pendingHooks.get(candidateId);
      if (hooks === undefined) {
        if (candidate.status === "expired") return { kind: "expired", candidate };
        if (candidate.status !== "pending_approval" && candidate.status !== "approved") {
          return {
            kind: "not_approvable",
            candidate,
            reason: `候选 ${candidateId} 状态为 ${candidate.status}，不可批准。`,
          };
        }
        const expired = this.approvals.expireCandidate(candidateId);
        return { kind: "expired", candidate: expired };
      }
      this.approvals.markApproved(candidateId);
      const outcome = await executeApprovedCandidate(this.approvals, candidateId, hooks);
      // 候选生命周期终结（executed / stale / expired）后释放钩子闭包（评审项 P3-5）。
      if (outcome.kind !== "not_approvable") this.pendingHooks.delete(candidateId);
      return outcome;
    } catch (err) {
      throw toWorkbenchError(err);
    }
  }

  /** 租户校验：入参 merchant_id 提供时必须等于本商家 owner_id。 */
  private assertMerchantId(merchantId: string | undefined): void {
    if (merchantId !== undefined && merchantId !== this.ownerId) {
      throw new MerchantWorkbenchError(
        "validation",
        `merchant_id ${merchantId} 不属于本商家（${this.ownerId}）`,
      );
    }
  }

  /** 扫 A2A ledger 生成结构化行（按最近落账时间倒序）；activeOnly 时剔除非终态以外的记录。 */
  private scanLedger(activeOnly: boolean): A2aNegotiationRow[] {
    if (this.a2aLedgerDir === undefined) {
      throw new MerchantWorkbenchError("unavailable", "未配置 A2A ledger 目录，无法读取磋商记录。");
    }
    const ledger = new LedgerStore({ dir: this.a2aLedgerDir, now: this.now });
    const rows: A2aNegotiationRow[] = [];
    for (const negotiationId of ledger.listNegotiations()) {
      const row: A2aNegotiationRow = {
        negotiation_id: negotiationId,
        phase: "OPEN",
        last_action: "",
        sku: "",
        agreement: false,
        recorded_at: "",
      };
      for (const e of ledger.events(negotiationId)) {
        if (e.recorded_at > row.recorded_at) row.recorded_at = e.recorded_at;
        if (e.state_transition?.to_phase !== undefined) {
          row.phase = e.state_transition.to_phase;
          if (e.state_transition.to_phase === "AGREEMENT_REACHED") row.agreement = true;
        }
        if (e.event_kind === "message_sent") {
          const wp = e.wire_payload as
            | {
                action?: string;
                payload?: {
                  terms?: {
                    items?: Array<{
                      sku?: string;
                      quantity?: { value?: number };
                      unit_price?: { amount_minor?: number };
                    }>;
                  };
                };
              }
            | undefined;
          if (wp?.action !== undefined) row.last_action = wp.action;
          const item = wp?.payload?.terms?.items?.[0];
          if (item?.sku !== undefined && item.sku !== "") row.sku = item.sku;
          if (item?.quantity?.value !== undefined) row.quantity = item.quantity.value;
          if (item?.unit_price?.amount_minor !== undefined)
            row.price_minor = item.unit_price.amount_minor;
        }
      }
      // 已到终态（AGREEMENT_REACHED/DECLINED/WITHDRAWN/CANCELLED/EXPIRED）不算进行中
      if (activeOnly && (TERMINAL_PHASES as readonly string[]).includes(row.phase)) continue;
      rows.push(row);
    }
    rows.sort((a, b) =>
      a.recorded_at > b.recorded_at ? -1 : a.recorded_at < b.recorded_at ? 1 : 0,
    );
    return rows;
  }
}
