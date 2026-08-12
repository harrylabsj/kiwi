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
import type { CommerceDataSource } from "../../commerce/data-source.js";
import type { CommerceClient } from "../../commerce/types.js";
import { LedgerStore } from "../../negotiation/ledger/index.js";
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
          return textResult(rows.length === 0 ? "目录为空。" : JSON.stringify(rows), {
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
        return textResult(rows.length === 0 ? "目录为空。" : JSON.stringify(rows), { count: rows.length });
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
        return textResult(JSON.stringify(productPreconditions(product)));
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
        return textResult(JSON.stringify(snapshot));
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const listConsultations: Tool = {
    name: "list_incoming_consultations",
    label: "收到的咨询",
    description: "列出商家收到的进行中咨询（磋商会话），含最新一条消息。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id, _params) => {
      try {
        // Always this merchant's own consultations — never a caller-supplied id.
        const consultations = await merchantClient.listIncomingConsultations(ownerId);
        if (consultations.length === 0) return textResult("当前没有进行中的咨询。");
        return textResult(
          consultations
            .map(
              (c) =>
                `· ${c.conversation_id} [${c.status}]${c.sku !== undefined ? ` ${c.sku}` : ""}：${c.last_message.slice(0, 120)}`,
            )
            .join("\n"),
          { count: consultations.length },
        );
      } catch (err) {
        return textResult(errorText(err));
      }
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
        return textResult(
          reviews
            .map(
              (r) =>
                `· #${String(r.review_id)} ${r.sku} [${r.severity}] ${r.reason}（${r.conversation_id}）`,
            )
            .join("\n"),
          { count: reviews.length },
        );
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
      return textResult(`共 ${rows.length} 笔 A2A 磋商（最近 ${recent.length} 笔）：\n${recent.map((r) => r.line).join("\n")}`, {
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
