/**
 * 订单复合身份、事件合并、归因与退款（v0.2 §11–§12 / FR19–FR25、AC10–AC12）。
 */
import { describe, expect, it } from "vitest";

import {
  allocateAttributions,
  compareSourceVersion,
  mergeOrderEvent,
  mergeRefund,
  orderIdentityKey,
  refundIdentityKey,
  refundTotalMinor,
  OrderFactError,
  type ExternalOrderIdentity,
  type OrderEvent,
  type OrderLineFact,
  type OrderStreamContract,
  type RefundFact,
} from "../src/merchant-core/orders/model.js";
import { calculateContribution } from "../src/merchant-core/contribution/calculate.js";

const identity: ExternalOrderIdentity = {
  merchant_id: "merchant-1",
  source_namespace: "jd",
  source_account_id: "account-1",
  external_order_id: "order-1",
};

const contract: OrderStreamContract = {
  dimension: "payment",
  ordering: "monotonic",
  version_scope: "payment",
};

function event(overrides: Partial<OrderEvent> = {}): OrderEvent {
  return {
    event_id: "event-1",
    identity,
    dimension: "payment",
    source_version: "1",
    occurred_at: "2026-10-29T09:00:00.000Z",
    observed_at: "2026-10-29T09:01:00.000Z",
    value: "unpaid",
    raw_digest: "digest-1",
    ...overrides,
  };
}

describe("复合外部身份", () => {
  it("订单身份区分商家/来源/账户；退款身份再加退款 ID", () => {
    const base = orderIdentityKey(identity);
    expect(base).not.toBe(orderIdentityKey({ ...identity, source_account_id: "account-2" }));
    expect(base).not.toBe(orderIdentityKey({ ...identity, external_order_id: "order-2" }));
    expect(refundIdentityKey({ ...identity, external_refund_id: "refund-1" })).not.toBe(
      refundIdentityKey({ ...identity, external_refund_id: "refund-2" }),
    );
  });

  it("版本比较：数字按数值，其余按字典序", () => {
    expect(compareSourceVersion("10", "9")).toBe(1);
    expect(compareSourceVersion("v1", "v2")).toBe(-1);
    expect(compareSourceVersion("2", "2")).toBe(0);
  });
});

describe("订单事件合并（字段级权威流）", () => {
  it("无当前事件时按契约接收；不可排序来源保持待核实", () => {
    expect(mergeOrderEvent({ incoming: event(), contract }).status).toBe("accepted");
    expect(
      mergeOrderEvent({
        incoming: event(),
        contract: { ...contract, ordering: "unorderable" },
      }).status,
    ).toBe("unverified");
  });

  it("重放去重；旧事件不覆盖新事实；同版本异内容冲突", () => {
    const current = event({ source_version: "2", raw_digest: "digest-2" });
    expect(mergeOrderEvent({ current, incoming: event({ source_version: "2", raw_digest: "digest-2" }), contract }).status).toBe(
      "duplicate",
    );
    expect(
      mergeOrderEvent({
        current,
        incoming: event({ event_id: "event-0", source_version: "1", raw_digest: "digest-1" }),
        contract,
      }).status,
    ).toBe("stale");
    expect(
      mergeOrderEvent({
        current,
        incoming: event({ event_id: "event-2", source_version: "2", raw_digest: "other" }),
        contract,
      }).status,
    ).toBe("conflict");
    expect(
      mergeOrderEvent({
        current,
        incoming: event({ event_id: "event-3", source_version: "3", raw_digest: "digest-3" }),
        contract,
      }).status,
    ).toBe("accepted");
  });

  it("同一 event_id 直接去重；跨订单事件拒绝", () => {
    const current = event();
    expect(mergeOrderEvent({ current, incoming: event(), contract }).status).toBe("duplicate");
    expect(() =>
      mergeOrderEvent({
        current,
        incoming: event({ identity: { ...identity, external_order_id: "order-2" } }),
        contract,
      }),
    ).toThrowError(OrderFactError);
  });
});

describe("订单行归因", () => {
  const lines: OrderLineFact[] = [
    { line_id: "line-1", sku: "SKU-A", quantity: 10, amount_minor: 1_000 },
    { line_id: "line-2", sku: "SKU-B", quantity: 5, amount_minor: 500 },
  ];

  it("按行分配数量/金额，剩余显式未分配", () => {
    const result = allocateAttributions(lines, [
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
    expect(result.allocations).toHaveLength(2);
    expect(result.totals_by_opportunity).toEqual({
      "opp-1": { quantity: 6, amount_minor: 600 },
      "opp-2": { quantity: 4, amount_minor: 400 },
    });
    expect(result.unassigned).toEqual([
      { line_id: "line-1", quantity: 0, amount_minor: 0 },
      { line_id: "line-2", quantity: 5, amount_minor: 500 },
    ]);
  });

  it("超过行上限、重复归因、未知行、全零归因都拒绝", () => {
    const allocate = (allocations: Parameters<typeof allocateAttributions>[1]) =>
      allocateAttributions(lines, allocations);
    expect(() =>
      allocate([
        { order_line_id: "line-1", opportunity_id: "opp-1", quantity: 11, amount_minor: 1, method: "manual_confirmation" },
      ]),
    ).toThrowError(OrderFactError);
    expect(() =>
      allocate([
        { order_line_id: "line-1", opportunity_id: "opp-1", quantity: 1, amount_minor: 1_001, method: "manual_confirmation" },
      ]),
    ).toThrowError(OrderFactError);
    expect(() =>
      allocate([
        { order_line_id: "line-1", opportunity_id: "opp-1", quantity: 1, amount_minor: 100, method: "manual_confirmation" },
        { order_line_id: "line-1", opportunity_id: "opp-1", quantity: 1, amount_minor: 100, method: "manual_confirmation" },
      ]),
    ).toThrowError(OrderFactError);
    expect(() =>
      allocate([
        { order_line_id: "unknown", opportunity_id: "opp-1", quantity: 1, amount_minor: 100, method: "manual_confirmation" },
      ]),
    ).toThrowError(OrderFactError);
    expect(() =>
      allocate([
        { order_line_id: "line-1", opportunity_id: "opp-1", quantity: 0, amount_minor: 0, method: "manual_confirmation" },
      ]),
    ).toThrowError(OrderFactError);
  });
});

describe("退款事实与更正", () => {
  const refund = (overrides: Partial<RefundFact> = {}): RefundFact => ({
    identity: { ...identity, external_refund_id: "refund-1" },
    amount_minor: 200,
    version: 1,
    status: "active",
    ...overrides,
  });

  it("重放不重复扣减；后续更正替换金额而不是累加", () => {
    const first = mergeRefund([], refund());
    expect(first.status).toBe("inserted");
    const replay = mergeRefund(first.refunds, refund());
    expect(replay.status).toBe("duplicate");
    expect(refundTotalMinor(replay.refunds)).toBe(200);

    const corrected = mergeRefund(first.refunds, refund({ amount_minor: 150, version: 2 }));
    expect(corrected.status).toBe("corrected");
    expect(refundTotalMinor(corrected.refunds)).toBe(150);

    const stale = mergeRefund(corrected.refunds, refund({ amount_minor: 300, version: 1 }));
    expect(stale.status).toBe("duplicate");
    expect(refundTotalMinor(stale.refunds)).toBe(150);
  });

  it("同版本异金额冲突；不同退款 ID 分别累计；撤销退款不再计入", () => {
    const first = mergeRefund([], refund());
    const conflict = mergeRefund(first.refunds, refund({ amount_minor: 201, version: 1 }));
    expect(conflict.status).toBe("conflict");
    expect(refundTotalMinor(conflict.refunds)).toBe(200);

    const other = mergeRefund(first.refunds, refund({ identity: { ...identity, external_refund_id: "refund-2" }, amount_minor: 50 }));
    expect(other.status).toBe("inserted");
    expect(refundTotalMinor(other.refunds)).toBe(250);

    const reversed = mergeRefund(other.refunds, refund({ status: "reversed", version: 2 }));
    expect(refundTotalMinor(reversed.refunds)).toBe(50);
  });

  it("退款总额接入贡献核算（§13.4：1000 − 200 → 800，贡献 120）", () => {
    const refunds = mergeRefund([], refund()).refunds;
    const total = refundTotalMinor(refunds);
    const contribution = calculateContribution({
      net_revenue_minor: undefined,
      gross_revenue_minor: 1_000,
      refund_minor: total,
      costs: {
        goods_cost_minor: 600,
        shipping_cost_minor: 60,
        platform_fee_minor: 0,
        other_variable_minor: 20,
      },
      completeness: "COMPLETE",
      kind: "ACTUAL",
    });
    expect(contribution.net_revenue_minor).toBe(800);
    expect(contribution.contribution_minor).toBe(120);
  });
});
