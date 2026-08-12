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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { FakeCommerceConnector, fakeConnectorProduct } from "../src/agent/connector/fake-connector.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { buildBuyerTools, type BuyerToolDeps } from "../src/agent/buyer/buyer-tools.js";
import {
  WriteApprovalCandidateStore,
  executeApprovedCandidate,
} from "../src/agent/merchant/action-candidate.js";
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

/** 商家 productSource 声明成交入口的栈（merchant→buyer 直传场景）。 */
async function checkoutStack(
  checkoutUrl: string,
  opts: { capture?: CapturedInbound[] } = {},
): Promise<Awaited<ReturnType<typeof startTestA2aStack>>> {
  const stack = await startTestA2aStack({
    ...(opts.capture !== undefined ? { capture: opts.capture } : {}),
    productSource: {
      async getProduct(sku: string) {
        if (sku === "sku-001") {
          return { price: 99, currency: "CNY", handoff_destination: checkoutUrl };
        }
        throw new Error(`no product ${sku}`);
      },
    },
  });
  stacks.push(stack);
  return stack;
}

const stacks: Awaited<ReturnType<typeof startTestA2aStack>>[] = [];
const capture: CapturedInbound[] = [];

afterEach(async () => {
  for (const s of stacks.splice(0)) await s.stop().catch(() => undefined);
  capture.length = 0;
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // The buyer profile and assertions are Chinese; pin locale so CI host LANG
  // cannot silently switch the user-visible negotiation summary to English.
  vi.stubEnv("KIWI_LANG", "zh");
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
  approvals: WriteApprovalCandidateStore;
  pendingHooks: Map<
    string,
    {
      readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    }
  >;
}

function setupBuyer(
  catalog: string,
  options: { mode?: "autopilot" | "supervised" } = {},
): E2eHarness {
  const dir = trackedMkdtemp("kiwi-e2e-");
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
  const mode = { value: (options.mode ?? "autopilot") as "autopilot" | "supervised" };
  const pendingHooks = new Map<
    string,
    { readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<unknown> }
  >();
  const deps: BuyerToolDeps = {
    store,
    connector,
    profile: testBuyerProfile({ buyer_policy: { ...buyerPolicyBase(), auto_negotiate: true } }),
    approvals,
    mode: () => mode.value,
    now: () => T0,
    registerPending: (id, hooks) => pendingHooks.set(id, hooks),
    catalog,
    allowLoopback: true, // 本地 127.0.0.1 测试栈
    handoff: { ledger, idempotency },
  };
  const tools = buildBuyerTools(deps);
  return {
    store,
    getTool: (name) => tools.find((t) => t.name === name) as unknown as CallableTool,
    ledger,
    idempotency,
    approvals,
    pendingHooks,
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
    // 外部 checkout 桩：URL 安全探测（HEAD）要求可达的 2xx 端点；商家 productSource
    // 声明其为成交入口（merchant→buyer 直传，不经 catalog、不现编）。
    const http = await import("node:http");
    const checkoutServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((resolve) =>
      checkoutServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const checkoutAddr = checkoutServer.address() as { port: number };
    const checkoutUrl = `http://127.0.0.1:${checkoutAddr.port}/checkout/e2e`;

    const stack = await checkoutStack(checkoutUrl);
    const h = setupBuyer(stack.catalogUrl);

    // 1. 磋商：任务 → negotiate_buyer_task（autopilot 直通）→ selected_nonbinding
    const taskId = await createReadyTask(h.store);
    const negotiateTool = h.getTool("negotiate_buyer_task");
    const negotiateResult = await negotiateTool.execute("1", { task_id: taskId });
    expect(toolText(negotiateResult)).toContain("非绑定协议");
    const task = h.store.getTask(taskId);
    expect(task?.status).toBe("selected_nonbinding");

    // 2. 交接：handoff_agreement（autopilot 审批直通 → executeHandoff → delivered）。
    //    目的地只取商家在协议里直传的成交入口，不传 destination 参数。
    const handoffTool = h.getTool("handoff_agreement");
    const handoffResult = await handoffTool.execute("2", {
      task_id: taskId,
      display_summary_merchant: "Acme Merchant",
      display_summary_text: "2 × sku-001",
    });
    expect(toolText(handoffResult)).toContain("交接已交付");
    await new Promise<void>((resolve) => checkoutServer.close(() => resolve()));

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

  it("handoff_agreement 商家未在协议声明成交入口 → 拒绝交接（不认 catalog/LLM 现编目的地）", async () => {
    // 共享 productSource 不携带 handoff_destination → 协议里没有成交入口。
    const stack = await startTestA2aStack({ productSource, capture });
    stacks.push(stack);
    const h = setupBuyer(stack.catalogUrl);
    const taskId = await createReadyTask(h.store);
    await h.getTool("negotiate_buyer_task").execute("1", { task_id: taskId });
    const result = await h.getTool("handoff_agreement").execute("2", {
      task_id: taskId,
      display_summary_merchant: "Acme Merchant",
    });
    expect(toolText(result)).toContain("商家未在协议中声明成交入口");
    // 未交接：无 created 事件。
    const negotiationId = h.ledger.listNegotiations()[0];
    if (negotiationId !== undefined) {
      expect(h.ledger.events(negotiationId).some((e) => e.event_kind === "handoff_candidate_created")).toBe(false);
    }
  });

  it("catalog listing 声明不能作为成交入口——只认商家协议直传（不经 catalog）", async () => {
    // 商家 productSource 无 handoff_destination；只在 catalog 事件里声明一个
    // 成交入口——旧行为会采纳它，现在必须忽略并拒绝交接。
    const stack = await startTestA2aStack({ productSource, capture });
    stacks.push(stack);
    const h = setupBuyer(stack.catalogUrl);
    const taskId = await createReadyTask(h.store);
    h.store.appendEvent(
      taskId,
      "candidate_shortlisted",
      {
        listing_id: "lst_1",
        owner_agent_id: "cagt_x",
        listing_title: "VQ-001 智能保温杯",
        handoff_destination_types: ["external_checkout_url"],
        handoff_destination_ref: "https://catalog-declared.example/checkout",
        source: "kiwi-catalog",
      },
      "model",
      `shortlist:${taskId}:${uuidv7()}`,
    );

    await h.getTool("negotiate_buyer_task").execute("1", { task_id: taskId });
    const result = await h.getTool("handoff_agreement").execute("2", {
      task_id: taskId,
      display_summary_merchant: "Acme",
    });
    expect(toolText(result)).toContain("商家未在协议中声明成交入口");
  });

  it("handoff_agreement 优先用 agreement 里商家直传的成交入口（覆盖 catalog 声明与 LLM 现编）", async () => {
    const http = await import("node:http");
    const checkoutServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((resolve) => checkoutServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (checkoutServer.address() as { port: number }).port;
    const merchantDeclared = `http://127.0.0.1:${port}/checkout/vq-003`;

    const stack = await startTestA2aStack({
      capture,
      productSource: {
        async getProduct(sku: string) {
          if (sku === "VQ-003") {
            return { price: 8999, currency: "CNY", handoff_destination: merchantDeclared };
          }
          throw new Error(`no product ${sku}`);
        },
      },
    });
    stacks.push(stack);
    const h = setupBuyer(stack.catalogUrl);
    const taskId = await createReadyTask(h.store);

    // 候选 sku VQ-003 + catalog 声明一个不同地址（验证 agreement 直传优先）。
    const cand = h.store.upsertCandidate({
      task_id: taskId,
      connector_id: "kiwi-catalog",
      platform: "kiwi-catalog",
      external_product_id: "lst_1",
      sku: "VQ-003",
      owner_agent_id: "cagt_veyquo",
    });
    h.store.updateCandidate(cand.candidate_id, { candidate_status: "shortlisted", eligibility: "eligible" });
    h.store.appendEvent(
      taskId,
      "candidate_shortlisted",
      {
        listing_id: "lst_1",
        owner_agent_id: "cagt_veyquo",
        handoff_destination_types: ["external_checkout_url"],
        handoff_destination_ref: "http://127.0.0.1:1/catalog-declared",
        source: "kiwi-catalog",
      },
      "model",
      `shortlist:${taskId}:lst_1`,
    );

    // 磋商（候选 sku VQ-003 → 商家 agreement 携带 merchantDeclared）。
    await h.getTool("negotiate_buyer_task").execute("1", { task_id: taskId });
    // 交接：目的地只取 agreement 直传（catalog 声明与 LLM 现编均被忽略）。
    await h.getTool("handoff_agreement").execute("2", {
      task_id: taskId,
      display_summary_merchant: "Acme",
    });

    const taskEvents = h.store.taskEvents(taskId);
    let negotiationId: string | undefined;
    for (let i = taskEvents.length - 1; i >= 0; i--) {
      const event = taskEvents[i];
      if (event?.type === "status_changed" && typeof event.payload.negotiation_id === "string") {
        negotiationId = event.payload.negotiation_id;
        break;
      }
    }
    const events = h.ledger.events(negotiationId as string);
    const created = events.find((e) => e.event_kind === "handoff_candidate_created");
    const candidate =
      created?.outcome.kind === "ok"
        ? (created.outcome.result?.candidate as Record<string, unknown> | undefined)
        : undefined;
    expect(candidate?.destination_ref).toBe(merchantDeclared);
    await new Promise<void>((resolve) => checkoutServer.close(() => resolve()));
  });

  it("local_callback 证据 → OPENED_CONFIRMED（opened 率更新，绝不伪装成交）", async () => {
    const http = await import("node:http");
    const checkoutServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((resolve) => checkoutServer.listen(0, "127.0.0.1", () => resolve()));
    const checkoutAddr = checkoutServer.address() as { port: number };
    const stack = await checkoutStack(`http://127.0.0.1:${checkoutAddr.port}/checkout/e2e`);
    const h = setupBuyer(stack.catalogUrl);
    const taskId = await createReadyTask(h.store);
    await h.getTool("negotiate_buyer_task").execute("1", { task_id: taskId });
    await h.getTool("handoff_agreement").execute("2", {
      task_id: taskId,
      display_summary_merchant: "Acme",
      display_summary_text: "2 × sku-001",
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
    await new Promise<void>((resolve) => checkoutServer.close(() => resolve()));
  });

  it("supervised: handoff 经审批门 → /approve 后交付，created 事件审批后才落链", async () => {
    const http = await import("node:http");
    const checkoutServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((resolve) => checkoutServer.listen(0, "127.0.0.1", () => resolve()));
    const checkoutAddr = checkoutServer.address() as { port: number };
    const stack = await checkoutStack(`http://127.0.0.1:${checkoutAddr.port}/checkout/e2e`);
    const h = setupBuyer(stack.catalogUrl, { mode: "supervised" });
    const taskId = await createReadyTask(h.store);

    // 1. 磋商（supervised）→ 审批候选 → /approve → selected_nonbinding
    const negotiateTool = h.getTool("negotiate_buyer_task");
    const firstNeg = await negotiateTool.execute("1", { task_id: taskId });
    expect(toolText(firstNeg)).toContain("等待批准");
    const negPending = h.approvals.listPending();
    expect(negPending).toHaveLength(1);
    const negCandidate = negPending[0] as NonNullable<(typeof negPending)[number]>;
    h.approvals.markApproved(negCandidate.candidate_id);
    const negOutcome = await executeApprovedCandidate(
      h.approvals,
      negCandidate.candidate_id,
      h.pendingHooks.get(negCandidate.candidate_id) as {
        readPreconditions: () => Record<string, unknown> | Promise<Record<string, unknown>>;
        execute: (args: Record<string, unknown>) => Promise<unknown>;
      },
    );
    if (negOutcome.kind !== "executed") throw new Error("expected negotiated execution");
    expect(h.store.getTask(taskId)?.status).toBe("selected_nonbinding");

    // 2. handoff_agreement（supervised）→ 审批候选；created 事件尚未落链。
    //    目的地来自商家协议直传（checkoutStack 声明的 checkoutUrl）。
    const handoffTool = h.getTool("handoff_agreement");
    const handoffResult = await handoffTool.execute("2", {
      task_id: taskId,
      display_summary_merchant: "Acme Merchant",
      display_summary_text: "2 × sku-001",
    });
    expect(toolText(handoffResult)).toContain("等待批准");
    const taskEvents = h.store.taskEvents(taskId);
    let statusChanged: (typeof taskEvents)[number] | undefined;
    for (let i = taskEvents.length - 1; i >= 0; i--) {
      const event = taskEvents[i];
      if (event !== undefined && event.type === "status_changed" && typeof event.payload.negotiation_id === "string") {
        statusChanged = event;
        break;
      }
    }
    const negotiationId = statusChanged?.payload.negotiation_id as string;
    expect(negotiationId).toBeDefined();
    // created 事件在审批后才落链（被 /reject 的候选不留悬空 PROPOSED）。
    expect(h.ledger.events(negotiationId).some((e) => e.event_kind === "handoff_candidate_created")).toBe(false);

    // 3. /approve → delivered；事件序列 [created, ready, consumed, delivered]
    const handoffPending = h.approvals.listPending();
    expect(handoffPending).toHaveLength(1);
    const handoffCandidate = handoffPending[0] as NonNullable<(typeof handoffPending)[number]>;
    h.approvals.markApproved(handoffCandidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      handoffCandidate.candidate_id,
      h.pendingHooks.get(handoffCandidate.candidate_id) as {
        readPreconditions: () => Record<string, unknown> | Promise<Record<string, unknown>>;
        execute: (args: Record<string, unknown>) => Promise<unknown>;
      },
    );
    if (outcome.kind !== "executed") throw new Error("expected handoff execution");
    const output = outcome.output as { ok: boolean; status?: string };
    expect(output.ok).toBe(true);
    expect(output.status).toBe("delivered");

    const events = h.ledger.events(negotiationId);
    expect(events.map((e) => e.event_kind)).toEqual([
      "handoff_candidate_created",
      "handoff_candidate_ready",
      "handoff_candidate_consumed",
      "handoff_delivered",
    ]);
    await new Promise<void>((resolve) => checkoutServer.close(() => resolve()));
  });
});

/** 评审项 L6：mkdtemp 目录跟踪清理（此前每次运行在 /tmp 残留）。 */
const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
