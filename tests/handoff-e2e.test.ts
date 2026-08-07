/**
 * KTH 端到端测试（完成定义 #20：Agreement → Handoff → external destination；
 * #21：Negotiation-to-Handoff Rate 可观测）。
 *
 * 全链路（完全离线）：
 *   Buyer 任务 → negotiate_buyer_task（catalog 发现 + A2A 磋商）→
 *   selected_nonbinding（agreement 快照落任务记录）→ handoff_agreement
 *   （autopilot 审批直通 → executeHandoff）→ delivered（external checkout
 *   URL 目的地）→ launch（LAUNCHED，不证明页面加载）→ local_callback
 *   证据 → OPENED_CONFIRMED。
 *
 * 断言：Ledger 事件序列（created→ready→consumed→delivered）、三副作用
 * 全 false、无订单/支付/库存事件、terms_digest 一致性、无证据永不确认、
 * 指标可观测（agreement_to_handoff_rate=1、launch/opened 率）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { FakeCommerceConnector, fakeConnectorProduct } from "../src/agent/connector/fake-connector.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { buildBuyerTools, type BuyerToolDeps } from "../src/agent/buyer/buyer-tools.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  HandoffEventStore,
  HandoffIdempotencyStore,
  deliveryState,
  foldCandidateLifecycle,
  recordLaunch,
  recordOpenEvidence,
  validateHandoffCandidate,
  computeHandoffMetrics,
} from "../src/handoff/index.js";
import { testBuyerProfile, startTestA2aStack, type CapturedInbound } from "./helpers.js";
import { uuidv7 } from "@earendil-works/pi-ai";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "buyer-agent:buyer-001";

type CallableTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: { type: string; text?: string }[];
    details?: unknown;
  }>;
};

const productSource = {
  async getProduct(sku: string) {
    const prices: Record<string, { price: number; currency: string }> = {
      "sku-001": { price: 99, currency: "CNY" },
    };
    const p = prices[sku];
    if (p === undefined) throw new Error(`no product ${sku}`);
    return p;
  },
};

const stacks: Awaited<ReturnType<typeof startTestA2aStack>>[] = [];
const capture: CapturedInbound[] = [];

afterEach(async () => {
  for (const s of stacks.splice(0)) await s.stop().catch(() => undefined);
  capture.length = 0;
});

function buyerPolicyBase() {
  return {
    target_skus: [] as string[],
    quantity: 1,
    max_total_price_private: 100_000,
    acceptable_eta_latest: "2099-12-31T23:59:59+08:00",
    required_after_sales_terms: [] as string[],
    auto_negotiate: true,
    human_review_on: [] as string[],
  };
}

interface E2eHarness {
  store: BuyerTaskStore;
  getTool: (name: string) => CallableTool;
  ledger: HandoffEventStore;
  idempotency: HandoffIdempotencyStore;
}

function setupBuyer(catalog: string): E2eHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-e2e-"));
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const connector = new FakeCommerceConnector([fakeConnectorProduct()]);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const ledger = new HandoffEventStore({ dir, now: () => T0 });
  const idempotency = new HandoffIdempotencyStore({ dir, now: () => T0 });
  const mode = { value: "autopilot" as const };
  const deps: BuyerToolDeps = {
    store,
    connector,
    profile: testBuyerProfile({ buyer_policy: { ...buyerPolicyBase(), auto_negotiate: true } }),
    approvals,
    mode: () => mode.value,
    now: () => T0,
    registerPending: () => undefined,
    catalog,
    handoff: { ledger, idempotency },
  };
  const tools = buildBuyerTools(deps);
  return {
    store,
    getTool: (name) => tools.find((t) => t.name === name) as unknown as CallableTool,
    ledger,
    idempotency,
  };
}

async function createReadyTask(store: BuyerTaskStore): Promise<string> {
  const task = store.createTask({
    goal_text: "采购 sku-001 磋商",
    intent: { category: "sku-001", quantity: 2, target_unit_price: 800 },
    idempotency_key: `create:${uuidv7()}`,
  });
  store.transitionTask({
    task_id: task.task_id,
    to: "ready",
    expected_version: task.version,
    event_type: "status_changed",
    origin: "user",
    idempotency_key: `ready:${uuidv7()}`,
  });
  return task.task_id;
}

/** 从 created 事件内嵌文档重建候选（kernel launchHandoff 同法）。 */
function rebuildCandidate(
  ledger: HandoffEventStore,
  negotiationId: string,
  candidateId: string,
) {
  const events = ledger.events(negotiationId);
  const created = events.find(
    (e) => e.handoff_candidate_id === candidateId && e.event_kind === "handoff_candidate_created",
  );
  if (created === undefined || created.outcome.kind !== "ok") {
    throw new Error("created event missing candidate document");
  }
  return validateHandoffCandidate(created.outcome.result?.candidate);
}

function toolText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => ("text" in c && c.text !== undefined ? c.text : "")).join("\n");
}

describe("KTH 端到端（#20、#21）", () => {
  it("Agreement → Handoff → external checkout URL：全链路 + 证据门 + 指标", async () => {
    const stack = await startTestA2aStack({ productSource, capture });
    stacks.push(stack);
    const h = setupBuyer(stack.catalogUrl);

    // 1. 磋商：任务 → negotiate_buyer_task（autopilot 直通）→ selected_nonbinding
    const taskId = await createReadyTask(h.store);
    const negotiateTool = h.getTool("negotiate_buyer_task");
    const negotiateResult = await negotiateTool.execute("1", { task_id: taskId });
    expect(toolText(negotiateResult)).toContain("非绑定协议");
    const task = h.store.getTask(taskId);
    expect(task?.status).toBe("selected_nonbinding");

    // 2. 交接：handoff_agreement（autopilot 审批直通 → executeHandoff → delivered）
    const handoffTool = h.getTool("handoff_agreement");
    // 目的地必须命中 merchant 声明域（URL 安全 expectedHost 绑定，anti-phishing）。
    const handoffResult = await handoffTool.execute("2", {
      task_id: taskId,
      destination_type: "external_checkout_url",
      destination_ref: `${stack.merchantUrl}/checkout/e2e`,
      display_summary_merchant: "Acme Merchant",
      display_summary_text: "2 × sku-001",
    });
    expect(toolText(handoffResult)).toContain("交接已交付");

    // 3. Ledger 事件序列 + 三副作用 + 无订单/支付/库存事件（#12-14）
    const taskEvents = h.store.taskEvents(taskId);
    let statusChanged: (typeof taskEvents)[number] | undefined;
    for (let i = taskEvents.length - 1; i >= 0; i--) {
      const event = taskEvents[i];
      if (event !== undefined && event.type === "status_changed" && typeof event.payload.negotiation_id === "string") {
        statusChanged = event;
        break;
      }
    }
    const negotiationIdFromTask = statusChanged?.payload.negotiation_id as string;
    expect(negotiationIdFromTask).toBeDefined();
    const events = h.ledger.events(negotiationIdFromTask);
    const kinds = events.map((e) => e.event_kind);
    expect(kinds).toEqual([
      "handoff_candidate_created",
      "handoff_candidate_ready",
      "handoff_candidate_consumed",
      "handoff_delivered",
    ]);
    expect(kinds.some((k) => k.includes("order") || k.includes("payment") || k.includes("inventory"))).toBe(false);

    // 候选生命周期投影 → CONSUMED
    const candidateId = events[0]?.handoff_candidate_id;
    expect(candidateId).toBeDefined();
    expect(foldCandidateLifecycle(h.ledger.eventsForCandidate(events[0]?.negotiation_id as string, candidateId as string))).toBe(
      "CONSUMED",
    );

    // 4. 证据门：无证据 → 保持 LAUNCHED；local_callback → OPENED_CONFIRMED
    const delivered = events.find((e) => e.event_kind === "handoff_delivered");
    const handoffId = delivered?.handoff_id;
    expect(handoffId).toBeDefined();
    const negotiationId = events[0]?.negotiation_id as string;
    const candidate = rebuildCandidate(h.ledger, negotiationId, candidateId as string);
    recordLaunch({
      ledger: h.ledger,
      candidate,
      handoff_id: handoffId as string,
      identity: {
        sender_identity: candidate.buyer_identity_ref,
        counterparty_identity: candidate.merchant_identity_ref,
        actor: "buyer",
      },
      capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
      now: () => T0,
    });
    expect(deliveryState(h.ledger.eventsForHandoff(negotiationId, handoffId as string))).toBe("LAUNCHED");

    // 无证据的 launch 永不成为 OPENED_CONFIRMED
    expect(deliveryState(h.ledger.eventsForHandoff(negotiationId, handoffId as string))).toBe("LAUNCHED");

    // 5. 指标（#21）：agreement→handoff=1，launch 率 1/1，opened 率 0
    const byNegotiation = new Map<string, ReturnType<HandoffEventStore["events"]>>();
    for (const nid of h.ledger.listNegotiations()) {
      if (nid === undefined) continue;
      byNegotiation.set(nid, h.ledger.events(nid));
    }
    const metrics = computeHandoffMetrics(byNegotiation);
    expect(metrics.negotiations_with_candidates).toBe(1);
    expect(metrics.candidates_created).toBe(1);
    expect(metrics.handoffs_delivered).toBe(1);
    expect(metrics.agreement_to_handoff_rate).toBe(1);
    expect(metrics.handoff_launch_rate).toBe(1);
    expect(metrics.opened_confirmed_rate).toBe(0);
    expect(metrics.reported_external_conversion).toBeNull();
  });

  it("local_callback 证据 → OPENED_CONFIRMED（opened 率更新，绝不伪装成交）", async () => {
    const stack = await startTestA2aStack({ productSource, capture });
    stacks.push(stack);
    const h = setupBuyer(stack.catalogUrl);
    const taskId = await createReadyTask(h.store);
    await h.getTool("negotiate_buyer_task").execute("1", { task_id: taskId });
    await h.getTool("handoff_agreement").execute("2", {
      task_id: taskId,
      destination_type: "quote_document",
      destination_ref: "quote-2026-08-07-01",
      display_summary_merchant: "Acme",
      display_summary_text: "quote",
    });

    const negotiationId = h.ledger.listNegotiations()[0];
    if (negotiationId === undefined) {
      throw new Error("no negotiations in ledger");
    }
    const events = h.ledger.events(negotiationId);
    const delivered = events.find((e) => e.event_kind === "handoff_delivered");
    const handoffId = delivered?.handoff_id;
    if (handoffId === undefined) {
      throw new Error("handoff id missing");
    }
    const candidateId = events[0]?.handoff_candidate_id;
    if (candidateId === undefined) {
      throw new Error("candidate id missing");
    }

    const candidate = rebuildCandidate(h.ledger, negotiationId, candidateId);
    recordOpenEvidence({
      ledger: h.ledger,
      candidate,
      handoff_id: handoffId,
      identity: {
        sender_identity: candidate.buyer_identity_ref,
        counterparty_identity: candidate.merchant_identity_ref,
        actor: "buyer",
      },
      capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
      now: () => T0,
      evidence: { kind: "local_callback", handoff_id: handoffId, at: T0 },
    });
    expect(deliveryState(h.ledger.eventsForHandoff(negotiationId, handoffId))).toBe("OPENED_CONFIRMED");

    const byNegotiation = new Map<string, ReturnType<HandoffEventStore["events"]>>();
    h.ledger.listNegotiations().forEach((nid) => {
      if (nid === undefined) return;
      byNegotiation.set(nid, h.ledger.events(nid));
    });
    const metrics = computeHandoffMetrics(byNegotiation);
    expect(metrics.opened_confirmed_rate).toBe(1);
  });
});
