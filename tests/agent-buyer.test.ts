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
import {
  FakeCommerceConnector,
  fakeConnectorProduct,
} from "../src/agent/connector/fake-connector.js";
import { runSearchCycle } from "../src/agent/buyer/search-loop.js";
import { TaskScheduler } from "../src/agent/buyer/scheduler.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { BuyerTaskError, type BuyerTask } from "../src/agent/buyer/types.js";
import { uuidv7 } from "@earendil-works/pi-ai";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "buyer-agent:buyer-001";

function setup(products = [fakeConnectorProduct()]) {
  let clock = T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 2, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => clock });
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
