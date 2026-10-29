/**
 * 商家经营门面：认证商家注入 + 计划/机会共用 state.sqlite（v0.2 §15.1/§17）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMerchantOperationsFacade, type MerchantOperationsFacade } from "../src/merchant-core/ops/facade.js";

let db: DatabaseSync;
let facade: MerchantOperationsFacade;
const now = () => "2026-10-29T10:00:00.000Z";

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  facade = openMerchantOperationsFacade({ db, merchantId: "merchant-1", now });
});

afterEach(() => db.close());

describe("MerchantOperationsFacade", () => {
  it("商家身份由门面注入：调用方无需也不能传 merchant_id", () => {
    const plan = facade.createPlan({
      source: "shopping-cli",
      source_account_id: "account-1",
      sku: "SKU-1",
      effective_from: "2026-11-01T00:00:00.000Z",
      effective_to: "2026-12-01T00:00:00.000Z",
      conditions: { quantity_range: { min: 1, max: 10 } },
      actions: {},
      authorization: { owner: "owner-1", scopes: ["publish_quote"] },
    });
    expect(plan.merchant_id).toBe("merchant-1");
    expect(
      facade.getEffectivePlan({
        source: "shopping-cli",
        sourceAccountId: "account-1",
        sku: "SKU-1",
        at: "2026-11-02T00:00:00.000Z",
      })?.plan_id,
    ).toBe(plan.plan_id);
    expect(facade.listPlans()).toHaveLength(1);
  });

  it("计划与机会在同一库内可组合；另一商家看不到", () => {
    facade.createPlan({
      source: "shopping-cli",
      source_account_id: "account-1",
      sku: "SKU-1",
      effective_from: "2026-11-01T00:00:00.000Z",
      conditions: {},
      actions: {},
      authorization: { owner: "owner-1", scopes: [] },
    });

    const ingested = facade.ingestSource({
      source_namespace: "manual-rfq",
      source_account_id: "account-1",
      external_inquiry_id: "inquiry-1",
      external_event_id: "event-1",
      event_kind: "message",
      raw_excerpt: "500 个纸箱",
      received_at: "2026-10-29T09:00:00.000Z",
      operator: "operator-1",
      parse_version: "v1",
    });
    const created = facade.createOpportunity({
      source_id: ingested.source.source_id,
      owner: "operator-1",
      operator: "operator-1",
      next_action: "确认尺寸",
      required_fields: ["quantity"],
      requirement_fields: [{ field: "quantity", value: 500, status: "UNKNOWN" }],
      basis: "manual entry",
    });
    expect(created.opportunity.status).toBe("NEEDS_INFO");

    const advanced = facade.recordRequirement({
      opportunity_id: created.opportunity.opportunity_id,
      expected_revision: created.opportunity.revision,
      required_fields: ["quantity"],
      fields: [
        {
          field: "quantity",
          value: 500,
          status: "CONFIRMED",
          confirmed_by: "operator-1",
          confirmed_at: "2026-10-29T09:30:00.000Z",
        },
      ],
      created_by: "operator-1",
      actor: "operator-1",
    });
    expect(advanced.opportunity.status).toBe("READY_FOR_PROPOSAL");

    const other = openMerchantOperationsFacade({ db, merchantId: "merchant-2", now });
    expect(other.listPlans()).toHaveLength(0);
    expect(other.listOpportunities()).toHaveLength(0);
    expect(other.getOpportunity(created.opportunity.opportunity_id)).toBeUndefined();
  });

  it("门面同时装配方案与跟进，商家身份一致", () => {
    const set = facade.prepareProposal({
      opportunity_id: "opp-1",
      requirement_revision: 1,
      facts_digest: "facts:v1",
      policy_version: "policy:v1",
      now: "2026-10-29T10:00:00.000Z",
      options: [
        {
          sku: "SKU-1",
          unit: "piece",
          quantity: 2,
          base_unit_price_minor: 1_000,
          line_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
          shipping_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
          adaptation: [],
        },
      ],
    });
    expect(set.merchant_id).toBe("merchant-1");
    expect(facade.getProposal(set.set_id)?.set_id).toBe(set.set_id);

    const followUp = facade.scheduleFollowUp({
      opportunity_id: "opp-1",
      trigger_event: "quote_not_answered",
      action_type: "merchant_todo",
      max_attempts: 3,
      payload: {},
    });
    expect(followUp.merchant_id).toBe("merchant-1");
    expect(facade.listFollowUps()).toHaveLength(1);
  });

  it("幂等键经门面透传：同计划重放不重复创建", () => {
    const input = {
      source: "shopping-cli",
      source_account_id: "account-1",
      sku: "SKU-1",
      effective_from: "2026-11-01T00:00:00.000Z",
      conditions: {},
      actions: {},
      authorization: { owner: "owner-1", scopes: [] as string[] },
    };
    const first = facade.createPlan(input, { idempotency_key: "plan-cmd-1" });
    const replay = facade.createPlan(input, { idempotency_key: "plan-cmd-1" });
    expect(replay.plan_id).toBe(first.plan_id);
    expect(facade.listPlans()).toHaveLength(1);
  });
});
