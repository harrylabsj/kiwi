/**
 * negotiate_buyer_task 测试（本地 A2A 磋商，零 marketplace）：
 * - 审批门：supervised 生成候选、/approve 后才发消息；未批准零消息；
 * - 商家按商品库（productSource 桩）报价：offer = SKU 真实价；
 * - 成功路径：任务 consulting → negotiating → selected_nonbinding + a2a-direct
 *   链接（negotiation_id）+ a2a_negotiated 事件 + 磋商记忆回调；
 * - 前置校验（状态/目录）；失败路径（catalog 找不到商家）；autopilot 直通。
 *
 * 完全离线：生产版 merchant handler（接 productSource 桩）+ 临时 A2AServer
 * + 两路由 catalog stub；capture 记录入站信封。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  FakeCommerceConnector,
  fakeConnectorProduct,
} from "../src/agent/connector/fake-connector.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { SupplierRelationshipStore } from "../src/agent/supplier/store.js";
import { buildBuyerTools, type BuyerToolDeps } from "../src/agent/buyer/buyer-tools.js";
import {
  executeApprovedCandidate,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { testBuyerProfile, startTestA2aStack, type CapturedInbound } from "./helpers.js";
import { dataSourceProductSource } from "../src/a2a/server/merchant-handler.js";
import { uuidv7 } from "@earendil-works/pi-ai";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "buyer-agent:buyer-001";

type PendingHooks = {
  readPreconditions: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

type CallableTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: { type: string; text?: string }[];
    details?: unknown;
  }>;
};

/** 商家商品库桩：按 SKU 报价（折扣/底价等真实数据在商家侧）。 */
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

interface BuyerHarness {
  db: DatabaseSync;
  store: BuyerTaskStore;
  supplierStore: SupplierRelationshipStore;
  approvals: WriteApprovalCandidateStore;
  mode: { value: "manual" | "supervised" | "autopilot" };
  hooks: Map<string, PendingHooks>;
  getTool: (name: string) => CallableTool;
  recordCalls: Array<Record<string, unknown>>;
  capture: CapturedInbound[];
  setNow: (t: string) => void;
  stop: () => Promise<void>;
}

const stacks: Awaited<ReturnType<typeof startTestA2aStack>>[] = [];
const capture: CapturedInbound[] = [];

afterEach(async () => {
  for (const s of stacks.splice(0)) await s.stop().catch(() => undefined);
  capture.length = 0;
});

async function setupBuyer(
  options: {
    catalog?: string;
    mode?: "manual" | "supervised" | "autopilot";
    autoNegotiate?: boolean;
  } = {},
): Promise<BuyerHarness> {
  let clock = T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => clock });
  const supplierStore = new SupplierRelationshipStore({ db, principalId: PRINCIPAL, now: () => clock });
  const connector = new FakeCommerceConnector([fakeConnectorProduct()]);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => clock,
  });
  const mode = { value: options.mode ?? ("supervised" as const) };
  const hooks = new Map<string, PendingHooks>();
  const recordCalls: Array<Record<string, unknown>> = [];
  const deps: BuyerToolDeps = {
    store,
    connector,
    profile: testBuyerProfile({
      buyer_policy: { ...testBuyerPolicyBase(), auto_negotiate: options.autoNegotiate ?? true },
    }),
    approvals,
    mode: () => mode.value,
    now: () => clock,
    registerPending: (id, h) => hooks.set(id, h),
    ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
    allowLoopback: true, // 本地 127.0.0.1 测试栈
    recordNegotiation: async (input) => {
      recordCalls.push({ ...input });
      return `mem-${input.negotiationId}`;
    },
    supplierStore,
  };
  const tools = buildBuyerTools(deps);
  return {
    db,
    store,
    supplierStore,
    approvals,
    mode,
    hooks,
    getTool: (name) => tools.find((t) => t.name === name) as unknown as CallableTool,
    recordCalls,
    capture,
    setNow: (t: string) => {
      clock = t;
    },
    stop: async () => undefined,
  };
}

function testBuyerPolicyBase() {
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

/** 建一个 ready 任务（磋商参数来自 intent）。 */
async function createReadyTask(
  store: BuyerTaskStore,
  overrides: Record<string, unknown> = {},
): Promise<{ task_id: string; version: number }> {
  const task = store.createTask({
    goal_text: "采购 sku-001 磋商",
    intent: { category: "sku-001", quantity: 2, target_unit_price: 800 },
    ...overrides,
    idempotency_key: `create:${uuidv7()}`,
  });
  const ready = store.transitionTask({
    task_id: task.task_id,
    to: "ready",
    expected_version: task.version,
    event_type: "status_changed",
    origin: "user",
    idempotency_key: `ready:${uuidv7()}`,
  });
  return { task_id: ready.task_id, version: ready.version };
}

describe("negotiate_buyer_task", () => {
  it("supervised: approval required; after /approve the A2A negotiation runs and the task settles", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const { task_id } = await createReadyTask(h.store);
    const tool = h.getTool("negotiate_buyer_task");

    // 1. supervised 调用 → 审批候选，零消息出站。
    const first = await tool.execute("c1", { task_id });
    const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
    expect(firstText).toContain("等待批准");
    expect(capture).toHaveLength(0);
    expect(h.store.getTask(task_id)?.status).toBe("ready");
    const pending = h.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe("negotiate_buyer_task");
    expect(pending[0]?.task_id).toBe(task_id);
    expect(pending[0]?.risk).toBe("send_negotiation_message");
    const pendingView = await h.getTool("list_pending_approvals").execute("pending", {});
    const pendingText = pendingView.content[0]?.type === "text" ? pendingView.content[0].text : "";
    expect(pendingText).toContain(pending[0]?.candidate_id ?? "");
    expect(pendingText).toContain(task_id);
    expect(h.store.taskEvents(task_id).some((e) => e.type === "approval_requested")).toBe(true);

    // 2. /approve → 执行：A2A 磋商 → 商家按商品库报价（sku-001 → 9900 minor）。
    const candidate = pending[0] as NonNullable<(typeof pending)[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    if (outcome.kind !== "executed") throw new Error("expected an executed candidate");
    const output = outcome.output as {
      ok: boolean;
      status?: string;
      negotiation_id?: string;
      facts?: { offerPriceMinor?: number; sku?: string };
    };
    expect(output.ok).toBe(true);
    expect(output.status).toBe("selected_nonbinding");
    expect(output.facts?.sku).toBe("sku-001");
    // 商家侧报价来自商品库（99 元），不是演示价。
    expect(output.facts?.offerPriceMinor).toBe(9_900);

    // 3. 任务终态 + 链接 + 事件 + 记忆回调。
    expect(h.store.getTask(task_id)?.status).toBe("selected_nonbinding");
    const links = h.store.linksForTask(task_id);
    expect(links).toHaveLength(1);
    expect(links[0]?.connector_id).toBe("a2a-direct");
    expect(links[0]?.conversation_id).toBe(output.negotiation_id);
    expect(links[0]?.status).toBe("closed");
    const event = h.store.taskEvents(task_id).find((e) => e.type === "a2a_negotiated");
    expect(event?.payload.ok).toBe(true);
    expect(event?.payload.boundary).toContain("非绑定");
    expect(h.recordCalls).toHaveLength(1);
    expect(h.recordCalls[0]?.negotiationId).toBe(output.negotiation_id);

    // 4. 商家确实收到了 RFQ（capture 记录）。
    expect(capture.some((c) => c.action === "rfq")).toBe(true);
    expect(capture.some((c) => c.action === "accept_nonbinding")).toBe(true);
  });

  // 回归 CD #28：intent.category 是自由文本时，优先用短名单候选的 merchant SKU，
  // 不能让商家按自由文本回退价报价（"iPhone 17" → 未知 SKU 回退，而非 VQ-003）。
  it("intent.category 自由文本 → 用短名单候选 SKU 协商", async () => {
    const s = await startTestA2aStack({
      capture,
      productSource: {
        async getProduct(sku: string) {
          if (sku === "VQ-003") return { price: 99, currency: "CNY" };
          throw new Error(`no product ${sku}`);
        },
      },
    });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const { task_id } = await createReadyTask(h.store, {
      intent: { category: "iPhone 17", quantity: 1 },
    });
    // 从 catalog listing 短名单一个候选，其 merchant SKU = VQ-003。
    const cand = h.store.upsertCandidate({
      task_id,
      connector_id: "kiwi-catalog",
      platform: "kiwi-catalog",
      external_product_id: "lst_iphone17",
      sku: "VQ-003",
      merchant_id: "mkt_veyquo",
      owner_agent_id: "cagt_veyquo",
    });
    h.store.updateCandidate(cand.candidate_id, {
      candidate_status: "shortlisted",
      eligibility: "eligible",
    });

    const tool = h.getTool("negotiate_buyer_task");
    const first = await tool.execute("c1", { task_id });
    expect(first.content[0]?.type === "text" ? first.content[0].text : "").toContain("等待批准");
    const pending = h.approvals.listPending();
    expect(pending).toHaveLength(1);
    const candidate = pending[0] as NonNullable<(typeof pending)[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    if (outcome.kind !== "executed") throw new Error("expected an executed candidate");
    const output = outcome.output as {
      ok: boolean;
      facts?: { sku?: string; offerPriceMinor?: number };
    };
    expect(output.ok).toBe(true);
    // 协商用候选 SKU VQ-003，而不是自由文本 "iPhone 17"（否则 getProduct 抛错）。
    expect(output.facts?.sku).toBe("VQ-003");
    expect(output.facts?.offerPriceMinor).toBe(9_900);
  });

  it("no approval → no messages leave the buyer side", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const { task_id } = await createReadyTask(h.store);
    const tool = h.getTool("negotiate_buyer_task");
    const result = await tool.execute("c1", { task_id });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("等待批准");
    expect(capture).toHaveLength(0);
    expect(h.store.getTask(task_id)?.status).toBe("ready");
    expect(h.store.linksForTask(task_id)).toHaveLength(0);
  });

  it("rejects non-negotiable task states and missing catalog", async () => {
    const s = await startTestA2aStack({ productSource });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const tool = h.getTool("negotiate_buyer_task");

    // draft（未就绪）不可磋商。
    const draft = h.store.createTask({
      goal_text: "g",
      intent: { category: "sku-001" },
      idempotency_key: `d:${uuidv7()}`,
    });
    const draftRes = await tool.execute("c1", { task_id: draft.task_id });
    expect(draftRes.content[0]?.type === "text" ? draftRes.content[0].text : "").toContain(
      "不可直接磋商",
    );
    expect(h.approvals.listPending()).toHaveLength(0);

    // searching（搜索在途）不可磋商。
    const { task_id, version } = await createReadyTask(h.store);
    h.store.transitionTask({
      task_id,
      to: "searching",
      expected_version: version,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: `s:${uuidv7()}`,
    });
    const searchingRes = await tool.execute("c1", { task_id });
    expect(searchingRes.content[0]?.type === "text" ? searchingRes.content[0].text : "").toContain(
      "不可直接磋商",
    );

    // 未配置 catalog → fail closed。
    const hNoCatalog = await setupBuyer({ catalog: undefined });
    const { task_id: t2 } = await createReadyTask(hNoCatalog.store);
    const toolNoCatalog = hNoCatalog.getTool("negotiate_buyer_task");
    const noCat = await toolNoCatalog.execute("c1", { task_id: t2 });
    expect(noCat.content[0]?.type === "text" ? noCat.content[0].text : "").toContain(
      "未配置 agent catalog",
    );
  });

  it("failure path: unknown merchant → 审批候选不标 executed（superseded + stale），任务不动", async () => {
    const s = await startTestA2aStack({ productSource });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const { task_id } = await createReadyTask(h.store);
    const tool = h.getTool("negotiate_buyer_task");
    const first = await tool.execute("c1", { task_id, catalog_agent_id: "cagt_missing" });
    expect(first.content[0]?.type === "text" ? first.content[0].text : "").toContain("等待批准");
    const pending = h.approvals.listPending();
    expect(pending).toHaveLength(1);
    const candidate = pending[0] as NonNullable<(typeof pending)[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    // execute 返回 {ok:false}（商家找不到）→ 候选 superseded + stale，
    // 不标 executed（审计状态与真实执行一致；此前无条件 markExecuted）。
    expect(outcome.kind).toBe("stale");
    expect(outcome.candidate.status).toBe("superseded");
    expect(h.approvals.get(candidate.candidate_id)?.status).toBe("superseded");
    // 任务不动：无链接、状态不变、事件记录失败。
    expect(h.store.getTask(task_id)?.status).toBe("ready");
    expect(h.store.linksForTask(task_id)).toHaveLength(0);
    const event = h.store.taskEvents(task_id).find((e) => e.type === "a2a_negotiated");
    expect(event?.payload.ok).toBe(false);
  });

  it("autopilot with auto_negotiate runs immediately without a pending candidate", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl, mode: "autopilot", autoNegotiate: true });
    const { task_id } = await createReadyTask(h.store);
    const tool = h.getTool("negotiate_buyer_task");
    const result = await tool.execute("c1", { task_id });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("已执行");
    expect(h.approvals.listPending()).toHaveLength(0);
    expect(h.store.getTask(task_id)?.status).toBe("selected_nonbinding");
    expect(capture.some((c) => c.action === "rfq")).toBe(true);
  });

  it("K-M3: shortlist_ready task can negotiate directly (state machine allows → consulting)", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl, mode: "autopilot", autoNegotiate: true });
    const tool = h.getTool("negotiate_buyer_task");
    // ready → searching → shortlist_ready（短名单就绪）
    const { task_id, version } = await createReadyTask(h.store);
    const searching = h.store.transitionTask({
      task_id,
      to: "searching",
      expected_version: version,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: `k3-s:${uuidv7()}`,
    });
    const shortlist = h.store.transitionTask({
      task_id,
      to: "shortlist_ready",
      expected_version: searching.version,
      event_type: "search_completed",
      origin: "scheduler",
      idempotency_key: `k3-sl:${uuidv7()}`,
    });
    expect(shortlist.status).toBe("shortlist_ready");
    // 直接磋商：K-M3 修复前 transitionTask("consulting") 在此抛 illegal_transition。
    const result = await tool.execute("c1", { task_id });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("已执行");
    expect(h.approvals.listPending()).toHaveLength(0);
    expect(h.store.getTask(task_id)?.status).toBe("selected_nonbinding");
    expect(capture.some((c) => c.action === "rfq")).toBe(true);
  });

  it("dataSourceProductSource × createMerchantHandler: offer price is price_minor, not 100x (P1 regression)", async () => {
    // 真实 CommerceDataSource（minor units）接 adapter → 商家 handler。
    // 回归：adapter 曾把 price_minor 直接当"元"返回，resolveProduct 再 ×100
    // → 83500 minor 报成 8,350,000。组合层此前完全无测试覆盖。
    const dataSource = {
      async getProduct(sku: string) {
        if (sku === "sku-001") {
          return { sku, title: "Real Beans", price_minor: 83500, currency: "CNY", stock: 200 };
        }
        return undefined;
      },
      async getProducts() {
        return [];
      },
      async getInventory() {
        return undefined;
      },
      async getPrice() {
        return undefined;
      },
      async getPublicListing() {
        return {};
      },
      async health() {
        return { ok: true };
      },
    };
    const adapter = dataSourceProductSource(dataSource);
    const s = await startTestA2aStack({ productSource: adapter, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    // 商家价 835 元；目标价 1000 元（否则预算校验拒绝——此测试只看价格换算）。
    const { task_id } = await createReadyTask(h.store, {
      intent: { category: "sku-001", quantity: 2, target_unit_price: 1000 },
    });
    const tool = h.getTool("negotiate_buyer_task");

    const first = await tool.execute("c1", { task_id });
    expect(first.content[0]?.type === "text" ? first.content[0].text : "").toContain("等待批准");
    const pending = h.approvals.listPending();
    const candidate = pending[0] as (typeof pending)[number];
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    if (outcome.kind !== "executed") throw new Error("expected an executed candidate");
    const output = outcome.output as { ok: boolean; facts?: { offerPriceMinor?: number } };
    expect(output.ok).toBe(true);
    // 83500 minor（835.00 元）——不是 100 倍的 8,350,000。
    expect(output.facts?.offerPriceMinor).toBe(83_500);
  });
});

/**
 * supplier_save_suggested（pull-relationship 设计 v0.1 §13 M0）：
 * 真实 RFQ（KNP RFQ→offer→…→accept）成功结束后，本地建议 Buyer 保存该
 * Merchant——只写建议事件，绝不自动保存；已有 active/paused 关系或 7 天
 * 冷却窗口内已提示过同 merchant 时不重复提示；失败的 RFQ 不提示。
 */
describe("supplier_save_suggested (M0)", () => {
  const MERCHANT_ID = "merchant-001";
  const CATALOG_AGENT_ID = "cagt_test_merchant_001";
  const DAY_MS = 24 * 3600 * 1000;

  interface NegotiationOutput {
    ok: boolean;
    negotiation_id?: string;
    supplier_save_suggested?: boolean;
    error?: string;
  }

  /** supervised 全流程：发起 → 等待批准 → /approve → 执行 → 返回工具输出。 */
  async function runApprovedNegotiation(
    h: BuyerHarness,
    taskId: string,
    extraArgs: Record<string, unknown> = {},
  ): Promise<NegotiationOutput> {
    const tool = h.getTool("negotiate_buyer_task");
    const first = await tool.execute("c1", { task_id: taskId, ...extraArgs });
    expect(first.content[0]?.type === "text" ? first.content[0].text : "").toContain("等待批准");
    const pending = h.approvals.listPending();
    expect(pending).toHaveLength(1);
    const candidate = pending[0] as NonNullable<(typeof pending)[number]>;
    h.approvals.markApproved(candidate.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      candidate.candidate_id,
      h.hooks.get(candidate.candidate_id) as PendingHooks,
    );
    if (outcome.kind === "executed") return outcome.output as NegotiationOutput;
    // execute 返回 {ok:false} 时候选标 stale（见既有失败路径测试）。
    return { ok: false, error: `candidate ${outcome.kind}` };
  }

  /** 带候选的 ready 任务：候选的 owner_agent_id/merchant_id 与测试栈一致。 */
  async function createTaskWithCandidate(h: BuyerHarness): Promise<string> {
    const { task_id } = await createReadyTask(h.store);
    const cand = h.store.upsertCandidate({
      task_id,
      connector_id: "kiwi-catalog",
      platform: "kiwi-catalog",
      external_product_id: "lst_test_001",
      sku: "sku-001",
      merchant_id: MERCHANT_ID,
      owner_agent_id: CATALOG_AGENT_ID,
    });
    h.store.updateCandidate(cand.candidate_id, {
      candidate_status: "shortlisted",
      eligibility: "eligible",
    });
    return task_id;
  }

  it("RFQ 成功完成 → 追加 supplier_save_suggested 事件（不自动保存关系）", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const taskId = await createTaskWithCandidate(h);

    const output = await runApprovedNegotiation(h, taskId);
    expect(output.ok).toBe(true);
    expect(output.supplier_save_suggested).toBe(true);

    const event = h.store.taskEvents(taskId).find((e) => e.type === "supplier_save_suggested");
    expect(event).toBeDefined();
    // merchant_id 来自候选的结构化字段（owner_agent_id 匹配），不是远程文本。
    expect(event?.payload.merchant_id).toBe(MERCHANT_ID);
    expect(event?.payload.catalog_agent_id).toBe(CATALOG_AGENT_ID);
    expect(event?.payload.negotiation_id).toBe(output.negotiation_id);
    expect(String(event?.payload.hint)).toContain(`kiwi buyer supplier save ${MERCHANT_ID}`);

    // 绝不自动保存：supplier_relationships 仍为空。
    expect(h.supplierStore.listRelationships({ includeDeleted: true })).toHaveLength(0);
  });

  it("已有 active / paused 关系 → 不提示", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });

    // active 关系抑制提示。
    const rel = h.supplierStore.saveRelationship({
      merchant_id: MERCHANT_ID,
      canonical_domain: "test.example",
      agent_card_url: `${s.merchantUrl}/.well-known/agent-card.json`,
      relationship_type: "saved",
      consent_source: "human_explicit",
    });
    const task1 = await createTaskWithCandidate(h);
    const out1 = await runApprovedNegotiation(h, task1);
    expect(out1.ok).toBe(true);
    expect(out1.supplier_save_suggested).toBe(false);
    expect(h.store.taskEvents(task1).some((e) => e.type === "supplier_save_suggested")).toBe(false);

    // paused 同样抑制（关系仍存在，只是暂停观察）。
    h.supplierStore.updateStatus(rel.relationship_id, "paused");
    const task2 = await createTaskWithCandidate(h);
    const out2 = await runApprovedNegotiation(h, task2);
    expect(out2.ok).toBe(true);
    expect(out2.supplier_save_suggested).toBe(false);
    expect(h.store.taskEvents(task2).some((e) => e.type === "supplier_save_suggested")).toBe(false);
  });

  it("冷却窗口：7 天内同 merchant 不重复提示，窗口过后再提示", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });

    const task1 = await createTaskWithCandidate(h);
    const out1 = await runApprovedNegotiation(h, task1);
    expect(out1.supplier_save_suggested).toBe(true);

    // 6 天后另一次成功 RFQ（新任务、同 merchant）：冷却窗口内，不重复。
    h.setNow(new Date(Date.parse(T0) + 6 * DAY_MS).toISOString());
    const task2 = await createTaskWithCandidate(h);
    const out2 = await runApprovedNegotiation(h, task2);
    expect(out2.ok).toBe(true);
    expect(out2.supplier_save_suggested).toBe(false);
    expect(h.store.taskEvents(task2).some((e) => e.type === "supplier_save_suggested")).toBe(false);

    // 8 天后（距首次建议 > 7 天）：再次提示。
    h.setNow(new Date(Date.parse(T0) + 8 * DAY_MS).toISOString());
    const task3 = await createTaskWithCandidate(h);
    const out3 = await runApprovedNegotiation(h, task3);
    expect(out3.ok).toBe(true);
    expect(out3.supplier_save_suggested).toBe(true);
    expect(
      h.store.taskEvents(task3).filter((e) => e.type === "supplier_save_suggested"),
    ).toHaveLength(1);
  });

  it("RFQ 失败（商家不存在）→ 不提示", async () => {
    const s = await startTestA2aStack({ productSource });
    stacks.push(s);
    const h = await setupBuyer({ catalog: s.catalogUrl });
    const { task_id } = await createReadyTask(h.store);

    const output = await runApprovedNegotiation(h, task_id, {
      catalog_agent_id: "cagt_missing",
    });
    expect(output.ok).toBe(false);
    expect(h.store.getTask(task_id)?.status).toBe("ready");
    expect(h.store.taskEvents(task_id).some((e) => e.type === "supplier_save_suggested")).toBe(
      false,
    );
  });
});
