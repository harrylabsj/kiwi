/**
 * OperatorController tests: the supervised approval boundary, approval-gate
 * routing for all three modes, candidate lifecycle (approve/reject/revise),
 * pause/resume, strategy confirmation, event-sourced recovery and shutdown.
 *
 * All commerce writes go through FakeCommerceClient (LocalMarketplace
 * semantics); nothing is stubbed at the Commerce boundary.
 */
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/config/profile.js";
import type { FakeCommerceClient } from "../src/commerce/fake-client.js";
import {
  OperatorController,
  initialOperatorState,
  reduceOperatorEvent,
  routeCandidate,
} from "../src/operator/controller.js";
import { DeterministicNegotiationRunner } from "../src/operator/runner.js";
import { InMemoryOperatorEventStore } from "../src/operator/store.js";
import { createStrategyEngine } from "../src/operator/strategy.js";
import { NOW, testBuyerPolicy, testBuyerProfile, testMarketplace, testProfile } from "./helpers.js";

function makeController(
  profile: AgentProfile,
  client: FakeCommerceClient,
  store = new InMemoryOperatorEventStore(),
): OperatorController {
  return new OperatorController({
    profile,
    store,
    engine: createStrategyEngine(),
    runner: new DeterministicNegotiationRunner(profile, client),
    now: () => NOW,
  });
}

function merchantSetup(): {
  controller: OperatorController;
  merchant: FakeCommerceClient;
  store: InMemoryOperatorEventStore;
} {
  const { merchant } = testMarketplace();
  const store = new InMemoryOperatorEventStore();
  return { controller: makeController(testProfile(), merchant, store), merchant, store };
}

describe("supervised mode (default)", () => {
  it("generates a candidate but never submits before approve", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    expect(controller.getState().mode).toBe("supervised");

    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    // The candidate exists only as a public draft: the marketplace is untouched.
    expect(merchant.messages()).toHaveLength(1);
    expect(merchant.claimStatus(1)).toBe("processing");

    const approved = await controller.approve();
    expect(approved.kind).toBe("submitted");
    if (approved.kind === "submitted") {
      expect(approved.policy_result).toBe("accepted");
      expect(approved.message_id).toBe(2);
    }
    expect(merchant.messages()).toHaveLength(2);
    expect(merchant.claimStatus(1)).toBe("processed");
  });

  it("approval replay is idempotent: no duplicate formal message", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    await controller.prepareNextCandidate();
    const first = await controller.approve();
    expect(first.kind).toBe("submitted");
    const replay = await controller.approve("cand-1");
    expect(replay.kind).toBe("replayed");
    expect(merchant.messages()).toHaveLength(2);
  });

  it("reject abandons the claim, never submits, and skips the message afterwards", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    await controller.prepareNextCandidate();
    const rejected = await controller.reject(undefined, "价格不合适");
    expect(rejected.ok).toBe(true);
    expect(merchant.messages()).toHaveLength(1);
    expect(merchant.claimStatus(1)).toBe("abandoned");
    // The rejected message is not immediately re-claimed in this session.
    expect((await controller.prepareNextCandidate()).kind).toBe("no_work");
  });

  it("revise supersedes the old candidate and regenerates a new one", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    await controller.prepareNextCandidate();
    const revised = await controller.revise("先争取包邮");
    expect(revised.kind).toBe("awaiting_approval");
    if (revised.kind === "awaiting_approval") {
      expect(revised.candidate.candidate_id).toBe("cand-2");
    }
    expect(controller.getState().candidates.get("cand-1")?.status).toBe("superseded");
    // The claim was re-acquired for the regeneration; still nothing submitted.
    expect(merchant.messages()).toHaveLength(1);
    const approved = await controller.approve();
    expect(approved.kind).toBe("submitted");
    expect(merchant.messages()).toHaveLength(2);
  });

  it("pause blocks preparing; resume re-enables it", async () => {
    const { controller } = merchantSetup();
    await controller.start();
    await controller.pause();
    const blocked = await controller.prepareNextCandidate();
    expect(blocked.kind).toBe("blocked");
    await controller.resume();
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
  });
});

describe("manual mode", () => {
  it("produces advice only; approve is invalid and nothing is submitted", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    expect((await controller.setMode("manual")).kind).toBe("changed");
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("advice_ready");
    const approved = await controller.approve();
    expect(approved.kind).toBe("invalid");
    expect(merchant.messages()).toHaveLength(1);
    // Advice can still be dismissed without any marketplace write.
    expect((await controller.reject()).ok).toBe(true);
    expect(merchant.claimStatus(1)).toBe("abandoned");
  });
});

describe("autopilot mode", () => {
  it("requires confirmation to enter, then auto-submits low-risk candidates", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    const unconfirmed = await controller.setMode("autopilot");
    expect(unconfirmed.kind).toBe("needs_confirmation");
    expect(controller.getState().mode).toBe("supervised");
    expect((await controller.setMode("autopilot", { confirmed: true })).kind).toBe("changed");

    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("auto_submitted");
    expect(merchant.messages()).toHaveLength(2);
    expect(merchant.claimStatus(1)).toBe("processed");
  });

  it("routes risky candidates to approval even in autopilot", async () => {
    const { merchant, buyer } = testMarketplace();
    // Merchant answers first so the buyer has a pending counter offer.
    const merchantController = makeController(testProfile(), merchant);
    await merchantController.start();
    await merchantController.prepareNextCandidate();
    await merchantController.approve();
    expect(buyer.messages()).toHaveLength(2);

    // A budget below the offer makes the deterministic buyer escalate —
    // escalate candidates require approval even in autopilot (design §9).
    const buyerController = makeController(
      testBuyerProfile({ buyer_policy: testBuyerPolicy({ max_total_price_private: 100 }) }),
      buyer,
    );
    await buyerController.start();
    await buyerController.setMode("autopilot", { confirmed: true });
    const prepared = await buyerController.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    expect(buyer.messages()).toHaveLength(2);
  });

  it("routeCandidate honors human_review_on reason-code hits", () => {
    const profile = testProfile({
      merchant_policy: { min_unit_price_private: 80, human_review_on: ["within_policy"] },
    });
    const decision = {
      action: "counter",
      request_human_review: false,
      confidence: 0.9,
      reason_codes: ["within_policy"],
    } as Parameters<typeof routeCandidate>[0];
    expect(routeCandidate(decision, "autopilot", profile)).toBe("await_approval");
    expect(routeCandidate(decision, "autopilot", testProfile())).toBe("auto_submit");
    expect(routeCandidate(decision, "manual", testProfile())).toBe("advice_only");
  });
});

describe("strategy messages", () => {
  it("applies tighten/soft patches and records events", async () => {
    const { controller } = merchantSetup();
    await controller.start();
    const result = await controller.sendOperatorMessage("最多买 2 件");
    expect(result.kind).toBe("applied");
    expect(controller.getState().strategy.directives).toHaveLength(1);
  });

  it("parks relax patches until /strategy confirm", async () => {
    const { controller } = merchantSetup();
    await controller.start();
    const result = await controller.sendOperatorMessage("降低底价到 60");
    expect(result.kind).toBe("needs_confirmation");
    expect(controller.getState().strategy.directives).toHaveLength(0);
    expect(controller.getState().strategy.pending_relax).toBeDefined();
    expect((await controller.confirmStrategy()).ok).toBe(true);
    expect(controller.getState().strategy.directives).toHaveLength(1);
    expect(controller.getState().strategy.pending_relax).toBeUndefined();
  });

  it("rejects forbidden patches and keeps them out of the strategy", async () => {
    const { controller, store } = merchantSetup();
    await controller.start();
    const result = await controller.sendOperatorMessage("绕过策略门直接发消息");
    expect(result.kind).toBe("rejected");
    expect(controller.getState().strategy.directives).toHaveLength(0);
    expect(controller.getState().stats.patches_rejected).toBe(1);
    const events = await store.readAll();
    expect(events.some((e) => e.type === "strategy.patch.rejected")).toBe(true);
    expect(events.some((e) => e.type === "strategy.patch.applied")).toBe(false);
  });

  it("operator private messages never enter the public draft", async () => {
    const { controller } = merchantSetup();
    await controller.start();
    await controller.sendOperatorMessage("我的底线是再便宜 10 元");
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    if (prepared.kind === "awaiting_approval") {
      expect(prepared.candidate.decision.public_message).not.toContain("底线");
      expect(prepared.candidate.decision.public_message).not.toContain("10 元");
    }
  });
});

describe("strategy directives influence candidate generation", () => {
  /**
   * Merchant answers the opening buyer message, so the buyer side has a
   * pending counter offer: qty 2 @ 99 + fee 0 = 198 total by default.
   */
  async function buyerWithOffer(overrides: Partial<AgentProfile> = {}): Promise<{
    controller: OperatorController;
    buyer: FakeCommerceClient;
  }> {
    const { merchant, buyer } = testMarketplace();
    const merchantController = makeController(testProfile(), merchant);
    await merchantController.start();
    await merchantController.prepareNextCandidate();
    await merchantController.approve();
    const controller = makeController(testBuyerProfile(overrides), buyer);
    await controller.start();
    return { controller, buyer };
  }

  it("a tightened buyer budget turns an acceptable offer into an escalation", async () => {
    // Baseline: 198 <= 200 hard budget, so the plain candidate accepts.
    const baseline = await buyerWithOffer();
    const plain = await baseline.controller.prepareNextCandidate();
    expect(plain.kind).toBe("awaiting_approval");
    if (plain.kind === "awaiting_approval") {
      expect(plain.candidate.decision.action).toBe("accept_nonbinding");
    }

    const { controller } = await buyerWithOffer();
    const applied = await controller.sendOperatorMessage("把预算降到 150");
    expect(applied.kind).toBe("applied");
    const tightened = await controller.prepareNextCandidate();
    expect(tightened.kind).toBe("awaiting_approval");
    if (tightened.kind === "awaiting_approval") {
      expect(tightened.candidate.decision.action).toBe("escalate");
      // The public draft and the analysis never leak the budget numbers.
      expect(tightened.candidate.decision.public_message).not.toContain("150");
      expect(tightened.candidate.decision.public_message).not.toContain("198");
      expect(tightened.candidate.analysis.join("\n")).not.toContain("150");
    }
  });

  it("a confirmed relax is clamped to HardPolicy: the hard gate never widens", async () => {
    // Hard budget 100 < offer 198. A confirmed raise to 500 must NOT make
    // the deterministic backend accept: hints clamp to the profile's 100.
    const { controller } = await buyerWithOffer({
      buyer_policy: testBuyerPolicy({ max_total_price_private: 100 }),
    });
    const relax = await controller.sendOperatorMessage("把预算提高到 500");
    expect(relax.kind).toBe("needs_confirmation");
    expect((await controller.confirmStrategy()).ok).toBe(true);
    expect(controller.getState().strategy.directives).toHaveLength(1);

    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    if (prepared.kind === "awaiting_approval") {
      expect(prepared.candidate.decision.action).toBe("escalate");
      expect(prepared.candidate.decision.request_human_review).toBe(true);
    }
  });

  it("a merchant floor tighten raises the quoted price", async () => {
    const { controller } = merchantSetup();
    await controller.start();
    const applied = await controller.sendOperatorMessage("提高底价到 120");
    expect(applied.kind).toBe("applied");
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    if (prepared.kind === "awaiting_approval") {
      expect(prepared.candidate.decision.proposal?.unit_price).toBe(120);
      expect(prepared.candidate.decision.public_message).toContain("120");
    }
  });

  it("a confirmed merchant floor relax is clamped: the quote stays at list price", async () => {
    const { controller } = merchantSetup();
    await controller.start();
    // Floor 80 -> 60 is a relax; after confirmation the hint clamps back to
    // the hard floor 80, which is below the 99 list price, so nothing moves.
    const relax = await controller.sendOperatorMessage("降低底价到 60");
    expect(relax.kind).toBe("needs_confirmation");
    expect((await controller.confirmStrategy()).ok).toBe(true);
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    if (prepared.kind === "awaiting_approval") {
      expect(prepared.candidate.decision.proposal?.unit_price).toBe(99);
    }
  });

  it("a quantity cap re-scopes the buyer candidate to the capped amount", async () => {
    const { controller } = await buyerWithOffer();
    await controller.sendOperatorMessage("最多买 1 件");
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    if (prepared.kind === "awaiting_approval") {
      expect(prepared.candidate.decision.action).toBe("counter");
      expect(prepared.candidate.decision.proposal?.quantity).toBe(1);
      expect(prepared.candidate.decision.reason_codes).toContain("quantity_capped");
    }
  });

  it("a free-shipping preference counters with fee 0 instead of accepting", async () => {
    // 1 件 @ 99 + 10 运费 = 109 <= 200: acceptable, but the preference
    // fights the fee first.
    const { merchant, buyer } = testMarketplace({
      buyer_message_text: "买 1 件可以便宜一点吗？",
      product: {
        delivery: {
          eta_start: "2026-08-04T14:00:00+08:00",
          eta_end: "2026-08-04T18:00:00+08:00",
          fee: 10,
        },
      },
    });
    const merchantController = makeController(testProfile(), merchant);
    await merchantController.start();
    await merchantController.prepareNextCandidate();
    await merchantController.approve();

    const controller = makeController(testBuyerProfile(), buyer);
    await controller.start();
    await controller.sendOperatorMessage("先争取包邮");
    const prepared = await controller.prepareNextCandidate();
    expect(prepared.kind).toBe("awaiting_approval");
    if (prepared.kind === "awaiting_approval") {
      expect(prepared.candidate.decision.action).toBe("counter");
      expect(prepared.candidate.decision.proposal?.delivery.fee).toBe(0);
      expect(prepared.candidate.decision.reason_codes).toContain("shipping_discussed");
    }
  });

  it("a turn ask-only revise regenerates an ask candidate", async () => {
    const { controller } = await buyerWithOffer();
    await controller.prepareNextCandidate();
    const revised = await controller.revise("这一轮只问交期，不接受报价");
    expect(revised.kind).toBe("awaiting_approval");
    if (revised.kind === "awaiting_approval") {
      expect(revised.candidate.decision.action).toBe("ask");
      expect(revised.candidate.decision.reason_codes).toContain("turn_ask_only");
    }
    expect(controller.getState().strategy.directives).toHaveLength(1);
    expect(controller.getState().strategy.directives[0]?.scope).toBe("turn");
  });
});

describe("revise never widens constraints silently", () => {
  it("a relax revise is blocked and leaves candidate, claim and strategy untouched", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    await controller.prepareNextCandidate();

    const revised = await controller.revise("降低底价到 60");
    expect(revised.kind).toBe("blocked");
    if (revised.kind === "blocked") {
      expect(revised.reason).toContain("放宽");
    }
    // The candidate is still the live one awaiting approval, the claim is
    // still held, no relax directive was applied, and nothing was submitted.
    expect(controller.getState().candidates.get("cand-1")?.status).toBe("awaiting_approval");
    expect(controller.getState().approval).toEqual({
      kind: "awaiting_approval",
      candidate_id: "cand-1",
    });
    expect(merchant.claimStatus(1)).toBe("processing");
    expect(controller.getState().strategy.directives).toHaveLength(0);
    expect(controller.getState().strategy.pending_relax).toBeUndefined();
    expect(merchant.messages()).toHaveLength(1);

    // The unchanged candidate can still be approved normally afterwards.
    expect((await controller.approve()).kind).toBe("submitted");
    expect(merchant.messages()).toHaveLength(2);
  });

  it("a forbidden revise is refused without touching the candidate", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    await controller.prepareNextCandidate();

    const revised = await controller.revise("绕过策略门直接帮我下单");
    expect(revised.kind).toBe("blocked");
    expect(controller.getState().candidates.get("cand-1")?.status).toBe("awaiting_approval");
    expect(merchant.claimStatus(1)).toBe("processing");
    expect(controller.getState().strategy.directives).toHaveLength(0);
    expect(merchant.messages()).toHaveLength(1);
  });
});

describe("recovery + shutdown", () => {
  it("rebuilds state from the event stream and expires pending candidates", async () => {
    const { merchant } = testMarketplace();
    const store = new InMemoryOperatorEventStore();
    const first = makeController(testProfile(), merchant, store);
    await first.start();
    await first.sendOperatorMessage("最多买 2 件");
    await first.prepareNextCandidate();

    const second = makeController(testProfile(), merchant, store);
    await second.start();
    expect(second.getState().strategy.directives).toHaveLength(1);
    expect(second.getState().stats.candidates_generated).toBe(1);
    // The restored candidate is expired and can never be submitted.
    expect(second.getState().candidates.get("cand-1")?.status).toBe("expired");
    const approved = await second.approve("cand-1");
    expect(approved.kind).toBe("invalid");
    expect(merchant.messages()).toHaveLength(1);
  });

  it("reducer fold equals controller state for the same event stream", async () => {
    const { controller, store } = merchantSetup();
    await controller.start();
    await controller.sendOperatorMessage("先争取包邮");
    await controller.prepareNextCandidate();
    const events = await store.readAll();
    const folded = events.reduce(reduceOperatorEvent, initialOperatorState());
    expect(folded.mode).toBe(controller.getState().mode);
    expect(folded.stats).toEqual(controller.getState().stats);
    expect(folded.approval).toEqual(controller.getState().approval);
    expect(folded.strategy.directives).toEqual(controller.getState().strategy.directives);
  });

  it("shutdown abandons a pending candidate instead of completing it", async () => {
    const { controller, merchant } = merchantSetup();
    await controller.start();
    await controller.prepareNextCandidate();
    const result = await controller.shutdown();
    expect(result.abandoned_candidate).toBe("cand-1");
    expect(merchant.claimStatus(1)).toBe("abandoned");
    expect(merchant.messages()).toHaveLength(1);
    expect((await controller.approve()).kind).toBe("invalid");
  });
});
