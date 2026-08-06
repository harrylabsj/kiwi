/**
 * A2A v0.4 WP1 ActionCandidate 候选模型统一 tests:
 *  - RFC 8785 JCS canonicalization + SHA-256 digest stability;
 *  - DecisionCandidate (v0.2) -> NegotiationActionCandidate adapter field
 *    mapping (including structural acceptance of the operator `Candidate`);
 *  - missing-field fail-closed behavior on the adapter.
 */
import { describe, expect, it } from "vitest";
import type { Candidate as OperatorCandidate } from "../src/operator/types.js";
import {
  ACTION_CANDIDATE_KINDS,
  CandidateAdapterError,
  candidateDigest,
  type DecisionCandidate,
  type NegotiationActionCandidateContext,
  toNegotiationActionCandidate,
  verifyCandidateDigest,
} from "../src/negotiation/action-candidate.js";
import { canonicalize, contentDigest, sha256Hex } from "../src/negotiation/jcs.js";
import { CONVERSATION_ID, validDecision } from "./helpers.js";

function makeDecisionCandidate(overrides: Record<string, unknown> = {}): DecisionCandidate {
  return {
    candidate_id: "cand-1",
    binding: { conversation_id: CONVERSATION_ID, message_id: 2 },
    decision: validDecision({ in_reply_to_message_id: 2 }),
    created_at: "2026-08-03T15:00:00+08:00",
    ...overrides,
  } as DecisionCandidate;
}

function makeContext(overrides: Record<string, unknown> = {}): NegotiationActionCandidateContext {
  return {
    expected_remote_revision: `conv:${CONVERSATION_ID}:msg:2`,
    policy_version: "shopping.negotiation/0.1",
    counterparty_identity: "merchant-001",
    risk: { level: "ok", reason: "within_policy" },
    ...overrides,
  } as NegotiationActionCandidateContext;
}

describe("RFC 8785 JCS canonicalization", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("is stable across input key-order permutations", () => {
    const a = canonicalize({ candidate_id: "cand-1", action: "counter", risk: { level: "ok" } });
    const b = canonicalize({ risk: { level: "ok" }, action: "counter", candidate_id: "cand-1" });
    expect(a).toBe(b);
  });

  it("normalizes number serialization per RFC 8785", () => {
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(1.5)).toBe("1.5");
    expect(canonicalize(-0)).toBe("-0");
    expect(canonicalize(1e21)).toBe("1e21"); // no '+' in exponent
    expect(canonicalize(5e-7)).toBe("5e-7"); // no leading exponent zeros
    expect(canonicalize(1e-7)).toBe("1e-7");
  });

  it("escapes strings and control characters", () => {
    expect(canonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalize("\u0000\u001f")).toBe('"\\u0000\\u001f"');
  });

  it("skips undefined object keys and rejects non-finite numbers", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize([1, undefined])).toThrow(TypeError);
  });

  it("contentDigest is sha256-hex over the canonical bytes", () => {
    expect(contentDigest({ a: 1 })).toBe(`sha256:${sha256Hex('{"a":1}')}`);
  });
});

describe("candidate_digest", () => {
  const candidate = toNegotiationActionCandidate(makeDecisionCandidate(), makeContext());

  it("is a sha256-prefixed content digest", () => {
    expect(candidate.candidate_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is stable across repeated computations", () => {
    const again = toNegotiationActionCandidate(makeDecisionCandidate(), makeContext());
    expect(again.candidate_digest).toBe(candidate.candidate_digest);
  });

  it("changes when any bound field changes", () => {
    const changedPublic = toNegotiationActionCandidate(
      makeDecisionCandidate({ decision: validDecision({ in_reply_to_message_id: 2, public_message: "改口了。" }) }),
      makeContext(),
    );
    const changedRemote = toNegotiationActionCandidate(
      makeDecisionCandidate(),
      makeContext({ expected_remote_revision: `conv:${CONVERSATION_ID}:msg:3` }),
    );
    const changedRisk = toNegotiationActionCandidate(
      makeDecisionCandidate(),
      makeContext({ risk: { level: "confirm", reason: "budget_near_limit" } }),
    );
    expect(changedPublic.candidate_digest).not.toBe(candidate.candidate_digest);
    expect(changedRemote.candidate_digest).not.toBe(candidate.candidate_digest);
    expect(changedRisk.candidate_digest).not.toBe(candidate.candidate_digest);
  });

  it("matches the locked reference digest", () => {
    // Frozen on 2026-08-06 against the fixed test fixture. Recompute only when
    // the digest scheme intentionally changes (RFC 8785 JCS + SHA-256, §17).
    expect(candidate.candidate_digest).toBe(
      "sha256:f7ba558dc625d15f9c271ee85cc53e93ac6a215fe875a4b4f28db47553f6ca4a",
    );
  });

  it("verifies recomputed digests and detects tampering", () => {
    expect(verifyCandidateDigest(candidate)).toBe(true);
    const tampered = { ...candidate, public_message: "篡改后的公开信息。" };
    expect(verifyCandidateDigest(tampered)).toBe(false);
  });

  it("digest equals candidateDigest over the mapped fields", () => {
    expect(candidate.candidate_digest).toBe(candidateDigest(candidate));
  });
});

describe("DecisionCandidate -> NegotiationActionCandidate adapter", () => {
  it("maps every bound field", () => {
    const candidate = toNegotiationActionCandidate(makeDecisionCandidate(), makeContext());
    expect(candidate.kind).toBe("negotiation");
    expect(candidate.candidate_id).toBe("cand-1");
    expect(candidate.negotiation_id).toBe(CONVERSATION_ID);
    expect(candidate.action).toBe("counter");
    expect(candidate.payload).toEqual(validDecision({ in_reply_to_message_id: 2 }));
    expect(candidate.expected_remote_revision).toBe(`conv:${CONVERSATION_ID}:msg:2`);
    expect(candidate.policy_version).toBe("shopping.negotiation/0.1");
    expect(candidate.counterparty_identity).toBe("merchant-001");
    expect(candidate.public_message).toBe("买 2 件的话，单价 89 元，明天下午送达。");
    expect(candidate.reason_codes).toEqual(["within_policy", "inventory_observed"]);
    expect(candidate.risk).toEqual({ level: "ok", reason: "within_policy" });
  });

  it("accepts the v0.2 operator Candidate shape", () => {
    const operatorCandidate = {
      candidate_id: "cand-1",
      binding: { conversation_id: CONVERSATION_ID, message_id: 2, idempotency_key: "idem-1" },
      decision: validDecision({ in_reply_to_message_id: 2 }),
      analysis: ["总价在私有预算约束内"],
      route: "await_approval",
      status: "awaiting_approval",
      created_at: "2026-08-03T15:00:00+08:00",
    } satisfies OperatorCandidate;
    const candidate = toNegotiationActionCandidate(operatorCandidate, makeContext());
    expect(candidate.negotiation_id).toBe(CONVERSATION_ID);
    expect(candidate.expected_remote_revision).toBe(`conv:${CONVERSATION_ID}:msg:2`);
    expect(verifyCandidateDigest(candidate)).toBe(true);
  });

  it("copies reason_codes and risk without aliasing the source", () => {
    const dc = makeDecisionCandidate();
    const ctx = makeContext();
    const candidate = toNegotiationActionCandidate(dc, ctx);
    candidate.reason_codes.push("extra");
    candidate.risk.reason = "mutated";
    expect(dc.decision.reason_codes).toEqual(["within_policy", "inventory_observed"]);
    expect(ctx.risk.reason).toBe("within_policy");
  });

  it("exposes the negotiation kind discriminant", () => {
    expect(ACTION_CANDIDATE_KINDS).toEqual(["negotiation"]);
  });
});

describe("missing-field fail-closed", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["candidate_id", { candidate_id: undefined }, {}],
    ["binding.conversation_id", { binding: { message_id: 2 } }, {}],
    ["binding.message_id", { binding: { conversation_id: CONVERSATION_ID } }, {}],
    ["decision.public_message", { decision: validDecision({ in_reply_to_message_id: 2, public_message: "" }) }, {}],
    ["decision.reason_codes", { decision: validDecision({ in_reply_to_message_id: 2, reason_codes: undefined }) }, {}],
    ["context.expected_remote_revision", {}, { expected_remote_revision: undefined }],
    ["context.policy_version", {}, { policy_version: undefined }],
    ["context.counterparty_identity", {}, { counterparty_identity: undefined }],
    ["context.risk", {}, { risk: undefined }],
  ];

  it.each(cases)("rejects missing %s", (name, dcOverrides, ctxOverrides) => {
    expect(() =>
      toNegotiationActionCandidate(makeDecisionCandidate(dcOverrides), makeContext(ctxOverrides)),
    ).toThrow(CandidateAdapterError);
  });

  it("rejects an invalid action value", () => {
    expect(() =>
      toNegotiationActionCandidate(
        makeDecisionCandidate({ decision: validDecision({ in_reply_to_message_id: 2, action: "purchase" }) }),
        makeContext(),
      ),
    ).toThrow(/action must be one of/);
  });

  it("rejects a malformed risk object", () => {
    expect(() =>
      toNegotiationActionCandidate(makeDecisionCandidate(), makeContext({ risk: { level: "extreme" } })),
    ).toThrow(/risk\.level must be ok\|confirm\|blocked/);
  });

  it("fails closed on non-finite numbers inside the digest payload", () => {
    expect(() =>
      toNegotiationActionCandidate(
        makeDecisionCandidate({ decision: validDecision({ in_reply_to_message_id: 2, confidence: Number.NaN }) }),
        makeContext(),
      ),
    ).toThrow(TypeError);
  });
});
