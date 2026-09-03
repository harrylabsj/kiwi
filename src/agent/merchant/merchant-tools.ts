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
 * Merchant capability pack (design §14–§15.4).
 *
 * Read-only tools surface the merchant's own catalog, inventory, incoming
 * consultations and human-review queue. Write tools (product/inventory/listing
 * changes) always produce a content-hashed WriteApprovalCandidate and route by mode
 * through the shared write gate (§16). The model only sees tools — catalog and
 * inventory tokens live in the CredentialBroker and are attached per-request.
 *
 * Private merchant values (floor price, cost, margin) live in the profile and
 * Vault; they never enter tool arguments, preconditions, the merchant client
 * or model-visible output. Autopilot only auto-executes within the profile's
 * HardPolicy envelope (floor / max discount); anything outside escalates to
 * approval.
 */

import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../../config/profile.js";
import { fenceModelPayload } from "../context/fencing.js";
import type { AgentHostEventType } from "../host/events.js";
import type { CommerceDataSource } from "../../commerce/data-source.js";
import type { CommerceClient } from "../../commerce/types.js";
import { LedgerStore } from "../../negotiation/ledger/index.js";
import { TERMINAL_PHASES } from "../../negotiation/state/phase.js";
import type { AgentMode } from "../mode.js";
import { buildNegotiationChatTools, writeGateText } from "../negotiation-chat.js";
import type { WriteApprovalCandidateStore } from "./action-candidate.js";
import type { CredentialBroker } from "./credential-broker.js";
import { requireScopeCredential } from "./credential-broker.js";
import type {
  MerchantCatalogProduct,
  MerchantClient,
  MerchantProductInput,
  MerchantProductPatch,
} from "./types.js";
import { MerchantClientError } from "./types.js";
import type { WriteGateDeps, WriteGateResult } from "../write-gate.js";
import { routeWriteCandidate } from "../write-gate.js";
import type { MerchantIntelligenceBackend } from "./intelligence/backend.js";
import { createMerchantPresentationRegistry } from "./merchant-presentations.js";
import { runPresentation } from "../presentation/runner.js";

type Tool = AgentHarnessTool<undefined>;

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errorText(err: unknown): string {
  if (err instanceof MerchantClientError) {
    const kindLabel: Record<string, string> = {
      auth: "凭据被拒或缺失",
      not_found: "未找到",
      validation: "参数或服务校验失败",
      transient: "暂时性错误",
    };
    return `商家操作失败（${kindLabel[err.kind] ?? err.kind}）：${err.message}`;
  }
  return `商家操作失败：${err instanceof Error ? err.message : String(err)}`;
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function experienceEnabled(profile: AgentProfile, capability: "intelligence" | "presentation"): boolean {
  const config = profile.merchant_experience;
  return config?.enabled === true && config[capability] !== false;
}

function experienceMaxChars(profile: AgentProfile): number {
  return profile.merchant_experience?.max_external_context_chars ?? 12_000;
}

function parseProductInput(value: unknown): MerchantProductInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MerchantClientError("validation", "product 必须是对象");
  }
  const v = value as Record<string, unknown>;
  const sku = optString(v.sku);
  const title = optString(v.title);
  const price = typeof v.price === "number" && Number.isFinite(v.price) ? v.price : undefined;
  const stock = typeof v.stock === "number" && Number.isInteger(v.stock) ? v.stock : undefined;
  const merchantId = optString(v.merchant_id);
  if (sku === undefined || title === undefined || price === undefined || stock === undefined) {
    throw new MerchantClientError(
      "validation",
      "product 需要 sku / title / price / stock（merchant_id 可选）",
    );
  }
  return {
    sku,
    merchant_id: merchantId ?? "",
    title,
    price,
    stock,
    ...(optString(v.currency) !== undefined ? { currency: v.currency as string } : {}),
    ...(optString(v.category) !== undefined ? { category: v.category as string } : {}),
    ...(Array.isArray(v.tags) ? { tags: v.tags.map(String) } : {}),
    ...(optString(v.description) !== undefined ? { description: v.description as string } : {}),
    ...(Array.isArray(v.delivery_attributes)
      ? { delivery_attributes: v.delivery_attributes.map(String) }
      : {}),
  };
}

function parseChanges(value: unknown): MerchantProductPatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MerchantClientError("validation", "changes 必须是对象");
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
  if (Array.isArray(v.delivery_attributes)) patch.delivery_attributes = v.delivery_attributes.map(String);
  if (typeof v.paused === "boolean") patch.paused = v.paused;
  return patch;
}

/** Public precondition snapshot of a product (no private values). */
function productPreconditions(product: MerchantCatalogProduct): Record<string, unknown> {
  return {
    sku: product.sku,
    merchant_id: product.merchant_id,
    title: product.title,
    price: product.price,
    stock: product.stock,
    paused: product.paused,
  };
}

/**
 * Autopilot escalation for catalog/inventory writes: anything outside the
 * profile HardPolicy (private floor, max auto discount) needs a human. The
 * reason never contains the private number.
 */
function catalogEscalation(
  profile: AgentProfile,
  args: Record<string, unknown>,
  current: MerchantCatalogProduct | undefined,
): string | undefined {
  const floor = profile.merchant_policy?.min_unit_price_private;
  const maxDiscount = profile.merchant_policy?.max_auto_discount_percent;
  const proposedPrice =
    typeof args.price === "number"
      ? args.price
      : typeof (args.changes as Record<string, unknown> | undefined)?.price === "number"
        ? Number((args.changes as Record<string, unknown>).price)
        : undefined;
  if (floor !== undefined && proposedPrice !== undefined && proposedPrice < floor) {
    return "新价格低于私有底价，需要人工批准。";
  }
  if (maxDiscount !== undefined && current !== undefined && proposedPrice !== undefined) {
    const floorDiscount = current.price * (1 - maxDiscount / 100);
    if (proposedPrice < floorDiscount) {
      return "折扣超过最大自动折扣授权，需要人工批准。";
    }
  }
  return undefined;
}

export interface MerchantToolDeps {
  profile: AgentProfile;
  merchantClient: MerchantClient;
  /**
   * Negotiation CommerceClient（v0.3.0-C）。目录/库存/咨询等只读工具与
   * 审批式写工具都不依赖它；仅磋商工具（claim/snapshot/submit）需要。
   * 缺失时磋商工具不挂载（fail closed），其余能力包照常可用——只读目录
   * 查询走公开搜索端点，无需谈判 token。
   */
  commerceClient?: CommerceClient;
  /**
   * Merchant 经营事实数据源（v0.7.0 CommerceDataSource）。提供时只读目录
   * 工具改从数据源读取（本地商品库 / ERP 适配器）；缺省走公开搜索端点。
   * 数据侧边界：不负责发现远端 Agent（架构 rev1.4.1 §33）。
   */
  dataSource?: CommerceDataSource;
  broker: CredentialBroker;
  approvals: WriteApprovalCandidateStore;
  mode: () => AgentMode;
  now: () => string;
  /** Register /approve execution hooks for pending candidates. */
  registerPending?: WriteGateDeps["registerPending"];
  /**
   * Read the merchant's own Restricted memory values (Vault). Owner-only:
   * results must never be written into public messages, offers, tool
   * arguments, proposals or logs.
   */
  privateValues?: () => Array<{ key: string; value: string }>;
  /** 商家 A2A 节点 ledger 目录（`<dataDir>/a2a/ledger`）；提供时挂载
   *  `list_a2a_negotiations` 工具，让运营者查看真实发生的 A2A 磋商记录。 */
  a2aLedgerDir?: string;
  /** Optional commerce-agents-style merchant application layer. */
  intelligence?: MerchantIntelligenceBackend;
  /** Optional host event projection; business state never depends on it. */
  emitEvent?: (type: AgentHostEventType, data: unknown) => Promise<void>;
  /** Process-bound principal id used by server enrichment. */
  principalId?: string;
}

export function buildMerchantTools(deps: MerchantToolDeps): Tool[] {
  const { profile, merchantClient, broker, approvals, mode, now } = deps;
  const ownerId = profile.owner_id;
  const writeGateDeps = { mode, approvals, profile, now, registerPending: deps.registerPending };

  // ---- read-only tools -------------------------------------------------------

  const listProducts: Tool = {
    name: "list_catalog_products",
    label: "列出商品",
    description: "列出商家自己的目录商品（只读；目录数据来自公开搜索端点，按本商家 owner 过滤）。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id, _params) => {
      try {
        // Always the merchant's own catalog — never an arbitrary merchant_id.
        if (deps.dataSource !== undefined) {
          const facts = await deps.dataSource.getProducts({ limit: 100 });
          const rows = facts.map((p) => ({
            sku: p.sku,
            title: p.title ?? "",
            price: p.price_minor ?? 0,
            stock: p.stock ?? null,
            paused: false,
          }));
          return textResult(rows.length === 0 ? "目录为空。" : fenceModelPayload("merchant_api", rows, { maxChars: experienceMaxChars(profile) }), {
            count: rows.length,
            source: "data-source",
          });
        }
        const products = await merchantClient.listProducts(ownerId);
        const rows = products.map((p) => ({
          sku: p.sku,
          title: p.title,
          price: p.price,
          stock: p.stock,
          paused: p.paused,
        }));
        return textResult(rows.length === 0 ? "目录为空。" : fenceModelPayload("merchant_api", rows, { maxChars: experienceMaxChars(profile) }), { count: rows.length });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const getProduct: Tool = {
    name: "get_catalog_product",
    label: "读取商品",
    description: "按 SKU 读取商家目录中的一个商品（只读）。",
    parameters: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const { sku } = params as { sku: string };
        const product = await merchantClient.getProduct(sku);
        return textResult(fenceModelPayload("merchant_api", productPreconditions(product), { maxChars: experienceMaxChars(profile) }));
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const inventorySnapshot: Tool = {
    name: "get_inventory_snapshot",
    label: "库存快照",
    description: "读取一个商品的当前库存快照（含观察时间，不是永恒事实）。",
    parameters: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const { sku } = params as { sku: string };
        const snapshot = await merchantClient.getInventorySnapshot(sku);
        return textResult(fenceModelPayload("merchant_api", snapshot, { maxChars: experienceMaxChars(profile) }));
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const listConsultations: Tool = {
    name: "list_incoming_consultations",
    label: "收到的咨询",
    description:
      "列出商家收到的**进行中**磋商（A2A ledger，未到终态）：negotiation_id、当前相位、" +
      "SKU、数量、报价、时间。运营者问「有用户来咨询吗/正在磋商什么」时用此查看；" +
      "历史已结束磋商用 list_a2a_negotiations。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id, _params) => {
      const ledgerDir = deps.a2aLedgerDir;
      if (ledgerDir === undefined) {
        return textResult("未配置 A2A ledger 目录，无法读取磋商记录。");
      }
      const ledger = new LedgerStore({ dir: ledgerDir, now: deps.now });
      const rows: Array<{ at: string; line: string }> = [];
      for (const negotiationId of ledger.listNegotiations()) {
        let phase = "OPEN";
        let at = "";
        let sku = "";
        let qty: number | undefined;
        let priceMinor: number | undefined;
        for (const e of ledger.events(negotiationId)) {
          if (e.recorded_at > at) at = e.recorded_at;
          if (e.state_transition?.to_phase !== undefined) phase = e.state_transition.to_phase;
          if (e.event_kind === "message_sent") {
            const wp = e.wire_payload as
              | {
                  action?: string;
                  payload?: {
                    terms?: { items?: Array<{ sku?: string; quantity?: { value?: number }; unit_price?: { amount_minor?: number } }> };
                  };
                }
              | undefined;
            const item = wp?.payload?.terms?.items?.[0];
            if (item?.sku !== undefined && item.sku !== "") sku = item.sku;
            if (item?.quantity?.value !== undefined) qty = item.quantity.value;
            if (item?.unit_price?.amount_minor !== undefined) priceMinor = item.unit_price.amount_minor;
          }
        }
        // 已到终态（AGREEMENT_REACHED/DECLINED/WITHDRAWN/CANCELLED/EXPIRED）不算进行中
        if ((TERMINAL_PHASES as readonly string[]).includes(phase)) continue;
        const price = priceMinor !== undefined ? `，价 ${(priceMinor / 100).toFixed(2)} 元/件` : "";
        rows.push({
          at,
          line: `· ${negotiationId}（${phase}）SKU=${sku || "-"} 数量=${qty ?? "-"}${price} ${at}`,
        });
      }
      rows.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
      if (rows.length === 0) return textResult("当前没有进行中的磋商。", { count: 0 });
      return textResult(fenceModelPayload("a2a_message", {
        total: rows.length,
        items: rows.map((r) => r.line),
      }, { maxChars: experienceMaxChars(profile) }), {
        count: rows.length,
      });
    },
  };

  const humanReviewQueue: Tool = {
    name: "get_human_review_queue",
    label: "人工处理队列",
    description: "查看商家需要人工处理的队列（升级、超预算/超底价、转人工的磋商）。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id, _params) => {
      try {
        const reviews = await merchantClient.getHumanReviewQueue(ownerId);
        if (reviews.length === 0) return textResult("人工处理队列为空。");
        return textResult(fenceModelPayload("human_review", reviews.map((r) => ({
          review_id: r.review_id,
          conversation_id: r.conversation_id,
          sku: r.sku,
          severity: r.severity,
          reason: r.reason,
        })), { maxChars: experienceMaxChars(profile) }), { count: reviews.length });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  // ---- write tools (approval-routed) -----------------------------------------

  const createProduct: Tool = {
    name: "create_product",
    label: "创建商品",
    description:
      "创建新商品（写操作）。需要 catalog 作用域凭据；supervised 模式生成审批候选，批准后才真正创建。",
    parameters: {
      type: "object",
      properties: {
        product: {
          type: "object",
          description: "sku/title/price/stock 必填；currency/category/tags/description 可选",
        },
      },
      required: ["product"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "catalog");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const input = parseProductInput((params as { product: unknown }).product);
        // A merchant's own catalog write always belongs to THIS merchant: an
        // omitted merchant_id must default to the profile owner, never empty.
        const product =
          input.merchant_id === "" ? { ...input, merchant_id: ownerId } : input;
        const args = { product: { ...product } };
        const preconditions = { sku: product.sku, exists: false };
        const escalation = catalogEscalation(profile, { ...product }, undefined);
        const outcome = await routeWriteCandidate(
          writeGateDeps,
          {
            tool: "create_product",
            arguments: args,
            preconditions,
            risk: "write_catalog",
            execute: (approvedArgs) => {
              const p = (approvedArgs as { product: MerchantProductInput }).product;
              return merchantClient.createProduct(p);
            },
            // Re-read existence: if another worker created the SKU meanwhile,
            // the old approval is stale and the create is superseded.
            readPreconditions: async () => {
              let exists = false;
              try {
                await merchantClient.getProduct(product.sku);
                exists = true;
              } catch {
                exists = false;
              }
              return { sku: product.sku, exists };
            },
            autopilotEscalation: () => escalation,
          },
        );
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const updateProduct: Tool = {
    name: "update_product",
    label: "更新商品",
    description:
      "更新商品的公开字段（title/price/stock/description 等，写操作）。supervised 模式生成审批候选。",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string" },
        changes: { type: "object", description: "要修改的字段" },
        reason: { type: "string" },
      },
      required: ["sku", "changes"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "catalog");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const p = params as { sku: string; changes: unknown };
        const patch = parseChanges(p.changes);
        if (Object.keys(patch).length === 0) {
          return textResult("changes 没有任何可修改字段。");
        }
        let current: MerchantCatalogProduct | undefined;
        try {
          current = await merchantClient.getProduct(p.sku);
        } catch {
          return textResult(`商品 ${p.sku} 不存在。`);
        }
        const args = { sku: p.sku, changes: { ...patch } };
        const preconditions = productPreconditions(current);
        const escalation = catalogEscalation(profile, args, current);
        const outcome = await routeWriteCandidate(
          writeGateDeps,
          {
            tool: "update_product",
            arguments: args,
            preconditions,
            risk: "write_catalog",
            execute: (approvedArgs) => {
              const a = approvedArgs as { sku: string; changes: MerchantProductPatch };
              return merchantClient.updateProduct(a.sku, a.changes);
            },
            readPreconditions: async () => {
              const fresh = await merchantClient.getProduct(p.sku);
              return productPreconditions(fresh);
            },
            autopilotEscalation: () => escalation,
          },
        );
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const updateInventory: Tool = {
    name: "update_inventory",
    label: "更新库存",
    description:
      "更新一个商品的库存数量（写操作，inventory 作用域凭据）。supervised 模式生成审批候选。",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string" },
        stock: { type: "integer", description: "新的库存数量（>= 0）" },
        reason: { type: "string" },
      },
      required: ["sku", "stock"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "inventory");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const p = params as { sku: string; stock: number };
        if (!Number.isInteger(p.stock) || p.stock < 0) {
          return textResult("stock 必须是非负整数。");
        }
        let current: MerchantCatalogProduct | undefined;
        try {
          current = await merchantClient.getProduct(p.sku);
        } catch {
          return textResult(`商品 ${p.sku} 不存在。`);
        }
        const args = { sku: p.sku, stock: p.stock };
        const preconditions = productPreconditions(current);
        const outcome = await routeWriteCandidate(
          writeGateDeps,
          {
            tool: "update_inventory",
            arguments: args,
            preconditions,
            risk: "update_inventory",
            execute: (approvedArgs) => {
              const a = approvedArgs as { sku: string; stock: number };
              return merchantClient.updateInventory(a.sku, a.stock);
            },
            readPreconditions: async () => {
              const fresh = await merchantClient.getProduct(p.sku);
              return productPreconditions(fresh);
            },
          },
        );
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const pauseListing: Tool = {
    name: "pause_or_resume_listing",
    label: "暂停/恢复上架",
    description:
      "暂停或恢复一个商品的上架状态（写操作）。真实 shopping-cli 2.x 无 listing 端点，真实 Connector 会 fail closed；" +
      "审批候选仍会生成与记录。",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string" },
        paused: { type: "boolean", description: "true 暂停上架，false 恢复上架" },
        reason: { type: "string" },
      },
      required: ["sku", "paused"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "catalog");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const p = params as { sku: string; paused: boolean };
        let current: MerchantCatalogProduct | undefined;
        try {
          current = await merchantClient.getProduct(p.sku);
        } catch {
          return textResult(`商品 ${p.sku} 不存在。`);
        }
        const args = { sku: p.sku, paused: p.paused };
        const preconditions = productPreconditions(current);
        const outcome = await routeWriteCandidate(
          writeGateDeps,
          {
            tool: "pause_or_resume_listing",
            arguments: args,
            preconditions,
            risk: "listing_pause",
            execute: (approvedArgs) => {
              const a = approvedArgs as { sku: string; paused: boolean };
              return merchantClient.pauseListing(a.sku, a.paused);
            },
            readPreconditions: async () => {
              const fresh = await merchantClient.getProduct(p.sku);
              return productPreconditions(fresh);
            },
          },
        );
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const draftChange: Tool = {
    name: "draft_product_change",
    label: "商品变更草稿",
    description:
      "为一个商品变更生成草稿候选（不立即执行，任何模式都不自动执行）。操作者批准后才会真正写入。",
    parameters: {
      type: "object",
      properties: {
        sku: { type: "string" },
        changes: { type: "object", description: "计划修改的字段（title/price/stock/description 等）" },
        reason: { type: "string" },
      },
      required: ["sku", "changes"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "catalog");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const p = params as { sku: string; changes: unknown; reason?: string };
        const patch = parseChanges(p.changes);
        if (Object.keys(patch).length === 0) {
          return textResult("changes 没有任何可修改字段。");
        }
        let current: MerchantCatalogProduct | undefined;
        try {
          current = await merchantClient.getProduct(p.sku);
        } catch {
          return textResult(`商品 ${p.sku} 不存在。`);
        }
        const args = { sku: p.sku, changes: { ...patch }, reason: optString(p.reason) ?? "" };
        const outcome = await routeWriteCandidate(
          writeGateDeps,
          {
            tool: "draft_product_change",
            arguments: args,
            preconditions: productPreconditions(current),
            risk: "write_catalog",
            // Drafts are ALWAYS pending (never auto-execute), even in autopilot.
            force_pending: true,
            execute: (approvedArgs) => {
              const a = approvedArgs as { sku: string; changes: MerchantProductPatch };
              return merchantClient.updateProduct(a.sku, a.changes);
            },
            readPreconditions: async () => {
              const fresh = await merchantClient.getProduct(p.sku);
              return productPreconditions(fresh);
            },
          },
        );
        if (outcome.kind === "pending_approval") {
          return textResult(
            `已生成变更草稿候选 ${outcome.candidate.candidate_id}（等待批准后才执行）。当前商品：` +
              JSON.stringify(productPreconditions(current)),
            { candidate_id: outcome.candidate.candidate_id, status: "pending_approval" },
          );
        }
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const experienceTools: Tool[] = [];
  if (experienceEnabled(profile, "intelligence") && deps.intelligence !== undefined) {
    const intelligence = deps.intelligence;
    const getBusinessSnapshot: Tool = {
      name: "get_business_snapshot",
      label: "读取经营摘要",
      description: "读取当前商家经营摘要、咨询/磋商和待处理事项。只读；指标由服务端计算并注明数据限制。",
      parameters: {
        type: "object",
        properties: {
          period: {
            type: "string",
            pattern: "^(?:[1-9]|[1-8][0-9]|90)d$",
            description: "UTC 统计窗口，1d 到 90d，例如 7d、14d、30d",
          },
        },
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        try {
          const period = optString((params as { period?: unknown }).period);
          const snapshot = await intelligence.getBusinessSnapshot({
            merchant_id: ownerId,
            ...(period === undefined ? {} : { period }),
          });
          return textResult(fenceModelPayload("metric", snapshot, { maxChars: experienceMaxChars(profile) }), {
            status: "ok",
            metric: "business_snapshot",
          });
        } catch (err) {
          return textResult(errorText(err));
        }
      },
    };

    const queryMetric: Tool = {
      name: "query_merchant_metric",
      label: "读取经营指标",
      description: "读取一项按日/周/月聚合的商家指标。不可得的指标返回明确说明，不用零值代替。",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", description: "指标名，例如 contact_events、negotiations" },
          period: {
            type: "string",
            pattern: "^(?:[1-9]|[1-8][0-9]|90)d$",
            description: "UTC 统计窗口，1d 到 90d，例如 7d、14d、30d",
          },
          granularity: { type: "string", enum: ["day", "week", "month"] },
        },
        required: ["metric"],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        try {
          const p = params as { metric?: unknown; period?: unknown; granularity?: unknown };
          const metric = optString(p.metric);
          if (metric === undefined) return textResult("metric 必须是非空字符串。");
          const granularity = p.granularity === "week" || p.granularity === "month" ? p.granularity : "day";
          const series = await intelligence.queryMetric({
            merchant_id: ownerId,
            metric,
            granularity,
            ...(optString(p.period) === undefined ? {} : { period: optString(p.period) }),
          });
          return textResult(fenceModelPayload("metric", series, { maxChars: experienceMaxChars(profile) }), {
            status: "ok",
            metric,
          });
        } catch (err) {
          return textResult(errorText(err));
        }
      },
    };

    const getNegotiationDigest: Tool = {
      name: "get_negotiation_digest",
      label: "读取磋商摘要",
      description: "读取商家 A2A 磋商摘要。返回当前 phase、公开报价和是否需要人工；只读。",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "agreement", "all"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        try {
          const p = params as { status?: unknown; limit?: unknown };
          const status = p.status === "active" || p.status === "agreement" ? p.status : "all";
          const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.trunc(p.limit) : 20;
          const rows = await intelligence.getNegotiationDigest({
            merchant_id: ownerId,
            status,
            limit: Math.max(1, Math.min(100, rawLimit)),
          });
          return textResult(fenceModelPayload("a2a_message", rows, { maxChars: experienceMaxChars(profile) }), {
            status: "ok",
            count: rows.length,
          });
        } catch (err) {
          return textResult(errorText(err));
        }
      },
    };

    const getCatalogHealth: Tool = {
      name: "get_catalog_health",
      label: "读取目录健康度",
      description: "读取商品总量、上下架状态和缺货数量；精确库存不可得时返回 null 及限制说明。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        try {
          const health = await intelligence.getCatalogHealth({ merchant_id: ownerId });
          return textResult(fenceModelPayload("merchant_api", health, { maxChars: experienceMaxChars(profile) }), {
            status: "ok",
          });
        } catch (err) {
          return textResult(errorText(err));
        }
      },
    };

    const getPendingActions: Tool = {
      name: "get_pending_actions",
      label: "读取待审批操作",
      description: "读取当前 principal 的待审批写操作。返回候选元数据，不返回私有阈值或凭据。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        try {
          const rows = await intelligence.getPendingActions();
          return textResult(fenceModelPayload("merchant_api", rows, { maxChars: experienceMaxChars(profile) }), {
            status: "ok",
            count: rows.length,
          });
        } catch (err) {
          return textResult(errorText(err));
        }
      },
    };
    experienceTools.push(getBusinessSnapshot, queryMetric, getCatalogHealth, getNegotiationDigest, getPendingActions);
  }

  if (experienceEnabled(profile, "presentation") && deps.emitEvent !== undefined) {
    const registry = createMerchantPresentationRegistry();
    const emitUi = async (component: string, payload: unknown): Promise<void> => {
      await deps.emitEvent?.("ui", { component, payload });
    };
    const presentationContext = {
      profile,
      principalId: deps.principalId ?? ownerId,
      merchantClient,
      approvals,
      ...(deps.intelligence !== undefined ? { intelligence: deps.intelligence } : {}),
    };
    for (const component of registry.list()) {
      const presentationTool: Tool = {
        name: component.toolName,
        label: component.label,
        description: component.description,
        parameters: component.inputSchema,
        execute: async (_id, params) => {
          try {
            const result = await runPresentation(
              registry,
              component.toolName,
              params,
              presentationContext,
              emitUi,
            );
            return textResult(
              component.toolName === "present_change_preview"
                ? "已展示变更预览；尚未批准或执行。"
                : `已展示${component.label.replace(/^展示/, "")}。`,
              { component: result.component },
            );
          } catch (err) {
            return textResult(errorText(err));
          }
        },
      };
      experienceTools.push(presentationTool);
    }
  }

  const negotiationTools =
    deps.commerceClient !== undefined
      ? buildNegotiationChatTools({
          profile,
          commerceClient: deps.commerceClient,
          broker,
          approvals,
          mode,
          now,
          registerPending: deps.registerPending,
        })
      : [];

  const viewPrivateThresholds: Tool = {
    name: "view_private_thresholds",
    label: "查看私密阈值",
    description:
      "查看操作者（委托人）自己的私有阈值（成本/底价/利润目标，从加密 Vault 读取）。" +
      "这些数值只对操作者本人可见；绝不能写进公开消息、对外报价文本、磋商 proposal 或日志。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (deps.privateValues === undefined) {
        return textResult("当前环境未配置私密阈值读取能力。");
      }
      const values = deps.privateValues();
      if (values.length === 0) return textResult("暂无私密阈值记忆。");
      return textResult(
        values.map((v) => `· ${v.key} = ${v.value}`).join("\n"),
        { count: values.length },
      );
    },
  };

  // ── A2A 磋商记录（真实经 A2A 节点的磋商，读 merchant 节点 ledger）───────
  const listA2aNegotiations: Tool = {
    name: "list_a2a_negotiations",
    label: "A2A 磋商记录",
    description:
      "列出商家节点收到/处理的 A2A 磋商记录（真实磋商，非 shopping-cli 咨询）：" +
      "negotiation_id、是否达成协议、SKU、数量、成交价、时间。运营者问" +
      "「有用户来磋商吗」时用此查看。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多返回最近 N 笔（缺省 20）" },
      },
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const ledgerDir = deps.a2aLedgerDir;
      if (ledgerDir === undefined) {
        return textResult("未配置 A2A ledger 目录，无法读取磋商记录。");
      }
      const ledger = new LedgerStore({ dir: ledgerDir, now: deps.now });
      const limit = Math.min(Math.max(Number((params as { limit?: unknown }).limit ?? 20) || 20, 1), 100);
      const rows: Array<{ at: string; line: string }> = [];
      for (const negotiationId of ledger.listNegotiations()) {
        const events = ledger.events(negotiationId);
        let at = "";
        let lastAction = "";
        let sku = "";
        let qty: number | undefined;
        let priceMinor: number | undefined;
        let agreement = false;
        for (const e of events) {
          if (e.recorded_at > at) at = e.recorded_at;
          if (e.event_kind === "message_sent") {
            const wp = e.wire_payload as
              | {
                  action?: string;
                  payload?: {
                    terms?: { items?: Array<{ sku?: string; quantity?: { value?: number }; unit_price?: { amount_minor?: number } }> };
                  };
                }
              | undefined;
            if (wp?.action !== undefined) lastAction = wp.action;
            const item = wp?.payload?.terms?.items?.[0];
            if (item?.sku !== undefined && item.sku !== "") sku = item.sku;
            if (item?.quantity?.value !== undefined) qty = item.quantity.value;
            if (item?.unit_price?.amount_minor !== undefined) priceMinor = item.unit_price.amount_minor;
          }
          if (e.state_transition?.to_phase === "AGREEMENT_REACHED") agreement = true;
        }
        const price = priceMinor !== undefined ? `，价 ${(priceMinor / 100).toFixed(2)} 元/件` : "";
        rows.push({
          at,
          line:
            `· ${negotiationId}${agreement ? " ✅ 已达成协议" : `（${lastAction || "?"}）`} ` +
            `SKU=${sku || "-"} 数量=${qty ?? "-"}${price} ${at}`,
        });
      }
      rows.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
      const recent = rows.slice(0, limit);
      if (recent.length === 0) return textResult("暂无 A2A 磋商记录。", { count: 0 });
      return textResult(fenceModelPayload("a2a_message", {
        total: rows.length,
        items: recent.map((r) => r.line),
      }, { maxChars: experienceMaxChars(profile) }), {
        count: recent.length,
      });
    },
  };

  return [
    listProducts,
    getProduct,
    inventorySnapshot,
    listConsultations,
    humanReviewQueue,
    viewPrivateThresholds,
    ...experienceTools,
    ...negotiationTools,
    createProduct,
    updateProduct,
    updateInventory,
    pauseListing,
    draftChange,
    ...(deps.a2aLedgerDir !== undefined ? [listA2aNegotiations] : []),
  ];
}

export type { WriteGateResult };
