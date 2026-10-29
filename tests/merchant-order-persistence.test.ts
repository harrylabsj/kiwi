/**
 * 订单/退款/归因与成本贡献持久化（v0.2 §11–§13）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { OrderRepository } from "../src/merchant-core/orders/repository.js";
import type { ExternalOrderIdentity, OrderEvent } from "../src/merchant-core/orders/model.js";
import { ContributionRepository } from "../src/merchant-core/contribution/repository.js";
import { calculateContribution } from "../src/merchant-core/contribution/calculate.js";

const NOW = "2026-10-29T10:00:00.000Z";
const identity: ExternalOrderIdentity = {
  merchant_id: "merchant-1",
  source_namespace: "jd",
  source_account_id: "account-1",
  external_order_id: "order-1",
};
let db: DatabaseSync;
let orders: OrderRepository;
let contributions: ContributionRepository;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  orders = new OrderRepository({ db, now: () => NOW });
  contributions = new ContributionRepository({ db, now: () => NOW });
});
afterEach(() => db.close());

function createOrder() {
  return orders.createOrder({
    identity,
    evidenceSource: "manual_report",
    paymentStatus: "paid",
    currency: "CNY",
    totalMinor: 1_000,
    lines: [
      { line_id: "line-1", sku: "SKU-A", quantity: 10, amount_minor: 1_000 },
      { line_id: "line-2", sku: "SKU-B", quantity: 5, amount_minor: 500 },
    ],
  });
}

function event(overrides: Partial<OrderEvent> = {}): OrderEvent {
  return {
    event_id: "event-1",
    identity,
    dimension: "payment",
    source_version: "1",
    occurred_at: "2026-10-29T09:00:00.000Z",
    observed_at: "2026-10-29T09:01:00.000Z",
    value: "paid",
    raw_digest: "digest-1",
    ...overrides,
  };
}

describe("订单事实持久化", () => {
  it("按复合身份幂等创建订单与行", () => {
    const first = createOrder();
    expect(first.created).toBe(true);
    const replay = createOrder();
    expect(replay.created).toBe(false);
    expect(replay.order.record_id).toBe(first.order.record_id);
    expect(orders.listLines(first.order.record_id)).toHaveLength(2);
    expect(orders.listOrders("merchant-1")).toHaveLength(1);
    expect(orders.listOrders("merchant-2")).toHaveLength(0);
  });

  it("事件合并：接收新版本、重放去重、旧版本不覆盖、同版本异内容冲突", () => {
    const { order } = createOrder();
    const contract = { dimension: "payment" as const, ordering: "monotonic" as const, version_scope: "payment" };
    expect(
      orders.appendEvent({ merchantId: "merchant-1", recordId: order.record_id, incoming: event(), contract }).status,
    ).toBe("accepted");
    expect(
      orders.appendEvent({ merchantId: "merchant-1", recordId: order.record_id, incoming: event(), contract }).status,
    ).toBe("duplicate");
    expect(
      orders.appendEvent({
        merchantId: "merchant-1",
        recordId: order.record_id,
        incoming: event({ event_id: "event-0", source_version: "0", raw_digest: "digest-0" }),
        contract,
      }).status,
    ).toBe("stale");
    expect(
      orders.appendEvent({
        merchantId: "merchant-1",
        recordId: order.record_id,
        incoming: event({ event_id: "event-2", source_version: "1", raw_digest: "different" }),
        contract,
      }).status,
    ).toBe("conflict");
    expect(
      orders.appendEvent({
        merchantId: "merchant-1",
        recordId: order.record_id,
        incoming: event({ event_id: "event-3", source_version: "2", raw_digest: "digest-2" }),
        contract,
      }).status,
    ).toBe("accepted");
    expect(orders.listEvents(order.record_id, "payment", identity)).toHaveLength(2);
  });

  it("归因按行上限持久化，剩余显式未分配", () => {
    const { order } = createOrder();
    const result = orders.replaceAttributions("merchant-1", order.record_id, [
      {
        order_line_id: "line-1",
        opportunity_id: "opp-1",
        quantity: 6,
        amount_minor: 600,
        method: "handoff_reference",
      },
      {
        order_line_id: "line-1",
        opportunity_id: "opp-2",
        quantity: 4,
        amount_minor: 400,
        method: "manual_confirmation",
        confirmed_by: "operator-1",
      },
    ]);
    expect(orders.listAttributions(order.record_id)).toHaveLength(2);
    expect(result.unassigned).toEqual([
      { line_id: "line-1", quantity: 0, amount_minor: 0 },
      { line_id: "line-2", quantity: 5, amount_minor: 500 },
    ]);
    expect(() =>
      orders.replaceAttributions("merchant-1", order.record_id, [
        { order_line_id: "line-1", opportunity_id: "opp-1", quantity: 11, amount_minor: 1, method: "manual_confirmation" },
      ]),
    ).toThrowError();
  });

  it("退款重放不重复扣减，更正替换金额，撤销后不计入", () => {
    const { order } = createOrder();
    const refund = {
      identity: { ...identity, external_refund_id: "refund-1" },
      amount_minor: 200,
      version: 1,
      status: "active" as const,
    };
    expect(orders.mergeRefund("merchant-1", order.record_id, refund)).toMatchObject({ status: "inserted", totalMinor: 200 });
    expect(orders.mergeRefund("merchant-1", order.record_id, refund)).toMatchObject({ status: "duplicate", totalMinor: 200 });
    expect(
      orders.mergeRefund("merchant-1", order.record_id, { ...refund, amount_minor: 150, version: 2 }),
    ).toMatchObject({ status: "corrected", totalMinor: 150 });
    expect(
      orders.mergeRefund("merchant-1", order.record_id, { ...refund, status: "reversed", version: 3 }),
    ).toMatchObject({ status: "corrected", totalMinor: 0 });
    expect(orders.listRefunds("merchant-1", order.record_id)).toHaveLength(1);
  });
});

describe("成本与贡献持久化", () => {
  it("成本快照与贡献评估可版本化读写", () => {
    const snapshot = contributions.saveCostSnapshot({
      merchant_id: "merchant-1",
      ref_kind: "order",
      ref_id: "order-1",
      currency: "CNY",
      completeness: "COMPLETE",
      costs: { goods_cost_minor: 600, shipping_cost_minor: 60, platform_fee_minor: 0, other_variable_minor: 20 },
      missing_items: [],
      version: 1,
    });
    const assessment = calculateContribution({
      net_revenue_minor: 800,
      costs: {
        goods_cost_minor: 600,
        shipping_cost_minor: 60,
        platform_fee_minor: 0,
        other_variable_minor: 20,
      },
      completeness: "COMPLETE",
      kind: "ACTUAL",
      gate: { enabled: true, min_contribution_minor: 100, min_rate_bps: 1_000 },
    });
    const saved = contributions.saveAssessment({
      merchantId: "merchant-1",
      refKind: "order",
      refId: "order-1",
      assessment,
      costSnapshotId: snapshot.snapshot_id,
    });
    expect(saved.assessment).toEqual(assessment);
    expect(contributions.getCostSnapshot("merchant-1", snapshot.snapshot_id)?.costs.goods_cost_minor).toBe(600);
    expect(contributions.listAssessments("merchant-1", "order", "order-1")).toHaveLength(1);
    expect(contributions.getAssessment("merchant-2", saved.assessment_id)).toBeUndefined();
  });

  it("未算全的贡献保持 null，不被写成 0", () => {
    const assessment = calculateContribution({
      net_revenue_minor: 1_000,
      costs: { goods_cost_minor: 620 },
      completeness: "INCOMPLETE",
      missing_cost_items: ["shipping"],
      kind: "ACTUAL",
    });
    const saved = contributions.saveAssessment({
      merchantId: "merchant-1",
      refKind: "order",
      refId: "order-2",
      assessment,
    });
    expect(saved.assessment.contribution_minor).toBeNull();
    expect(saved.assessment.known_contribution_minor).toBe(380);
    expect(contributions.listAssessments("merchant-1", "order", "order-2")[0]?.assessment.contribution_minor).toBeNull();
  });
});
