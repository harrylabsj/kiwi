import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { FakeCommerceClient } from "../src/commerce/fake-client.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import { runNegotiationTurn } from "../src/runtime/negotiation-turn.js";
import { TOOL_GET_SNAPSHOT, TOOL_SUBMIT_DECISION } from "../src/runtime/tools.js";
import {
  buyerAcceptDecision,
  testBuyerPolicy,
  testBuyerProfile,
  testMarketplace,
  testProfile,
  validDecision,
} from "./helpers.js";

interface Market {
  merchant: FakeCommerceClient;
  buyer: FakeCommerceClient;
}

function scriptedTurn(decisionArgs: unknown): FauxResponseStep[] {
  const steps: FauxResponseStep[] = [fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})])];
  if (decisionArgs) {
    steps.push(
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, decisionArgs as Record<string, unknown>),
      ]),
    );
  } else {
    steps.push(fauxAssistantMessage("我无法处理这个请求。"));
  }
  return steps;
}

/** Drive the marketplace to waiting_buyer: merchant counters the buyer ask. */
async function merchantCounters(market: Market): Promise<void> {
  const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
  const report = await runNegotiationTurn({
    profile: testProfile(),
    client: market.merchant,
    streamFn,
  });
  if (report.outcome.kind !== "accepted") {
    throw new Error(`merchant setup failed: ${JSON.stringify(report.outcome)}`);
  }
}

function buyerGatewaySubmitSpy(client: FakeCommerceClient): { count: () => number } {
  let n = 0;
  const original = client.submitNegotiationDecision.bind(client);
  client.submitNegotiationDecision = async (input) => {
    n += 1;
    return original(input);
  };
  return { count: () => n };
}

describe("buyer single turn (fake model + shared fake marketplace)", () => {
  it("accepts the merchant counter: accepted, 3 messages, claim processed", async () => {
    const market = testMarketplace();
    await merchantCounters(market);

    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(buyerAcceptDecision()));
    const report = await runNegotiationTurn({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn,
    });

    expect(report.outcome.kind).toBe("accepted");
    expect(report.policy_result?.next_actor).toBe("merchant");
    expect(market.buyer.messages()).toHaveLength(3);
    expect(market.buyer.conversationState().status).toBe("waiting_merchant");
    const events = market.buyer.auditEvents().map((e) => e.event);
    expect(events).toContain("negotiation_decision_submitted");
    expect(events).toContain("agent_message_processed");
    // The accepted decision was written by the buyer identity.
    expect(market.buyer.messages()[2]?.sender_role).toBe("buyer");
    // No order/payment/reservation semantics anywhere.
    expect(JSON.stringify(market.buyer.messages())).not.toContain("order_id");
  });

  it("a quote exactly at the private budget is allowed when not called a budget", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    // 100 * 2 + 0 = 200 == max_total_price_private; the number alone is a
    // normal quote, not a leak.
    const decision = buyerAcceptDecision();
    decision.proposal!.unit_price = 100;
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(decision));
    const report = await runNegotiationTurn({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn,
    });
    expect(report.outcome.kind).toBe("accepted");
  });

  it("local gate blocks a budget leak BEFORE the gateway; model repairs in-turn", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    const spy = buyerGatewaySubmitSpy(market.buyer);

    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      // Explicitly states the private budget -> local rejection, no gateway call.
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, {
          ...buyerAcceptDecision({ public_message: "我的最高预算是 200，89 元可以" }),
        }),
      ]),
      // Repaired: same decision without budget wording.
      fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, { ...buyerAcceptDecision() })]),
    ]);
    const report = await runNegotiationTurn({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn,
    });

    expect(report.outcome.kind).toBe("accepted");
    // The gateway saw exactly one submission (the repaired one).
    expect(spy.count()).toBe(1);
    expect(market.buyer.messages()).toHaveLength(3);
  });

  it("local gate blocks an over-budget proposal without ever calling the gateway", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    const spy = buyerGatewaySubmitSpy(market.buyer);

    const overBudget = buyerAcceptDecision();
    overBudget.proposal!.unit_price = 150; // 150 * 2 = 300 > 200
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(overBudget));
    const profile = testBuyerProfile();
    profile.runtime.max_retries = 0; // no repair: the turn ends after the local rejection
    const report = await runNegotiationTurn({ profile, client: market.buyer, streamFn });

    expect(spy.count()).toBe(0);
    expect(report.outcome.kind).toBe("failed");
    const serialized = JSON.stringify(report);
    // The private threshold never appears in the report (logs included).
    expect(serialized).not.toContain("200");
    expect(serialized).not.toContain("300");
    expect(market.buyer.messages()).toHaveLength(2);
    expect(market.buyer.auditEvents().map((e) => e.event)).toContain("agent_message_failed");
  });

  it("local gate rejects late ETA and missing required after-sales terms", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    const spy = buyerGatewaySubmitSpy(market.buyer);
    const profile = testBuyerProfile();
    profile.runtime.max_retries = 0;

    const lateEta = buyerAcceptDecision();
    lateEta.proposal!.delivery.eta_end = "2100-01-01T00:00:00+08:00";
    const r1 = createScriptedFakeStreamFn(scriptedTurn(lateEta));
    const report1 = await runNegotiationTurn({
      profile,
      client: market.buyer,
      streamFn: r1.streamFn,
    });
    expect(report1.outcome.kind).toBe("failed");
    expect(spy.count()).toBe(0);
    expect(JSON.stringify(report1)).not.toContain("200");
  });

  it("buyer escalate routes to a human and completes the claim", async () => {
    const market = testMarketplace();
    await merchantCounters(market);

    const escalate = buyerAcceptDecision({
      action: "escalate",
      request_human_review: true,
      reason_codes: ["ambiguous_after_sales"],
    }) as unknown as Record<string, unknown>;
    delete escalate.proposal;
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(escalate));
    const report = await runNegotiationTurn({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn,
    });
    expect(report.outcome.kind).toBe("human_required");
    expect(market.buyer.conversationState().status).toBe("human_required");
    expect(market.buyer.auditEvents().map((e) => e.event)).toContain("agent_message_processed");
  });

  it("guard blocks a decision bound to another conversation; buyer recovers", async () => {
    const market = testMarketplace();
    await merchantCounters(market);

    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, {
          ...buyerAcceptDecision({ conversation_id: "conv-someone-else" }),
        }),
      ]),
      fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, { ...buyerAcceptDecision() })]),
    ]);
    const report = await runNegotiationTurn({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn,
    });
    expect(report.outcome.kind).toBe("accepted");
    expect(market.buyer.messages()).toHaveLength(3);
  });

  it("enforces the submission budget for buyer repairs", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    const spy = buyerGatewaySubmitSpy(market.buyer);
    const profile = testBuyerProfile();
    profile.runtime.max_retries = 0;

    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, {
          ...buyerAcceptDecision({ public_message: "我的最高预算是 200" }),
        }),
      ]),
      // Repair attempt would exceed the budget and must be blocked locally.
      fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, { ...buyerAcceptDecision() })]),
    ]);
    const report = await runNegotiationTurn({ profile, client: market.buyer, streamFn });
    expect(report.outcome.kind).toBe("failed");
    expect(report.outcome.kind === "failed" && report.outcome.error).toMatch(/budget exhausted/);
    expect(spy.count()).toBe(0);
    expect(JSON.stringify(report)).not.toContain("200");
  });

  it("deterministic buyer fake (CLI path) accepts a good counter end to end", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    const { createDeterministicStreamFn } = await import("../src/runtime/fake-model.js");
    const profile = testBuyerProfile();
    const report = await runNegotiationTurn({
      profile,
      client: market.buyer,
      streamFn: createDeterministicStreamFn(profile),
    });
    expect(report.outcome.kind).toBe("accepted");
    expect(market.buyer.messages()[2]?.sender_role).toBe("buyer");
    expect(market.buyer.messages()[2]?.action).toBe("accept_nonbinding");
  });

  it("deterministic buyer escalates instead of leaking when the offer exceeds the budget", async () => {
    const market = testMarketplace();
    await merchantCounters(market);
    const { createDeterministicStreamFn } = await import("../src/runtime/fake-model.js");
    const profile = testBuyerProfile();
    profile.buyer_policy = { ...profile.buyer_policy!, max_total_price_private: 10 };
    const report = await runNegotiationTurn({
      profile,
      client: market.buyer,
      streamFn: createDeterministicStreamFn(profile),
    });
    expect(report.outcome.kind).toBe("human_required");
    expect(JSON.stringify(report)).not.toContain('"10"');
  });
});

describe("checkBuyerLocalPolicy (pure local gate)", () => {
  it("flags every budget-wording variant without echoing private values", async () => {
    const { checkBuyerLocalPolicy } = await import("../src/runtime/buyer-policy.js");
    const policy = testBuyerPolicy();
    for (const text of [
      "我的预算是 200",
      "最高预算 200 元",
      "这超出了我的内部预算",
      "预算上限不允许",
      "my budget is 200",
      "above my price ceiling",
    ]) {
      const violation = checkBuyerLocalPolicy(
        buyerAcceptDecision({ public_message: text }),
        policy,
      );
      expect(violation, text).toBeDefined();
      expect(violation?.reason_codes).toContain("local_budget_leak");
      expect(violation?.public_reason).not.toContain("200");
    }
  });

  it("allows normal price talk that never mentions a budget", async () => {
    const { checkBuyerLocalPolicy } = await import("../src/runtime/buyer-policy.js");
    const policy = testBuyerPolicy();
    for (const text of ["89 元可以成交", "两件 178 元接受", "价格没问题，明天能到吗？"]) {
      expect(
        checkBuyerLocalPolicy(buyerAcceptDecision({ public_message: text }), policy),
        text,
      ).toBeUndefined();
    }
  });

  it("flags over-budget totals, late ETA and missing terms with reasons free of private numbers", async () => {
    const { checkBuyerLocalPolicy, proposalTotal } = await import("../src/runtime/buyer-policy.js");
    const policy = testBuyerPolicy();

    const over = buyerAcceptDecision();
    over.proposal!.unit_price = 150;
    expect(proposalTotal(over)).toBe(300);
    const v1 = checkBuyerLocalPolicy(over, policy);
    expect(v1?.reason_codes).toContain("local_budget_exceeded");
    expect(v1?.public_reason).not.toContain("200");
    expect(v1?.public_reason).not.toContain("300");

    const late = buyerAcceptDecision();
    late.proposal!.delivery.eta_end = "2100-01-01T00:00:00+08:00";
    expect(checkBuyerLocalPolicy(late, policy)?.reason_codes).toContain("local_eta_violation");

    const missing = buyerAcceptDecision();
    missing.proposal!.after_sales_policy_refs = [];
    const v3 = checkBuyerLocalPolicy(missing, policy);
    expect(v3?.reason_codes).toContain("local_missing_after_sales_terms");
    expect(v3?.public_reason).toContain("policy:return-7d");

    // Boundary: exactly at budget and exactly at the latest ETA passes.
    const edge = buyerAcceptDecision();
    edge.proposal!.unit_price = 100; // 100*2 = 200 == budget
    edge.proposal!.delivery.eta_end = policy.acceptable_eta_latest;
    expect(checkBuyerLocalPolicy(edge, policy)).toBeUndefined();
  });
});
