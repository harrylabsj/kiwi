/**
 * v0.3.0-C consultation tests (design §11.8, §20-C, §19.2):
 * schema v3 migration (consultation_links + action_candidates), the
 * consultation-link store (idempotent, no authoritative-state copy), and the
 * start_consultation tool (approval-routed, task -> consulting, stale
 * approvals invalidated).
 *
 * Deterministic: in-memory SQLite, fake connector + fake marketplace.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  migrateMemorySchema,
  MigrationError,
  MEMORY_SCHEMA_VERSION,
} from "../src/agent/memory/schema.js";
import {
  FakeCommerceConnector,
  fakeConnectorProduct,
} from "../src/agent/connector/fake-connector.js";
import { runSearchCycle } from "../src/agent/buyer/search-loop.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { buildBuyerTools, type BuyerToolDeps } from "../src/agent/buyer/buyer-tools.js";
import {
  WriteApprovalCandidateStore,
  executeApprovedCandidate,
  executionFailureDetail,
} from "../src/agent/merchant/action-candidate.js";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import { testBuyerProfile, testMarketplace } from "./helpers.js";
import { uuidv7 } from "@earendil-works/pi-ai";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "buyer-agent:buyer-001";

type PendingHooks = {
  readPreconditions: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

/** Direct-call view of a tool: the harness passes 5 args, tests pass 2. */
type CallableTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text?: string }[] }>;
};

function setupBuyer() {
  let clock = T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => clock });
  const connector = new FakeCommerceConnector([fakeConnectorProduct()]);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => clock,
  });
  const marketplace = testMarketplace();
  const profile = testBuyerProfile();
  const mode = { value: "supervised" as "manual" | "supervised" | "autopilot" };
  const hooks = new Map<string, PendingHooks>();
  const deps: BuyerToolDeps = {
    store,
    connector,
    profile,
    commerceClient: marketplace.buyer,
    broker: new StaticCredentialBroker({ negotiation: "buyer-token" }),
    approvals,
    mode: () => mode.value,
    now: () => clock,
    registerPending: (id, h) => hooks.set(id, h),
  };
  const tools = buildBuyerTools(deps);
  return {
    db,
    store,
    connector,
    approvals,
    mode,
    hooks,
    getTool: (name: string) => tools.find((t) => t.name === name) as unknown as CallableTool,
    setNow: (t: string) => {
      clock = t;
    },
  };
}

async function shortlistOne(
  store: BuyerTaskStore,
  connector: FakeCommerceConnector,
  taskId: string,
) {
  await runSearchCycle({ store, connector, now: () => T0 }, taskId, `run:${uuidv7()}`);
  const task = store.getTask(taskId) as NonNullable<ReturnType<BuyerTaskStore["getTask"]>>;
  expect(task.status).toBe("awaiting_user");
  const candidate = store.listCandidates(taskId)[0] as NonNullable<
    ReturnType<BuyerTaskStore["listCandidates"]>[number]
  >;
  return { task, candidate };
}

async function createAwaitingTask(store: BuyerTaskStore) {
  const task = store.createTask({
    goal_text: "买 2 个陶瓷杯",
    intent: { category: "kitchenware", query_text: "陶瓷杯" },
    idempotency_key: `create:${uuidv7()}`,
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

describe("schema v3 migration (§11.8, §16)", () => {
  it("adds consultation_links and action_candidates and bumps the schema version", () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("consultation_links");
    expect(tables).toContain("action_candidates");
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    };
    expect(version.v).toBe(6);
    expect(MEMORY_SCHEMA_VERSION).toBe(6);
    db.close();
  });

  it("migrates an existing v2 database forward to v3 without data loss", () => {
    const db = new DatabaseSync(":memory:");
    // Simulate a v0.3.0-B (v2) database by running the real migrations to 2.
    migrateMemorySchema(db, undefined, 2);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES ('buyer-agent:x', 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 2, ?, ?)`,
    ).run(T0, T0);
    expect(() => {
      db.prepare("SELECT * FROM consultation_links").all();
    }).toThrow();
    // Now bring it forward to v3.
    migrateMemorySchema(db, undefined, 3);
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('consultation_links')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("conversation_id");
    expect(db.prepare("SELECT COUNT(*) AS c FROM principals").get() as { c: number }).toMatchObject(
      { c: 1 },
    );
    db.close();
  });

  it("a broken migration rolls back completely (no half-applied v3)", () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db, undefined, 2);
    const broken = {
      3: "CREATE TABLE consultation_links (this_is_invalid", // syntax error
    };
    expect(() => migrateMemorySchema(db, broken, 3)).toThrow(MigrationError);
    // The v3 row was rolled back.
    const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    };
    expect(version.v).toBe(2);
    db.close();
  });
});

describe("consultation link store (§11.8)", () => {
  it("creates a link, is idempotent per (task, conversation), and updates", async () => {
    const { store, connector } = setupBuyer();
    const task = await createAwaitingTask(store);
    const { candidate } = await shortlistOne(store, connector, task.task_id);

    const key = `consult:${uuidv7()}`;
    const link = store.createConsultationLink({
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      connector_id: "shopping-cli",
      conversation_id: "conv-merchant-001",
      idempotency_key: key,
    });
    expect(link.status).toBe("consulting");
    expect(link.conversation_id).toBe("conv-merchant-001");

    // Replay with the same idempotency key returns the existing link.
    const replay = store.createConsultationLink({
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      connector_id: "shopping-cli",
      conversation_id: "conv-merchant-001",
      idempotency_key: key,
    });
    expect(replay.link_id).toBe(link.link_id);
    expect(store.linksForTask(task.task_id)).toHaveLength(1);

    // The link never copies authoritative state; only the cursor is ours.
    const updated = store.updateConsultationLink(link.link_id, {
      status: "negotiating",
      last_message_id: "m2",
    });
    expect(updated.status).toBe("negotiating");
    expect(updated.last_message_id).toBe("m2");
    expect(store.linkByConversation("conv-merchant-001")?.link_id).toBe(link.link_id);
  });

  it("rejects a link for a missing task or a foreign candidate", async () => {
    const { store, connector } = setupBuyer();
    const task = await createAwaitingTask(store);
    const { candidate } = await shortlistOne(store, connector, task.task_id);
    expect(() =>
      store.createConsultationLink({
        task_id: "task-missing",
        candidate_id: candidate.candidate_id,
        connector_id: "shopping-cli",
        conversation_id: "conv-x",
        idempotency_key: `c:${uuidv7()}`,
      }),
    ).toThrow(/no task/);
    expect(() =>
      store.createConsultationLink({
        task_id: task.task_id,
        candidate_id: "cand-foreign",
        connector_id: "shopping-cli",
        conversation_id: "conv-y",
        idempotency_key: `c:${uuidv7()}`,
      }),
    ).toThrow(/no candidate/);
  });
});

describe("start_consultation tool (§15.2, §20-C)", () => {
  it("supervised: creates an approval candidate; approve links the conversation and transitions to consulting", async () => {
    const h = setupBuyer();
    const task = await createAwaitingTask(h.store);
    const { candidate } = await shortlistOne(h.store, h.connector, task.task_id);

    const tool = h.getTool("start_consultation");
    const result = await tool.execute("c1", {
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      message: "请问 2 件有优惠吗？",
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("等待批准");

    const pending = h.approvals.listPending();
    expect(pending).toHaveLength(1);
    const cand = pending[0] as NonNullable<
      ReturnType<WriteApprovalCandidateStore["listPending"]>[number]
    >;
    expect(cand.tool).toBe("start_consultation");
    expect(cand.task_id).toBe(task.task_id);
    expect(cand.arguments).toMatchObject({ task_id: task.task_id, message: "请问 2 件有优惠吗？" });

    h.approvals.markApproved(cand.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      cand.candidate_id,
      h.hooks.get(cand.candidate_id) as PendingHooks,
    );
    expect(outcome.kind).toBe("executed");
    const links = h.store.linksForTask(task.task_id);
    expect(links).toHaveLength(1);
    expect(links[0]?.conversation_id).toBe("conv-merchant-001");
    expect(h.store.getTask(task.task_id)?.status).toBe("consulting");
    const events = h.store.taskEvents(task.task_id).filter((e) => e.type === "consultation_linked");
    expect(events).toHaveLength(1);
  });

  it("执行体抛错 → 候选 superseded，不重复执行（评审项 P3-4：防外部副作用重放）", async () => {
    const h = setupBuyer();
    const task = await createAwaitingTask(h.store);
    const { candidate } = await shortlistOne(h.store, h.connector, task.task_id);
    const tool = h.getTool("start_consultation");
    await tool.execute("c2", {
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      message: "hi",
    });
    const cand = h.approvals.listPending()[0];
    expect(cand).toBeDefined();
    h.approvals.markApproved(cand!.candidate_id);

    // 执行体抛错（模拟网关在本地落账前故障）：修复前候选停留 approved，
    // 操作者可再次 /approve——若首次执行已创建外部会话，重试会重复创建。
    const hooks = h.hooks.get(cand!.candidate_id) as PendingHooks;
    const throwing: PendingHooks = {
      ...hooks,
      execute: async () => {
        throw new Error("gateway unreachable");
      },
    };
    const outcome = await executeApprovedCandidate(h.approvals, cand!.candidate_id, throwing);
    expect(outcome.kind).toBe("stale");
    // 候选已 superseded：再次批准无法执行（防副作用重放）
    const again = await executeApprovedCandidate(h.approvals, cand!.candidate_id, throwing);
    expect(again.kind).toBe("not_approvable");
    // 本地未建立咨询（外部副作用不发生在本仓库内）
    expect(h.store.getTask(task.task_id)?.status).not.toBe("consulting");
  });

  it("rejects a task that is not awaiting_user or a candidate not shortlisted", async () => {
    const h = setupBuyer();
    const task = await createAwaitingTask(h.store);
    const { candidate } = await shortlistOne(h.store, h.connector, task.task_id);

    // Downgrade the candidate out of the shortlist.
    h.store.updateCandidate(candidate.candidate_id, { candidate_status: "tracked" });
    const tool = h.getTool("start_consultation");
    const badCandidate = await tool.execute("c1", {
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      message: "hi",
    });
    expect(badCandidate.content[0]?.type === "text" ? badCandidate.content[0].text : "").toContain(
      "not shortlisted",
    );

    // Task in `ready` cannot consult either.
    const fresh = await createAwaitingTask(h.store);
    const ready = h.store.transitionTask({
      task_id: fresh.task_id,
      to: "searching",
      expected_version: fresh.version,
      event_type: "search_started",
      origin: "user",
      idempotency_key: `search:${uuidv7()}`,
    });
    expect(ready.status).toBe("searching");
    const result = await tool.execute("c2", {
      task_id: fresh.task_id,
      candidate_id: candidate.candidate_id,
      message: "hi",
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "awaiting_user",
    );
  });

  it("a stale approval is invalidated when the task moves before approve", async () => {
    const h = setupBuyer();
    const task = await createAwaitingTask(h.store);
    const { candidate } = await shortlistOne(h.store, h.connector, task.task_id);
    const tool = h.getTool("start_consultation");
    await tool.execute("c1", {
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      message: "请问？",
    });
    const cand = h.approvals.listPending()[0] as NonNullable<
      ReturnType<WriteApprovalCandidateStore["listPending"]>[number]
    >;

    // The user moves the task before the operator approves.
    const current = h.store.getTask(task.task_id) as NonNullable<
      ReturnType<BuyerTaskStore["getTask"]>
    >;
    h.store.transitionTask({
      task_id: task.task_id,
      to: "cancelled",
      expected_version: current.version,
      event_type: "cancelled",
      origin: "user",
      idempotency_key: `cancel:${uuidv7()}`,
    });

    h.approvals.markApproved(cand.candidate_id);
    const outcome = await executeApprovedCandidate(
      h.approvals,
      cand.candidate_id,
      h.hooks.get(cand.candidate_id) as PendingHooks,
    );
    expect(outcome.kind).toBe("stale");
    expect(h.store.linksForTask(task.task_id)).toHaveLength(0);
    expect(h.store.getTask(task.task_id)?.status).toBe("cancelled");
  });

  it("manual mode is advice-only — no consultation is ever started", async () => {
    const h = setupBuyer();
    h.mode.value = "manual";
    const task = await createAwaitingTask(h.store);
    const { candidate } = await shortlistOne(h.store, h.connector, task.task_id);
    const result = await h.getTool("start_consultation").execute("c1", {
      task_id: task.task_id,
      candidate_id: candidate.candidate_id,
      message: "hi",
    });
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("manual");
    expect(h.store.linksForTask(task.task_id)).toHaveLength(0);
    expect(h.store.getTask(task.task_id)?.status).toBe("awaiting_user");
  });
});

describe("executionFailureDetail（/approve 失败带具体原因）", () => {
  it("从 {ok:false, error} 提取原因", () => {
    const detail = executionFailureDetail({
      ok: false,
      error: "商家成交价 8999.00 元/件 超过买方预算上限 8900.00 元/件，已拒绝成交",
    });
    expect(detail).toContain("超过买方预算上限");
  });

  it("从 textResult content[].text 提取", () => {
    const detail = executionFailureDetail({
      ok: false,
      content: [{ type: "text", text: "磋商失败：商家不可用（network）" }],
    });
    expect(detail).toContain("磋商失败");
  });

  it("无 detail 时回退空串", () => {
    expect(executionFailureDetail({ ok: false })).toBe("");
  });
});
