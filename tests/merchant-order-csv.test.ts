/**
 * 人工/CSV 订单申报（v0.2 §11.1 / FR19）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { parseCsv, parseOrderCsv } from "../src/merchant-core/orders/csv.js";
import { MerchantOrderService } from "../src/merchant-core/orders/service.js";
import { OrderRepository } from "../src/merchant-core/orders/repository.js";
import { ContributionRepository } from "../src/merchant-core/contribution/repository.js";
import { OrderFactError } from "../src/merchant-core/orders/model.js";

const NOW = "2026-10-29T10:00:00.000Z";
const header =
  "source_namespace,source_account_id,external_order_id,line_id,sku,quantity,amount_minor,observed_at,currency,total_minor,payment_status";
let db: DatabaseSync;
let service: MerchantOrderService;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  service = new MerchantOrderService({
    orders: new OrderRepository({ db, now: () => NOW }),
    contributions: new ContributionRepository({ db, now: () => NOW }),
  });
});
afterEach(() => db.close());

function csv(rows: string[]): string {
  return [header, ...rows].join("\n");
}

describe("CSV 解析", () => {
  it("支持引号内的逗号、双引号与多行分组", () => {
    const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,1", 'he said "hi"'],
    ]);

    const reports = parseOrderCsv(
      csv([
        "jd,acc-1,order-1,l1,SKU-A,2,1000,2026-10-29T10:00:00Z,CNY,1000,paid",
        "jd,acc-1,order-1,l2,SKU-B,1,500,2026-10-29T10:00:00Z,CNY,1000,paid",
        "jd,acc-1,order-2,l1,SKU-C,3,900,2026-10-29T10:00:00Z,CNY,900,paid",
      ]),
    );
    expect(reports).toHaveLength(2);
    expect(reports[0]?.lines).toHaveLength(2);
    expect(reports[0]?.total_minor).toBe(1_000);
  });

  it("缺列、重复行、非法数字整批拒绝", () => {
    expect(() => parseOrderCsv("source_namespace,source_account_id\njd,acc")).toThrowError(OrderFactError);
    expect(() =>
      parseOrderCsv(
        csv([
          "jd,acc-1,order-1,l1,SKU-A,2,1000,2026-10-29T10:00:00Z,CNY,1000,paid",
          "jd,acc-1,order-1,l1,SKU-B,1,500,2026-10-29T10:00:00Z,CNY,1000,paid",
        ]),
      ),
    ).toThrowError(OrderFactError);
    expect(() =>
      parseOrderCsv(csv(["jd,acc-1,order-1,l1,SKU-A,two,1000,2026-10-29T10:00:00Z,CNY,1000,paid"])),
    ).toThrowError(OrderFactError);
  });

  it("服务写入 csv_import 证据，重复导入不新建订单", () => {
    const text = csv(["jd,acc-1,order-1,l1,SKU-A,2,1000,2026-10-29T10:00:00Z,CNY,1000,paid"]);
    const first = service.recordCsvReport({ merchantId: "merchant-1", csv: text, reportedBy: "operator-1", observedAtFallback: NOW });
    expect(first).toHaveLength(1);
    expect(first[0]?.evidence_source).toBe("csv_import");
    const second = service.recordCsvReport({ merchantId: "merchant-1", csv: text, reportedBy: "operator-1", observedAtFallback: NOW });
    expect(second[0]?.record_id).toBe(first[0]?.record_id);
    expect(service.listOrders("merchant-1")).toHaveLength(1);
  });
});
