import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { FakeCommerceClient } from "../src/commerce/fake-client.js";
import { CommerceError, type CommerceClient } from "../src/commerce/types.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import { MAX_BACKOFF_MS, runForeground, type Sleeper } from "../src/runtime/foreground.js";
import type { TurnReport } from "../src/runtime/negotiation-turn.js";
import { TOOL_GET_SNAPSHOT, TOOL_SUBMIT_DECISION } from "../src/runtime/tools.js";
import {
  hangingStreamFn,
  testBuyerProfile,
  testClient,
  testMarketplace,
  testProfile,
  validDecision,
} from "./helpers.js";

function scriptedTurn(decisionArgs: unknown): FauxResponseStep[] {
  return [
    fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_SUBMIT_DECISION, decisionArgs as Record<string, unknown>),
    ]),
  ];
}

/** A client whose capability check fails transiently N times, then recovers. */
class FlakyClient extends FakeCommerceClient {
  failuresLeft: number;
  constructor(failures: number) {
    super({
      merchant_id: "merchant-001",
      buyer_id: "buyer-001",
      product: {
        sku: "sku-001",
        title: "手写陶瓷杯",
        currency: "CNY",
        list_price: 99,
        stock_quantity: 12,
        delivery: {
          eta_start: "2026-08-04T14:00:00+08:00",
          eta_end: "2026-08-04T18:00:00+08:00",
          fee: 0,
        },
        policies: [{ ref: "policy:return-7d", summary: "签收后 7 天内无理由退货。" }],
      },
    });
    this.failuresLeft = failures;
  }
  override async getCapabilities(): ReturnType<CommerceClient["getCapabilities"]> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new CommerceError("transient", "gateway unreachable");
    }
    return super.getCapabilities();
  }
}

describe("foreground polling loop", () => {
  it("no_work waits poll_interval_seconds, then stops cleanly on signal", async () => {
    const market = testMarketplace();
    const controller = new AbortController();
    const sleeps: number[] = [];
    const reports: TurnReport[] = [];
    const sleep: Sleeper = async (ms) => {
      sleeps.push(ms);
      controller.abort();
    };
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const result = await runForeground({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn,
      signal: controller.signal,
      sleep,
      onReport: (r) => reports.push(r),
    });
    expect(result).toEqual({ turns: 1, stopped_by: "signal" });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome.kind).toBe("no_work");
    expect(sleeps).toEqual([5000]); // poll_interval_seconds = 5
  });

  it("transient errors back off with a bounded cap, then the loop continues", async () => {
    const client = new FlakyClient(2);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const reports: TurnReport[] = [];
    const sleep: Sleeper = async (ms) => {
      sleeps.push(ms);
    };
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const result = await runForeground({
      profile: testProfile(),
      client,
      streamFn,
      signal: controller.signal,
      sleep,
      onReport: (r) => {
        reports.push(r);
        controller.abort();
      },
    });
    expect(result.turns).toBe(1);
    expect(reports[0]?.outcome.kind).toBe("accepted");
    // pollMs=5000: 5000, 10000 — exponential and capped.
    expect(sleeps).toEqual([5000, 10000]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("signal mid-turn abandons the claim (never completes) and exits; no double claim", async () => {
    const market = testMarketplace();
    const controller = new AbortController();
    const reports: TurnReport[] = [];
    const sleep: Sleeper = async () => {};
    const hanging = hangingStreamFn();
    const streamFn: StreamFn = (model, context, options) => {
      // The external stop arrives while the model stream is hanging.
      queueMicrotask(() => controller.abort());
      return hanging(model, context, options);
    };
    const result = await runForeground({
      profile: testProfile(),
      client: market.merchant,
      streamFn,
      signal: controller.signal,
      sleep,
      onReport: (r) => reports.push(r),
    });

    expect(result).toEqual({ turns: 1, stopped_by: "signal" });
    expect(reports[0]?.outcome.kind).toBe("aborted");
    const events = market.merchant.auditEvents().map((e) => e.event);
    expect(events).toContain("agent_message_abandoned");
    expect(events).not.toContain("agent_message_processed");
    expect(events).not.toContain("negotiation_decision_submitted");
    // Exactly one claim happened.
    expect(events.filter((e) => e === "agent_message_claimed")).toHaveLength(1);
    // The abandoned claim was released: another worker can pick it up.
    const reclaim = await market.merchant.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: "other-worker:1:shopping.negotiation/0.1",
    });
    expect(reclaim.claimed).toBe(true);
  });

  it("an accepted turn is never rolled back when the stop arrives afterwards", async () => {
    const market = testMarketplace();
    const controller = new AbortController();
    const reports: TurnReport[] = [];
    const sleep: Sleeper = async () => {
      // The stop arrives while waiting out the no_work poll after the win.
      controller.abort();
    };
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const result = await runForeground({
      profile: testProfile(),
      client: market.merchant,
      streamFn,
      signal: controller.signal,
      sleep,
      onReport: (r) => reports.push(r),
    });

    expect(result.stopped_by).toBe("signal");
    expect(reports.map((r) => r.outcome.kind)).toEqual(["accepted", "no_work"]);
    const events = market.merchant.auditEvents().map((e) => e.event);
    expect(events).toContain("agent_message_processed");
    expect(events).not.toContain("agent_message_abandoned");
    expect(events).not.toContain("agent_message_failed");
    // The processed claim stays processed (never abandoned or re-claimable).
    expect(market.merchant.claimStatus(1)).toBe("processed");
  });

  it("maxTurns bounds the loop (serial turns, one report per turn)", async () => {
    const client = testClient();
    const reports: TurnReport[] = [];
    const sleep: Sleeper = async () => {
      throw new Error("sleep must not be called when turns are bounded by work");
    };
    // Two turns: first accepted, second no_work would sleep — so bound at 1.
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const result = await runForeground({
      profile: testProfile(),
      client,
      streamFn,
      sleep,
      maxTurns: 1,
      onReport: (r) => reports.push(r),
    });
    expect(result).toEqual({ turns: 1, stopped_by: "max_turns" });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.outcome.kind).toBe("accepted");
    // Structured report carries no secret/private fields.
    const serialized = JSON.stringify(reports[0]);
    expect(serialized).not.toContain("80"); // private floor never leaks
    expect(serialized).not.toContain("token");
  });

  it("a message under an active claim is not re-listed; the loop waits instead of hot-looping", async () => {
    const market = testMarketplace();
    await market.merchant.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: "other:1:shopping.negotiation/0.1",
    });
    const controller = new AbortController();
    const sleeps: number[] = [];
    const reports: TurnReport[] = [];
    const sleep: Sleeper = async (ms) => {
      sleeps.push(ms);
      controller.abort();
    };
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const result = await runForeground({
      profile: testProfile(),
      client: market.merchant,
      streamFn,
      signal: controller.signal,
      sleep,
      onReport: (r) => reports.push(r),
    });
    expect(result.stopped_by).toBe("signal");
    expect(reports[0]?.outcome.kind).toBe("no_work");
    expect(sleeps).toEqual([5000]);
  });
});
