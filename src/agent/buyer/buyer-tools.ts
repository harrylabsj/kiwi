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
import type { AgentProfile } from "../../config/profile.js";
import type { CommerceClient } from "../../commerce/types.js";
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
import type { TaskConstraints, TaskIntent } from "./types.js";
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
  const sku = intent.category ?? intent.query_text ?? NEGOTIATE_SKU;
  const result = await negotiateWithAgent({
    catalog: deps.catalog,
    ...(a.catalog_agent_id !== undefined && a.catalog_agent_id !== ""
      ? { catalogAgentId: a.catalog_agent_id }
      : {}),
    sku,
    quantity: intent.quantity ?? 1,
    dealPriceMinor:
      intent.target_unit_price !== undefined
        ? Math.round(intent.target_unit_price * 100)
        : NEGOTIATE_DEAL_PRICE_MINOR,
    deliveryBefore: intent.needed_by ?? NEGOTIATE_DELIVERY_BEFORE,
    senderIdentity: deps.profile.agent_id,
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
            return `· ${c.candidate_id} [${c.candidate_status}/${c.eligibility}] ${c.sku ?? c.external_product_id} score=${c.score?.toFixed(3) ?? "-"}${reasons}`;
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
            `最近磋商: ${String(p.negotiation_id ?? "?")} 商家 ${String(p.catalog_agent_id ?? "?")} ` +
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
          { store, connector, now },
          task.task_id,
          `tool:${uuidv7()}`,
        );
        current = cycle.task;
        if (cycle.outcome === "shortlist_ready") {
          const lines = cycle.shortlist.map(({ candidate }) => {
            const top = candidate.score_explanation?.dimensions
              .slice()
              .sort((a, b) => b.weight * b.score - a.weight * a.score)[0];
            return `· ${candidate.candidate_id} ${candidate.sku}（${(candidate.score ?? 0).toFixed(2)}）${top !== undefined ? ` 主要加分: ${top.dimension} ${top.note}` : ""}`;
          });
          return textResult(
            `搜索完成，${cycle.shortlist.length} 个候选待你选择：\n${lines.join("\n")}\n` +
              `用 select_product_nonbinding 可形成非绑定选定（不是下单）。`,
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
          const cycle = await runSearchCycle({ store, connector, now }, searching.task_id, `tool:${uuidv7()}`);
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

  return [
    searchProducts,
    getProduct,
    listTasks,
    getTask,
    createTask,
    updateConstraints,
    addRule,
    pauseRule,
    cancelTask,
    selectNonbinding,
    startConsultation,
    negotiateBuyerTask,
    ...negotiationTools,
  ];
}
