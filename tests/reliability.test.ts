/**
 * M3 reliability tests: claim heartbeat and stale-claim recovery, for both
 * roles, fully deterministic (fake marketplace clock + injected heartbeat
 * cadence; no long real-time waits).
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { FakeCommerceClient } from "../src/commerce/fake-client.js";
import { CommerceError } from "../src/commerce/types.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import { startClaimHeartbeat } from "../src/runtime/heartbeat.js";
import {
  HEARTBEAT_INTERVAL_MS,
  runNegotiationTurn,
  STALE_CLAIM_TTL_SECONDS,
} from "../src/runtime/negotiation-turn.js";
import { TOOL_GET_SNAPSHOT, TOOL_SUBMIT_DECISION } from "../src/runtime/tools.js";
import {
  buyerAcceptDecision,
  testBuyerProfile,
  testClient,
  testMarketplace,
  testProfile,
  validDecision,
} from "./helpers.js";

const CONV = "conv-merchant-001";
const KEY = "merchant-agent:merchant-001:1:shopping.negotiation/0.1";

function scriptedTurn(decisionArgs: unknown): FauxResponseStep[] {
  return [
    fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_SUBMIT_DECISION, decisionArgs as Record<string, unknown>),
    ]),
  ];
}

/** Scripted turn whose model calls are delayed, leaving room for heartbeats. */
function delayedTurn(decisionArgs: unknown, delayMs: number): StreamFn {
  const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(decisionArgs));
  return async (model, context, options) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return streamFn(model, context, options);
  };
}

function auditEvents(client: FakeCommerceClient): string[] {
  return client.auditEvents().map((e) => e.event);
}

describe("documented reliability constants", () => {
  it("heartbeat cadence sits comfortably below the stale TTL", () => {
    expect(STALE_CLAIM_TTL_SECONDS).toBe(300);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(STALE_CLAIM_TTL_SECONDS * 1000);
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });
});

describe("FakeCommerceClient heartbeat and stale recovery", () => {
  it("heartbeat refreshes only processing claims and prevents stale recovery", async () => {
    const client = testClient();
    await client.claimMessage({ conversation_id: CONV, message_id: 1, idempotency_key: KEY });
    client.advanceTime(400_000); // beyond the 300s TTL
    const hb = await client.heartbeat({ message_id: 1 });
    expect(hb).toMatchObject({ status: "ok", refreshed: 1 });
    const recovered = await client.abandonStaleClaims({ ttl_seconds: 300 });
    expect(recovered.abandoned).toBe(0);
    expect(client.claimStatus(1)).toBe("processing");
    // A settled claim is never refreshed.
    await client.completeClaim({ message_id: 1, idempotency_key: KEY });
    expect((await client.heartbeat({ message_id: 1 })).refreshed).toBe(0);
  });

  it("abandonStaleClaims abandons only own stale claims; abandoned claims are reclaimable", async () => {
    const client = testClient();
    await client.claimMessage({ conversation_id: CONV, message_id: 1, idempotency_key: KEY });
    client.advanceTime(400_000);
    const recovered = await client.abandonStaleClaims({ ttl_seconds: 300 });
    expect(recovered).toMatchObject({ abandoned: 1, message_ids: [1], ttl_seconds: 300 });
    expect(client.claimStatus(1)).toBe("abandoned");
    expect(auditEvents(client)).toContain("agent_message_abandoned");
    const reclaim = await client.claimMessage({
      conversation_id: CONV,
      message_id: 1,
      idempotency_key: `${KEY}:retry`,
    });
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.attempts).toBe(2);
  });

  it("identity isolation: a buyer cannot heartbeat or recover a merchant claim", async () => {
    const market = testMarketplace();
    await market.merchant.claimMessage({
      conversation_id: CONV,
      message_id: 1,
      idempotency_key: KEY,
    });
    market.merchant.advanceTime(400_000);
    // Buyer sees no such claim (404), refreshes and abandons nothing.
    await expect(market.buyer.heartbeat({ message_id: 1 })).rejects.toMatchObject({
      kind: "not_found",
    });
    const recovered = await market.buyer.abandonStaleClaims({ ttl_seconds: 300 });
    expect(recovered.abandoned).toBe(0);
    expect(market.merchant.claimStatus(1)).toBe("processing");
    // The owner recovers its own stale claim.
    expect((await market.merchant.abandonStaleClaims({ ttl_seconds: 300 })).abandoned).toBe(1);
  });

  it("rejects non-integer ttl at the client boundary", async () => {
    const client = testClient();
    await expect(client.abandonStaleClaims({ ttl_seconds: 1.5 })).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(client.abandonStaleClaims({ ttl_seconds: 0 })).rejects.toMatchObject({
      kind: "validation",
    });
  });
});

describe("startClaimHeartbeat discipline", () => {
  it("never overlaps in-flight beats and stops cleanly (no leaks)", async () => {
    const client = testClient();
    await client.claimMessage({ conversation_id: CONV, message_id: 1, idempotency_key: KEY });
    let calls = 0;
    let release: (() => void) | undefined;
    const slow = Object.assign(client, {
      heartbeat: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve({ status: "ok", refreshed: 1, at: "t" });
        });
      },
    });
    const hb = startClaimHeartbeat(slow, 1, 1);
    await new Promise((r) => setTimeout(r, 25));
    // First beat still in flight: no second call may have started.
    expect(calls).toBe(1);
    release?.();
    await hb.stop();
    const beatsAfterStop = hb.beats();
    await new Promise((r) => setTimeout(r, 15));
    // Timer cleared: nothing more happens after stop.
    expect(hb.beats()).toBe(beatsAfterStop);
    expect(calls).toBe(1);
  });

  it("counts transient failures without throwing", async () => {
    const client = testClient();
    const failing = Object.assign(client, {
      heartbeat: () => Promise.reject(new Error("gateway unreachable")),
    });
    const hb = startClaimHeartbeat(failing, 1, 1);
    await new Promise((r) => setTimeout(r, 15));
    await hb.stop();
    expect(hb.failures()).toBeGreaterThanOrEqual(1);
    expect(hb.beats()).toBe(0);
  });
});

describe("turn-level stale recovery and heartbeat", () => {
  it("recovers a crashed run's stale claim BEFORE claiming: abandon, reclaim, accept", async () => {
    const client = testClient();
    const calls: string[] = [];
    for (const name of [
      "abandonStaleClaims",
      "claimMessage",
      "heartbeat",
      "completeClaim",
    ] as const) {
      const original = client[name].bind(client) as (...args: unknown[]) => Promise<unknown>;
      client[name] = ((...args: unknown[]) => {
        calls.push(name);
        return original(...args);
      }) as never;
    }
    // Simulate a previous crashed runtime: a processing claim aged past the TTL.
    await client.claimMessage({
      conversation_id: CONV,
      message_id: 1,
      idempotency_key: "crashed:1",
    });
    client.advanceTime(400_000);
    calls.length = 0;

    const report = await runNegotiationTurn({
      profile: testProfile(),
      client,
      streamFn: delayedTurn(validDecision(), 20),
      heartbeatIntervalMs: 1,
    });

    expect(report.outcome.kind).toBe("accepted");
    // Order: recovery first, then claim, then settlement; heartbeats in between.
    expect(calls[0]).toBe("abandonStaleClaims");
    expect(calls.indexOf("abandonStaleClaims")).toBeLessThan(calls.indexOf("claimMessage"));
    expect(calls.indexOf("claimMessage")).toBeLessThan(calls.lastIndexOf("completeClaim"));
    expect(calls).toContain("heartbeat");
    const events = auditEvents(client);
    const abandonedIdx = events.indexOf("agent_message_abandoned");
    const secondClaimIdx = events.lastIndexOf("agent_message_claimed");
    expect(abandonedIdx).toBeGreaterThanOrEqual(0);
    expect(secondClaimIdx).toBeGreaterThan(abandonedIdx);
    expect(client.claimStatus(1)).toBe("processed");
    expect(report.heartbeat?.beats).toBeGreaterThanOrEqual(1);
  });

  it("a healthy long turn heartbeats: claim is never considered stale", async () => {
    const client = testClient();
    const report = await runNegotiationTurn({
      profile: testProfile(),
      client,
      streamFn: delayedTurn(validDecision(), 40),
      heartbeatIntervalMs: 1,
    });
    expect(report.outcome.kind).toBe("accepted");
    expect(report.heartbeat?.beats).toBeGreaterThanOrEqual(1);
    expect(auditEvents(client)).toContain("agent_message_heartbeat");
    // Claim settled processed — and nothing stale remains for this identity.
    const recovered = await client.abandonStaleClaims({ ttl_seconds: 300 });
    expect(recovered.abandoned).toBe(0);
  });

  it("transient heartbeat failure never fails the turn", async () => {
    const client = testClient();
    let heartbeatCalls = 0;
    const original = client.heartbeat.bind(client);
    client.heartbeat = (input?: { message_id?: number }) => {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) {
        return Promise.reject(new Error("gateway unreachable")) as never;
      }
      return original(input);
    };
    const report = await runNegotiationTurn({
      profile: testProfile(),
      client,
      streamFn: delayedTurn(validDecision(), 30),
      heartbeatIntervalMs: 1,
    });
    expect(report.outcome.kind).toBe("accepted");
    expect(report.heartbeat?.failures).toBeGreaterThanOrEqual(1);
    expect(client.claimStatus(1)).toBe("processed");
  });

  it("buyer turns run the same recovery + heartbeat discipline", async () => {
    const market = testMarketplace();
    // Merchant counters first so the buyer has work.
    const merchantReport = await runNegotiationTurn({
      profile: testProfile(),
      client: market.merchant,
      streamFn: delayedTurn(validDecision(), 5),
      heartbeatIntervalMs: 1,
    });
    expect(merchantReport.outcome.kind).toBe("accepted");

    const report = await runNegotiationTurn({
      profile: testBuyerProfile(),
      client: market.buyer,
      streamFn: delayedTurn(buyerAcceptDecision(), 20),
      heartbeatIntervalMs: 1,
    });
    expect(report.outcome.kind).toBe("accepted");
    expect(report.heartbeat?.beats).toBeGreaterThanOrEqual(1);
    expect(auditEvents(market.buyer)).toContain("agent_message_heartbeat");
    expect(market.buyer.claimStatus(2)).toBe("processed");
    // Buyer-side recovery touches no merchant claims.
    expect((await market.buyer.abandonStaleClaims({ ttl_seconds: 300 })).abandoned).toBe(0);
  });

  it("heartbeat timer does not outlive an aborted turn", async () => {
    const client = testClient();
    let heartbeatCalls = 0;
    const original = client.heartbeat.bind(client);
    client.heartbeat = ((input?: { message_id?: number }) => {
      heartbeatCalls += 1;
      return original(input);
    }) as typeof client.heartbeat;

    const controller = new AbortController();
    const { hangingStreamFn } = await import("./helpers.js");
    const hanging = hangingStreamFn();
    const streamFn: StreamFn = (model, context, options) => {
      queueMicrotask(() => controller.abort());
      return hanging(model, context, options);
    };
    const report = await runNegotiationTurn({
      profile: testProfile(),
      client,
      streamFn,
      signal: controller.signal,
      heartbeatIntervalMs: 1,
    });
    expect(report.outcome.kind).toBe("aborted");
    const callsAtStop = heartbeatCalls;
    await new Promise((r) => setTimeout(r, 15));
    expect(heartbeatCalls).toBe(callsAtStop);
  });
});

describe("settlement escapes and shutdown edge cases", () => {
  it("an error escaping settlement abandons the claim immediately (no 300s stale wait)", async () => {
    const client = testClient();
    // The turn ends without a decision; the failClaim response is then lost.
    client.failClaim = (() =>
      Promise.reject(
        new CommerceError("transient", "gateway lost the response"),
      )) as typeof client.failClaim;
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      fauxAssistantMessage("我无法处理这个请求。"),
    ]);
    await expect(
      runNegotiationTurn({
        profile: testProfile(),
        client,
        streamFn,
        heartbeatIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "transient" });
    // The claim is settled back to abandoned at once — reclaimable without
    // waiting for the stale TTL, and the deterministic key reclaims it.
    expect(client.claimStatus(1)).toBe("abandoned");
    const reclaim = await client.claimMessage({
      conversation_id: CONV,
      message_id: 1,
      idempotency_key: KEY,
    });
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.attempts).toBe(2);
  });

  it("shutdown after a rejected_retryable decision abandons (never fails) the claim", async () => {
    const client = testClient();
    const controller = new AbortController();
    const original = client.submitNegotiationDecision.bind(client);
    client.submitNegotiationDecision = (async (input: Parameters<typeof original>[0]) => {
      const result = await original(input);
      controller.abort(); // SIGINT lands right after the retryable rejection
      return result;
    }) as typeof client.submitNegotiationDecision;
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      // Leaks the private floor -> rejected_retryable.
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, validDecision({ public_message: "底价 80 元给你" })),
      ]),
      fauxAssistantMessage("好的我再想想。"),
    ]);
    const report = await runNegotiationTurn({
      profile: testProfile(),
      client,
      streamFn,
      signal: controller.signal,
      heartbeatIntervalMs: 1,
    });
    expect(report.outcome.kind).toBe("aborted");
    expect(client.claimStatus(1)).toBe("abandoned");
    const events = auditEvents(client);
    expect(events).toContain("agent_message_abandoned");
    expect(events).not.toContain("agent_message_failed");
  });
});
