/**
 * A321 2-12 返修自有控制。
 *
 * 红根因（A317 p212-v6 实证）：幂等事件存在但 link 行缺失时，旧控制流
 * COMMIT 后**落穿 INSERT**——typed conflict 抛出的同时新 link 0→1 已自提交
 * （已持久效果 + 错误并发）。返修：幂等命中分支在 COMMIT 后立即终止
 * （同 link 返回 / 缺失 typed conflict），零新 link/零新 event，无
 * finally 抛错遮蔽、无 catch ROLLBACK 修已提交行。
 *
 * R1/R2 与既有测试同形，但按 v6 口径做**行级强断言**（行身份/计数/事件实际核）。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { uuidv7 } from "@earendil-works/pi-ai";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "buyer-agent:buyer-001";

function setup(): { store: BuyerTaskStore; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => T0 });
  return { store, db };
}

function makeTask(store: BuyerTaskStore): string {
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
  }).task_id;
}

function linkCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM consultation_links").get() as { n: number }).n;
}
function eventCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number }).n;
}
function seedOrphanEvent(db: DatabaseSync, key: string, taskId: string): void {
  // 幂等事件存在而 link 行缺失的形态（真实崩溃/删除窗口）
  db.prepare(
    `INSERT INTO task_events (event_id, task_id, type, origin, payload_json, idempotency_key, created_at)
     VALUES (?, ?, 'consultation_linked', 'model', '{}', ?, ?)`,
  ).run(`evt-${uuidv7()}`, taskId, key, T0);
}

describe("A321 2-12 返修：幂等命中缺失 link 立即终止", () => {
  it("R1: 事件存在 link 缺失 → typed conflict，零新 link/零新 event", () => {
    const { store, db } = setup();
    const taskId = makeTask(store);
    const key = `consult:${uuidv7()}`;
    seedOrphanEvent(db, key, taskId);
    const linksBefore = linkCount(db);
    const eventsBefore = eventCount(db);

    let caught: { code?: string; message?: string } | undefined;
    try {
      store.createConsultationLink({
        task_id: taskId,
        connector_id: "shopping-cli",
        conversation_id: "conv-missing",
        idempotency_key: key,
      });
    } catch (err) {
      caught = err as { code?: string; message?: string };
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("conflict");
    expect(caught?.message).toContain("consultation link row is missing");
    // 行级强断言（v6 口径）：零新 link、零新 event
    expect(linkCount(db)).toBe(linksBefore);
    expect(eventCount(db)).toBe(eventsBefore);
  });

  it("R2: 正常重放同键 → 同 link_id 同内容，计数不变", () => {
    const { store, db } = setup();
    const taskId = makeTask(store);
    const key = `consult:${uuidv7()}`;
    const first = store.createConsultationLink({
      task_id: taskId,
      connector_id: "shopping-cli",
      conversation_id: "conv-r2",
      idempotency_key: key,
    });
    const linksAfterFirst = linkCount(db);
    const eventsAfterFirst = eventCount(db);
    const replay = store.createConsultationLink({
      task_id: taskId,
      connector_id: "shopping-cli",
      conversation_id: "conv-r2",
      idempotency_key: key,
    });
    expect(replay.link_id).toBe(first.link_id);
    expect(replay.status).toBe(first.status);
    expect(replay.created_at).toBe(first.created_at);
    expect(linkCount(db)).toBe(linksAfterFirst);
    expect(eventCount(db)).toBe(eventsAfterFirst);
  });

  it("同幂等键 + 不同 conversation → 键绑定冲突终止，零新 link", () => {
    const { store, db } = setup();
    const taskId = makeTask(store);
    const key = `consult:${uuidv7()}`;
    store.createConsultationLink({
      task_id: taskId,
      connector_id: "shopping-cli",
      conversation_id: "conv-a",
      idempotency_key: key,
    });
    const linksBefore = linkCount(db);
    let caught: { code?: string } | undefined;
    try {
      store.createConsultationLink({
        task_id: taskId,
        connector_id: "shopping-cli",
        conversation_id: "conv-b",
        idempotency_key: key,
      });
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe("conflict");
    expect(linkCount(db)).toBe(linksBefore);
  });

  it("全新键正常建链不受影响（回归）", () => {
    const { store, db } = setup();
    const taskId = makeTask(store);
    const link = store.createConsultationLink({
      task_id: taskId,
      connector_id: "shopping-cli",
      conversation_id: "conv-new",
      idempotency_key: `consult:${uuidv7()}`,
    });
    expect(link.status).toBe("consulting");
    expect(linkCount(db)).toBe(1);
  });
});
