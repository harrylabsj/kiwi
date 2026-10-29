/**
 * 商品经营计划（v0.2 §5.1 / FR01–FR04、FR15、FR17、AC01/AC18）。
 *
 * 覆盖：区间不重叠、暂停/恢复、原子切版本、幂等重放、就绪检查与租户隔离。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { MerchantOperatingPlanRepository } from "../src/merchant-core/operating/repository.js";
import { MerchantOperatingPlanService } from "../src/merchant-core/operating/service.js";
import type { OperatingPlanInput } from "../src/merchant-core/operating/types.js";

let clock = "2026-10-29T10:00:00.000Z";
const now = () => clock;

let db: DatabaseSync;
let service: MerchantOperatingPlanService;
let repository: MerchantOperatingPlanRepository;

beforeEach(() => {
  clock = "2026-10-29T10:00:00.000Z";
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  repository = new MerchantOperatingPlanRepository({ db, now });
  service = new MerchantOperatingPlanService({ repository, now });
});

afterEach(() => {
  db.close();
});

function planInput(overrides: Partial<OperatingPlanInput> = {}): OperatingPlanInput {
  return {
    merchant_id: "merchant-1",
    source: "shopping-cli",
    source_account_id: "account-1",
    sku: "SKU-1",
    effective_from: "2026-11-01T00:00:00.000Z",
    effective_to: "2026-12-01T00:00:00.000Z",
    conditions: {
      quantity_range: { min: 1, max: 100 },
      allowed_units: ["piece"],
    },
    actions: { promotions: [] },
    authorization: { owner: "owner-1", scopes: ["publish_quote"] },
    ...overrides,
  };
}

const effectiveKey = {
  merchantId: "merchant-1",
  source: "shopping-cli",
  sourceAccountId: "account-1",
  sku: "SKU-1",
};

describe("MerchantOperatingPlanService", () => {
  it("创建计划并按 UTC 半开区间取生效版本", () => {
    const plan = service.create(planInput());
    expect(plan.status).toBe("ACTIVE");
    expect(plan.revision).toBe(1);

    expect(service.getEffective({ ...effectiveKey, at: "2026-10-31T23:59:59.999Z" })).toBeUndefined();
    expect(service.getEffective({ ...effectiveKey, at: "2026-11-01T00:00:00.000Z" })?.plan_id).toBe(plan.plan_id);
    expect(service.getEffective({ ...effectiveKey, at: "2026-11-30T23:59:59.999Z" })?.plan_id).toBe(plan.plan_id);
    expect(service.getEffective({ ...effectiveKey, at: "2026-12-01T00:00:00.000Z" })).toBeUndefined();
  });

  it("同一商品的生效区间不得重叠（部分重叠/包含/无上限）", () => {
    service.create(planInput());
    for (const [from, to] of [
      ["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"],
      ["2026-11-15T00:00:00.000Z", "2026-12-15T00:00:00.000Z"],
      ["2026-10-15T00:00:00.000Z", "2026-11-15T00:00:00.000Z"],
      ["2026-11-15T00:00:00.000Z", undefined],
    ] as const) {
      expect(() =>
        service.create(
          planInput({
            effective_from: from,
            ...(to !== undefined ? { effective_to: to } : {}),
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "interval_overlap" }));
    }
  });

  it("首尾相接的区间允许创建（半开区间）", () => {
    service.create(planInput());
    const before = service.create(
      planInput({ effective_from: "2026-10-01T00:00:00.000Z", effective_to: "2026-11-01T00:00:00.000Z" }),
    );
    const after = service.create(
      planInput({ effective_from: "2026-12-01T00:00:00.000Z", effective_to: "2027-01-01T00:00:00.000Z" }),
    );
    expect(before.plan_id).not.toBe(after.plan_id);
    expect(service.getEffective({ ...effectiveKey, at: "2026-10-15T00:00:00.000Z" })?.plan_id).toBe(
      before.plan_id,
    );
  });

  it("未生效计划可原地修改；已生效计划必须切版本", () => {
    const plan = service.create(planInput());
    const updated = service.update({
      merchant_id: "merchant-1",
      plan_id: plan.plan_id,
      expected_revision: plan.revision,
      patch: { conditions: { quantity_range: { min: 5, max: 50 }, allowed_units: ["piece"] } },
    });
    expect(updated.revision).toBe(2);
    expect(updated.conditions.quantity_range).toEqual({ min: 5, max: 50 });

    clock = "2026-11-02T00:00:00.000Z";
    expect(() =>
      service.update({
        merchant_id: "merchant-1",
        plan_id: plan.plan_id,
        expected_revision: updated.revision,
        patch: { actions: { promotions: ["x"] } },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interval" }));
  });

  it("暂停不释放区间；恢复重验有效期与授权", () => {
    const plan = service.create(planInput());
    clock = "2026-11-02T00:00:00.000Z";
    const paused = service.pause({
      merchant_id: "merchant-1",
      plan_id: plan.plan_id,
      expected_revision: plan.revision,
    });
    expect(paused.status).toBe("PAUSED");
    expect(service.getEffective({ ...effectiveKey, at: "2026-11-02T00:00:00.000Z" })).toBeUndefined();

    const resumed = service.resume({
      merchant_id: "merchant-1",
      plan_id: plan.plan_id,
      expected_revision: paused.revision,
    });
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.effective_to).toBe("2026-12-01T00:00:00.000Z");

    // 过期后不能恢复。
    clock = "2026-12-02T00:00:00.000Z";
    const pausedAgain = service.pause({
      merchant_id: "merchant-1",
      plan_id: plan.plan_id,
      expected_revision: resumed.revision,
    });
    expect(() =>
      service.resume({
        merchant_id: "merchant-1",
        plan_id: plan.plan_id,
        expected_revision: pausedAgain.revision,
      }),
    ).toThrowError(expect.objectContaining({ code: "plan_expired" }));
  });

  it("授权撤销后不能恢复", () => {
    const plan = service.create(
      planInput({
        authorization: {
          owner: "owner-1",
          scopes: ["publish_quote"],
          revoked_at: "2026-11-01T00:00:00.000Z",
        },
      }),
    );
    clock = "2026-11-02T00:00:00.000Z";
    const paused = service.pause({
      merchant_id: "merchant-1",
      plan_id: plan.plan_id,
      expected_revision: plan.revision,
    });
    expect(() =>
      service.resume({
        merchant_id: "merchant-1",
        plan_id: plan.plan_id,
        expected_revision: paused.revision,
      }),
    ).toThrowError(expect.objectContaining({ code: "authorization_revoked" }));
  });

  it("版本切换原子关闭旧区间并建立新区间", () => {
    const plan = service.create(planInput());
    const switched = service.switchVersion({
      merchant_id: "merchant-1",
      plan_id: plan.plan_id,
      expected_revision: plan.revision,
      effective_from: "2026-11-15T00:00:00.000Z",
      patch: {
        conditions: { quantity_range: { min: 10, max: 200 }, allowed_units: ["piece"] },
      },
    });
    expect(switched.previous.effective_to).toBe("2026-11-15T00:00:00.000Z");
    expect(switched.next.effective_from).toBe("2026-11-15T00:00:00.000Z");
    expect(switched.next.effective_to).toBe("2026-12-01T00:00:00.000Z");
    expect(switched.next.conditions.quantity_range).toEqual({ min: 10, max: 200 });

    expect(service.getEffective({ ...effectiveKey, at: "2026-11-10T00:00:00.000Z" })?.plan_id).toBe(
      plan.plan_id,
    );
    expect(service.getEffective({ ...effectiveKey, at: "2026-11-20T00:00:00.000Z" })?.plan_id).toBe(
      switched.next.plan_id,
    );
  });

  it("版本切换不能回写历史或越过当前区间", () => {
    const plan = service.create(planInput());
    expect(() =>
      service.switchVersion({
        merchant_id: "merchant-1",
        plan_id: plan.plan_id,
        expected_revision: plan.revision,
        effective_from: "2026-10-30T00:00:00.000Z",
        patch: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interval" }));
    expect(() =>
      service.switchVersion({
        merchant_id: "merchant-1",
        plan_id: plan.plan_id,
        expected_revision: plan.revision,
        effective_from: "2026-12-01T00:00:00.000Z",
        patch: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_interval" }));
  });

  it("幂等键：同内容重放返回原结果，异内容冲突", () => {
    const input = planInput();
    const first = service.create(input, { idempotency_key: "cmd-1" });
    const replay = service.create(input, { idempotency_key: "cmd-1" });
    expect(replay.plan_id).toBe(first.plan_id);
    expect(service.list("merchant-1")).toHaveLength(1);

    expect(() =>
      service.create(planInput({ sku: "SKU-2" }), { idempotency_key: "cmd-1" }),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it("租户隔离：其他商家读不到/改不了计划", () => {
    const plan = service.create(planInput());
    expect(repository.getById("merchant-2", plan.plan_id)).toBeUndefined();
    expect(() =>
      service.update({
        merchant_id: "merchant-2",
        plan_id: plan.plan_id,
        expected_revision: 1,
        patch: { actions: {} },
      }),
    ).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("三级就绪检查：暂停/缺条件/成本未知/订单源不可用分别阻断", () => {
    const plan = service.create(planInput());
    const at = "2026-11-02T00:00:00.000Z";

    expect(service.readiness(plan, { at, order_source_ready: true })).toMatchObject({
      can_receive_demand: { ok: true },
      can_publish_quote: { ok: true },
      can_verify_orders: { ok: true },
    });

    const noConditions = service.readiness(
      { ...plan, conditions: {} },
      { at, order_source_ready: true },
    );
    expect(noConditions.can_receive_demand.ok).toBe(true);
    expect(noConditions.can_publish_quote).toMatchObject({
      ok: false,
      blockers: expect.arrayContaining(["missing_quantity_range", "missing_allowed_units"]),
    });

    const noCost = service.readiness(plan, {
      at,
      contribution_gate_enabled: true,
      cost_complete: false,
      order_source_ready: false,
    });
    expect(noCost.can_publish_quote.blockers).toContain("missing_cost");
    expect(noCost.can_verify_orders.blockers).toContain("order_source_unavailable");

    const paused = service.readiness({ ...plan, status: "PAUSED" }, { at, order_source_ready: true });
    expect(paused.can_publish_quote.blockers).toContain("plan_paused");
  });

  it("输入校验：非法区间、空授权、非对象条件被拒绝", () => {
    expect(() =>
      service.create(planInput({ effective_to: "2026-11-01T00:00:00.000Z" })),
    ).toThrowError(expect.objectContaining({ code: "invalid_interval" }));
    expect(() =>
      service.create(planInput({ authorization: { owner: "", scopes: [] } })),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
    expect(() =>
      service.create(planInput({ conditions: [] as unknown as Record<string, unknown> })),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});
