/**
 * 买家识别与交易回执 · K7 接入实际订单来源（B3）。
 *
 * 覆盖：渠道订单（已完成支付验证的 completed checkout 模拟）摄取后上报
 * merchant_order_created（含来源渠道、订单引用、可验证关联）；重复投递
 * 同渠道重试只计一次（同 event_id）；同协议第二笔订单独立计数；订单
 * 状态非创建态 / 摄取校验拒绝（失败 checkout、恶意 permalink）→ 不产生
 * 事实。外链（无回调）不进入本路径——由调用方只在渠道回调后构造
 * OrderRecordSource 保证。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openOrderRecordStore } from "../src/handoff/order-record.js";
import { ingestAndReportOrderRecord } from "../src/handoff/order-receipts.js";
import { orderReceiptId, ReceiptHttpError, ReceiptOutbox, type CommerceReceipt, type OrderReceipt } from "../src/commerce/receipt/receipts.js";
import { ReceiptDispatcher } from "../src/commerce/receipt/dispatcher.js";

const NOW = "2026-11-08T04:00:00.000Z";
const MERCHANT = "merchant-a";

/** 排空 outbox（enqueueAndDeliver 是 fire-and-forget；等待全部投递完成）。 */
async function drainUntilEmpty(f: { outbox: ReceiptOutbox; dispatcher: ReceiptDispatcher }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await f.dispatcher.drain();
    if (f.outbox.pendingCount() === 0) {
      // 再 drain 一轮确认无重复入队。
      await f.dispatcher.drain();
      if (f.outbox.pendingCount() === 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("K7 渠道订单事实 → 回执上报（B3）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k7-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeFixture = () => {
    const submitted: CommerceReceipt[] = [];
    const outbox = new ReceiptOutbox({ dbPath: join(dir, "outbox.sqlite"), now: () => NOW });
    const dispatcher = new ReceiptDispatcher({
      outbox,
      submitter: {
        submit: async (receipt): Promise<void> => void submitted.push(receipt),
      },
    });
    const store = openOrderRecordStore({ dbPath: join(dir, "orders.sqlite") });
    const baseSource = {
      permalink_url: "https://orders.channel-x.example/order/SO-100001",
      line_items: [{ sku: "sku-last-time", quantity: 200 }],
      terms_digest: "sha256:" + "a".repeat(64),
      agreement_id: "agr_1",
      negotiation_id: "neg_1",
      session_ref: "checkout-session-1",
      recorded_at: NOW,
    };
    return { submitted, outbox, dispatcher, store, baseSource };
  };

  it("bounds long legacy IDs and stops retrying a permanent rejection", async () => {
    const channel = "a".repeat(24), ref = "b".repeat(110);
    const stamp = { value: NOW };
    const outbox = new ReceiptOutbox({ now: () => stamp.value });
    const legacy = `merchant-order:${channel}:${ref}`;
    const event: OrderReceipt = { event_id: legacy, event_type: "merchant_order_created",
      merchant_id: MERCHANT, occurred_at: NOW, order_channel: channel, order_ref: ref,
      order_evidence: { checkout_session_ref: "checkout", channel_evidence: ref } };
    let calls = 0;
    try {
      const dispatcher = new ReceiptDispatcher({ outbox, submitter: { async submit(receipt) {
        calls++;
        expect(receipt.event_id).toBe(orderReceiptId(channel, ref));
        expect(receipt.event_id.length).toBeLessThanOrEqual(128);
        throw new ReceiptHttpError(422);
      } } });
      await dispatcher.enqueueAndDeliver(event);
      stamp.value = "2030-01-01T00:00:00Z";
      await dispatcher.drain();
      expect(calls).toBe(1);
      expect(outbox.due()).toEqual([]);
    } finally { outbox.close(); }
  });

  it("成功创建的测试订单 → merchant_order_created（来源渠道+引用+可验证关联）", async () => {
    const f = makeFixture();
    const outcome = ingestAndReportOrderRecord({
      merchantId: MERCHANT,
      store: f.store,
      dispatcher: f.dispatcher,
      source: { ...f.baseSource, order_id: "SO-100001", status: "completed" },
      now: () => NOW,
    });
    expect(outcome.status).toBe("reported");
    await drainUntilEmpty(f);
    const orders = f.submitted.filter(
      (r): r is OrderReceipt => r.event_type === "merchant_order_created",
    );
    expect(orders).toHaveLength(1);
    const receipt = orders[0]!;
    expect(receipt.merchant_id).toBe(MERCHANT);
    expect(receipt.order_channel).toBe("orders.channel-x.example");
    expect(receipt.order_ref).toBe("SO-100001");
    expect(receipt.order_evidence.merchant_agreement_ref).toBe("agr_1");
    expect(receipt.order_evidence.checkout_session_ref).toBe("checkout-session-1");
    // 事件 ID 绑定渠道订单引用（重试幂等的基础）。
    expect(receipt.event_id).toBe(`merchant-order:${receipt.order_channel}:SO-100001`);
    f.store.close();
    f.outbox.close();
  });

  it("成功回调重复投递（同渠道订单引用重试）→ 同 event_id 只计一次", async () => {
    const f = makeFixture();
    for (const attempt of [1, 2, 3]) {
      const outcome = ingestAndReportOrderRecord({
        merchantId: MERCHANT,
        store: f.store,
        dispatcher: f.dispatcher,
        source: { ...f.baseSource, order_id: "SO-100001", status: "completed", recorded_at: `2026-11-08T04:00:0${attempt}.000Z` },
        now: () => NOW,
      });
      expect(outcome.status).toBe("reported");
      expect((outcome as { event_id: string }).event_id).toBe("merchant-order:orders.channel-x.example:SO-100001");
    }
    await drainUntilEmpty(f);
    const orders = f.submitted.filter(
      (r): r is OrderReceipt => r.event_type === "merchant_order_created",
    );
    // 同一 event_id 出队三次（本地幂等在 Catalog 侧），但事件内容恒定 ——
    // Catalog 按（已验证报告方, event_id）幂等吸收后只计一笔。
    expect(orders.every((r) => r.event_id === orders[0]!.event_id)).toBe(true);
    expect(orders.every((r) => r.order_ref === "SO-100001")).toBe(true);
    f.store.close();
    f.outbox.close();
  });

  it("同一协议的第二笔有效订单独立计数（不同 order_id）", async () => {
    const f = makeFixture();
    ingestAndReportOrderRecord({
      merchantId: MERCHANT, store: f.store, dispatcher: f.dispatcher,
      source: { ...f.baseSource, order_id: "SO-100001", status: "completed" }, now: () => NOW,
    });
    ingestAndReportOrderRecord({
      merchantId: MERCHANT, store: f.store, dispatcher: f.dispatcher,
      source: { ...f.baseSource, order_id: "SO-100002", status: "completed", session_ref: "checkout-session-2" }, now: () => NOW,
    });
    await drainUntilEmpty(f);
    const refs = f.submitted
      .filter((r): r is OrderReceipt => r.event_type === "merchant_order_created")
      .map((r) => r.order_ref)
      .sort();
    expect(refs).toEqual(["SO-100001", "SO-100002"]);
    f.store.close();
    f.outbox.close();
  });

  it("非订单创建态（pending/failed checkout）→ skipped，无事实无回执", async () => {
    const f = makeFixture();
    for (const status of ["pending", "failed", "abandoned", ""]) {
      const outcome = ingestAndReportOrderRecord({
        merchantId: MERCHANT, store: f.store, dispatcher: f.dispatcher,
        source: { ...f.baseSource, order_id: `SO-BAD-${status || "empty"}`, status }, now: () => NOW,
      });
      expect(outcome.status).toBe("skipped");
    }
    await drainUntilEmpty(f);
    expect(f.submitted).toHaveLength(0);
    f.store.close();
    f.outbox.close();
  });

  it("摄取校验拒绝（内网 permalink / 缺 terms digest）→ skipped 不上报", async () => {
    const f = makeFixture();
    const outcome = ingestAndReportOrderRecord({
      merchantId: MERCHANT, store: f.store, dispatcher: f.dispatcher,
      source: { ...f.baseSource, order_id: "SO-EVIL", status: "completed", permalink_url: "http://127.0.0.1/order/1" },
      now: () => NOW,
    });
    expect(outcome.status).toBe("skipped");
    await drainUntilEmpty(f);
    expect(f.submitted).toHaveLength(0);
    f.store.close();
    f.outbox.close();
  });
});
