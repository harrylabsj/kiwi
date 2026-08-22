/**
 * 商家侧运营统计（merchant stats）测试。
 *
 * 覆盖：
 * - stats-store：recordBuyerContact + message_id 幂等去重（INSERT OR IGNORE）+
 *   distinct buyer / negotiation 聚合 + top_skus 排序 + 本地权限 0700/0600；
 * - pipeline hook：message_received 落账成功 → 买家触达记录一次（含 SKU 提取）；
 *   记录失败不阻断消息处理（只进 logError）；幂等重放不重复计数；inquiry 无 SKU。
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import {
  echoHandler,
  InboundPipeline,
  TaskRegistry,
  type BuyerContactRecord,
} from "../src/a2a/server/index.js";
import type { A2AMessage } from "../src/a2a/client/index.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import {
  openMerchantStatsStore,
  type BuyerContactEvent,
} from "../src/merchant/stats-store.js";
import { validEnvelopeFields, validInquiry, validRfq, SKU, TIMESTAMP } from "./negotiation-helpers.js";

// ---------------------------------------------------------------------------
// stats-store
// ---------------------------------------------------------------------------

function ev(overrides: Partial<BuyerContactEvent> = {}): BuyerContactEvent {
  return {
    message_id: "msg_1",
    buyer_identity: "buyer-a",
    negotiation_id: "neg_1",
    exchange_id: "ex_1",
    action: "rfq",
    skus: ["SKU-001"],
    occurred_at: "2026-08-20T10:00:00Z",
    ...overrides,
  };
}

describe("MerchantStatsStore", () => {
  it("records contacts and aggregates totals/daily/top_skus", () => {
    const store = openMerchantStatsStore({ dbPath: ":memory:" });
    try {
      // buyer-a 两次触达（同一 neg_1），buyer-b 一次（neg_2，两个 SKU）。
      store.recordBuyerContact(ev({ message_id: "msg_1", skus: ["SKU-001", "SKU-002"] }));
      store.recordBuyerContact(
        ev({ message_id: "msg_2", occurred_at: "2026-08-20T11:00:00Z", skus: ["SKU-001"] }),
      );
      store.recordBuyerContact(
        ev({
          message_id: "msg_3",
          buyer_identity: "buyer-b",
          negotiation_id: "neg_2",
          action: "inquiry",
          skus: [],
          occurred_at: "2026-08-19T09:00:00Z",
        }),
      );

      const totals = store.totalsSince("2026-08-19");
      expect(totals).toEqual({ distinct_buyers: 2, contact_events: 3, negotiations: 2 });

      // 窗口外（只含 08-20）→ 只剩 buyer-a 的两条。
      expect(store.totalsSince("2026-08-20")).toEqual({
        distinct_buyers: 1,
        contact_events: 2,
        negotiations: 1,
      });

      const daily = store.dailySince("2026-08-19");
      expect(daily).toEqual([
        { day: "2026-08-19", distinct_buyers: 1, contact_events: 1, negotiations: 1 },
        { day: "2026-08-20", distinct_buyers: 1, contact_events: 2, negotiations: 1 },
      ]);

      // SKU-001 出现在 2 条事件（1 个买家），SKU-002 在 1 条。
      expect(store.topSkus("2026-08-19", 20)).toEqual([
        { sku: "SKU-001", contact_events: 2, distinct_buyers: 1, negotiations: 1 },
        { sku: "SKU-002", contact_events: 1, distinct_buyers: 1, negotiations: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it("dedupes by message_id (INSERT OR IGNORE) and dedupes skus within one event", () => {
    const store = openMerchantStatsStore({ dbPath: ":memory:" });
    try {
      store.recordBuyerContact(ev({ skus: ["SKU-001", "SKU-001", "SKU-002"] }));
      store.recordBuyerContact(ev({ skus: ["SKU-999"] })); // 同 message_id → 忽略
      expect(store.totalsSince("2026-08-20").contact_events).toBe(1);
      expect(store.topSkus("2026-08-20", 20)).toEqual([
        { sku: "SKU-001", contact_events: 1, distinct_buyers: 1, negotiations: 1 },
        { sku: "SKU-002", contact_events: 1, distinct_buyers: 1, negotiations: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it("creates the directory 0700 and the database file 0600", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-stats-store-"));
    try {
      const dbPath = path.join(root, "a2a", "stats.sqlite");
      const store = openMerchantStatsStore({ dbPath });
      store.close();
      expect(statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      // 预存的宽松权限被收紧。
      const dir2 = path.join(root, "loose");
      mkdirSync(dir2, { recursive: true, mode: 0o755 });
      chmodSync(dir2, 0o755);
      const dbPath2 = path.join(dir2, "stats.sqlite");
      openMerchantStatsStore({ dbPath: dbPath2 }).close();
      expect(statSync(dir2).mode & 0o777).toBe(0o700);
      expect(statSync(dbPath2).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pipeline hook
// ---------------------------------------------------------------------------

function knpMessage(envelope: NegotiationEnvelope): A2AMessage {
  return {
    role: "agent",
    parts: [{ kind: "data", data: { knp_envelope: envelope } }],
    messageId: envelope.message_id,
  };
}

interface HookFixture {
  pipeline: InboundPipeline;
  records: BuyerContactRecord[];
  logErrors: string[];
  statsStore: ReturnType<typeof openMerchantStatsStore>;
  dir: string;
}

function makePipeline(opts: { throwOnRecord?: boolean; messageId?: string } = {}): HookFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-stats-pipeline-"));
  const now = () => "2026-08-20T10:00:00.000Z";
  const records: BuyerContactRecord[] = [];
  const logErrors: string[] = [];
  const statsStore = openMerchantStatsStore({ dbPath: ":memory:" });
  const pipeline = new InboundPipeline({
    handler: echoHandler(),
    idempotency: new IdempotencyStore({ dir, now }),
    ledger: new LedgerStore({ dir, now }),
    tasks: new TaskRegistry(),
    now,
    logError: (message) => logErrors.push(message),
    stats: {
      recordBuyerContact(event) {
        if (opts.throwOnRecord === true) throw new Error("simulated stats failure");
        records.push(event);
        statsStore.recordBuyerContact(event);
      },
    },
  });
  return { pipeline, records, logErrors, statsStore, dir };
}

const CALLER = { senderIdentity: "buyer-alice", remoteAddress: "127.0.0.1:9000" };

describe("InboundPipeline buyer-contact stats hook", () => {
  it("records the contact once after a successful message_received append (skus extracted)", async () => {
    const f = makePipeline();
    try {
      // 默认 fixture：counter_offer → SKU 在 payload.proposed_terms.items。
      const envelope = finalizeEnvelope(validEnvelopeFields());
      const result = await f.pipeline.sendMessage({ message: knpMessage(envelope) }, CALLER);
      expect(result.task.status.state).toBe("completed");

      expect(f.records).toHaveLength(1);
      expect(f.records[0]).toEqual({
        message_id: envelope.message_id,
        buyer_identity: "buyer-alice",
        negotiation_id: envelope.negotiation_id,
        exchange_id: envelope.exchange_id,
        action: "counter_offer",
        skus: [SKU],
        occurred_at: TIMESTAMP,
      });
      // 落到真实 store：可被聚合查询读到。
      expect(f.statsStore.totalsSince("2026-08-05")).toEqual({
        distinct_buyers: 1,
        contact_events: 1,
        negotiations: 1,
      });
    } finally {
      f.statsStore.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("recording failure never breaks message handling (logged only)", async () => {
    const f = makePipeline({ throwOnRecord: true });
    try {
      const envelope = finalizeEnvelope(validEnvelopeFields());
      const result = await f.pipeline.sendMessage({ message: knpMessage(envelope) }, CALLER);
      expect(result.task.status.state).toBe("completed");
      expect(result.ledgerEvent?.event_kind).toBe("message_received");
      expect(f.logErrors).toContain("buyer contact stats recording failed");
      expect(f.records).toHaveLength(0);
    } finally {
      f.statsStore.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("idempotent replay does not double-count", async () => {
    const f = makePipeline();
    try {
      const envelope = finalizeEnvelope(validEnvelopeFields());
      const message = knpMessage(envelope);
      await f.pipeline.sendMessage({ message }, CALLER);
      const replay = await f.pipeline.sendMessage({ message }, CALLER);
      expect(replay.ledgerEvent).toBeUndefined(); // 幂等短接
      expect(f.records).toHaveLength(1);
      expect(f.statsStore.totalsSince("2026-08-05").contact_events).toBe(1);
    } finally {
      f.statsStore.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("extracts skus from rfq payload.items; inquiry records an empty sku list", async () => {
    const f = makePipeline();
    try {
      const rfq = finalizeEnvelope({ ...validEnvelopeFields(), action: "rfq", payload: validRfq() });
      const inquiry = finalizeEnvelope({
        ...validEnvelopeFields(),
        message_id: "msg_stats_inquiry",
        action: "inquiry",
        payload: validInquiry(),
      });
      await f.pipeline.sendMessage({ message: knpMessage(rfq) }, CALLER);
      await f.pipeline.sendMessage({ message: knpMessage(inquiry) }, CALLER);

      expect(f.records[0]?.skus).toEqual([SKU]);
      expect(f.records[1]?.skus).toEqual([]);
      // inquiry 也计入触达（买家联系了商家），只是没有 SKU。
      expect(f.statsStore.totalsSince("2026-08-05").contact_events).toBe(2);
      expect(f.statsStore.topSkus("2026-08-05", 20)).toEqual([
        { sku: SKU, contact_events: 1, distinct_buyers: 1, negotiations: 1 },
      ]);
    } finally {
      f.statsStore.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("non-merchant pipelines (no stats option) are unaffected", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-stats-nostats-"));
    try {
      const now = () => "2026-08-20T10:00:00.000Z";
      const pipeline = new InboundPipeline({
        handler: echoHandler(),
        idempotency: new IdempotencyStore({ dir, now }),
        ledger: new LedgerStore({ dir, now }),
        tasks: new TaskRegistry(),
        now,
        logError: () => {},
      });
      const envelope = finalizeEnvelope(validEnvelopeFields());
      const result = await pipeline.sendMessage({ message: knpMessage(envelope) }, CALLER);
      expect(result.task.status.state).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
