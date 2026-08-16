/**
 * Kiwi Northbound 契约 v0.1 schema 测试（战略 v2.5 §5.2 / §5.3 / §5.5 / §6.2）。
 *
 * 正例：完整 CommerceIntent / DelegationPolicy / EffectiveAuthorization /
 * PersistentTask 通过冻结 schema。反例：缺 items / payment≠never /
 * deny 优先被破坏（一层 denied 却 granted）/ 缺 idempotency_key。
 */
import { describe, expect, it } from "vitest";
import {
  validateCommerceIntent,
  validateDelegationPolicy,
  validateEffectiveAuthorization,
  validatePersistentTask,
} from "../src/contracts/northbound-schema.js";

const TS = "2026-08-15T10:00:00+08:00";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("CommerceIntent v0.1 schema", () => {
  it("合法 purchase intent 通过", () => {
    const errors = validateCommerceIntent({
      intent_id: "intent-0001",
      intent_type: "purchase",
      items: [
        {
          query: "USB-C 扩展坞",
          sku: "dock-usbc-8in1",
          quantity: { value: 3, unit: "台" },
        },
      ],
      constraints: {
        budget: { currency: "CNY", amount_minor: 1200000 },
        delivery_location: "杭州",
        deadline: "2026-08-30T18:00:00+08:00",
      },
      context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items"] },
    });
    expect(errors).toEqual([]);
  });

  it("缺 items 被拒绝", () => {
    const errors = validateCommerceIntent({ intent_id: "intent-x", intent_type: "procurement" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("非法 intent_type 被拒绝", () => {
    const errors = validateCommerceIntent({
      intent_id: "intent-x",
      intent_type: "purchase_order",
      items: [{ query: "扩展坞" }],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("DelegationPolicy v0.1 schema", () => {
  const baseActions = {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "ask" },
  } as const;

  it("合法 policy（payment=never）通过", () => {
    const errors = validateDelegationPolicy({
      policy_id: "dp-0001",
      version: "1.0",
      principal: "company:acme",
      expires_at: TS,
      actions: { ...baseActions, payment: { mode: "never" } },
      limits: {
        max_total_price: { currency: "CNY", amount_minor: 1200000 },
        max_rounds: 3,
        allowed_currencies: ["CNY"],
      },
    });
    expect(errors).toEqual([]);
  });

  it("payment≠never（auto）被拒绝——KNP 硬不变量", () => {
    const errors = validateDelegationPolicy({
      policy_id: "dp-bad",
      version: "1.0",
      principal: "company:acme",
      expires_at: TS,
      actions: { ...baseActions, payment: { mode: "auto" } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("缺必需动作被拒绝", () => {
    const errors = validateDelegationPolicy({
      policy_id: "dp-bad",
      version: "1.0",
      principal: "company:acme",
      expires_at: TS,
      actions: { discover: { mode: "auto" } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("EffectiveAuthorization v0.1 schema", () => {
  const subject = {
    buyer_agent_id: "buyer-agent:hermes-001",
    session_id: "session-0001",
    delegation_id: "dp-0001",
    expires_at: TS,
  } as const;

  function layers(
    status: "allowed" | "denied",
  ): Record<
    string,
    { status: "allowed" | "denied"; reason?: string }
  > {
    return {
      package_trust: { status },
      host_tool_policy: { status },
      runtime_approval: { status },
      kiwi_delegation_policy: { status },
      merchant_hard_policy: { status },
    };
  }

  it("五层全部 allowed + granted 通过", () => {
    const errors = validateEffectiveAuthorization({
      authorization_id: "authz-0001",
      action: "accept_nonbinding",
      subject,
      layers: layers("allowed"),
      effective_decision: "granted",
      approval_id: "appr-0001",
      decided_at: TS,
    });
    expect(errors).toEqual([]);
  });

  it("任一层 denied 但 granted 被拒绝——deny 优先不变量", () => {
    const l = layers("allowed");
    l.runtime_approval = { status: "denied", reason: "host UI allow 不能提升硬策略" };
    const errors = validateEffectiveAuthorization({
      authorization_id: "authz-bad",
      action: "handoff",
      subject,
      layers: l,
      effective_decision: "granted",
      decided_at: TS,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("granted 但五层未全部 allowed 被拒绝——交集语义", () => {
    const errors = validateEffectiveAuthorization({
      authorization_id: "authz-bad2",
      action: "discover",
      subject,
      layers: {
        package_trust: { status: "allowed" },
        host_tool_policy: { status: "allowed" },
        runtime_approval: { status: "allowed" },
        kiwi_delegation_policy: { status: "allowed" },
        merchant_hard_policy: { status: "denied" },
      },
      effective_decision: "granted",
      decided_at: TS,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("denied + 有层 denied 通过（deny 优先合法态）", () => {
    const errors = validateEffectiveAuthorization({
      authorization_id: "authz-denied-ok",
      action: "handoff",
      subject,
      layers: {
        package_trust: { status: "allowed" },
        host_tool_policy: { status: "allowed" },
        runtime_approval: { status: "denied" },
        kiwi_delegation_policy: { status: "allowed" },
        merchant_hard_policy: { status: "allowed" },
      },
      effective_decision: "denied",
      decided_at: TS,
    });
    expect(errors).toEqual([]);
  });
});

describe("PersistentTask v0.1 schema", () => {
  it("合法 partial_success 任务通过", () => {
    const errors = validatePersistentTask({
      task_id: "task-rfq-0001",
      task_kind: "request_quotes",
      status: "partial_success",
      idempotency_key: "rfq-20260815-k3",
      intent_id: "intent-0001",
      delegation_policy_id: "dp-0001",
      created_at: TS,
      updated_at: TS,
      expires_at: "2026-08-16T10:00:00+08:00",
      resumable: true,
      candidates: [
        {
          candidate_id: "cand-001",
          merchant_id: "merchant-001",
          status: "succeeded",
          provenance: { negotiation_id: "neg-1", offer_id: "offer-1", source: "a2a" },
          expires_at: "2026-08-15T11:30:00+08:00",
          retryable: false,
        },
        {
          candidate_id: "cand-002",
          merchant_id: "merchant-002",
          status: "failed",
          failure: { classification: "timeout", retryable: true },
          retryable: true,
        },
      ],
      approval: {
        approval_id: "appr-0001",
        action: "accept_nonbinding",
        status: "pending",
        candidate_digest: DIGEST,
        expires_at: TS,
      },
    });
    expect(errors).toEqual([]);
  });

  it("缺 idempotency_key 被拒绝", () => {
    const errors = validatePersistentTask({
      task_id: "task-x",
      task_kind: "search",
      status: "pending",
      created_at: TS,
      updated_at: TS,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("非法任务状态被拒绝", () => {
    const errors = validatePersistentTask({
      task_id: "task-x",
      task_kind: "search",
      status: "half_done",
      idempotency_key: "k3",
      created_at: TS,
      updated_at: TS,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
