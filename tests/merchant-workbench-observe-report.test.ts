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
 * WP11：会话旁观 / 运营报告 / 规则表单化 的 API 与聚合测试。
 *
 * 覆盖：鉴权（未登录 401、viewer 可读）、CSRF、分页与状态过滤、时间线投影
 * （方向/动作/规则依据/转人工标记）、报告周期计算（UTC 跨天/周边界/月跨界）、
 * 指标缺失时「不可得」、规则表单→草稿生成、XSS（外部内容作为数据 + 页面转义）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import type { MerchantManagementApiOptions } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { openMerchantStatsStore } from "../src/merchant/stats-store.js";
import {
  createNegotiationObserver,
  type NegotiationTimelineEntry,
} from "../src/merchant/negotiation-observer.js";
import {
  createOperationsReportBuilder,
  reportWindow,
} from "../src/merchant/operations-report.js";

const MERCHANT = "merchant-wp11";
const ACTOR = "owner:merchant-wp11";
// 固定「现在」：2026-09-28 是周一（当周窗口 09-21..09-28）。
const NOW = new Date("2026-09-28T12:00:00.000Z");

const IDENTITY_IN = {
  sender_identity: "buyer:buyer-001",
  counterparty_identity: "mkt_wp11",
  actor: "buyer",
} as const;
const IDENTITY_OUT = {
  sender_identity: "mkt_wp11",
  counterparty_identity: "buyer:buyer-001",
  actor: "merchant",
} as const;
const CAPABILITY = {
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
} as const;

function item(sku: string, qty: number, priceMinor: number) {
  return {
    sku,
    quantity: { value: qty, unit: "piece" },
    unit_price: { currency: "CNY", amount_minor: priceMinor },
  };
}

let dataDir: string;
let bareDir: string;
let emptyDir: string;
let server: Server;
let bareServer: Server;
let emptyServer: Server;
let base: string;
let bareBase: string;
let emptyBase: string;
let auth: { cookie: string; csrf: string };
const sessions = new MerchantAdminSessions({ db: new DatabaseSync(":memory:") });

/** 逐事件递增的落账时钟（保证 recorded_at 可排序、可控落在指定 UTC 日）。 */
function makeLedger(dir: string): { ledger: LedgerStore; at: (iso: string) => string } {
  let current = "2026-09-28T10:00:00.000Z";
  const ledger = new LedgerStore({ dir: path.join(dir, "a2a"), now: () => current });
  return { ledger, at: (iso: string) => (current = iso) };
}

function buildLedgerFixture(dir: string): void {
  const { ledger, at } = makeLedger(dir);
  // 磋商 A（今天，已达成非绑定协议）：询价 → 报价 → 接受。
  at("2026-09-28T09:00:00.000Z");
  ledger.append({
    event_kind: "message_received",
    negotiation_id: "neg-wp11-a",
    identity: IDENTITY_IN,
    capability: CAPABILITY,
    wire_payload: {
      action: "inquiry",
      payload: {
        inquiry: {
          questions: [
            { code: "<script>alert(1)</script>" },
            { code: "delivery_before" },
            { code: "delivery_before" },
          ],
        },
      },
    },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T09:00:00.000Z",
  });
  at("2026-09-28T09:01:00.000Z");
  ledger.append({
    event_kind: "message_sent",
    negotiation_id: "neg-wp11-a",
    identity: IDENTITY_OUT,
    capability: CAPABILITY,
    wire_payload: {
      action: "offer",
      payload: { offer: { offer_id: "ofr-a1", terms: { items: [item("sku-a", 10, 99_900)] } } },
    },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T09:01:00.000Z",
  });
  ledger.append({
    event_kind: "state_transition",
    negotiation_id: "neg-wp11-a",
    identity: IDENTITY_IN,
    capability: CAPABILITY,
    state_transition: { to_phase: "OFFER_OPEN" },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T09:01:00.000Z",
  });
  at("2026-09-28T09:30:00.000Z");
  ledger.append({
    event_kind: "message_received",
    negotiation_id: "neg-wp11-a",
    identity: IDENTITY_IN,
    capability: CAPABILITY,
    wire_payload: { action: "accept_nonbinding", payload: {} },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T09:30:00.000Z",
  });
  ledger.append({
    event_kind: "state_transition",
    negotiation_id: "neg-wp11-a",
    identity: IDENTITY_OUT,
    capability: CAPABILITY,
    state_transition: { to_phase: "AGREEMENT_REACHED" },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T09:30:00.000Z",
  });
  // 磋商 B（今天，澄清等待 = 进入人工）。
  at("2026-09-28T11:00:00.000Z");
  ledger.append({
    event_kind: "message_received",
    negotiation_id: "neg-wp11-b",
    identity: IDENTITY_IN,
    capability: CAPABILITY,
    wire_payload: {
      action: "clarification",
      payload: { clarification: { questions: [{ code: "warranty_scope" }] } },
    },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T11:00:00.000Z",
  });
  ledger.append({
    event_kind: "state_transition",
    negotiation_id: "neg-wp11-b",
    identity: IDENTITY_OUT,
    capability: CAPABILITY,
    state_transition: { to_phase: "AWAITING_CLARIFICATION" },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-28T11:00:00.000Z",
  });
  // 磋商 C（昨天，已婉拒终态；用于排序/过滤/对比周期）。
  at("2026-09-27T08:00:00.000Z");
  ledger.append({
    event_kind: "message_received",
    negotiation_id: "neg-wp11-c",
    identity: IDENTITY_IN,
    capability: CAPABILITY,
    wire_payload: { action: "inquiry", payload: { inquiry: { questions: [{ code: "moq" }] } } },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-27T08:00:00.000Z",
  });
  ledger.append({
    event_kind: "state_transition",
    negotiation_id: "neg-wp11-c",
    identity: IDENTITY_OUT,
    capability: CAPABILITY,
    state_transition: { to_phase: "DECLINED" },
    outcome: { kind: "ok" },
    occurred_at: "2026-09-27T08:05:00.000Z",
  });
}

function buildStatsFixture(dir: string): void {
  const store = openMerchantStatsStore({
    dbPath: path.join(dir, "a2a", "stats.sqlite"),
  });
  try {
    // 今日（当前日窗口）：两个去重买家、3 次触达、2 个磋商。
    for (const [messageId, buyer, negotiation] of [
      ["m1", "buyer:1", "neg-wp11-a"],
      ["m2", "buyer:2", "neg-wp11-b"],
      ["m3", "buyer:1", "neg-wp11-b"],
    ] as const) {
      store.recordBuyerContact({
        message_id: messageId,
        buyer_identity: buyer,
        negotiation_id: negotiation,
        exchange_id: "",
        action: "inquiry",
        skus: ["sku-a"],
        occurred_at: "2026-09-28T09:30:00.000Z",
      });
    }
    // 昨日（对比窗口）：1 个买家、1 次触达、1 个磋商。
    store.recordBuyerContact({
      message_id: "m4",
      buyer_identity: "buyer:1",
      negotiation_id: "neg-wp11-c",
      exchange_id: "",
      action: "inquiry",
      skus: ["sku-c"],
      occurred_at: "2026-09-27T08:01:00.000Z",
    });
  } finally {
    store.close();
  }
}

function handlerOptions(
  dir: string,
  withReports: boolean,
): MerchantManagementApiOptions {
  const db = new DatabaseSync(":memory:");
  return {
    merchantId: MERCHANT,
    generation: () => 1,
    runtimeVersion: "test",
    sessions,
    listPending: () => [],
    mintCandidateConfirmation: () => "unused",
    executeDecision: async () => {},
    drafts: new MerchantImportDraftStore({ db, now: () => NOW.toISOString() }),
    operations: new MerchantManagementOperationStore({ db, now: () => NOW.toISOString() }),
    serviceState: new MutableServiceState("OPERATING"),
    readiness: async () => ({ ready: true, checks: {} }),
    negotiationObserver: createNegotiationObserver({
      ledgerDir: path.join(dir, "a2a"),
    }),
    ...(withReports
      ? {
          operationsReports: createOperationsReportBuilder({
            dataDir: dir,
            now: () => NOW,
          }),
        }
      : {}),
    now: () => NOW,
  };
}

async function startServer(
  options: MerchantManagementApiOptions,
): Promise<{ server: Server; base: string }> {
  const httpServer = createServer(createMerchantManagementApiHandler(options));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  return {
    server: httpServer,
    base: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
  };
}

async function createAuth(
  role: "owner" | "viewer",
): Promise<{ cookie: string; csrf: string }> {
  const session = sessions.createSession({ principalId: ACTOR, merchantId: MERCHANT, role });
  const cookie = `${ADMIN_SESSION_COOKIE}=${session.sessionId}`;
  const response = await fetch(`${base}/merchant/api/session`, { headers: { cookie } });
  const body = (await response.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-wp11-"));
  bareDir = mkdtempSync(path.join(tmpdir(), "kiwi-wp11-bare-"));
  emptyDir = mkdtempSync(path.join(tmpdir(), "kiwi-wp11-empty-"));
  buildLedgerFixture(dataDir);
  buildStatsFixture(dataDir);
  const main = await startServer(handlerOptions(dataDir, true));
  server = main.server;
  base = main.base;
  const bare = await startServer(handlerOptions(bareDir, false));
  bareServer = bare.server;
  bareBase = bare.base;
  // 有报告通道、但目录里没有任何数据（stats 缺失 → 指标「不可得」）。
  const empty = await startServer(handlerOptions(emptyDir, true));
  emptyServer = empty.server;
  emptyBase = empty.base;
  auth = await createAuth("owner");
});

afterAll(async () => {
  server.closeAllConnections();
  bareServer.closeAllConnections();
  emptyServer.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => bareServer.close(() => resolve())),
    new Promise<void>((resolve) => emptyServer.close(() => resolve())),
  ]);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(bareDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("WP11 会话旁观 API", () => {
  it("未登录访问返回 401（列表/详情）", async () => {
    for (const target of ["/negotiations", "/negotiations/neg-wp11-a"]) {
      const response = await fetch(`${base}/merchant/api/v1${target}`);
      expect(response.status).toBe(401);
    }
  });

  it("分页：按最近活动倒序，limit/cursor 翻页", async () => {
    const page1 = (await (
      await fetch(`${base}/merchant/api/v1/negotiations?limit=2`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as { total: number; items: Array<{ negotiation_id: string }>; next_cursor: string | null };
    expect(page1.total).toBe(3);
    expect(page1.items.map((item) => item.negotiation_id)).toEqual([
      "neg-wp11-b",
      "neg-wp11-a",
    ]);
    expect(page1.next_cursor).toBe("2");
    const page2 = (await (
      await fetch(`${base}/merchant/api/v1/negotiations?limit=2&cursor=2`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as { items: Array<{ negotiation_id: string }>; next_cursor: string | null };
    expect(page2.items.map((item) => item.negotiation_id)).toEqual(["neg-wp11-c"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("非法 cursor / 非法 status 返回 422", async () => {
    for (const query of ["cursor=abc", "status=bogus"]) {
      const response = await fetch(`${base}/merchant/api/v1/negotiations?${query}`, {
        headers: { cookie: auth.cookie },
      });
      expect(response.status).toBe(422);
    }
  });

  it("状态过滤：active 只留进行中，agreement 只留已达成", async () => {
    const active = (await (
      await fetch(`${base}/merchant/api/v1/negotiations?status=active`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as { items: Array<{ negotiation_id: string; needs_attention: boolean }> };
    expect(active.items.map((item) => item.negotiation_id)).toEqual(["neg-wp11-b"]);
    expect(active.items[0]?.needs_attention).toBe(true);
    const agreement = (await (
      await fetch(`${base}/merchant/api/v1/negotiations?status=agreement`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as { items: Array<{ negotiation_id: string }> };
    expect(agreement.items.map((item) => item.negotiation_id)).toEqual(["neg-wp11-a"]);
  });

  it("时间线：方向/动作/规则依据/转人工标记；买家问题原文按数据返回（XSS）", async () => {
    const detail = (await (
      await fetch(`${base}/merchant/api/v1/negotiations/neg-wp11-a`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as {
      negotiation_id: string;
      phase: string;
      agreement: boolean;
      buyer_ref: string;
      timeline: NegotiationTimelineEntry[];
    };
    expect(detail.negotiation_id).toBe("neg-wp11-a");
    expect(detail.phase).toBe("AGREEMENT_REACHED");
    expect(detail.agreement).toBe(true);
    expect(detail.buyer_ref).toBe("buyer:buyer-001");
    const messages = detail.timeline.filter((entry) => entry.kind === "message");
    expect(messages.map((entry) => entry.direction)).toEqual([
      "buyer",
      "merchant",
      "buyer",
    ]);
    expect(messages.map((entry) => entry.action)).toEqual(["inquiry", "offer", "accept_nonbinding"]);
    const offer = messages[1];
    expect(offer?.rule_summary).toContain("自动生成");
    expect(offer?.sku).toBe("sku-a");
    expect(offer?.unit_price_minor).toBe(99900);
    expect(messages[0]?.rule_summary).toBeNull();
    // 外部内容按数据返回：JSON 序列化本身不执行 HTML；转义责任在页面层。
    expect(messages[0]?.summary).toContain("<script>alert(1)</script>");
    const phaseEntries = detail.timeline.filter((entry) => entry.kind === "phase");
    expect(phaseEntries.map((entry) => entry.action)).toContain("phase→AGREEMENT_REACHED");
  });

  it("澄清等待：触发消息带 manual_review 标记", async () => {
    const detail = (await (
      await fetch(`${base}/merchant/api/v1/negotiations/neg-wp11-b`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as { timeline: NegotiationTimelineEntry[] };
    const trigger = detail.timeline.find((entry) => entry.kind === "message");
    expect(trigger?.action).toBe("clarification");
    expect(trigger?.manual_review).toBe(true);
  });

  it("页面壳对新动态字段统一走 esc() 转义（XSS 静态防线）", () => {
    const html = renderMerchantManagementPage();
    for (const required of [
      "esc(it.negotiation_id)",
      "esc(it.recorded_at)",
      "esc(e.summary)",
      "esc(e.action)",
      "esc(d.buyer_ref)",
      "esc(t.token)",
      "esc(s.sku)",
    ]) {
      expect(html).toContain(required);
    }
  });

  it("不存在的磋商返回 404", async () => {
    const response = await fetch(`${base}/merchant/api/v1/negotiations/neg-missing`, {
      headers: { cookie: auth.cookie },
    });
    expect(response.status).toBe(404);
  });
});

describe("WP11 运营报告 API", () => {
  it("未登录返回 401", async () => {
    const response = await fetch(`${base}/merchant/api/v1/reports?period=day`);
    expect(response.status).toBe(401);
  });

  it("viewer 角色可读（operations:read）", async () => {
    const viewer = await createAuth("viewer");
    const response = await fetch(`${base}/merchant/api/v1/reports?period=day`, {
      headers: { cookie: viewer.cookie },
    });
    expect(response.status).toBe(200);
  });

  it("非法 period 返回 422", async () => {
    const response = await fetch(`${base}/merchant/api/v1/reports?period=quarter`, {
      headers: { cookie: auth.cookie },
    });
    expect(response.status).toBe(422);
  });

  it("day 报告：窗口/对比窗口正确（UTC），指标来自 stats 与账本", async () => {
    const report = (await (
      await fetch(`${base}/merchant/api/v1/reports?period=day`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as {
      period: string;
      window: { since: string; until_exclusive: string; basis: string };
      previous_window: { since: string; until_exclusive: string };
      metrics: Record<
        string,
        { available: boolean; value?: number; previous?: number; delta?: number }
      >;
      top_skus: Array<{ sku: string; contact_events: number }>;
      recent_inquiry_terms: Array<{ token: string; count: number }>;
      series: Array<{ day: string; contact_events: number }>;
    };
    expect(report.period).toBe("day");
    expect(report.window).toEqual({
      since: "2026-09-28",
      until_exclusive: "2026-09-29",
      basis: "UTC",
    });
    expect(report.previous_window).toEqual({
      since: "2026-09-27",
      until_exclusive: "2026-09-28",
    });
    expect(report.metrics.distinct_buyers).toMatchObject({ available: true, value: 2, previous: 1, delta: 1 });
    expect(report.metrics.contact_events).toMatchObject({ available: true, value: 3, previous: 1 });
    expect(report.metrics.negotiations).toMatchObject({ available: true, value: 2, previous: 1 });
    expect(report.metrics.agreements_reached).toMatchObject({ available: true, value: 1, previous: 0 });
    expect(report.metrics.human_escalations).toMatchObject({ available: true, value: 1, previous: 0 });
    expect(report.top_skus[0]).toMatchObject({ sku: "sku-a", contact_events: 3 });
    const tokens = Object.fromEntries(
      report.recent_inquiry_terms.map((term) => [term.token, term.count]),
    );
    expect(tokens["delivery_before"]).toBe(2);
    expect(tokens["<script>alert(1)</script>"]).toBe(1);
    expect(report.series).toEqual([
      { day: "2026-09-28", contact_events: 3, negotiations: 2 },
    ]);
  });

  it("week 报告：周一为一周开始，周日归上一周", async () => {
    const report = (await (
      await fetch(`${base}/merchant/api/v1/reports?period=week`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as {
      window: { since: string; until_exclusive: string; basis: string };
      previous_window: { since: string; until_exclusive: string };
      metrics: Record<string, { available: boolean; value?: number; previous?: number }>;
    };
    // 2026-09-28 是周一：本周窗口 09-28..10-05；上一周期（含周日的数据）09-21..09-28。
    expect(report.window).toEqual({
      since: "2026-09-28",
      until_exclusive: "2026-10-05",
      basis: "UTC",
    });
    expect(report.previous_window).toEqual({ since: "2026-09-21", until_exclusive: "2026-09-28" });
    expect(report.metrics.distinct_buyers).toMatchObject({ available: true, value: 2, previous: 1 });
    expect(report.metrics.contact_events).toMatchObject({ available: true, value: 3, previous: 1 });
    expect(report.metrics.agreements_reached).toMatchObject({ available: true, value: 1, previous: 0 });
  });

  it("month 报告窗口覆盖全月（1 日为界）", async () => {
    const report = (await (
      await fetch(`${base}/merchant/api/v1/reports?period=month`, {
        headers: { cookie: auth.cookie },
      })
    ).json()) as { window: { since: string; until_exclusive: string; basis: string }; series: Array<{ day: string }> };
    expect(report.window).toEqual({
      since: "2026-09-01",
      until_exclusive: "2026-10-01",
      basis: "UTC",
    });
    expect(report.series).toHaveLength(30);
  });

  it("指标缺失时明确「不可得」，不编造数值", async () => {
    // emptyDir：无 stats.sqlite、无账本文件 → stats 指标不可得；账本为空事实（0）可得。
    const bareAuthSession = sessions.createSession({
      principalId: ACTOR,
      merchantId: MERCHANT,
      role: "viewer",
    });
    const response = await fetch(`${emptyBase}/merchant/api/v1/reports?period=day`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${bareAuthSession.sessionId}` },
    });
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      metrics: Record<string, { available: boolean; reason?: string; value?: number }>;
      top_skus: unknown[];
      recent_inquiry_terms: unknown[];
    };
    expect(report.metrics.distinct_buyers).toEqual({
      available: false,
      reason: "merchant_stats_unavailable",
    });
    expect(report.metrics.contact_events).toMatchObject({
      available: false,
      reason: "merchant_stats_unavailable",
    });
    expect(report.top_skus).toEqual([]);
    expect(report.recent_inquiry_terms).toEqual([]);
  });

  it("未配置报告通道时返回 503，不伪造空报告", async () => {
    const session = sessions.createSession({ principalId: ACTOR, merchantId: MERCHANT, role: "owner" });
    const response = await fetch(`${bareBase}/merchant/api/v1/reports?period=day`, {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}` },
    });
    expect(response.status).toBe(503);
  });
});

describe("WP11 周期计算（UTC 边界，纯函数）", () => {
  it("day：UTC 午夜前后分属不同窗口", () => {
    const before = reportWindow("day", new Date("2026-09-27T23:59:59.999Z"));
    const after = reportWindow("day", new Date("2026-09-28T00:00:00.000Z"));
    expect(before.current).toEqual({ since: "2026-09-27", until_exclusive: "2026-09-28" });
    expect(after.current).toEqual({ since: "2026-09-28", until_exclusive: "2026-09-29" });
    expect(after.previous).toEqual(before.current);
  });

  it("week：周日归上一周（ISO 周一为始）", () => {
    const sunday = reportWindow("week", new Date("2026-09-27T00:30:00.000Z"));
    expect(sunday.current).toEqual({ since: "2026-09-21", until_exclusive: "2026-09-28" });
    expect(sunday.previous).toEqual({ since: "2026-09-14", until_exclusive: "2026-09-21" });
    const monday = reportWindow("week", new Date("2026-09-28T00:30:00.000Z"));
    expect(monday.current).toEqual({ since: "2026-09-28", until_exclusive: "2026-10-05" });
  });

  it("month：月初零点跨月、1 月的上一周期跨年", () => {
    const jan1 = reportWindow("month", new Date("2026-01-01T00:00:00.000Z"));
    expect(jan1.current).toEqual({ since: "2026-01-01", until_exclusive: "2026-02-01" });
    expect(jan1.previous).toEqual({ since: "2025-12-01", until_exclusive: "2026-01-01" });
    const dec31 = reportWindow("month", new Date("2026-12-31T23:59:59.999Z"));
    expect(dec31.current).toEqual({ since: "2026-12-01", until_exclusive: "2027-01-01" });
    expect(dec31.previous).toEqual({ since: "2026-11-01", until_exclusive: "2026-12-01" });
  });
});

describe("WP11 规则表单 → 草稿（候选）生成", () => {
  it("缺 CSRF 头的 POST 被拒绝（403）", async () => {
    const response = await fetch(`${base}/merchant/api/v1/policy/form-drafts`, {
      method: "POST",
      headers: { cookie: auth.cookie, "content-type": "application/json", origin: "https://merchant.example" },
      body: JSON.stringify({ auto: "off" }),
    });
    expect(response.status).toBe(403);
  });

  it("表单提交生成草稿：服务端映射 schema 字段，回执含 applied_keys", async () => {
    const response = await fetch(`${base}/merchant/api/v1/policy/form-drafts`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "content-type": "application/json",
        origin: "https://merchant.example",
        "x-csrf-token": auth.csrf,
      },
      body: JSON.stringify({
        auto: "off",
        floor: 120,
        discount: 5,
        lead_days: 7,
        ttl_seconds: 86400,
        human_review: ["below_floor", "suspicious_content"],
      }),
    });
    expect(response.status).toBe(200);
    const draft = (await response.json()) as {
      draft_id: string;
      digest: string;
      reused: boolean;
      applied_keys: string[];
    };
    expect(draft.draft_id).toBeTruthy();
    expect(draft.digest).toMatch(/^sha256:/);
    expect(draft.reused).toBe(false);
    expect(draft.applied_keys.sort()).toEqual([
      "auto_negotiate",
      "delivery_lead_days",
      "human_review_on",
      "max_auto_discount_percent",
      "min_unit_price_private",
      "quote_ttl_seconds",
    ]);
  });

  it("表单校验：空表单/越界折扣/未知触发词返回 422", async () => {
    for (const body of [
      {},
      { discount: 150 },
      { human_review: ["unknown_trigger"] },
      { lead_days: 0 },
    ]) {
      const response = await fetch(`${base}/merchant/api/v1/policy/form-drafts`, {
        method: "POST",
        headers: {
          cookie: auth.cookie,
          "content-type": "application/json",
          "x-csrf-token": auth.csrf,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
    }
  });

  it("viewer 无 policy:draft 权限，提交被拒（403）", async () => {
    const viewer = await createAuth("viewer");
    const response = await fetch(`${base}/merchant/api/v1/policy/form-drafts`, {
      method: "POST",
      headers: {
        cookie: viewer.cookie,
        "content-type": "application/json",
        "x-csrf-token": viewer.csrf,
      },
      body: JSON.stringify({ auto: "on" }),
    });
    expect(response.status).toBe(403);
  });

  it("页面包含表单字段与高级 JSON 模式，且不含策略内部字段名（隐私守卫）", () => {
    const html = renderMerchantManagementPage();
    for (const id of [
      "pf-auto",
      "pf-floor",
      "pf-discount",
      "pf-lead",
      "pf-ttl",
      "pf-hr-below",
      "pf-hr-warranty",
      "pf-hr-suspicious",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("policy/form-drafts");
    expect(html).toContain("JSON patch");
    expect(html).toContain("draftPolicyForm()");
    // 页面壳不含 schema 字段名（与既有隐私守卫同口径；映射在服务端）。
    expect(html).not.toMatch(/price_floors|min_unit_price_private|max_auto_discount_percent/);
    // 只读提示：会话旁观不能发消息。
    expect(html).toContain("不能在这里向买家发送消息");
  });
});
