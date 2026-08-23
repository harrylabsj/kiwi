/**
 * M0 供应商关系指标测试（pull-relationship 设计 v0.1 §13/§14）：
 * `kiwi buyer supplier metrics` 的 supplierMetrics() —— 注入 now + mkdtempSync
 * 真实 state.sqlite，构造关系/事件/观察数据，断言各指标数值与空库、分母为 0
 * 的边界。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDatabase } from "../src/agent/agent-db.js";
import { BuyerTaskStore } from "../src/agent/buyer/task-store.js";
import { SupplierRelationshipStore } from "../src/agent/supplier/store.js";
import { supplierMetrics } from "../src/product-supplier.js";

const NOW = "2026-08-25T00:00:00.000Z";
const PRINCIPAL = "buyer-agent:buyer-001";

let dir: string;

function iso(day: string): string {
  return `2026-${day}T00:00:00.000Z`;
}

/** 打开临时 buyer DB（state.sqlite），插入 buyer principal，返回带时钟的 stores。 */
function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "kiwi-supplier-metrics-"));
  const db = openAgentDatabase(path.join(dir, "state.sqlite"));
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 2, ?, ?)`,
  ).run(PRINCIPAL, iso("07-01"), iso("07-01"));
  let clock = iso("07-01");
  const supplierStore = new SupplierRelationshipStore({
    db,
    principalId: PRINCIPAL,
    now: () => clock,
  });
  const taskStore = new BuyerTaskStore({ db, principalId: PRINCIPAL, now: () => clock });
  return {
    db,
    supplierStore,
    taskStore,
    setNow: (t: string) => {
      clock = t;
    },
    close: () => {
      db.close();
    },
  };
}

function cardUrl(merchant: string): string {
  return `https://${merchant}.example/.well-known/agent-card.json`;
}

function saveRel(
  ctx: ReturnType<typeof setup>,
  merchant: string,
  type: "saved" | "watched" | "preferred",
  createdAt: string,
): string {
  ctx.setNow(createdAt);
  const rel = ctx.supplierStore.saveRelationship({
    merchant_id: merchant,
    canonical_domain: `${merchant}.example`,
    agent_card_url: cardUrl(merchant),
    relationship_type: type,
  });
  return rel.relationship_id;
}

function rfq(
  ctx: ReturnType<typeof setup>,
  taskId: string,
  merchant: string,
  at: string,
  ok: boolean,
  key: string,
): void {
  ctx.setNow(at);
  ctx.taskStore.appendEvent(
    taskId,
    "a2a_negotiated",
    ok
      ? {
          ok: true,
          negotiation_id: `neg-${key}`,
          catalog_agent_id: merchant,
          agent_card_url: cardUrl(merchant),
        }
      : { ok: false, error: "declined", negotiation_id: `neg-${key}` },
    "model",
    `rfq-${key}`,
  );
}

function suggest(
  ctx: ReturnType<typeof setup>,
  taskId: string,
  merchant: string,
  at: string,
  key: string,
): void {
  ctx.setNow(at);
  ctx.taskStore.appendEvent(
    taskId,
    "supplier_save_suggested",
    { merchant_id: merchant, catalog_agent_id: merchant, negotiation_id: `neg-${key}` },
    "model",
    `suggest-${key}`,
  );
}

const metrics = () => supplierMetrics({ dataDir: dir, now: () => NOW });

beforeEach(() => {
  dir = "";
});

afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("supplierMetrics（§14 M0 指标）", () => {
  it("空库：计数为 0，所有比率 value=null（分母为 0 不虚报）", async () => {
    const ctx = setup();
    ctx.close();
    const m = await metrics();
    expect(m.principal_id).toBe(PRINCIPAL);
    expect(m.generated_at).toBe(NOW);
    expect(m.successful_rfqs).toBe(0);
    expect(m.failed_rfqs).toBe(0);
    expect(m.save_after_rfq).toMatchObject({ value: null, numerator: 0, denominator: 0 });
    expect(m.relationships_by_type_status).toMatchObject({
      total: 0,
      active_watched_preferred: 0,
      buckets: [],
    });
    expect(m.reuse_7d).toMatchObject({ value: null, numerator: 0, denominator: 0 });
    expect(m.reuse_30d).toMatchObject({ value: null, numerator: 0, denominator: 0 });
    expect(m.relationship_assisted_rfq).toMatchObject({ value: null, numerator: 0, denominator: 0 });
    expect(m.repeat_merchants).toEqual({
      merchants_with_successful_rfq: 0,
      merchants_with_repeat_rfq: 0,
      successful_rfqs: 0,
      unidentified_merchant_rfqs: 0,
    });
    expect(m.observations.total).toBe(0);
    expect(m.observations.on_active_watched).toMatchObject({ value: null });
    expect(m.observations.notification_hit_rate.value).toBeNull();
    expect(m.lifecycle.paused).toMatchObject({ value: null, denominator: 0 });
    expect(m.lifecycle.deleted).toMatchObject({ value: null, denominator: 0 });
    expect(m.health.review_required).toMatchObject({ value: null, denominator: 0 });
    expect(m.health.degraded_sources).toMatchObject({ value: null, denominator: 0 });
  });

  it("有建议事件但无任何关系：conversion = 0/N（不是 null）", async () => {
    const ctx = setup();
    ctx.setNow(iso("08-01"));
    const task = ctx.taskStore.createTask({
      goal_text: "买扩展坞",
      intent: { query_text: "dock" },
      idempotency_key: "task-1",
    });
    suggest(ctx, task.task_id, "m1", iso("08-02"), "s1");
    suggest(ctx, task.task_id, "m2", iso("08-03"), "s2");
    ctx.close();
    const m = await metrics();
    expect(m.save_after_rfq).toMatchObject({ value: 0, numerator: 0, denominator: 2 });
  });

  it("完整场景：conversion / 复用 / assisted / 重复 merchant / lifecycle / health", async () => {
    const ctx = setup();
    ctx.setNow(iso("08-01"));
    const task = ctx.taskStore.createTask({
      goal_text: "买扩展坞",
      intent: { query_text: "dock" },
      idempotency_key: "task-1",
    });
    // 建议事件（M0 提示）。
    suggest(ctx, task.task_id, "m1", iso("08-02"), "s1");
    suggest(ctx, task.task_id, "m2", iso("08-03"), "s2");
    // 关系：r1 在建议 7 天内建立（转化）；r2 在 7 天外建立（不转化）。
    const r1 = saveRel(ctx, "m1", "saved", iso("08-05"));
    const r2 = saveRel(ctx, "m2", "watched", iso("08-15"));
    const r3 = saveRel(ctx, "m3", "preferred", iso("08-06"));
    const r4 = saveRel(ctx, "m4", "watched", iso("08-24")); // 太新，不进 reuse 分母
    const r5 = saveRel(ctx, "m5", "saved", iso("07-20"));
    ctx.setNow(iso("08-16"));
    ctx.supplierStore.updateStatus(r2, "paused");
    ctx.supplierStore.updateStatus(r3, "review_required");
    ctx.supplierStore.updateStatus(r5, "deleted");
    // 成功/失败 RFQ。
    rfq(ctx, task.task_id, "m1", iso("08-06"), true, "n1"); // r1 建立后 7d 内 → 复用 + assisted
    rfq(ctx, task.task_id, "m1", iso("08-10"), true, "n2"); // m1 第 2 次 → repeat merchant
    rfq(ctx, task.task_id, "m3", iso("08-20"), true, "n3"); // r3 当前非 active → 不算 assisted
    rfq(ctx, task.task_id, "m9", iso("08-21"), true, "n4"); // 无关系
    rfq(ctx, task.task_id, "m9", iso("08-22"), false, "n5"); // 失败终态不计入
    // observations：r2（paused watched）2 条、r4（active watched）1 条。
    ctx.supplierStore.addObservation({
      relationship_id: r2,
      kind: "listing_added",
      source_type: "agent_card",
      payload: {},
      content_digest: "d1",
      observed_at: iso("08-16"),
    });
    ctx.supplierStore.addObservation({
      relationship_id: r2,
      kind: "listing_added",
      source_type: "agent_card",
      payload: {},
      content_digest: "d2",
      observed_at: iso("08-17"),
    });
    ctx.supplierStore.addObservation({
      relationship_id: r4,
      kind: "capability_changed",
      source_type: "agent_card",
      payload: {},
      content_digest: "d3",
      observed_at: iso("08-24"),
    });
    // observation_state：r1 健康，r2 退避中（degraded）。
    ctx.supplierStore.recordSourceSuccess(r1, "agent_card", {
      checked_at: iso("08-20"),
      next_check_at: iso("08-26"),
      unchanged: true,
    });
    ctx.supplierStore.recordSourceFailure(r2, "agent_card", {
      checked_at: iso("08-21"),
      backoff_at: iso("08-26"),
    });
    ctx.close();

    const m = await metrics();

    // Qualified RFQ 代理口径。
    expect(m.qualified_rfq_definition).toContain("a2a_negotiated");
    expect(m.successful_rfqs).toBe(4);
    expect(m.failed_rfqs).toBe(1);

    // a. save-after-RFQ：2 条建议，只有 m1 在 7 天内建立关系。
    expect(m.save_after_rfq).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });

    // b. type × status。
    expect(m.relationships_by_type_status.total).toBe(5);
    expect(m.relationships_by_type_status.active_watched_preferred).toBe(1); // 仅 r4
    expect(m.relationships_by_type_status.buckets).toEqual([
      { relationship_type: "preferred", status: "review_required", count: 1 },
      { relationship_type: "saved", status: "active", count: 1 },
      { relationship_type: "saved", status: "deleted", count: 1 },
      { relationship_type: "watched", status: "active", count: 1 },
      { relationship_type: "watched", status: "paused", count: 1 },
    ]);

    // c. 复用：7d 分母=r1/r2/r3/r5（r4 建立未满 7 天被排除），只有 r1 复用。
    expect(m.reuse_7d).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
    // 30d 分母=r5（唯一建立满 30 天），未复用。
    expect(m.reuse_30d).toMatchObject({ value: 0, numerator: 0, denominator: 1 });

    // d. assisted：4 次成功 RFQ 中 m1 的 2 次发生前已有 active 关系。
    expect(m.relationship_assisted_rfq).toMatchObject({ value: 0.5, numerator: 2, denominator: 4 });

    // e. 重复 merchant：m1/m3/m9 各 ≥1 次，m1 ≥2 次。
    expect(m.repeat_merchants).toEqual({
      merchants_with_successful_rfq: 3,
      merchants_with_repeat_rfq: 1,
      successful_rfqs: 4,
      unidentified_merchant_rfqs: 0,
    });

    // f. observation 面。
    expect(m.observations.total).toBe(3);
    expect(m.observations.by_kind).toEqual({ listing_added: 2, capability_changed: 1 });
    expect(m.observations.on_active_watched).toMatchObject({
      value: 1 / 3,
      numerator: 1,
      denominator: 3,
    });
    expect(m.observations.notification_hit_rate.value).toBeNull();
    expect(m.observations.notification_hit_rate.note).toContain("不可计算");

    // g. lifecycle：paused/deleted 各占 1/5。
    expect(m.lifecycle.paused).toMatchObject({ value: 0.2, numerator: 1, denominator: 5 });
    expect(m.lifecycle.deleted).toMatchObject({ value: 0.2, numerator: 1, denominator: 5 });

    // h. health：review_required 1/5；2 个来源中 1 个 degraded。
    expect(m.health.review_required).toMatchObject({ value: 0.2, numerator: 1, denominator: 5 });
    expect(m.health.degraded_sources).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
  });

  it("没有关系建立满 30 天时 reuse_30d 为 null（新关系不进分母）", async () => {
    const ctx = setup();
    saveRel(ctx, "m1", "saved", iso("08-20")); // 建立 5 天，两个窗口都未满
    ctx.close();
    const m = await metrics();
    expect(m.reuse_7d).toMatchObject({ value: null, denominator: 0 });
    expect(m.reuse_30d).toMatchObject({ value: null, denominator: 0 });
  });
});
