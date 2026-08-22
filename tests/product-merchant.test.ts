/**
 * `kiwi merchant stats` 报告（product-merchant）测试。
 *
 * 覆盖：
 * - merchantStats 报告形状：ok/agent_id/days/identity_note/totals/today/
 *   daily（零填充 N 天窗口，升序含今天）/top_skus；
 * - 窗口语义：--days 之外的事件不计入 totals/top_skus；
 * - days clamp 1..90；
 * - stats.sqlite 不存在时 fail-closed 友好报错（先跑 merchant start）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { merchantStats } from "../src/product-merchant.js";
import {
  openMerchantStatsStore,
  type BuyerContactEvent,
} from "../src/merchant/stats-store.js";

const NOW = "2026-08-20T12:00:00Z";
const clock = () => NOW;

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kiwi-product-merchant-"));
}

function ev(overrides: Partial<BuyerContactEvent>): BuyerContactEvent {
  return {
    message_id: "msg_x",
    buyer_identity: "buyer-a",
    negotiation_id: "neg_1",
    exchange_id: "ex_1",
    action: "rfq",
    skus: ["SKU-001"],
    occurred_at: "2026-08-20T10:00:00Z",
    ...overrides,
  };
}

/** 在 <dir>/a2a/stats.sqlite 预置事件（模拟 merchant 节点已收集）。 */
function seed(dir: string, events: BuyerContactEvent[]): void {
  const store = openMerchantStatsStore({ dbPath: path.join(dir, "a2a", "stats.sqlite") });
  try {
    for (const e of events) store.recordBuyerContact(e);
  } finally {
    store.close();
  }
}

describe("kiwi merchant stats report", () => {
  it("builds the report shape with zero-filled daily window", () => {
    const dir = tmpDir();
    try {
      seed(dir, [
        // 今天：buyer-a 两条（neg_1，SKU-001），buyer-b 一条（neg_2，SKU-002）。
        ev({ message_id: "msg_1" }),
        ev({ message_id: "msg_2", skus: ["SKU-001"], occurred_at: "2026-08-20T11:00:00Z" }),
        ev({
          message_id: "msg_3",
          buyer_identity: "buyer-b",
          negotiation_id: "neg_2",
          skus: ["SKU-002"],
          occurred_at: "2026-08-20T08:00:00Z",
        }),
        // 3 天前：buyer-a 一条。
        ev({ message_id: "msg_4", occurred_at: "2026-08-17T10:00:00Z" }),
        // 窗口外（days=7 → since 2026-08-14）：不计入。
        ev({ message_id: "msg_5", occurred_at: "2026-08-01T10:00:00Z" }),
      ]);

      const report = merchantStats({ agentId: "m1", dataDir: dir, days: 7, now: clock });
      expect(report.ok).toBe(true);
      expect(report.agent_id).toBe("m1");
      expect(report.days).toBe(7);
      expect(report.identity_note).toContain("signature");
      expect(report.totals).toEqual({ distinct_buyers: 2, contact_events: 4, negotiations: 2 });
      expect(report.today).toEqual({ distinct_buyers: 2, contact_events: 3 });

      expect(report.daily).toHaveLength(7);
      expect(report.daily[0]).toEqual({
        day: "2026-08-14",
        distinct_buyers: 0,
        contact_events: 0,
        negotiations: 0,
      });
      expect(report.daily[3]).toEqual({
        day: "2026-08-17",
        distinct_buyers: 1,
        contact_events: 1,
        negotiations: 1,
      });
      expect(report.daily[6]).toEqual({
        day: "2026-08-20",
        distinct_buyers: 2,
        contact_events: 3,
        negotiations: 2,
      });

      expect(report.top_skus).toEqual([
        { sku: "SKU-001", contact_events: 3, distinct_buyers: 1, negotiations: 1 },
        { sku: "SKU-002", contact_events: 1, distinct_buyers: 1, negotiations: 1 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clamps --days into 1..90 (default 14)", () => {
    const dir = tmpDir();
    try {
      seed(dir, [ev({ message_id: "msg_1" })]);
      expect(merchantStats({ agentId: "m1", dataDir: dir, now: clock }).days).toBe(14);
      const clamped = merchantStats({ agentId: "m1", dataDir: dir, days: 500, now: clock });
      expect(clamped.days).toBe(90);
      expect(clamped.daily).toHaveLength(90);
      expect(merchantStats({ agentId: "m1", dataDir: dir, days: 0, now: clock }).days).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with guidance when no stats DB exists yet", () => {
    const dir = tmpDir();
    try {
      expect(() => merchantStats({ agentId: "m1", dataDir: dir, now: clock })).toThrow(
        /尚无买家沟通数据/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
