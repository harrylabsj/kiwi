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
 * Buyer capability tools for the main conversation (design §15.1/§15.2).
 * All writes flow through BuyerTaskStore governance (state machine +
 * idempotency); the model never touches SQL or tokens.
 */

import { createHash } from "node:crypto";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  HandoffIdempotencyStore,
  HandoffEventStore,
  createHandoffCandidate,
  defaultUrlSafety,
  executeHandoff,
  validateDestination,
  type HandoffCandidate,
} from "../../handoff/index.js";
import type { ExecuteHandoffResult } from "../../handoff/index.js";
import { toMinorUnits as losslessToMinorUnits } from "../../protocol/legacy-shopping-negotiation/money.js";
import { contentDigest } from "../../negotiation/jcs.js";
import type { AgentProfile } from "../../config/profile.js";
import type { CommerceClient } from "../../commerce/types.js";
import type { KiwiCatalogSource } from "../../discovery/catalog-source/index.js";
import type { CommerceConnector } from "../connector/types.js";
import type { AgentMode } from "../mode.js";
import type { WriteApprovalCandidateStore } from "../merchant/action-candidate.js";
import type { CredentialBroker } from "../merchant/credential-broker.js";
import { requireScopeCredential } from "../merchant/credential-broker.js";
import {
  NEGOTIATE_DEAL_PRICE_MINOR,
  NEGOTIATE_DELIVERY_BEFORE,
  NEGOTIATE_SKU,
  negotiateWithAgent,
  summarizeNegotiation,
} from "../../a2a/negotiate.js";
import { buildNegotiationChatTools, writeGateText } from "../negotiation-chat.js";
import { routeWriteCandidate, type WriteGateDeps } from "../write-gate.js";
import { runSearchCycle } from "./search-loop.js";
import type { BuyerTaskStore } from "./task-store.js";
import type { ConsultationLink, BuyerTaskStatus } from "./types.js";
import type { TaskConstraints, TaskEvent, TaskIntent } from "./types.js";
import { BuyerTaskError } from "./types.js";
import { uuidv7 } from "@earendil-works/pi-ai";

type Tool = AgentHarnessTool<undefined>;

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errorText(err: unknown): string {
  if (err instanceof BuyerTaskError) return `任务操作被拒绝（${err.code}）：${err.message}`;
  return `任务操作失败：${err instanceof Error ? err.message : String(err)}`;
}

function parseIntent(value: unknown): TaskIntent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BuyerTaskError("validation", "intent must be an object");
  }
  const v = value as Record<string, unknown>;
  const out: TaskIntent = {};
  if (typeof v.category === "string") out.category = v.category;
  if (typeof v.use_case === "string") out.use_case = v.use_case;
  if (typeof v.query_text === "string") out.query_text = v.query_text;
  if (typeof v.city === "string") out.city = v.city;
  if (typeof v.area === "string") out.area = v.area;
  if (typeof v.needed_by === "string") out.needed_by = v.needed_by;
  if (typeof v.quantity === "number" && Number.isInteger(v.quantity) && v.quantity > 0) {
    out.quantity = v.quantity;
  }
  if (typeof v.target_unit_price === "number" && Number.isFinite(v.target_unit_price) && v.target_unit_price >= 0) {
    out.target_unit_price = v.target_unit_price;
  }
  if (Array.isArray(v.preferences)) out.preferences = v.preferences.map(String);
  if (Array.isArray(v.required_terms)) out.required_terms = v.required_terms.map(String);
  if (Array.isArray(v.open_questions)) out.open_questions = v.open_questions.map(String);
  if (v.location_precision === "city" || v.location_precision === "district") {
    out.location_precision = v.location_precision;
  }
  return out;
}

function parseConstraints(value: unknown): TaskConstraints {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BuyerTaskError("validation", "constraints must be an object");
  }
  const v = value as Record<string, unknown>;
  const out: TaskConstraints = {};
  if (typeof v.max_unit_price === "number" && Number.isFinite(v.max_unit_price) && v.max_unit_price >= 0) {
    out.max_unit_price = v.max_unit_price;
  }
  if (typeof v.max_total_price === "number" && Number.isFinite(v.max_total_price)) {
    out.max_total_price = v.max_total_price;
  }
  if (typeof v.max_total_price_vault_ref === "string") {
    out.max_total_price_vault_ref = v.max_total_price_vault_ref;
  }
  if (typeof v.latest_eta === "string") out.latest_eta = v.latest_eta;
  if (Array.isArray(v.required_terms)) out.required_terms = v.required_terms.map(String);
  if (typeof v.exclude_out_of_stock === "boolean") out.exclude_out_of_stock = v.exclude_out_of_stock;
  return out;
}

/** Model-facing task constraints never echo the private budget (§11.2). */
function redactConstraints(constraints: TaskConstraints): Record<string, unknown> {
  const { max_total_price: _price, max_total_price_vault_ref: _ref, ...rest } = constraints;
  if (_price !== undefined || _ref !== undefined) {
    return { ...rest, max_total_price: "<私密预算>" };
  }
  return { ...rest };
}

/**
 * §16 mode table: "创建任务和跟踪规则" is 建议 in manual — the write must NOT
 * execute. supervised/autopilot execute as today. Blocks the low-risk local
 * task/rule writes from silently running under manual.
 */
function manualAdvice(mode: (() => AgentMode) | undefined): { ok: true } | { ok: false; reason: string } {
  if (mode?.() === "manual") {
    return {
      ok: false,
      reason:
        "manual 模式只提供建议、不执行任务写入；请切换到 supervised（写操作需批准）或 autopilot。",
    };
  }
  return { ok: true };
}

/** Execute an approved non-binding selection (§12.4 — never an order). */
function executeSelection(
  store: BuyerTaskStore,
  now: () => string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const p = args as { task_id: string; candidate_id: string; user_instruction: string };
  const task = store.getTask(p.task_id);
  if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
  const candidate = store.getCandidate(p.candidate_id);
  if (candidate === undefined || candidate.task_id !== p.task_id) {
    throw new BuyerTaskError("not_found", `no candidate ${p.candidate_id} in task`);
  }
  if (candidate.candidate_status !== "shortlisted" && candidate.candidate_status !== "selected") {
    throw new BuyerTaskError(
      "validation",
      `candidate ${p.candidate_id} is ${candidate.candidate_status}; 只能选定 shortlisted 或已 selected 的候选`,
    );
  }
  const observation = store.latestObservation(p.candidate_id);
  store.appendEvent(
    p.task_id,
    "selected",
    {
      candidate_id: p.candidate_id,
      observation_id: observation?.observation_id ?? null,
      selected_at: now(),
      authorization: p.user_instruction,
      score_explanation: candidate.score_explanation ?? null,
      boundary: "未创建订单；非绑定选定不声明价格、库存或交期仍然有效",
    },
    "user",
    `select:${p.task_id}:${p.candidate_id}:${uuidv7()}`,
  );
  store.updateCandidate(p.candidate_id, { candidate_status: "selected" });
  store.transitionTask({
    task_id: p.task_id,
    to: "selected_nonbinding",
    expected_version: task.version,
    event_type: "status_changed",
    payload: { selected_candidate_id: p.candidate_id },
    origin: "user",
    idempotency_key: `select-transition:${p.task_id}:${p.candidate_id}`,
    selected_candidate_id: p.candidate_id,
  });
  return {
    task_id: p.task_id,
    status: "selected_nonbinding",
    candidate_id: p.candidate_id,
    observation_id: observation?.observation_id ?? null,
  };
}

export interface BuyerToolDeps {
  store: BuyerTaskStore;
  connector: CommerceConnector;
  profile: AgentProfile;
  commerceClient?: CommerceClient;
  broker?: CredentialBroker;
  approvals?: WriteApprovalCandidateStore;
  mode?: () => AgentMode;
  now: () => string;
  /** Register /approve execution hooks for pending candidates. */
  registerPending?: WriteGateDeps["registerPending"];
  /** agent catalog base URL（`negotiate_buyer_task` 的 A2A 商家发现用）。 */
  catalog?: string;
  /**
   * 本地开发 loopback 放行（透传给 negotiateWithAgent → AgentDiscovery；
   * 缺省 false，fail-closed）。仅测试/本地联调环境显式传 true。
   */
  allowLoopback?: boolean;
  /**
   * kiwi-catalog listing 源（rev1.5 CD #27 Product-first）。注入时挂载
   * `search_listings` / `shortlist_listing` 工具；缺失时工具不挂载
   * （fail-closed，legacy marketplace 搜索路径不变）。
   */
  catalogSource?: KiwiCatalogSource;
  /**
   * 磋商结果写记忆（kernel 注入，复用 recordNegotiation 的 remember 形状）。
   * 记忆是尽力而为：失败不影响任务推进。
   */
  recordNegotiation?: (input: {
    negotiationId: string;
    catalogAgentId: string;
    sku: string;
    quantity: number;
    offerPriceMinor?: number;
    dealPriceMinor?: number;
    agreementId?: string;
  }) => Promise<string>;
  /**
   * KTH/0.1 Handoff 存储（v0.7.0；kernel 注入）。提供时挂载 `handoff_agreement`
   * 工具（agreement → 审批门 → 安全交接）；缺失时工具不挂载（fail closed）。
   */
  handoff?: { ledger: HandoffEventStore; idempotency: HandoffIdempotencyStore };
}

/**
 * 可直接发起本地 A2A 磋商的任务状态。排除：
 * - draft/clarifying（意图未定）；searching（搜索在途，避免版本并发冲突）；
 * - consulting/negotiating（已有磋商链接）；selected_nonbinding（重谈是未来工作）。
 */
const NEGOTIABLE_TASK_STATUSES: ReadonlySet<BuyerTaskStatus> = new Set([
  "ready",
  "tracking",
  "shortlist_ready",
  "awaiting_user",
]);

/** 磋商前置快照（审批候选 + 执行前重读用，§16）。 */
function negotiationPreconditions(
  store: BuyerTaskStore,
  catalogConfigured: boolean,
  taskId: string,
): Record<string, unknown> {
  const task = store.getTask(taskId);
  return {
    task_status: task?.status ?? null,
    task_version: task?.version ?? null,
    catalog_configured: catalogConfigured,
  };
}

/**
 * 已批准的本地 A2A 磋商执行体：经 catalog 发现商家 → negotiateWithAgent
 * 确定性 KNP 磋商（RFQ→offer→counter→conditional→accept）。成功：任务
 * consulting → negotiating → selected_nonbinding，链路（connector=a2a-direct）
 * 记 negotiation_id；失败：仅记 ok:false 事件，任务状态不动。
 */
async function executeNegotiateBuyerTask(
  deps: BuyerToolDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store } = deps;
  const a = args as { task_id: string; catalog_agent_id?: string };
  const task = store.getTask(a.task_id);
  if (task === undefined) throw new BuyerTaskError("not_found", `no task ${a.task_id}`);
  if (!NEGOTIABLE_TASK_STATUSES.has(task.status)) {
    throw new BuyerTaskError(
      "illegal_transition",
      `task ${a.task_id} is ${task.status}; 可直接磋商的状态：${[...NEGOTIABLE_TASK_STATUSES].join("/")}`,
    );
  }
  if (deps.catalog === undefined) {
    throw new BuyerTaskError("validation", "未配置 agent catalog（KIWI_CATALOG_URL 或 --catalog）");
  }
  const intent = task.intent;
  // 优先用短名单候选的 merchant SKU（catalog listing source_product_ref /
  // marketplace product.sku）——用自由文本 intent 当 SKU 会让商家按回退价报价
  // （实测 "iPhone 17" → ¥807.50，而候选 VQ-003 → ¥94.05）。
  const candidateSku = store
    .listCandidates(a.task_id)
    .find((c) => c.candidate_status === "shortlisted" || c.candidate_status === "selected")?.sku;
  const sku = candidateSku ?? intent.category ?? intent.query_text ?? NEGOTIATE_SKU;
  const result = await negotiateWithAgent({
    catalog: deps.catalog,
    allowLoopback: deps.allowLoopback === true,
    // CD #27：listing → owner_agent_id → getRecord → fresh verify 全链，
    // 与 search_listings 同一注入源（历史教训：只注入 search 面不注入磋商面）。
    ...(deps.catalogSource !== undefined ? { catalogSource: deps.catalogSource } : {}),
    ...(a.catalog_agent_id !== undefined && a.catalog_agent_id !== ""
      ? { catalogAgentId: a.catalog_agent_id }
      : {}),
    sku,
    quantity: intent.quantity ?? 1,
    dealPriceMinor:
      intent.target_unit_price !== undefined
        ? (() => {
            // 审查 BUG-04：目标价 major→minor 必须 lossless——静默舍入会把
            // 错误的目标价写进 buyer 出价（fail-closed：lossy 时用缺省价）。
            const converted = losslessToMinorUnits(intent.target_unit_price, 2);
            return converted.lossless ? converted.amount_minor : NEGOTIATE_DEAL_PRICE_MINOR;
          })()
        : NEGOTIATE_DEAL_PRICE_MINOR,
    deliveryBefore: intent.needed_by ?? NEGOTIATE_DELIVERY_BEFORE,
    senderIdentity: deps.profile.agent_id,
    // 预算硬约束（单价上限）：成交价超此值即拒绝。优先 constraints.max_unit_price；
    // 只有总预算时按数量折算单价。
    maxPriceMinor: (() => {
      const perUnit = task.constraints.max_unit_price;
      if (perUnit !== undefined && Number.isFinite(perUnit) && perUnit > 0) {
        const c = losslessToMinorUnits(perUnit, 2);
        return c.lossless ? c.amount_minor : undefined;
      }
      const total = task.constraints.max_total_price;
      const qty = intent.quantity ?? 1;
      if (total !== undefined && Number.isFinite(total) && qty > 0) {
        const c = losslessToMinorUnits(total / qty, 2);
        return c.lossless ? c.amount_minor : undefined;
      }
      return undefined;
    })(),
  });
  const eventKey = `a2a-neg:${a.task_id}:${result.negotiationId}`;
  if (!result.ok) {
    store.appendEvent(
      a.task_id,
      "a2a_negotiated",
      {
        ok: false,
        error: result.error ?? "未知错误",
        negotiation_id: result.negotiationId,
        catalog_agent_id: result.catalogAgentId,
      },
      "model",
      eventKey,
    );
    return { ok: false, task_id: a.task_id, negotiation_id: result.negotiationId, error: result.error };
  }
  const facts = result.facts;
  try {
    const link = store.createConsultationLink({
      task_id: a.task_id,
      connector_id: "a2a-direct",
      conversation_id: result.negotiationId,
      idempotency_key: `a2a-consult:${a.task_id}:${result.negotiationId}`,
    });
    // consulting → negotiating → selected_nonbinding（各跳 version 守卫 + 幂等）。
    let current = store.transitionTask({
      task_id: a.task_id,
      to: "consulting",
      expected_version: task.version,
      event_type: "status_changed",
      payload: { negotiation_id: result.negotiationId, link_id: link.link_id },
      origin: "model",
      idempotency_key: `${eventKey}:consulting`,
    });
    current = store.transitionTask({
      task_id: a.task_id,
      to: "negotiating",
      expected_version: current.version,
      event_type: "status_changed",
      origin: "model",
      idempotency_key: `${eventKey}:negotiating`,
    });
    store.transitionTask({
      task_id: a.task_id,
      to: "selected_nonbinding",
      expected_version: current.version,
      event_type: "status_changed",
      payload: {
        negotiation_id: result.negotiationId,
        agreement_id: result.agreement?.agreement_id ?? null,
        deal_price_minor: facts?.dealPriceMinor ?? null,
        // v0.7.0 KTH：agreement 快照落任务记录——handoff_agreement 的
        // agreementReader 以此做 pre-execution revalidation（§10）。
        agreed_terms: result.agreement?.agreed_terms ?? null,
        terms_digest: result.agreement?.terms_digest ?? null,
        merchant_identity_ref: `merchant:${result.catalogAgentId}`,
      },
      origin: "model",
      idempotency_key: `${eventKey}:selected`,
    });
    store.updateConsultationLink(link.link_id, { status: "closed" });
    store.appendEvent(
      a.task_id,
      "a2a_negotiated",
      {
        ok: true,
        negotiation_id: result.negotiationId,
        catalog_agent_id: result.catalogAgentId,
        agent_card_url: result.agentCardUrl,
        merchant_name: facts?.merchantName ?? null,
        sku: facts?.sku ?? sku,
        quantity: facts?.quantity ?? intent.quantity ?? 1,
        offer_price_minor: facts?.offerPriceMinor ?? null,
        deal_price_minor: facts?.dealPriceMinor ?? null,
        delivery_before: facts?.deliveryBefore ?? null,
        agreement_id: result.agreement?.agreement_id ?? null,
        steps: result.steps,
        boundary: "非绑定协议 — 不创建订单、不锁库存、不授权支付",
      },
      "model",
      eventKey,
    );
    await deps.recordNegotiation?.({
      negotiationId: result.negotiationId,
      catalogAgentId: result.catalogAgentId,
      sku: facts?.sku ?? sku,
      quantity: facts?.quantity ?? intent.quantity ?? 1,
      offerPriceMinor: facts?.offerPriceMinor,
      dealPriceMinor: facts?.dealPriceMinor,
      agreementId:
        typeof result.agreement?.agreement_id === "string"
          ? result.agreement.agreement_id
          : undefined,
    }).catch(() => undefined); // 记忆尽力而为，失败不阻塞任务推进
    return {
      ok: true,
      task_id: a.task_id,
      status: "selected_nonbinding",
      link_id: link.link_id,
      negotiation_id: result.negotiationId,
      catalog_agent_id: result.catalogAgentId,
      agreement_id: result.agreement?.agreement_id ?? null,
      facts,
      summary: summarizeNegotiation(result),
    };
  } catch (err) {
    // 磋商已成功但本地持久化冲突（如调度器并发推进任务）：协议在 ledger 里
    // 仍有效，任务状态不动。绝不把异常抛出 execute（会卡死已 approved 候选）。
    store.appendEvent(
      a.task_id,
      "a2a_negotiated",
      {
        ok: false,
        phase: "post-negotiation-persist",
        negotiation_id: result.negotiationId,
        error: err instanceof Error ? err.message : String(err),
      },
      "model",
      `${eventKey}:persist-fail`,
    );
    return {
      ok: false,
      task_id: a.task_id,
      negotiation_id: result.negotiationId,
      error: `磋商已完成但任务状态写入失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Preconditions for a consultation start: task + candidate state (§16). */
function consultationPreconditions(
  store: BuyerTaskStore,
  taskId: string,
  candidateId: string,
): Record<string, unknown> {
  const task = store.getTask(taskId);
  const candidate = store.getCandidate(candidateId);
  return {
    task_status: task?.status ?? null,
    task_version: task?.version ?? null,
    candidate_status: candidate?.candidate_status ?? null,
  };
}

/**
 * Execution of an approved consultation start: create the authoritative
 * Marketplace Conversation via the connector, link the task to it, and
 * transition the task to `consulting` (§11.8/§20-C).
 */
async function executeStartConsultation(
  deps: BuyerToolDeps,
  args: Record<string, unknown>,
): Promise<{ link_id: string; conversation_id: string; status: string }> {
  const { store, connector } = deps;
  const a = args as {
    task_id: string;
    candidate_id: string;
    message: string;
    sku: string;
    merchant_id: string;
  };
  const task = store.getTask(a.task_id);
  if (task === undefined) throw new BuyerTaskError("not_found", `no task ${a.task_id}`);
  if (task.status !== "awaiting_user") {
    throw new BuyerTaskError(
      "illegal_transition",
      `task ${a.task_id} is ${task.status}; 发起咨询要求 awaiting_user`,
    );
  }
  const conv = await connector.startConsultation({
    buyer_id: deps.profile.owner_id,
    sku: a.sku,
    merchant_id: a.merchant_id,
    opening_message: a.message,
  });
  const link: ConsultationLink = store.createConsultationLink({
    task_id: a.task_id,
    candidate_id: a.candidate_id,
    connector_id: connector.connector_id,
    conversation_id: conv.conversation_id,
    idempotency_key: `consult:${a.task_id}:${a.candidate_id}:${conv.conversation_id}`,
  });
  store.transitionTask({
    task_id: a.task_id,
    to: "consulting",
    expected_version: task.version,
    event_type: "status_changed",
    payload: { conversation_id: conv.conversation_id, link_id: link.link_id },
    origin: "model",
    idempotency_key: `consult-transition:${a.task_id}:${conv.conversation_id}`,
  });
  return { link_id: link.link_id, conversation_id: conv.conversation_id, status: conv.status };
}

/** Buyer-side consultation link update after a negotiation decision settles. */
function updateLinkAfterSettle(
  store: BuyerTaskStore,
  info: { conversation_id: string; result: { result: string; next_actor: string } },
): void {
  const link = store.linkByConversation(info.conversation_id);
  if (link === undefined) return;
  if (info.result.result === "human_required") {
    store.updateConsultationLink(link.link_id, { status: "consulting" });
    return;
  }
  // Only an ACCEPTED decision advances the link: a rejected_retryable (local
  // or gateway rejection) sent no message and the conversation did not move,
  // so the link must stay consulting instead of claiming "negotiating".
  if (info.result.result === "accepted") {
    const status = info.result.next_actor === "none" ? "closed" : "negotiating";
    store.updateConsultationLink(link.link_id, { status });
  }
}

export function buildBuyerTools(deps: BuyerToolDeps): Tool[] {
  const { store, connector, now, profile } = deps;

  const searchProducts: Tool = {
    name: "search_products",
    label: "搜索商品",
    description: "在 Commerce 平台搜索商品（只读事实，含价格/库存/商家公开信息）。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        city: { type: "string" },
        area: { type: "string" },
        max_price: { type: "number" },
        include_out_of_stock: { type: "boolean" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const p = params as Record<string, unknown>;
        const products = await connector.searchProducts({
          ...(typeof p.query === "string" ? { query: p.query } : {}),
          ...(typeof p.city === "string" ? { city: p.city } : {}),
          ...(typeof p.area === "string" ? { area: p.area } : {}),
          ...(typeof p.max_price === "number" ? { max_price: p.max_price } : {}),
          include_out_of_stock: p.include_out_of_stock === true,
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        });
        const rows = products.map((prod) => ({
          sku: prod.sku,
          title: prod.title,
          price: prod.price,
          currency: prod.currency,
          delivery_fee: prod.delivery.fee,
          eta_minutes: prod.delivery.eta_minutes,
          stock: prod.stock,
          merchant: prod.merchant.name,
          city: prod.merchant.city,
        }));
        return textResult(JSON.stringify(rows), { count: rows.length });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const getProduct: Tool = {
    name: "get_product",
    label: "读取商品",
    description: "按 SKU 读取单个商品的最新公开事实。",
    parameters: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const { sku } = params as { sku: string };
        const p = await connector.getProduct(sku);
        return textResult(JSON.stringify(p));
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const listTasks: Tool = {
    name: "list_buyer_tasks",
    label: "列出任务",
    description: "列出当前进行中的 Buyer 任务（搜索、跟踪、待选择）。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const tasks = store.listTasks();
      if (tasks.length === 0) return textResult("当前没有进行中的任务。");
      return textResult(
        tasks
          .map(
            (t) =>
              `· ${t.task_id} [${t.status}] ${t.goal_text}${t.next_run_at !== undefined ? `（下次唤醒 ${t.next_run_at}）` : ""}`,
          )
          .join("\n"),
      );
    },
  };

  const getTask: Tool = {
    name: "get_buyer_task",
    label: "任务详情",
    description: "查看一个 Buyer 任务的状态、候选、评分解释和最近事件。",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const { task_id: taskId } = params as { task_id: string };
        const task = store.getTask(taskId);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${taskId}`);
        const candidates = store
          .listCandidates(taskId)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        // 失败必须可见：tracking 可能是"等条件满足"，也可能是"搜索一直在失败"。
        // 把最近一次 connector_retry 的原因和下次唤醒时间暴露给模型，避免把
        // 重试等待误报为"网络错误已经过去"。
        const retries = store.taskEvents(taskId).filter((e) => e.type === "connector_retry");
        const lastRetry = retries.at(-1);
        const nextWake =
          task.next_run_at !== undefined ? `；下次唤醒 ${task.next_run_at}` : "";
        const lastError =
          lastRetry !== undefined && typeof lastRetry.payload.error === "string"
            ? `；上次搜索失败：${String(lastRetry.payload.error)}`
            : "";
        const lines = [
          `${task.task_id} [${task.status}] ${task.goal_text}${nextWake}${lastError}`,
          `意图: ${JSON.stringify(task.intent)}`,
          `约束: ${JSON.stringify(redactConstraints(task.constraints))}`,
          ...candidates.map((c) => {
            const reasons =
              c.rejection_reasons.length > 0 ? ` 排除: ${c.rejection_reasons.join(";")}` : "";
            return `· ${c.candidate_id} [${c.candidate_status}/${c.eligibility}] ${c.sku ?? c.external_product_id} score=${c.score?.toFixed(3) ?? "-"}${c.merchant_name !== undefined ? ` merchant=${c.merchant_name}` : ""}${c.owner_agent_id !== undefined ? ` owner=${c.owner_agent_id}` : ""}${reasons}`;
          }),
        ];
        // 磋商链接（marketplace 或 A2A 直连）——磋商结果对模型可见。
        const links = store.linksForTask(taskId);
        if (links.length > 0) {
          lines.push(
            "磋商:",
            ...links.map((l) => `· ${l.conversation_id} [${l.connector_id}/${l.status}]`),
          );
        }
        // 最近一次成功的 A2A 磋商商业要点（报价/条件价/协议 id）——模型和操作者
        // 都要能看到成交数字，而不是只能看到"已达成协议"。
        const negotiated = store
          .taskEvents(taskId)
          .filter((e) => e.type === "a2a_negotiated" && e.payload.ok === true)
          .at(-1);
        if (negotiated !== undefined) {
          const p = negotiated.payload as Record<string, unknown>;
          const fmt = (minor: unknown): string =>
            typeof minor === "number" && Number.isFinite(minor)
              ? (minor / 100).toFixed(2)
              : "?";
          const sku = typeof p.sku === "string" ? p.sku : "?";
          const qty = typeof p.quantity === "number" ? String(p.quantity) : "?";
          const agreement = typeof p.agreement_id === "string" ? p.agreement_id : "?";
          lines.push(
            `最近磋商: ${String(p.negotiation_id ?? "?")} 商家 ${String(p.merchant_name ?? p.catalog_agent_id ?? "?")} ` +
              `${qty} 件 ${sku} 报价 ${fmt(p.offer_price_minor)} 元/件，` +
              `条件价 ${fmt(p.deal_price_minor)} 元/件，agreement ${agreement}（非绑定）`,
          );
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const createTask: Tool = {
    name: "create_buyer_task",
    label: "创建购买任务",
    description:
      "把用户的购买需求创建成 Buyer 任务。意图足够明确（有品类或关键词）会立即执行一轮搜索；" +
      "关键信息缺失（品类/用途不明）时进入 clarifying，先向用户追问。私有预算会自动加密保存，" +
      "绝不在任务输出、回复或任何地方回显预算数值。",
    parameters: {
      type: "object",
      properties: {
        goal_text: { type: "string", description: "用户原始目标的简洁表达" },
        intent: { type: "object", description: "结构化意图（category/query_text/city/needed_by/quantity/target_unit_price 等；target_unit_price = 砍价目标单价）" },
        constraints: {
          type: "object",
          description: "硬约束（max_total_price 私有预算/latest_eta/required_terms/exclude_out_of_stock）",
        },
        run_search: { type: "boolean", description: "意图足够时是否立即搜索（默认 true）" },
        expires_at: { type: "string", description: "RFC3339；任务到期自动失效（可选）" },
      },
      required: ["goal_text", "intent"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const guard = manualAdvice(deps.mode);
      if (!guard.ok) return textResult(guard.reason);
      try {
        const p = params as Record<string, unknown>;
        const goalText = String(p.goal_text ?? "");
        const intent = parseIntent(p.intent);
        const constraints = parseConstraints(p.constraints);
        const expiresAt = typeof p.expires_at === "string" ? p.expires_at : undefined;
        const task = store.createTask({
          goal_text: goalText,
          intent,
          constraints,
          ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
          // Content-addressed: a model retry with the same args replays the
          // existing task instead of creating a duplicate.
          idempotency_key: `create:${createHash("sha256")
            .update(
              JSON.stringify({ goal_text: goalText, intent, constraints, expires_at: expiresAt ?? null }),
            )
            .digest("hex")
            .slice(0, 16)}`,
        });
        if (task.status !== "draft") {
          // Content-addressed replay: this exact create already ran — the task
          // exists and progressed. Short-circuit instead of re-transitioning.
          return textResult(`任务 ${task.task_id} 已存在（${task.status}）。`, {
            task_id: task.task_id,
            status: task.status,
          });
        }
        // Clarifying gate (§12.1): no category AND no query text => ask first.
        const needsClarification =
          (intent.category === undefined || intent.category === "") &&
          (intent.query_text === undefined || intent.query_text === "");
        if (needsClarification) {
          store.transitionTask({
            task_id: task.task_id,
            to: "clarifying",
            expected_version: task.version,
            event_type: "clarified",
            origin: "model",
            idempotency_key: `${task.task_id}:clarifying`,
          });
          return textResult(
            `任务 ${task.task_id} 已创建（clarifying）。关键信息不足，请先向用户澄清品类/用途或关键词。`,
            { task_id: task.task_id, status: "clarifying" },
          );
        }
        let current = store.transitionTask({
          task_id: task.task_id,
          to: "ready",
          expected_version: task.version,
          event_type: "status_changed",
          origin: "model",
          idempotency_key: `${task.task_id}:ready`,
        });
        if (p.run_search === false) {
          return textResult(`任务 ${task.task_id} 已就绪（ready）。`, {
            task_id: task.task_id,
            status: "ready",
          });
        }
        const cycle = await runSearchCycle(
          {
            store,
            connector,
            now,
            // CD #28：配置 catalog 时任务搜索优先走 catalog listings。
            ...(deps.catalogSource !== undefined ? { catalogSource: deps.catalogSource } : {}),
          },
          task.task_id,
          `tool:${uuidv7()}`,
        );
        current = cycle.task;
        if (cycle.outcome === "shortlist_ready") {
          const lines = cycle.shortlist.map(({ candidate }) => {
            const top = candidate.score_explanation?.dimensions
              .slice()
              .sort((a, b) => b.weight * b.score - a.weight * a.score)[0];
            return `· ${candidate.candidate_id} ${candidate.sku}（${(candidate.score ?? 0).toFixed(2)}）${candidate.merchant_name !== undefined ? ` merchant=${candidate.merchant_name}` : ""}${candidate.owner_agent_id !== undefined ? ` owner=${candidate.owner_agent_id}` : ""}${top !== undefined ? ` 主要加分: ${top.dimension} ${top.note}` : ""}`;
          });
          return textResult(
            `搜索完成，${cycle.shortlist.length} 个候选待你选择：\n${lines.join("\n")}\n` +
              `用 select_product_nonbinding 可形成非绑定选定（不是下单）；` +
              `catalog 候选可先 negotiate_buyer_task 与 owner Agent 磋商。`,
            { task_id: task.task_id, status: current.status },
          );
        }
        if (cycle.outcome === "tracking") {
          return textResult(
            `暂无满足条件的候选，已转入跟踪（${task.task_id}），条件满足时会通知你。`,
            { task_id: task.task_id, status: current.status },
          );
        }
        if (cycle.outcome === "retry") {
          return textResult(
            `搜索遇到临时错误，已安排自动重试（${task.task_id}）。错误：${cycle.error ?? "未知"}`,
            { task_id: task.task_id, status: current.status },
          );
        }
        return textResult(`搜索失败：${cycle.error ?? "未知错误"}（任务已标记 failed）。`, {
          task_id: task.task_id,
          status: current.status,
        });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const updateConstraints: Tool = {
    name: "update_buyer_task_constraints",
    label: "调整任务约束",
    description: "调整任务的硬约束（预算、交期等）；awaiting_user 中的任务会立即重新搜索。",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        constraints: { type: "object" },
      },
      required: ["task_id", "constraints"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const guard = manualAdvice(deps.mode);
      if (!guard.ok) return textResult(guard.reason);
      try {
        const p = params as { task_id: string; constraints: unknown };
        const task = store.getTask(p.task_id);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
        const updated = store.updateTask(
          p.task_id,
          { constraints: parseConstraints(p.constraints) },
          task.version,
          `update-constraints:${uuidv7()}`,
        );
        if (updated.status === "awaiting_user") {
          const searching = store.transitionTask({
            task_id: updated.task_id,
            to: "searching",
            expected_version: updated.version,
            event_type: "search_started",
            origin: "user",
            idempotency_key: `${updated.task_id}:re-search:${uuidv7()}`,
          });
          const cycle = await runSearchCycle(
            {
              store,
              connector,
              now,
              ...(deps.catalogSource !== undefined ? { catalogSource: deps.catalogSource } : {}),
            },
            searching.task_id,
            `tool:${uuidv7()}`,
          );
          return textResult(`约束已更新并重新搜索（结果：${cycle.outcome}）。`);
        }
        return textResult(`约束已更新（任务 ${updated.task_id}，当前 ${updated.status}），下次搜索生效。`);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const addRule: Tool = {
    name: "add_tracking_rule",
    label: "添加跟踪规则",
    description: "为任务或单个候选添加跟踪规则（降价、到货、促销变化、交期、定时复查）。",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        candidate_id: { type: "string" },
        rule_type: {
          type: "string",
          enum: ["price_below", "stock_available", "delivery_before", "new_candidate", "periodic_review"],
        },
        condition: { type: "object", description: "如 {threshold: 90} 或 {eta_before: RFC3339}" },
        interval_seconds: { type: "integer" },
        cooldown_seconds: { type: "integer" },
      },
      required: ["task_id", "rule_type", "condition", "interval_seconds"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const guard = manualAdvice(deps.mode);
      if (!guard.ok) return textResult(guard.reason);
      try {
        const p = params as Record<string, unknown>;
        const rule = store.addTrackingRule({
          task_id: String(p.task_id),
          ...(typeof p.candidate_id === "string" ? { candidate_id: p.candidate_id } : {}),
          rule_type: p.rule_type as never,
          condition: (p.condition ?? {}) as Record<string, unknown>,
          interval_seconds: Number(p.interval_seconds),
          ...(typeof p.cooldown_seconds === "number"
            ? { cooldown_seconds: p.cooldown_seconds }
            : {}),
          idempotency_key: `rule:${uuidv7()}`,
        });
        return textResult(
          `跟踪规则已安装（${rule.rule_id}，每 ${rule.interval_seconds}s 检查）。`,
          { rule_id: rule.rule_id },
        );
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const pauseRule: Tool = {
    name: "pause_tracking_rule",
    label: "暂停跟踪规则",
    description: "暂停一条跟踪规则。",
    parameters: {
      type: "object",
      properties: { rule_id: { type: "string" } },
      required: ["rule_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const guard = manualAdvice(deps.mode);
      if (!guard.ok) return textResult(guard.reason);
      try {
        const rule = store.pauseRule(String((params as { rule_id: string }).rule_id));
        return textResult(`规则 ${rule.rule_id} 已暂停。`);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const cancelTask: Tool = {
    name: "cancel_buyer_task",
    label: "取消任务",
    description: "取消一个 Buyer 任务（仅 draft/clarifying/awaiting_user 可取消）。",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const guard = manualAdvice(deps.mode);
      if (!guard.ok) return textResult(guard.reason);
      try {
        const p = params as { task_id: string };
        const task = store.getTask(p.task_id);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
        store.transitionTask({
          task_id: p.task_id,
          to: "cancelled",
          expected_version: task.version,
          event_type: "cancelled",
          origin: "user",
          idempotency_key: `cancel:${uuidv7()}`,
        });
        return textResult(`任务 ${p.task_id} 已取消。`);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const selectNonbinding: Tool = {
    name: "select_product_nonbinding",
    label: "非绑定选定",
    description:
      "用户明确选定某个候选时记录非绑定选定结果（§12.4：不是下单，不声明价格/库存仍有效）。" +
      "选定是本地非绑定标记，直接执行、无需审批；任务在 awaiting_user（或已选定想再谈价回 consulting 后）时调用。",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        candidate_id: { type: "string" },
        user_instruction: { type: "string", description: "用户选定指令原文（授权依据）" },
      },
      required: ["task_id", "candidate_id", "user_instruction"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const guard = manualAdvice(deps.mode);
      if (!guard.ok) return textResult(guard.reason);
      try {
        const p = params as { task_id: string; candidate_id: string; user_instruction: string };
        // 选定是本地非绑定标记（不是订单、不对外写）——无需审批，直接执行。
        const result = executeSelection(store, now, {
          task_id: p.task_id,
          candidate_id: p.candidate_id,
          user_instruction: p.user_instruction,
        });
        return textResult(
          `已记录非绑定选定（${result.candidate_id}）。这不是订单；价格、库存或交期以当时观察 ${result.observation_id ?? "-"} 为准，可能已变化。`,
          result,
        );
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const startConsultation: Tool = {
    name: "start_consultation",
    label: "发起咨询",
    description:
      "把 Buyer 任务与一个 Marketplace Conversation 关联并发起咨询（§11.8/§20-C）。" +
      "不复制权威会话状态；磋商继续由现有磋商运行时处理。写操作，supervised 模式需 /approve 批准。" +
      "任务必须处于 awaiting_user 且候选在 shortlist 中。",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        candidate_id: { type: "string" },
        message: { type: "string", description: "发给商家的咨询消息" },
      },
      required: ["task_id", "candidate_id", "message"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      if (deps.approvals === undefined || deps.broker === undefined || deps.mode === undefined) {
        return textResult("当前环境未配置咨询能力（缺少审批存储或磋商凭据），无法发起咨询。");
      }
      const credential = requireScopeCredential(deps.broker, "negotiation");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const p = params as { task_id: string; candidate_id: string; message: string };
        const task = store.getTask(p.task_id);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
        if (task.status !== "awaiting_user") {
          throw new BuyerTaskError(
            "illegal_transition",
            `task ${p.task_id} is ${task.status}; 发起咨询要求 awaiting_user`,
          );
        }
        const candidate = store.getCandidate(p.candidate_id);
        if (candidate === undefined || candidate.task_id !== p.task_id) {
          throw new BuyerTaskError("not_found", `no candidate ${p.candidate_id} in task`);
        }
        if (candidate.candidate_status !== "shortlisted") {
          throw new BuyerTaskError(
            "validation",
            `candidate ${p.candidate_id} is ${candidate.candidate_status}, not shortlisted`,
          );
        }
        const args = {
          task_id: p.task_id,
          candidate_id: p.candidate_id,
          message: p.message,
          sku: candidate.sku ?? candidate.external_product_id,
          merchant_id: candidate.merchant_id ?? "",
        };
        const outcome = await routeWriteCandidate(
          {
            mode: deps.mode,
            approvals: deps.approvals,
            profile,
            now,
            registerPending: deps.registerPending,
          },
          {
            tool: "start_consultation",
            arguments: args,
            preconditions: consultationPreconditions(store, p.task_id, p.candidate_id),
            risk: "send_consultation",
            execute: (approvedArgs) => executeStartConsultation(deps, approvedArgs),
            readPreconditions: () =>
              consultationPreconditions(store, p.task_id, p.candidate_id),
            autopilotEscalation: () => {
              if (profile.buyer_policy?.auto_negotiate === false) {
                return "buyer 未授权自动咨询（auto_negotiate=false），需要人工确认。";
              }
              return undefined;
            },
          },
        );
        if (outcome.kind === "pending_approval") {
          store.appendEvent(
            p.task_id,
            "approval_requested",
            { candidate_id: outcome.candidate.candidate_id, tool: "start_consultation" },
            "model",
            `approval:${outcome.candidate.candidate_id}`,
          );
        }
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const negotiateBuyerTask: Tool = {
    name: "negotiate_buyer_task",
    label: "本地 A2A 磋商",
    description:
      "用 Buyer 任务的意图直接与商家进行本地 A2A 磋商：经 agent catalog 发现商家，" +
      "与商家的 A2A 节点跑确定性 KNP 磋商（RFQ→offer→counter→conditional→accept）。" +
      "不依赖 marketplace API；商家报价仍来自其自身商品库（折扣/底价在商家侧）。" +
      "SKU/数量/目标单价/交期取自任务 intent（category 或 query_text 视为 SKU）。" +
      "结果是非绑定协议（不创建订单、不锁库存、不授权支付）。写操作：supervised 模式" +
      "需 /approve 批准后才真正发送消息；任务须处于 ready/tracking/shortlist_ready/awaiting_user。" +
      "达成协议后任务进入 selected_nonbinding。",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        catalog_agent_id: {
          type: "string",
          description: "目标商家 catalog_agent_id（可选；缺省取第一个可发现商家）",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      if (deps.approvals === undefined || deps.mode === undefined) {
        return textResult("当前环境未配置磋商能力（缺少审批存储），无法发起 A2A 磋商。");
      }
      try {
        const p = params as { task_id: string; catalog_agent_id?: string };
        const task = store.getTask(p.task_id);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
        if (!NEGOTIABLE_TASK_STATUSES.has(task.status)) {
          return textResult(
            `任务 ${p.task_id} 当前状态 ${task.status} 不可直接磋商；` +
              `可直接磋商的状态：${[...NEGOTIABLE_TASK_STATUSES].join("/")}。`,
          );
        }
        if (deps.catalog === undefined) {
          return textResult("未配置 agent catalog（KIWI_CATALOG_URL 或 --catalog），无法发现商家。");
        }
        const args = {
          task_id: p.task_id,
          ...(p.catalog_agent_id !== undefined && p.catalog_agent_id !== ""
            ? { catalog_agent_id: p.catalog_agent_id }
            : {}),
        };
        const outcome = await routeWriteCandidate(
          { mode: deps.mode, approvals: deps.approvals, profile, now, registerPending: deps.registerPending },
          {
            tool: "negotiate_buyer_task",
            arguments: args,
            preconditions: negotiationPreconditions(store, true, p.task_id),
            risk: "send_negotiation_message",
            execute: (approvedArgs) => executeNegotiateBuyerTask(deps, approvedArgs),
            readPreconditions: () => negotiationPreconditions(store, deps.catalog !== undefined, p.task_id),
            autopilotEscalation: () =>
              profile.buyer_policy?.auto_negotiate === false
                ? "buyer 未授权自动磋商（auto_negotiate=false），需要人工确认。"
                : undefined,
          },
        );
        if (outcome.kind === "pending_approval") {
          store.appendEvent(
            p.task_id,
            "approval_requested",
            { candidate_id: outcome.candidate.candidate_id, tool: "negotiate_buyer_task" },
            "model",
            `approval:${outcome.candidate.candidate_id}`,
          );
        }
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const negotiationTools =
    deps.commerceClient !== undefined &&
    deps.broker !== undefined &&
    deps.approvals !== undefined &&
    deps.mode !== undefined
      ? buildNegotiationChatTools({
          profile,
          commerceClient: deps.commerceClient,
          broker: deps.broker,
          approvals: deps.approvals,
          mode: deps.mode,
          now,
          registerPending: deps.registerPending,
          afterSettle: (info) => updateLinkAfterSettle(store, info),
        })
      : [];

const handoffAgreement: Tool = {
  name: "handoff_agreement",
  label: "非绑定协议交接",
  description:
    "把已谈妥的非绑定协议（selected_nonbinding 任务）交接给真实成交入口（KTH/0.1）。" +
    "目的地**只取商家在协议里直传的成交入口**（merchant 从 shopping-cli 读的 handoff_destination），" +
    "不允许 LLM 自编、也不读 catalog 投影——协议未带成交入口则拒绝交接。" +
    "经审批门（supervised 需 /approve）后执行：重验 agreement/terms/destination/expiry，" +
    "安全交付到 external checkout URL。不创建订单、不授权支付、不预留库存。",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "已达成非绑定协议（selected_nonbinding）的 buyer 任务" },
      display_summary_merchant: { type: "string", description: "展示用商家名（缺省取协议商家）" },
      display_summary_text: { type: "string", description: "展示用摘要（如“200 units, CNY 8999.00/unit”）" },
      expires_in_hours: { type: "number", description: "候选有效期（小时，缺省 24）" },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  execute: async (_id, params) => {
    const handoff = deps.handoff;
    if (handoff === undefined) {
      return textResult("未配置 Handoff 能力（kernel 未注入 handoff 存储）。");
    }
    if (deps.approvals === undefined || deps.mode === undefined) {
      return textResult("当前环境未配置审批存储，无法发起 Handoff 交接。");
    }
    try {
      const p = params as {
        task_id: string;
        display_summary_merchant?: string;
        display_summary_text?: string;
        expires_in_hours?: number;
      };
      const task = deps.store.getTask(p.task_id);
      if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
      if (task.status !== "selected_nonbinding") {
        return textResult(
          `任务 ${p.task_id} 当前状态 ${task.status}；handoff 需要先达成非绑定协议（selected_nonbinding）。`,
        );
      }
      const agreement = agreementFromTask(deps.store.taskEvents(p.task_id));
      if (agreement === undefined) {
        return textResult("任务记录缺少 agreement 快照（磋商未完成或 terms 未持久化）。");
      }
      // 成交入口**只取商家在协议里直传的** handoff_destination——不经 catalog、
      // 不允许 LLM 现编。协议未携带则拒绝交接（fail-closed）。
      const agreementDestination = agreementDestinationFromTerms(agreement.agreed_terms);
      if (agreementDestination === undefined) {
        return textResult("商家未在协议中声明成交入口（handoff_destination），无法交接。");
      }
      const destination = validateDestination(agreementDestination);
      // 协议级去重：同一磋商、同一目的地已交付过 → 拒绝（LLM 重试会生成
      // 新候选 → 新 digest，绕过 (candidate_id, digest) 幂等键，导致同协议
      // 二次交付/二次 URL 探测、negotiation_to_handoff_rate 虚高）。
      const priorDelivery = handoff.ledger.events(agreement.negotiation_id).find(
        (e) =>
          e.event_kind === "handoff_delivered" &&
          (e.destination as { ref?: unknown } | undefined)?.ref === destination.ref &&
          (e.destination as { type?: unknown } | undefined)?.type === destination.type,
      );
      if (priorDelivery !== undefined) {
        return textResult(
          `该协议已交付过（handoff ${priorDelivery.handoff_id ?? "unknown"}，` +
            `目的地 ${destination.type} ${destination.ref}），同一目的地不重复交接。`,
        );
      }
      // NaN 防护：非数字 expires_in_hours → Date.now()+NaN 抛 RangeError。
      const expiresInHours = Number(p.expires_in_hours ?? 24);
      if (!Number.isFinite(expiresInHours) || expiresInHours <= 0) {
        return textResult("expires_in_hours 必须是正数（小时）。");
      }
      // 审计链：stale 候选之后的新候选链接到被它取代的候选
      //（supersedes_candidate_id；此前从不写入，stale 后的新候选是审计孤儿）。
      const lastStale = [...handoff.ledger.events(agreement.negotiation_id)]
        .reverse()
        .find((e) => e.event_kind === "handoff_candidate_stale");
      const candidate = createHandoffCandidate({
        agreement_id: agreement.agreement_id,
        negotiation_id: agreement.negotiation_id,
        agreed_terms: agreement.agreed_terms,
        buyer_identity_ref: `principal:${profile.agent_id}`,
        merchant_identity_ref: agreement.merchant_identity_ref,
        destination: { type: destination.type, ref: destination.ref },
        display_summary: {
          merchant: p.display_summary_merchant ?? agreement.merchant_identity_ref,
          summary: p.display_summary_text ?? `negotiation ${agreement.negotiation_id}`,
        },
        policy_version: "handoff-policy/1",
        // 时钟统一用注入的 deps.now()（此前 created_at 走墙钟、事件走注入时钟，
        // time_to_handoff 指标掺入偏差）。
        created_at: deps.now(),
        expires_at: new Date(Date.parse(deps.now()) + expiresInHours * 3_600_000).toISOString(),
        ...(lastStale?.handoff_candidate_id !== undefined
          ? { supersedes_candidate_id: lastStale.handoff_candidate_id }
          : {}),
        requires_user_action: true,
      });
      const outcome = await routeWriteCandidate(
        { mode: deps.mode, approvals: deps.approvals, profile, now: deps.now, registerPending: deps.registerPending },
        {
          tool: "handoff_agreement",
          arguments: { task_id: p.task_id, candidate },
          preconditions: { agreement_bound: true },
          risk: "handoff_delivery",
          execute: (approvedArgs) => executeHandoffForCandidate(deps, approvedArgs),
          // §16 stale 检测的真实重读：approval 与执行之间协议被重磋商改写
          //（agreement 消失 / 身份变化 / terms_digest 不匹配）→ 候选 supersede。
          // 此前恒返回 {agreement_bound: true}，write-gate 的 stale 检测对
          // handoff 结构性失效（防护只剩 executeHandoff 执行期重验）。
          readPreconditions: () => {
            const current = agreementFromTask(deps.store.taskEvents(p.task_id));
            const stillBound =
              current !== undefined &&
              current.agreement_id === agreement.agreement_id &&
              current.negotiation_id === agreement.negotiation_id &&
              contentDigest(current.agreed_terms) === candidate.terms_digest;
            return { agreement_bound: stillBound };
          },
          // autopilot 政策闸：handoff 把买家送向真实成交入口（外部结账/PO/联系
          // 商家），是系统里最接近交易的写动作——未授权自动磋商时绝不自动执行。
          autopilotEscalation: () =>
            profile.buyer_policy?.auto_negotiate === false
              ? "buyer 未授权自动交接（auto_negotiate=false），需要人工确认。"
              : undefined,
        },
      );
      return writeGateText(outcome);
    } catch (err) {
      return textResult(errorText(err));
    }
  },
};

  const searchListings: Tool = {
    name: "search_listings",
    label: "搜索商品/能力 Listing",
    description:
      "在 kiwi-catalog 按商品/能力意图搜索 Listing（rev1.5 CD #27）。返回 discovery " +
      "projection（authority=discovery_projection、requires_direct_confirmation=true）：" +
      "报价/库存必须联系 owner Agent 确认。",
    parameters: {
      type: "object",
      properties: {
        need_description: { type: "string", description: "需求描述（q）" },
        category: { type: "string" },
        region: { type: "string" },
        listing_type: { type: "string", enum: ["product", "capability"] },
        min_moq: { type: "integer" },
        max_moq: { type: "integer" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const source = deps.catalogSource;
      if (source === undefined) {
        return textResult(errorText(new Error("kiwi-catalog listing 源未配置（工具不应被挂载）")));
      }
      try {
        const p = params as Record<string, unknown>;
        const results = await source.searchListings({
          ...(typeof p.need_description === "string" ? { q: p.need_description } : {}),
          ...(typeof p.category === "string" ? { category: p.category } : {}),
          ...(typeof p.region === "string" ? { region: p.region } : {}),
          ...(p.listing_type === "product" || p.listing_type === "capability"
            ? { listing_type: p.listing_type }
            : {}),
          ...(typeof p.min_moq === "number" ? { min_moq: p.min_moq } : {}),
          ...(typeof p.max_moq === "number" ? { max_moq: p.max_moq } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        });
        const rows = results.map((r) => ({
          listing_id: r.listing.listing_id,
          listing_type: r.listing.listing_type,
          title: r.listing.title,
          category: r.listing.category,
          merchant: r.merchant.display_name,
          owner_agent_id: r.agent.catalog_agent_id,
          owner_verification: r.agent.verification_level,
          commercial_hints: r.listing.commercial_hints ?? {},
          listing_freshness_state: r.listing.listing_freshness_state,
          authority: r.authority,
          requires_direct_confirmation: r.requires_direct_confirmation,
          // 商家声明的每商品成交入口透出（P3-11）：shortlist_listing /
          // handoff_agreement 优先用商家声明，不用 LLM 现编目的地。有值才输出。
          ...(r.listing.handoff_destination_types !== undefined
            ? { handoff_destination_types: r.listing.handoff_destination_types }
            : {}),
          ...(r.listing.handoff_destination_ref !== undefined
            ? { handoff_destination_ref: r.listing.handoff_destination_ref }
            : {}),
        }));
        return textResult(JSON.stringify(rows), { count: rows.length });
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const shortlistListing: Tool = {
    name: "shortlist_listing",
    label: "入选 Listing",
    description:
      "把一个 Listing 写入任务候选并标记 shortlisted（供 negotiate_buyer_task 使用）。" +
      "Listing 是 discovery projection，真正询价时传 owner_agent_id 给 negotiate_buyer_task。",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        listing_id: { type: "string" },
        owner_agent_id: { type: "string" },
        title: { type: "string" },
        sku: { type: "string" },
        handoff_destination_types: {
          type: "array",
          items: { type: "string" },
          description: "商家声明的 KTH destination_type（来自 listing，KTH 词表）",
        },
        handoff_destination_ref: {
          type: "string",
          description: "商家声明的每商品成交入口（listing handoff_destination_ref；URL 类为 https URL，联系/会话类为 opaque ref）",
        },
        merchant_name: {
          type: "string",
          description: "商家显示名（listing.merchant.display_name）——沟通用名字而非 catalog_agent_id",
        },
      },
      required: ["task_id", "listing_id", "owner_agent_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      try {
        const p = params as {
          task_id: string;
          listing_id: string;
          owner_agent_id: string;
          title?: string;
          sku?: string;
          handoff_destination_types?: string[];
          handoff_destination_ref?: string;
          merchant_name?: string;
        };
        const task = store.getTask(p.task_id);
        if (task === undefined) throw new BuyerTaskError("not_found", `no task ${p.task_id}`);
        const candidate = store.upsertCandidate({
          task_id: p.task_id,
          connector_id: "kiwi-catalog",
          platform: "kiwi-catalog",
          external_product_id: p.listing_id,
          sku: p.sku,
          ...(p.owner_agent_id !== undefined ? { owner_agent_id: p.owner_agent_id } : {}),
          ...(p.merchant_name !== undefined ? { merchant_name: p.merchant_name } : {}),
        });
        store.updateCandidate(candidate.candidate_id, {
          candidate_status: "shortlisted",
          eligibility: "eligible",
        });
        store.appendEvent(
          p.task_id,
          "candidate_shortlisted",
          {
            candidate_id: candidate.candidate_id,
            listing_id: p.listing_id,
            owner_agent_id: p.owner_agent_id,
            listing_title: p.title ?? null,
            source: "kiwi-catalog",
            // 商家声明的每商品成交入口（handoff_agreement 优先用，不现编）。
            handoff_destination_types: p.handoff_destination_types ?? null,
            handoff_destination_ref: p.handoff_destination_ref ?? null,
          },
          "model",
          `shortlist:${p.task_id}:${p.listing_id}:${uuidv7()}`,
        );
        return textResult(
          JSON.stringify({
            candidate_id: candidate.candidate_id,
            task_id: p.task_id,
            status: "shortlisted",
            owner_agent_id: p.owner_agent_id,
          }),
        );
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  // catalog-first（CD #28）：配置 catalog 时 buyer 是「catalog 发现 + A2A 磋商」
  // 形态——不挂载 legacy marketplace 工具（search_products/get_product/
  // start_consultation/磋商 chat），避免模型去查死掉的本地 marketplace 而误报
  // 网络故障。无 catalog（legacy 形态）时行为不变。
  const catalogFirst = deps.catalogSource !== undefined;
  return [
    ...(catalogFirst ? [] : [searchProducts, getProduct]),
    listTasks,
    getTask,
    createTask,
    updateConstraints,
    addRule,
    pauseRule,
    cancelTask,
    selectNonbinding,
    ...(catalogFirst ? [] : [startConsultation]),
    negotiateBuyerTask,
    ...(catalogFirst ? [searchListings, shortlistListing] : []),
    ...(deps.handoff !== undefined ? [handoffAgreement] : []),
    ...(catalogFirst ? [] : negotiationTools),
  ];
}

// ── v0.7.0 KTH：handoff_agreement ───────────────────────────────────────────

/**
 * 从任务事件流重建 agreement 快照（handoff 的 agreementReader 权威源；
 * 取最新 status_changed 事件的 payload —— negotiate 成功时落 agreed_terms）。
 */

/**
 * 从 agreement 的 agreed_terms 提取商家直传的每商品成交入口（offerTerms 带的
 * `handoff_destination`，merchant 从 shopping-cli 商品读）。https URL →
 * external_checkout_url 类型。商家直传优先于 catalog listing 声明。
 */
function agreementDestinationFromTerms(agreed_terms: unknown):
  | { type: string; ref: string }
  | undefined {
  const terms = agreed_terms as { handoff_destination?: unknown } | null | undefined;
  const ref = terms?.handoff_destination;
  if (typeof ref !== "string" || ref.trim() === "") return undefined;
  return { type: "external_checkout_url", ref: ref.trim() };
}

/**
 * 候选目的地若来自商家协议直传的 handoff_destination 且与候选一致，返回该
 * 目的地主机——供 URL 安全 allowlist 放行外部成交入口（如 item.jd.com）。
 * 只信 agreement 直传：不经 catalog、不认 LLM 现编。
 */
function declaredHandoffHost(
  agreement: { agreed_terms: unknown },
  candidate: HandoffCandidate,
): string | undefined {
  const declared = agreementDestinationFromTerms(agreement.agreed_terms);
  if (declared?.ref === undefined || declared.ref !== candidate.destination_ref) return undefined;
  try {
    return new URL(declared.ref).hostname;
  } catch {
    return undefined;
  }
}

function agreementFromTask(events: readonly TaskEvent[]): {
  agreement_id: string;
  negotiation_id: string;
  agreed_terms: unknown;
  merchant_identity_ref: string;
  /** merchant 声明域（从 a2a_negotiated 的 agent_card_url 派生；URL 安全用）。 */
  merchant_domain?: string;
} | undefined {
  let merchantDomain: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === "a2a_negotiated") {
      const cardUrl = event.payload.agent_card_url;
      // http(s) 均可（URL 安全策略对 loopback http 放行；https-only 由
      // validateExternalDestinationUrl 强制）。
      if (typeof cardUrl === "string" && /^https?:\/\//.test(cardUrl)) {
        try {
          merchantDomain = new URL(cardUrl).hostname;
        } catch {
          merchantDomain = undefined;
        }
      }
    }
    if (event.type !== "status_changed") continue;
    const payload = event.payload;
    const agreementId = payload.agreement_id;
    const negotiationId = payload.negotiation_id;
    const agreedTerms = payload.agreed_terms;
    if (
      typeof agreementId !== "string" ||
      typeof negotiationId !== "string" ||
      agreedTerms === null ||
      agreedTerms === undefined
    ) {
      continue;
    }
    return {
      agreement_id: agreementId,
      negotiation_id: negotiationId,
      agreed_terms: agreedTerms,
      merchant_identity_ref:
        typeof payload.merchant_identity_ref === "string"
          ? payload.merchant_identity_ref
          : "merchant:unknown",
      ...(merchantDomain !== undefined ? { merchant_domain: merchantDomain } : {}),
    };
  }
  return undefined;
}

function handoffResultText(result: ExecuteHandoffResult): AgentToolResult<unknown> {
  switch (result.kind) {
    case "delivered": {
      const h = result.handoff;
      return textResult(
        `交接已交付（handoff ${h.handoff_id}）：` +
          `${h.display_summary.merchant} — ${h.display_summary.summary}\n` +
          `目的地：${h.destination_type} ${h.destination_ref}${result.final_url !== undefined ? `\n最终 URL：${result.final_url}` : ""}\n` +
          `非绑定协议已安全交接；Kiwi 不创建订单/不授权支付/不预留库存。`,
        { status: "delivered", handoff_id: h.handoff_id, destination_type: h.destination_type },
      );
    }
    case "already_delivered":
      return textResult(`该协议已交付过（handoff ${result.handoff_id}），未重复执行。`, {
        status: "already_delivered",
      });
    case "stale":
      return textResult(`交接未执行：候选已失效（${result.reason}）。需重新生成候选。`, { status: "stale" });
    case "probe_failed":
      return textResult(`交接未执行：目的地探测瞬时失败（${result.reason}）。候选保持可用，可重试。`, {
        status: "probe_failed",
      });
    case "rejected":
      return textResult(`交接未执行：${result.reason}。`, { status: "rejected" });
    case "expired":
      return textResult(`交接未执行：候选已过期。`, { status: "expired" });
  }
}

/** 批准后的实际执行：agreementReader 从任务事件重读（§10 revalidation）。 */
async function executeHandoffForCandidate(
  deps: BuyerToolDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const a = args as { task_id: string; candidate: HandoffCandidate };
  const handoff = deps.handoff;
  if (handoff === undefined) {
    return { ok: false, status: "unavailable", error: "Handoff 存储未配置，无法执行交接。" };
  }
  const agreement = agreementFromTask(deps.store.taskEvents(a.task_id));
  if (agreement === undefined) {
    return { ok: false, status: "stale", error: "任务记录缺少 agreement 快照，交接中止（fail-closed）" };
  }
  // created 事件在审批通过后才落链：被 /reject 的候选不在 Ledger 留下悬空的
  // PROPOSED（此前先落链，/reject 后 /handoff 永远显示"从未获批"的候选，
  // 且 LLM 重复调用会堆积无限候选事件与审批候选）。
  handoff.ledger.appendCandidateEvent({
    kind: "handoff_candidate_created",
    candidate: a.candidate,
    identity: {
      sender_identity: a.candidate.buyer_identity_ref,
      counterparty_identity: a.candidate.merchant_identity_ref,
      actor: "buyer",
    },
    capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
    occurred_at: deps.now(),
  });
  // 成交入口若来自商家权威声明（agreement 直传 / catalog listing），URL 安全
  // 放行该外部主机（如 item.jd.com）；LLM 现编的 destination_ref 仍限制在
  // merchant 声明域（anti-phishing）。
  const declaredHost = declaredHandoffHost(agreement, a.candidate);
  const result = await executeHandoff({
    candidate: a.candidate,
    ledger: handoff.ledger,
    idempotency: handoff.idempotency,
    identity: {
      sender_identity: a.candidate.buyer_identity_ref,
      counterparty_identity: a.candidate.merchant_identity_ref,
      actor: "buyer",
    },
    capability: {
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
    },
    approval: async () => ({ approved: true, evidence: { via: "write-gate" } }),
    agreementReader: async () => ({
      agreement_id: agreement.agreement_id,
      negotiation_id: agreement.negotiation_id,
      agreed_terms: agreement.agreed_terms,
    }),
    urlSafety: defaultUrlSafety(
      agreement.merchant_domain,
      declaredHost !== undefined ? [declaredHost] : undefined,
    ),
    now: deps.now,
  });
  const rendered = handoffResultText(result);
  return {
    ok: result.kind === "delivered" || result.kind === "already_delivered",
    status: result.kind,
    text: rendered.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
  };
}
