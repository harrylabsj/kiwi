import { describe, expect, it } from "vitest";
import { createFakeMarketplace, FakeCommerceClient } from "../src/commerce/fake-client.js";
import { CommerceError } from "../src/commerce/types.js";
import { PROTOCOL_VERSION } from "../src/negotiation/types.js";
import { testClient, testClientConfig, validDecision } from "./helpers.js";

const KEY = "merchant-agent:merchant-001:1:shopping.negotiation/0.1";

async function claim(client: ReturnType<typeof testClient>) {
  return client.claimMessage({
    conversation_id: "conv-merchant-001",
    message_id: 1,
    idempotency_key: KEY,
  });
}

describe("FakeCommerceClient claim lifecycle", () => {
  it("lists the pending buyer message exactly once", async () => {
    const client = testClient();
    const pending = await client.listPendingMessages();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message_id).toBe(1);
    // A mismatched identity (wrong role or owner) sees nothing.
    const buyerSide = new FakeCommerceClient(testClientConfig(), {
      identity: { role: "buyer", owner_id: "buyer-001" },
    });
    expect(await buyerSide.listPendingMessages()).toEqual([]);
    const stranger = new FakeCommerceClient(testClientConfig(), {
      identity: { role: "merchant", owner_id: "other" },
    });
    expect(await stranger.listPendingMessages()).toEqual([]);
  });

  it("same-key replay while processing returns the recorded claim (claimed=false)", async () => {
    const client = testClient();
    const first = await claim(client);
    expect(first.claimed).toBe(true);
    // Contract: a non-retryable existing claim returns claimed=false — even
    // for a same-key replay. The key is deterministic, so two same-identity
    // workers generate the same key and must never both hold the claim.
    const replay = await claim(client);
    expect(replay.claimed).toBe(false);
    expect(replay.status).toBe("processing");
    expect(replay.idempotency_key).toBe(KEY);
    expect(replay.attempts).toBe(1);
  });

  it("the same deterministic key reclaims after abandon or fail (retryable)", async () => {
    const client = testClient();
    await claim(client);
    await client.abandonClaim({ message_id: 1, idempotency_key: KEY, error: "crash" });
    const reclaim = await claim(client);
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.attempts).toBe(2);
    await client.failClaim({ message_id: 1, idempotency_key: KEY, error: "boom" });
    const retry = await claim(client);
    expect(retry.claimed).toBe(true);
    expect(retry.attempts).toBe(3);
  });

  it("two same-identity workers cannot both see and claim one message", async () => {
    const config = testClientConfig();
    const { state, merchant: workerA } = createFakeMarketplace(config);
    const workerB = new FakeCommerceClient(config, {
      identity: { role: "merchant", owner_id: "merchant-001" },
      state,
    });
    await workerA.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: KEY,
    });
    // The second worker neither sees the message as pending nor can claim it.
    expect(await workerB.listPendingMessages()).toEqual([]);
    const second = await workerB.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: KEY, // deterministic: same identity, same key
    });
    expect(second.claimed).toBe(false);
    expect(second.status).toBe("processing");
  });

  it("a second agent key cannot steal a processing claim", async () => {
    const client = testClient();
    await claim(client);
    const other = await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: "other-agent:1:shopping.negotiation/0.1",
    });
    expect(other.claimed).toBe(false);
    expect(other.status).toBe("processing");
  });

  it("complete closes the claim; re-claim is refused, message stays listed until answered", async () => {
    const client = testClient();
    await claim(client);
    const done = await client.completeClaim({ message_id: 1, idempotency_key: KEY });
    expect(done.status).toBe("processed");
    // The buyer message is still unanswered (no merchant reply was written),
    // so it remains listed — matching shopping-cli's reply-based listing.
    expect(await client.listPendingMessages()).toHaveLength(1);
    const reclaim = await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: `${KEY}:again`,
    });
    expect(reclaim.claimed).toBe(false);
    expect(reclaim.status).toBe("processed");
  });

  it("fail makes the claim retryable; retry bumps attempts", async () => {
    const client = testClient();
    await claim(client);
    await client.failClaim({ message_id: 1, idempotency_key: KEY, error: "boom" });
    const retry = await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: `${KEY}:retry`,
    });
    expect(retry.claimed).toBe(true);
    expect(retry.attempts).toBe(2);
  });

  it("abandon makes the claim retryable", async () => {
    const client = testClient();
    await claim(client);
    await client.abandonClaim({ message_id: 1, idempotency_key: KEY, error: "crash" });
    const retry = await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: `${KEY}:retry`,
    });
    expect(retry.claimed).toBe(true);
  });

  it("cannot complete/fail/abandon without an active claim", async () => {
    const client = testClient();
    await expect(client.completeClaim({ message_id: 1, idempotency_key: KEY })).rejects.toThrow(
      CommerceError,
    );
  });

  it("snapshot requires an active claim", async () => {
    const client = testClient();
    await expect(
      client.getNegotiationSnapshot({ conversation_id: "conv-merchant-001", message_id: 1 }),
    ).rejects.toThrow(CommerceError);
  });
});

describe("FakeCommerceClient policy gate", () => {
  it("accepts a valid counter and writes exactly one message", async () => {
    const client = testClient();
    await claim(client);
    const result = await client.submitNegotiationDecision({
      decision: validDecision(),
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("accepted");
    expect(result.next_actor).toBe("buyer");
    expect(client.messages()).toHaveLength(2);
    expect(client.conversationState().status).toBe("waiting_buyer");
    const events = client.auditEvents().map((e) => e.event);
    expect(events).toContain("negotiation_decision_submitted");
    expect(events).toContain("negotiation_policy_accepted");
  });

  it("submit is idempotent: replay returns the stored result without rewriting", async () => {
    const client = testClient();
    await claim(client);
    const first = await client.submitNegotiationDecision({
      decision: validDecision(),
      idempotency_key: `${KEY}:submit`,
    });
    const replay = await client.submitNegotiationDecision({
      decision: validDecision(),
      idempotency_key: `${KEY}:submit`,
    });
    expect(replay).toEqual(first);
    expect(client.messages()).toHaveLength(2);
  });

  it("rejects schema-invalid decisions without any write", async () => {
    const client = testClient();
    await claim(client);
    const bad = { ...validDecision(), action: "place_order" } as never;
    const result = await client.submitNegotiationDecision({
      decision: bad,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("human_required"); // retries: 0 for schema errors
    expect(result.reason_codes).toContain("invalid_schema");
    expect(client.messages()).toHaveLength(1);
  });

  it("rejects prices below the private floor as human_required", async () => {
    const client = testClient();
    await claim(client);
    const decision = validDecision();
    decision.proposal!.unit_price = 50; // floor is 80
    const result = await client.submitNegotiationDecision({
      decision,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("human_required");
    expect(result.reason_codes).toContain("below_floor");
    expect(client.conversationState().status).toBe("human_required");
  });

  it("rejects public text that leaks the private floor (retryable)", async () => {
    const client = testClient();
    await claim(client);
    const decision = validDecision({ public_message: "底价 80 元不能再低了" });
    const result = await client.submitNegotiationDecision({
      decision,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("rejected_retryable");
    expect(result.reason_codes).toContain("policy_leak");
  });

  it("rejects unknown after-sales policy refs", async () => {
    const client = testClient();
    await claim(client);
    const decision = validDecision();
    decision.proposal!.after_sales_policy_refs = ["policy:lifetime-warranty"];
    const result = await client.submitNegotiationDecision({
      decision,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("rejected_retryable");
    expect(result.reason_codes).toContain("unknown_policy_ref");
  });

  it("rejects stale stock observations", async () => {
    const client = testClient();
    await claim(client);
    const decision = validDecision();
    decision.proposal!.stock.observed_at = "2026-08-03T10:00:00+08:00";
    const result = await client.submitNegotiationDecision({
      decision,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("rejected_retryable");
    expect(result.reason_codes).toContain("stale_inventory");
  });

  it("rejects quantities beyond stock", async () => {
    const client = testClient();
    await claim(client);
    const decision = validDecision();
    decision.proposal!.quantity = 99;
    const result = await client.submitNegotiationDecision({
      decision,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("rejected_retryable");
    expect(result.reason_codes).toContain("insufficient_stock");
  });

  it("requires a claim bound to in_reply_to_message_id", async () => {
    const client = testClient();
    // no claim at all
    const result = await client.submitNegotiationDecision({
      decision: validDecision(),
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.reason_codes).toContain("claim_required");
  });

  it("escalate routes to human and writes the public message", async () => {
    const client = testClient();
    await claim(client);
    const decision = validDecision({
      action: "escalate",
      request_human_review: true,
      reason_codes: ["exceptional_warranty"],
    });
    delete (decision as unknown as Record<string, unknown>).proposal;
    const result = await client.submitNegotiationDecision({
      decision,
      idempotency_key: `${KEY}:submit`,
    });
    expect(result.result).toBe("human_required");
    expect(client.conversationState().status).toBe("human_required");
    expect(client.auditEvents().map((e) => e.event)).toContain("negotiation_human_required");
  });

  it("never creates orders: capabilities pin orders=false", async () => {
    const client = testClient();
    const caps = await client.getCapabilities();
    expect(caps.capabilities.orders).toBe(false);
    expect(caps.protocol_versions).toContain(PROTOCOL_VERSION);
  });
});
