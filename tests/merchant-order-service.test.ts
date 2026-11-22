/**
 * 订单申报/来源核实/归因/退款/贡献（v0.2 §11–§13 / AC10–AC14）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { OrderRepository } from "../src/merchant-core/orders/repository.js";
import { MerchantOrderService, validateOrderSourceContract } from "../src/merchant-core/orders/service.js";
import { ContributionRepository } from "../src/merchant-core/contribution/repository.js";
import { OrderFactError, type ExternalOrderIdentity } from "../src/merchant-core/orders/model.js";

const NOW = "2026-10-29T10:00:00.000Z";
const identity: ExternalOrderIdentity = {
  merchant_id: "merchant-1",
  source_namespace: "jd",
  source_account_id: "account-1",
  external_order_id: "order-1",
};
let db: DatabaseSync;
let service: MerchantOrderService;
let orders: OrderRepository;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  orders = new OrderRepository({ db, now: () => NOW });
  service = new MerchantOrderService({
    orders,
    contributions: new ContributionRepository({ db, now: () => NOW }),
  });
});
afterEach(() => db.close());

function report() {
  return service.recordManualReport({
    identity,
    lines: [{ line_id: "line-1", sku: "SKU-A", quantity: 10, amount_minor: 1_000 }],
    currency: "CNY",
    total_minor: 1_000,
    payment_status: "paid",
    observed_at: NOW,
    reported_by: "operator-1",
    evidence_ref: "chat-snippet-1",
  });
}

describe("MerchantOrderService", () => {
  it("rolls back after a failed BEGIN on the same repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-lock-"));
    const file = join(dir, "db");
    const holder = new DatabaseSync(file);
    const writer = new DatabaseSync(file);
    try {
      holder.exec("create table entries(n); begin immediate");
      const repo = new OrderRepository({ db: writer, now: () => NOW });
      expect(() => repo.transaction(() => {})).toThrow(/locked/);
      holder.exec("rollback");
      expect(() => repo.transaction(() => {
        writer.exec("insert into entries values(1)");
        throw new Error("abort");
      })).toThrow("abort");
      expect(holder.prepare("select * from entries").all()).toHaveLength(0);
    } finally {
      writer.close();
      holder.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("separates attribution IDs across orders and refuses orphan assessments", () => {
    const first = report();
    const { order: second } = orders.createOrder({ identity: { ...identity, external_order_id: "second" },
      evidenceSource: "manual_report", lines: orders.listLines(first.record_id) });
    const allocations = [{ order_line_id: "line-1", opportunity_id: "same", quantity: 1,
      amount_minor: 100, method: "manual_confirmation" as const }];
    for (const id of [first.record_id, second.record_id, second.record_id]) {
      orders.replaceAttributions(identity.merchant_id, id, allocations);
    }
    expect(db.prepare("select * from order_attributions_v2").all()).toHaveLength(2);
    expect(() => service.assessContribution({ merchantId: identity.merchant_id, recordId: "missing",
      contribution: { kind: "ACTUAL", costs: {}, completeness: "COMPLETE" } })).toThrow(/not found/);
  });

  it("人工申报只写 manual_report，不提供工作台自证升级", () => {
    const order = report();
    expect(order.evidence_source).toBe("manual_report");
    expect(order.verified_at).toBeNull();
  });

  it("归因与退款沿用行级上限与更正语义", () => {
    const order = report();
    const attributed = service.attribute("merchant-1", order.record_id, [
      {
        order_line_id: "line-1",
        opportunity_id: "opp-1",
        quantity: 4,
        amount_minor: 400,
        method: "manual_confirmation",
        confirmed_by: "operator-1",
      },
    ]);
    expect(attributed.unassigned[0]).toMatchObject({ quantity: 6, amount_minor: 600 });

    const refund = {
      identity: { ...identity, external_refund_id: "refund-1" },
      amount_minor: 200,
      version: 1,
      status: "active" as const,
    };
    expect(service.recordRefund({ merchantId: "merchant-1", recordId: order.record_id, refund })).toMatchObject({
      status: "inserted",
      totalMinor: 200,
    });
    expect(
      service.recordRefund({
        merchantId: "merchant-1",
        recordId: order.record_id,
        refund: { ...refund, amount_minor: 150, version: 2 },
      }),
    ).toMatchObject({ status: "corrected", totalMinor: 150 });
  });

  it("贡献评估持久化，退款后净收入与贡献正确", () => {
    const order = report();
    service.recordRefund({ merchantId: "merchant-1", recordId: order.record_id, refund: {
      identity: { ...identity, external_refund_id: "refund-1" }, amount_minor: 200, version: 1, status: "active",
    } });
    const saved = service.assessContribution({
      merchantId: "merchant-1",
      recordId: order.record_id,
      contribution: {
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
      },
    });
    expect(saved.assessment.contribution_minor).toBe(120);
    expect(saved.assessment.gate.status).toBe("PASSED");
  });

  it("人工申报行明细逐字段校验，坏行整单拒绝", () => {
    for (const lines of [
      [{ line_id: "l1", sku: "", quantity: 1, amount_minor: 1 }],
      [{ line_id: "l1", sku: "SKU", quantity: 0, amount_minor: 1 }],
      [{ line_id: "l1", sku: "SKU", quantity: 1, amount_minor: -1 }],
      [
        { line_id: "l1", sku: "SKU", quantity: 1, amount_minor: 1 },
        { line_id: "l1", sku: "SKU2", quantity: 1, amount_minor: 1 },
      ],
    ]) {
      expect(() =>
        service.recordManualReport({
          identity,
          lines,
          observed_at: NOW,
          reported_by: "operator-1",
        }),
      ).toThrowError(OrderFactError);
    }
  });

  it("归因按商户收口，未知订单返回 not_found", () => {
    const order = report();
    expect(() => service.attribute("merchant-2", order.record_id, [])).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(() => service.attribute("merchant-1", "ord_missing", [])).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  it("来源契约与申报字段校验", () => {
    expect(() =>
      validateOrderSourceContract({
        source_namespace: "jd",
        source_account_id: "account-1",
        ordering: "monotonic",
        version_scope: "payment",
        event_id_scope: "order",
        supports_watermark: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateOrderSourceContract({
        source_namespace: "",
        source_account_id: "account-1",
        ordering: "monotonic",
        version_scope: "payment",
        event_id_scope: "order",
        supports_watermark: true,
      }),
    ).toThrowError(OrderFactError);
    expect(() =>
      service.recordManualReport({
        identity,
        lines: [],
        observed_at: "not-a-time",
        reported_by: "operator-1",
      }),
    ).toThrowError(OrderFactError);
  });
});
