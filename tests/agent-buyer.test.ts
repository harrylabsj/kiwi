/**
 * Buyer task tests (design §19.2): state machine legal/illegal transitions,
 * optimistic version conflicts, idempotent events, candidate/observation
 * dedup, hard-filter vs soft-preference separation, tracking rules with
 * merged notifications and cooldowns, scheduler restart recovery and
 * expiry, and the non-binding selection semantics.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import {
  FakeCommerceConnector,
  fakeConnectorProduct,
} from "../src/agent/connector/fake-connector.js";
import {
  ConnectorError,
  type CommerceConnector,
  type ConnectorMerchant,
  type ConnectorProduct,
  type SearchMerchantsQuery,
  type SearchProductsQuery,
} from "../src/agent/connector/types.js";
import { observationHash, runSearchCycle } from "../src/agent/buyer/search-loop.js";
import { TaskScheduler } from "../src/agent/buyer/scheduler.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { BuyerTaskError, type BuyerTask } from "../src/agent/buyer/types.js";
import { buildBuyerTools } from "../src/agent/buyer/buyer-tools.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import type { KiwiCatalogSource } from "../src/discovery/index.js";
import { uuidv7 } from "@earendil-works/pi-ai";
import { testBuyerProfile } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "buyer-agent:buyer-001";
const TEST_KEY = "a".repeat(64);

function setup(products = [fakeConnectorProduct()], options: { withVault?: boolean } = {}) {
  let clock = T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 2, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const vault = options.withVault === true ? new PrivateVault(new EnvKeyProvider(TEST_KEY)) : undefined;
  const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => clock, vault });
  const connector = new FakeCommerceConnector(products);
  const scheduler = new TaskScheduler({ store, connectors: [connector], now: () => clock });
  return {
    db,
    store,
    connector,
    scheduler,
    now: () => clock,
    setNow: (t: string) => {
      clock = t;
    },
  };
}

function createReadyTask(store: BuyerTaskStore, overrides: Record<string, unknown> = {}): BuyerTask {
  const task = store.createTask({
    goal_text: "买 2 个陶瓷杯",
    intent: { category: "kitchenware", query_text: "陶瓷杯" },
    constraints: {},
    idempotency_key: `create:${uuidv7()}`,
    ...overrides,
  });
  return store.transitionTask({
    task_id: task.task_id,
    to: "ready",
    expected_version: task.version,
    event_type: "status_changed",
    origin: "user",
    idempotency_key: `ready:${uuidv7()}`,
  });
}

/** Delegating connector that throws a transient error on the first search. */
class FlakyConnector implements CommerceConnector {
  readonly connector_id = "shopping-cli";
  readonly platform = "shopping-cli";
  calls = 0;
  constructor(private readonly inner: CommerceConnector) {}
  async searchProducts(query: SearchProductsQuery): Promise<ConnectorProduct[]> {
    this.calls += 1;
    if (this.calls === 1) throw new ConnectorError("transient", "gateway blip");
    return this.inner.searchProducts(query);
  }
  async getProduct(sku: string): Promise<ConnectorProduct> {
    return this.inner.getProduct(sku);
  }
  async searchMerchants(query: SearchMerchantsQuery): Promise<ConnectorMerchant[]> {
    return this.inner.searchMerchants(query);
  }
  async startConsultation(input: {
    buyer_id: string;
    sku: string;
    merchant_id: string;
    opening_message: string;
  }): Promise<{ conversation_id: string; status: string }> {
    return this.inner.startConsultation(input);
  }
}

describe("task state machine (§11.3)", () => {
  it("walks the legal path and rejects illegal transitions", () => {
    const { store } = setup();
    const task = store.createTask({
      goal_text: "g",
      intent: { query_text: "杯" },
      idempotency_key: `c:${uuidv7()}`,
    });
    expect(task.status).toBe("draft");
    expect(() =>
      store.transitionTask({
        task_id: task.task_id,
        to: "searching",
        expected_version: task.version,
        event_type: "status_changed",
        origin: "user",
        idempotency_key: `x:${uuidv7()}`,
      }),
    ).toThrow(/not a legal transition/);

    let current = store.transitionTask({
      task_id: task.task_id,
      to: "clarifying",
      expected_version: task.version,
      event_type: "clarified",
      origin: "user",
      idempotency_key: `t1:${uuidv7()}`,
    });
    expect(current.status).toBe("clarifying");
    current = store.transitionTask({
      task_id: task.task_id,
      to: "ready",
      expected_version: current.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `t2:${uuidv7()}`,
    });
    expect(current.status).toBe("ready");
  });

  it("ready/tracking can go straight to consulting (local negotiation task); searching cannot", () => {
    const { store } = setup();
    // ready → consulting（不经搜索/候选，直接本地 A2A 磋商）。
    const task = store.createTask({
      goal_text: "g",
      intent: { query_text: "杯" },
      idempotency_key: `c:${uuidv7()}`,
    });
    let current = store.transitionTask({
      task_id: task.task_id,
      to: "ready",
      expected_version: task.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `r:${uuidv7()}`,
    });
    current = store.transitionTask({
      task_id: task.task_id,
      to: "consulting",
      expected_version: current.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `c1:${uuidv7()}`,
    });
    expect(current.status).toBe("consulting");

    // tracking → consulting（搜索失败退避中的任务也可直接磋商）。
    const t2 = store.createTask({
      goal_text: "g2",
      intent: { query_text: "杯" },
      idempotency_key: `c:${uuidv7()}:2`,
    });
    let cur2 = store.transitionTask({
      task_id: t2.task_id,
      to: "ready",
      expected_version: t2.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `r2:${uuidv7()}`,
    });
    cur2 = store.transitionTask({
      task_id: t2.task_id,
      to: "searching",
      expected_version: cur2.version,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: `s2:${uuidv7()}`,
    });
    cur2 = store.transitionTask({
      task_id: t2.task_id,
      to: "tracking",
      expected_version: cur2.version,
      event_type: "tracking_installed",
      origin: "scheduler",
      idempotency_key: `t2:${uuidv7()}`,
    });
    cur2 = store.transitionTask({
      task_id: t2.task_id,
      to: "consulting",
      expected_version: cur2.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `c2:${uuidv7()}`,
    });
    expect(cur2.status).toBe("consulting");

    // searching → consulting 仍非法（搜索在途，不允许并发磋商写入）。
    const t3 = store.createTask({
      goal_text: "g3",
      intent: { query_text: "杯" },
      idempotency_key: `c:${uuidv7()}:3`,
    });
    const cur3 = store.transitionTask({
      task_id: t3.task_id,
      to: "ready",
      expected_version: t3.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `r3:${uuidv7()}`,
    });
    store.transitionTask({
      task_id: t3.task_id,
      to: "searching",
      expected_version: cur3.version,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: `s3:${uuidv7()}`,
    });
    expect(() =>
      store.transitionTask({
        task_id: t3.task_id,
        to: "consulting",
        expected_version: cur3.version + 1,
        event_type: "status_changed",
        origin: "user",
        idempotency_key: `c3:${uuidv7()}`,
      }),
    ).toThrow(BuyerTaskError);
  });

  it("optimistic versioning: a stale expected_version loses; replays are no-ops", () => {
    const { store } = setup();
    const task = store.createTask({
      goal_text: "g",
      intent: { query_text: "杯" },
      idempotency_key: `c:${uuidv7()}`,
    });
    store.transitionTask({
      task_id: task.task_id,
      to: "ready",
      expected_version: task.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `r:${uuidv7()}`,
    });
    // Someone else already bumped the version: this writer is stale.
    expect(() =>
      store.transitionTask({
        task_id: task.task_id,
        to: "cancelled",
        expected_version: task.version,
        event_type: "cancelled",
        origin: "user",
        idempotency_key: `z:${uuidv7()}`,
      }),
    ).toThrow(BuyerTaskError);

    // Replaying the same transition idempotency key does nothing twice.
    const key = `ready:${uuidv7()}`;
    const fresh = store.getTask(task.task_id) as BuyerTask;
    const once = store.transitionTask({
      task_id: task.task_id,
      to: "searching",
      expected_version: fresh.version,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: key,
    });
    const twice = store.transitionTask({
      task_id: task.task_id,
      to: "searching",
      expected_version: 999,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: key,
    });
    expect(twice.version).toBe(once.version);
    expect(
      store.taskEvents(task.task_id).filter((e) => e.idempotency_key === key),
    ).toHaveLength(1);
  });
});

describe("search cycle (§13)", () => {
  it("searches, filters hard constraints, ranks deterministically and shortlists", async () => {
    const { store, connector, now } = setup([
      fakeConnectorProduct({ sku: "sku-cheap", price: 50, stock: 5 }),
      fakeConnectorProduct({ sku: "sku-pricy", price: 150, stock: 5 }),
    ]);
    const ready = createReadyTask(store, {
      constraints: { max_total_price: 100 },
    });
    const result = await runSearchCycle(
      { store, connector, now },
      ready.task_id,
      `run:${uuidv7()}`,
    );
    expect(result.outcome).toBe("shortlist_ready");
    expect(result.task.status).toBe("awaiting_user");
    // The over-budget product is hard-filtered with a reason, never ranked away silently.
    expect(result.shortlist.map((s) => s.candidate.sku)).toEqual(["sku-cheap"]);
    const rejected = store
      .listCandidates(ready.task_id)
      .find((c) => c.sku === "sku-pricy");
    expect(rejected?.eligibility).toBe("ineligible");
    expect(rejected?.rejection_reasons.join()).toContain("超过上限");
    // The surviving candidate carries an explanation with weight sources.
    const winner = result.shortlist[0]?.candidate;
    expect(winner?.score_explanation?.dimensions.length).toBeGreaterThan(0);
    expect(
      winner?.score_explanation?.dimensions.every((d) => d.source.length > 0),
    ).toBe(true);
  });

  it("dedups candidates by canonical key and observations by content hash", async () => {
    const { store, connector, now } = setup();
    const ready = createReadyTask(store);
    await runSearchCycle({ store, connector, now }, ready.task_id, `r1:${uuidv7()}`);
    // Second cycle with unchanged facts: no duplicate candidate or observation.
    const task = store.getTask(ready.task_id) as BuyerTask;
    const back = store.transitionTask({
      task_id: task.task_id,
      to: "searching",
      expected_version: task.version,
      event_type: "search_started",
      origin: "user",
      idempotency_key: `again:${uuidv7()}`,
    });
    await runSearchCycle({ store, connector, now }, back.task_id, `r2:${uuidv7()}`);
    const candidates = store.listCandidates(ready.task_id);
    expect(candidates).toHaveLength(1);
    expect(store.observations(candidates[0]?.candidate_id ?? "")).toHaveLength(1);
  });

  it("installs tracking rules and waits when nothing is eligible", async () => {
    const { store, connector, now } = setup([
      fakeConnectorProduct({ sku: "sku-oos", stock: 0 }),
    ]);
    const ready = createReadyTask(store, {
      constraints: { max_total_price: 200 },
    });
    const result = await runSearchCycle(
      { store, connector, now },
      ready.task_id,
      `run:${uuidv7()}`,
    );
    expect(result.outcome).toBe("tracking");
    const rules = store.rulesForTask(ready.task_id);
    expect(rules.map((r) => r.rule_type)).toContain("price_below");
    expect(rules.map((r) => r.rule_type)).toContain("periodic_review");
    expect(result.task.next_run_at).toBeDefined();
  });

  it("a transient connector error fails the task retriably without stale facts", async () => {
    const { store, now } = setup();
    const connector = new FakeCommerceConnector();
    connector.searchProducts = () =>
      Promise.reject(new Error("gateway unreachable"));
    const ready = createReadyTask(store);
    const result = await runSearchCycle(
      { store, connector, now },
      ready.task_id,
      `run:${uuidv7()}`,
    );
    expect(result.outcome).toBe("failed");
    expect(result.task.status).toBe("failed");
    const events = store.taskEvents(ready.task_id);
    expect(events.some((e) => e.type === "failed")).toBe(true);
  });

  it("searching 转移设置 next_run_at：崩溃后 dueTasks 可恢复（评审项 H4）", async () => {
    const { store, setNow } = setup();
    const task = createReadyTask(store);
    // 新激活任务 next_run_at 为空——此前 searching 转移保留空值，
    // 崩溃后 dueTasks（要求 NOT NULL）永不选中，任务永久卡死。
    expect(store.getTask(task.task_id)?.next_run_at).toBeUndefined();

    // 卡住搜索的 connector：runSearchCycle 同步执行到 awaiting 之前，
    // 让我们断言 searching 中间态。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging = new FakeCommerceConnector();
    const original = hanging.searchProducts.bind(hanging);
    hanging.searchProducts = async () => {
      await gate;
      return original({});
    };
    const cycle = runSearchCycle(
      { store, connector: hanging, now: () => "2026-08-05T12:00:01+08:00" },
      task.task_id,
      "run:1",
    );

    const searching = store.getTask(task.task_id);
    expect(searching?.status).toBe("searching");
    // 关键断言：next_run_at 非 NULL 且在锁定期内（正常完成由 tracking
    // 转移覆盖；崩溃后到期即被 dueTasks 重新选中 → 恢复路径真实存在）。
    expect(searching?.next_run_at).not.toBeNull();
    expect(Date.parse(searching?.next_run_at ?? "")).toBeGreaterThan(
      Date.parse("2026-08-05T12:00:01+08:00"),
    );

    // 模拟崩溃（搜索永远不完成，进程重启）：锁定期到期后 dueTasks 选中它。
    const due = store.dueTasks("2026-08-05T12:03:00+08:00", 10);
    expect(due.some((t) => t.task_id === task.task_id)).toBe(true);

    release();
    await cycle;
    setNow("2026-08-05T12:03:00+08:00");
  });
});

describe("tracking rules and scheduler (§11.7, §13)", () => {
  it("price_below triggers once facts change; multiple rules merge into one notification", async () => {
    const { store, connector, scheduler, setNow, now } = setup([
      fakeConnectorProduct({ sku: "sku-001", price: 120 }),
    ]);
    const ready = createReadyTask(store);
    await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    const candidate = store.listCandidates(ready.task_id)[0];
    expect(candidate).toBeDefined();
    const candidateId = candidate?.candidate_id as string;

    store.addTrackingRule({
      task_id: ready.task_id,
      candidate_id: candidateId,
      rule_type: "price_below",
      condition: { threshold: 100 },
      interval_seconds: 60,
      idempotency_key: `rule1:${uuidv7()}`,
    });
    store.addTrackingRule({
      task_id: ready.task_id,
      candidate_id: candidateId,
      rule_type: "stock_available",
      condition: {},
      interval_seconds: 60,
      idempotency_key: `rule2:${uuidv7()}`,
    });

    // Not yet due.
    let tick = await scheduler.tick();
    expect(tick.checked_rules).toBe(0);

    // Price drops; both rules come due.
    setNow("2026-08-05T12:02:00+08:00");
    connector.put(fakeConnectorProduct({ sku: "sku-001", price: 90 }));
    tick = await scheduler.tick();
    expect(tick.checked_rules).toBe(2);
    // Two rules, one candidate => exactly one merged notification.
    expect(tick.notifications).toHaveLength(1);
    expect(tick.notifications[0]?.summary).toContain("已低于");
    expect(tick.notifications[0]?.summary).toContain("已到货");
    expect(tick.notifications[0]?.rule_ids).toHaveLength(2);
    const events = store
      .taskEvents(ready.task_id)
      .filter((e) => e.type === "notification");
    expect(events).toHaveLength(1);
  });

  it("cooldown suppresses retriggering; transient observe errors reschedule", async () => {
    const { store, connector, scheduler, setNow } = setup([
      fakeConnectorProduct({ sku: "sku-001", price: 80 }),
    ]);
    const ready = createReadyTask(store);
    await runSearchCycle(
      { store, connector, now: () => T0 },
      ready.task_id,
      `r:${uuidv7()}`,
    );
    const candidateId = store.listCandidates(ready.task_id)[0]?.candidate_id as string;
    store.addTrackingRule({
      task_id: ready.task_id,
      candidate_id: candidateId,
      rule_type: "price_below",
      condition: { threshold: 100 },
      interval_seconds: 60,
      cooldown_seconds: 3600,
      idempotency_key: `rule:${uuidv7()}`,
    });
    setNow("2026-08-05T12:02:00+08:00");
    let tick = await scheduler.tick();
    expect(tick.notifications).toHaveLength(1);
    // Inside cooldown: checked but not retriggered.
    setNow("2026-08-05T12:04:00+08:00");
    tick = await scheduler.tick();
    expect(tick.checked_rules).toBe(1);
    expect(tick.notifications).toHaveLength(0);

    // Connector failure: error recorded, rule rescheduled, no crash.
    connector.getProduct = () => Promise.reject(new Error("boom"));
    setNow("2026-08-05T13:30:00+08:00");
    tick = await scheduler.tick();
    expect(tick.errors.length).toBeGreaterThan(0);
    expect(tick.notifications).toHaveLength(0);
  });

  it("restart recovery: due tasks are picked up from the database after a fresh scheduler", async () => {
    const { store, connector, setNow, now } = setup([
      fakeConnectorProduct({ sku: "sku-001", stock: 0 }),
    ]);
    const ready = createReadyTask(store, { constraints: { max_total_price: 200 } });
    const cycle = await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    expect(cycle.outcome).toBe("tracking");

    // Simulate a restart: a brand-new scheduler over the same database.
    setNow("2026-08-05T12:31:00+08:00");
    connector.put(fakeConnectorProduct({ sku: "sku-001", stock: 8 }));
    const recovered = new TaskScheduler({ store, connectors: [connector], now });
    const tick = await recovered.tick();
    expect(tick.tasks_searched).toContain(ready.task_id);
    expect(store.getTask(ready.task_id)?.status).toBe("awaiting_user");
  });

  it("任务级默认规则在重搜索后基于新鲜观察求值：price_below 触发降价通知（评审项 H5）", async () => {
    const { store, connector, scheduler, setNow, now } = setup([
      fakeConnectorProduct({ sku: "sku-001", price: 150 }), // 高于预算 → 无 eligible
    ]);
    const ready = createReadyTask(store, { constraints: { max_total_price: 100 } });
    // 首次搜索：无 eligible → tracking + 默认任务级规则（price_below threshold=100）
    await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    expect(store.getTask(ready.task_id)?.status).toBe("tracking");
    const rules = store.rulesForTask(ready.task_id);
    expect(rules.some((r) => r.rule_type === "price_below" && r.candidate_id === undefined)).toBe(true);

    // 价格降到阈值内：重搜索写入新鲜观察后，任务级 price_below 必须被求值并通知
    //（修复前只 markRuleChecked、条件永不求值——承诺的"降价通知"静默失效）。
    // 12:30 = 12:00 + 默认 interval(1800s)，next_run_at 到期后才重搜。
    setNow("2026-08-05T12:35:00+08:00");
    connector.put(fakeConnectorProduct({ sku: "sku-001", price: 90 }));
    const tick = await scheduler.tick();
    const notified = tick.notifications.find(
      (n) => n.task_id === ready.task_id && n.rule_ids.length === 1,
    );
    expect(notified).toBeDefined();
    expect(notified?.summary).toContain("已低于");
  });

  it("expires tracking tasks past their deadline", async () => {
    const { store, connector, scheduler, setNow, now } = setup([
      fakeConnectorProduct({ sku: "sku-001", stock: 0 }),
    ]);
    const ready = createReadyTask(store, {
      constraints: { max_total_price: 200 },
      expires_at: "2026-08-06T00:00:00+08:00",
    });
    await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    setNow("2026-08-07T00:00:00+08:00");
    const tick = await scheduler.tick();
    expect(tick.tasks_expired).toContain(ready.task_id);
    expect(store.getTask(ready.task_id)?.status).toBe("expired");
  });
});

describe("non-binding selection (§12.4)", () => {
  it("records the selection with snapshot, authorization and the no-order boundary", async () => {
    const { store, connector, now } = setup();
    const ready = createReadyTask(store);
    const cycle = await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    const candidate = cycle.shortlist[0]?.candidate;
    expect(candidate).toBeDefined();
    const candidateId = candidate?.candidate_id as string;
    const task = store.getTask(ready.task_id) as BuyerTask;

    store.appendEvent(
      task.task_id,
      "selected",
      {
        candidate_id: candidateId,
        observation_id: candidate?.latest_observation_id ?? null,
        selected_at: now(),
        authorization: "用户说：就要这个",
        boundary: "未创建订单；非绑定选定不声明价格、库存或交期仍然有效",
      },
      "user",
      `select:${uuidv7()}`,
    );
    store.updateCandidate(candidateId, { candidate_status: "selected" });
    const selected = store.transitionTask({
      task_id: task.task_id,
      to: "selected_nonbinding",
      expected_version: task.version,
      event_type: "status_changed",
      payload: { selected_candidate_id: candidateId },
      origin: "user",
      idempotency_key: `sel:${uuidv7()}`,
      selected_candidate_id: candidateId,
    });
    expect(selected.status).toBe("selected_nonbinding");
    const events = store.taskEvents(task.task_id);
    const sel = events.find((e) => e.type === "selected");
    expect(sel?.payload.boundary).toContain("未创建订单");
    // The store has no order/payment/reservation concepts at all.
    const tables = (
      store as unknown as { db: DatabaseSync }
    ).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables.filter((t) => /order|payment|reservation/i.test(t))).toEqual([]);
  });
});

describe("private budget vaulting (§11.2, §6.3)", () => {
  it("seals a private budget into the Vault; plaintext never reaches constraints_json", () => {
    const { db, store } = setup([], { withVault: true });
    const task = store.createTask({
      goal_text: "买一个净水器",
      intent: { category: "appliance", query_text: "净水器" },
      constraints: { max_total_price: 2499 },
      idempotency_key: `c:${uuidv7()}`,
    });
    expect(task.constraints.max_total_price).toBeUndefined();
    expect(task.constraints.max_total_price_vault_ref).toMatch(/^vr_/);
    const row = db
      .prepare("SELECT constraints_json FROM buyer_tasks WHERE task_id = ?")
      .get(task.task_id) as { constraints_json: string };
    expect(row.constraints_json).not.toContain("2499");
    expect(row.constraints_json).toContain("max_total_price_vault_ref");
    expect(store.resolveBudget(task.constraints)).toBe(2499);
  });

  it("without a data key the budget stays in the 0600 DB but the tool output redacts it", async () => {
    const { store } = setup([]); // no vault key: documented plaintext fallback
    const task = store.createTask({
      goal_text: "买一个净水器",
      intent: { category: "appliance", query_text: "净水器" },
      constraints: { max_total_price: 2499 },
      idempotency_key: `c:${uuidv7()}`,
    });
    expect(store.resolveBudget(task.constraints)).toBe(2499);
    const tools = buildBuyerTools({
      store,
      connector: new FakeCommerceConnector([]),
      profile: testBuyerProfile(),
      now: () => T0,
    });
    const getTask = tools.find((t) => t.name === "get_buyer_task");
    expect(getTask).toBeDefined();
    const result = await getTask!.execute("call-1", { task_id: task.task_id }, undefined, undefined, undefined);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("2499");
    expect(text).toContain("私密预算");
  });

  it("a vaulted budget still hard-filters in the search cycle", async () => {
    const { store, connector } = setup([{ ...fakeConnectorProduct(), price: 500 }], {
      withVault: true,
    });
    const task = createReadyTask(store, { constraints: { max_total_price: 200 } });
    const result = await runSearchCycle(
      { store, connector, now: () => T0 },
      task.task_id,
      `run:${uuidv7()}`,
    );
    expect(result.outcome).toBe("tracking");
    expect(store.listCandidates(task.task_id)[0]?.eligibility).toBe("ineligible");
  });
});

describe("connector failure classification (§18.1, §18.2)", () => {
  it("a transient connector error schedules a retry instead of failing the task", async () => {
    const { store, now, setNow } = setup([fakeConnectorProduct()]);
    const flaky = new FlakyConnector(new FakeCommerceConnector([fakeConnectorProduct()]));
    const task = createReadyTask(store, {});

    const first = await runSearchCycle({ store, connector: flaky, now }, task.task_id, `run:1`);
    expect(first.outcome).toBe("retry");
    expect(first.task.status).toBe("tracking");
    expect(first.task.next_run_at).toBeDefined();

    // Advance past the backoff: the scheduler re-runs and the search succeeds.
    setNow(new Date(Date.parse(first.task.next_run_at as string) + 1000).toISOString());
    const second = await runSearchCycle({ store, connector: flaky, now }, task.task_id, `run:2`);
    expect(second.outcome).toBe("shortlist_ready");
    expect(second.task.status).toBe("awaiting_user");
  });

  it("the retry backoff is recorded as a task event (visible, not silent)", async () => {
    const { store, now } = setup([fakeConnectorProduct()]);
    const flaky = new FlakyConnector(new FakeCommerceConnector([fakeConnectorProduct()]));
    const task = createReadyTask(store, {});
    await runSearchCycle({ store, connector: flaky, now }, task.task_id, `run:1`);
    const retry = store.taskEvents(task.task_id).find((e) => e.type === "connector_retry");
    expect(retry).toBeDefined();
    expect(retry?.payload.retriable).toBe(true);
  });

  it("get_buyer_task surfaces the last failure and next retry (never 'tracking = all clear')", async () => {
    const { store, now } = setup([fakeConnectorProduct()]);
    const flaky = new FlakyConnector(new FakeCommerceConnector([fakeConnectorProduct()]));
    const task = createReadyTask(store, {});
    const cycle = await runSearchCycle({ store, connector: flaky, now }, task.task_id, `run:1`);
    expect(cycle.outcome).toBe("retry");

    const tools = buildBuyerTools({
      store,
      connector: flaky,
      profile: testBuyerProfile(),
      now,
    });
    const getTask = tools.find((t) => t.name === "get_buyer_task");
    const result = await getTask!.execute("call-1", { task_id: task.task_id }, undefined, undefined, undefined);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("tracking");
    expect(text).toContain("上次搜索失败");
    expect(text).toContain("gateway blip");
    expect(text).toContain("下次唤醒");
  });
});

function toolsWithMode(
  mode: "manual" | "supervised" | "autopilot",
  store: BuyerTaskStore,
  db: DatabaseSync,
  connector = new FakeCommerceConnector([]),
) {
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const hooks = new Map<string, unknown>();
  const tools = buildBuyerTools({
    store,
    connector,
    profile: testBuyerProfile(),
    approvals,
    mode: () => mode,
    registerPending: (id, h) => hooks.set(id, h),
    now: () => T0,
  });
  return { tools, approvals, hooks };
}

describe("write-gate coverage for buyer tools (§16)", () => {
  it("manual mode never executes create_buyer_task", async () => {
    const { store, db } = setup([]);
    const { tools } = toolsWithMode("manual", store, db);
    const create = tools.find((t) => t.name === "create_buyer_task");
    expect(create).toBeDefined();
    const result = await create!.execute(
      "c1",
      { goal_text: "买一个杯子", intent: { query_text: "杯" } },
      undefined,
      undefined,
      undefined,
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("manual 模式");
    expect(store.listTasks()).toHaveLength(0);
  });

  it("manual mode never executes add_tracking_rule", async () => {
    const { store, db } = setup([]);
    const { tools } = toolsWithMode("manual", store, db);
    const task = createReadyTask(store, {});
    const addRule = tools.find((t) => t.name === "add_tracking_rule");
    expect(addRule).toBeDefined();
    const result = await addRule!.execute(
      "c1",
      { task_id: task.task_id, rule_type: "price_below", condition: { threshold: 90 }, interval_seconds: 1800 },
      undefined,
      undefined,
      undefined,
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("manual 模式");
    expect(store.rulesForTask(task.task_id)).toHaveLength(0);
  });

  it("select_product_nonbinding is advice-only in manual and auto-executes otherwise", async () => {
    const { store, db, connector, now } = setup([fakeConnectorProduct()]);
    const ready = createReadyTask(store, {});
    const cycle = await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    const candidateId = cycle.shortlist[0]?.candidate.candidate_id as string;
    expect(candidateId).toBeDefined();
    const args = { task_id: ready.task_id, candidate_id: candidateId, user_instruction: "就这个" };

    // manual: advice only — never records the selection.
    const manual = toolsWithMode("manual", store, db, connector);
    const select = manual.tools.find((t) => t.name === "select_product_nonbinding");
    const manualResult = await select!.execute("c1", args, undefined, undefined, undefined);
    expect((manualResult.content[0] as { type: "text"; text: string }).text).toContain("manual 模式");
    expect(store.getTask(ready.task_id)?.status).not.toBe("selected_nonbinding");

    // supervised: a local non-binding marker — executes directly, no /approve.
    const supervised = toolsWithMode("supervised", store, db, connector);
    const select2 = supervised.tools.find((t) => t.name === "select_product_nonbinding");
    const supervisedResult = await select2!.execute("c1", args, undefined, undefined, undefined);
    expect((supervisedResult.content[0] as { type: "text"; text: string }).text).toContain("已记录非绑定选定");
    expect(store.getTask(ready.task_id)?.status).toBe("selected_nonbinding");
    expect(supervised.approvals.listPending()).toHaveLength(0);
  });

  it("a selected task can go back to consulting to renegotiate", async () => {
    const { store, connector, now } = setup([fakeConnectorProduct()]);
    const ready = createReadyTask(store, {});
    const cycle = await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    const candidate = cycle.shortlist[0]?.candidate;
    expect(candidate).toBeDefined();
    const task = store.getTask(ready.task_id) as BuyerTask;
    const selected = store.transitionTask({
      task_id: task.task_id,
      to: "selected_nonbinding",
      expected_version: task.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `sel:${uuidv7()}`,
      selected_candidate_id: candidate?.candidate_id,
    });
    expect(selected.status).toBe("selected_nonbinding");
    const renegotiated = store.transitionTask({
      task_id: selected.task_id,
      to: "consulting",
      expected_version: selected.version,
      event_type: "status_changed",
      origin: "user",
      idempotency_key: `re:${uuidv7()}`,
    });
    expect(renegotiated.status).toBe("consulting");
  });
});

describe("P2: expiry, observation freshness and event dedup", () => {
  it("normalizes a +08:00 expires_at to UTC ISO", () => {
    const { store } = setup([]);
    const task = store.createTask({
      goal_text: "买一个电饭煲",
      intent: { category: "appliance", query_text: "电饭煲" },
      expires_at: "2026-08-06T00:00:00+08:00",
      idempotency_key: `c:${uuidv7()}`,
    });
    expect(task.expires_at).toBe("2026-08-05T16:00:00.000Z");
  });

  it("re-verifying unchanged facts extends fresh_until without a new observation", () => {
    const { store } = setup([fakeConnectorProduct()]);
    const task = createReadyTask(store, {});
    const product = fakeConnectorProduct();
    const t0 = "2026-08-05T12:00:00.000Z";
    const candidate = store.upsertCandidate({
      task_id: task.task_id,
      connector_id: "shopping-cli",
      platform: "shopping-cli",
      external_product_id: product.sku,
      sku: product.sku,
      merchant_id: product.merchant.id,
    });
    const base = {
      candidate_id: candidate.candidate_id,
      source_url_or_ref: `shopping-cli:/products/${product.sku}`,
      title: product.title,
      price: { list: product.price, currency: product.currency, delivery_fee: product.delivery.fee },
      promotion: {},
      stock: { quantity: product.stock, observed_at: t0 },
      delivery: { ...product.delivery },
      after_sales: {},
      merchant: { id: product.merchant.id, name: product.merchant.name, city: product.merchant.city, warnings: [] },
      content_hash: observationHash(product),
    };
    const first = store.addObservation({
      ...base,
      observed_at: t0,
      fresh_until: new Date(Date.parse(t0) + 1800 * 1000).toISOString(),
    });
    // Same facts re-verified 31 minutes later: same observation, fresh_until extended.
    const t1 = "2026-08-05T12:31:00.000Z";
    const second = store.addObservation({
      ...base,
      observed_at: t1,
      fresh_until: new Date(Date.parse(t1) + 1800 * 1000).toISOString(),
    });
    expect(second.added).toBe(false);
    expect(second.observation_id).toBe(first.observation_id);
    const latest = store.latestObservation(candidate.candidate_id);
    expect(latest?.fresh_until).toBe(new Date(Date.parse(t1) + 1800 * 1000).toISOString());
    expect(latest?.observed_at).toBe(t0); // trend timestamp preserved
  });

  it("appendEvent returns false for an idempotent replay (notification dedup)", () => {
    const { store } = setup([]);
    const task = createReadyTask(store, {});
    expect(store.appendEvent(task.task_id, "notification", { summary: "x" }, "scheduler", "notify:1")).toBe(true);
    expect(store.appendEvent(task.task_id, "notification", { summary: "x" }, "scheduler", "notify:1")).toBe(false);
  });

  it("scheduler observation freshness uses the task tracking-policy TTL", async () => {
    const { store, connector, scheduler, now, setNow } = setup([fakeConnectorProduct()]);
    const ready = createReadyTask(store, { tracking_policy: { observation_ttl_seconds: 60 } });
    const cycle = await runSearchCycle({ store, connector, now }, ready.task_id, `r:${uuidv7()}`);
    const candidate = cycle.shortlist[0]?.candidate;
    expect(candidate).toBeDefined();
    store.addTrackingRule({
      task_id: ready.task_id,
      candidate_id: candidate?.candidate_id,
      rule_type: "price_below",
      condition: { threshold: 100 },
      interval_seconds: 1,
      cooldown_seconds: 0,
      idempotency_key: `r:${uuidv7()}`,
    });
    // Advance past the rule's next_check_at so the tick re-observes.
    const tickNow = "2026-08-05T12:00:02+08:00";
    setNow(tickNow);
    await scheduler.tick();
    const obs = store.latestObservation(candidate?.candidate_id as string);
    expect(obs).toBeDefined();
    // fresh_until = observe time + the task's custom 60s TTL (not 1800s).
    expect(obs?.fresh_until).toBe(
      new Date(Date.parse(tickNow) + 60 * 1000).toISOString(),
    );
  });

  it("create_buyer_task with identical args is idempotent (no duplicate task)", async () => {
    const { store, db } = setup([]);
    const { tools } = toolsWithMode("supervised", store, db);
    const create = tools.find((t) => t.name === "create_buyer_task");
    expect(create).toBeDefined();
    const args = {
      goal_text: "买一个杯子",
      intent: { query_text: "杯", category: "kitchenware" },
      run_search: false,
    };
    await create!.execute("c1", args, undefined, undefined, undefined);
    const r2 = await create!.execute("c2", args, undefined, undefined, undefined);
    expect(store.listTasks()).toHaveLength(1);
    expect((r2.content[0] as { type: "text"; text: string }).text).toContain("已存在");
  });

  it("create_buyer_task accepts expires_at", async () => {
    const { store, db } = setup([]);
    const { tools } = toolsWithMode("supervised", store, db);
    const create = tools.find((t) => t.name === "create_buyer_task");
    expect(create).toBeDefined();
    await create!.execute(
      "c1",
      {
        goal_text: "买一个杯子",
        intent: { query_text: "杯", category: "kitchenware" },
        expires_at: "2026-08-10T00:00:00+08:00",
        run_search: false,
      },
      undefined,
      undefined,
      undefined,
    );
    const task = store.listTasks()[0];
    expect(task?.expires_at).toBe("2026-08-09T16:00:00.000Z");
  });

  it("create_buyer_task captures quantity and target_unit_price", async () => {
    const { store, db } = setup([]);
    const { tools } = toolsWithMode("supervised", store, db);
    const create = tools.find((t) => t.name === "create_buyer_task");
    expect(create).toBeDefined();
    await create!.execute(
      "c1",
      {
        goal_text: "买2个手写陶瓷杯，砍到100",
        intent: { query_text: "手写陶瓷杯", category: "厨具", quantity: 2, target_unit_price: 100 },
        constraints: { max_total_price: 240 },
        run_search: false,
      },
      undefined,
      undefined,
      undefined,
    );
    const task = store.listTasks()[0] as BuyerTask;
    expect(task.intent.quantity).toBe(2);
    expect(task.intent.target_unit_price).toBe(100);
    expect(task.constraints.max_total_price).toBe(240);
  });
});

// ── 审查 P3-11：search_listings 透出商家声明的每商品成交入口 ─────────────────
describe("search_listings 透出 handoff_destination（P3-11）", () => {
  function listingResult(overrides: Record<string, unknown> = {}) {
    return {
      listing: {
        listing_id: "lst_1",
        listing_type: "product",
        owner_agent_id: "cagt_x",
        merchant_id: "merchant-acme",
        title: "VQ-001 智能保温杯",
        category: "kitchenware",
        listing_digest: "digest-1",
        publication_state: "ACTIVE",
        listing_freshness_state: "FRESH",
        published_at: T0,
        updated_at: T0,
        fresh_until: T0,
        ...overrides,
      },
      merchant: { merchant_id: "merchant-acme", display_name: "Acme" },
      agent: {
        catalog_agent_id: "cagt_x",
        verification_level: "commerce_verified",
        freshness_state: "fresh",
        administrative_state: "active",
      },
      listing_freshness_state: "FRESH",
      authority: "discovery_projection",
      requires_direct_confirmation: true,
    };
  }

  function toolsWithCatalog(results: unknown[], store: BuyerTaskStore) {
    const catalogSource = {
      searchListings: async () => results,
    } as unknown as KiwiCatalogSource;
    return buildBuyerTools({
      store,
      connector: new FakeCommerceConnector([]),
      profile: testBuyerProfile(),
      catalogSource,
      now: () => T0,
    });
  }

  function toolText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.map((c) => c.text ?? "").join("\n");
  }

  it("listing 带 handoff_destination_ref/types → 输出透出，shortlist 链路优先取该值", async () => {
    const { store } = setup([]);
    const declaredRef = "https://shop.example.com/checkout/vq-001";
    const tools = toolsWithCatalog(
      [
        listingResult({
          handoff_destination_types: ["external_checkout_url"],
          handoff_destination_ref: declaredRef,
        }),
      ],
      store,
    );
    const search = tools.find((t) => t.name === "search_listings");
    const result = await search!.execute(
      "call-1",
      { need_description: "保温杯" },
      undefined,
      undefined,
      undefined,
    );
    const rows = JSON.parse(toolText(result)) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handoff_destination_types).toEqual(["external_checkout_url"]);
    expect(rows[0]?.handoff_destination_ref).toBe(declaredRef);

    // 链路：搜索输出原样传给 shortlist_listing → 候选事件携带商家声明
    //（handoff_agreement 优先用声明不现编，端到端由 handoff-e2e.test.ts
    // 「优先用商家声明的每商品成交入口」锁定）。
    const task = createReadyTask(store);
    const shortlist = tools.find((t) => t.name === "shortlist_listing");
    await shortlist!.execute(
      "call-2",
      {
        task_id: task.task_id,
        listing_id: String(rows[0]?.listing_id),
        owner_agent_id: String(rows[0]?.owner_agent_id),
        handoff_destination_types: rows[0]?.handoff_destination_types,
        handoff_destination_ref: rows[0]?.handoff_destination_ref,
      },
      undefined,
      undefined,
      undefined,
    );
    const event = store.taskEvents(task.task_id).find((e) => e.type === "candidate_shortlisted");
    expect(event?.payload.handoff_destination_ref).toBe(declaredRef);
    expect(event?.payload.handoff_destination_types).toEqual(["external_checkout_url"]);
  });

  it("listing 无 handoff_destination 字段 → 输出不带这两个键（回退行为不变）", async () => {
    const { store } = setup([]);
    const tools = toolsWithCatalog([listingResult()], store);
    const search = tools.find((t) => t.name === "search_listings");
    const result = await search!.execute(
      "call-1",
      { need_description: "保温杯" },
      undefined,
      undefined,
      undefined,
    );
    const rows = JSON.parse(toolText(result)) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("handoff_destination_types");
    expect(rows[0]).not.toHaveProperty("handoff_destination_ref");
  });
});
