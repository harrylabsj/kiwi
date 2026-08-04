import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEvent,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import { runMerchantTurn } from "../src/runtime/merchant-turn.js";
import { resolveThinkingLevel } from "../src/runtime/model.js";
import { TOOL_GET_SNAPSHOT, TOOL_SUBMIT_DECISION } from "../src/runtime/tools.js";
import { hangingStreamFn, testClient, testProfile, validDecision } from "./helpers.js";

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

describe("merchant single turn (fake model + fake marketplace)", () => {
  it("completes a full turn: claim -> snapshot -> decision -> accepted -> complete", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });

    expect(report.outcome.kind).toBe("accepted");
    expect(report.policy_result?.result).toBe("accepted");
    expect(report.policy_result?.next_actor).toBe("buyer");
    expect(report.steps).toBe(2);
    expect(report.usage.total).toBeGreaterThanOrEqual(0);

    // Exactly one new message; claim processed; audit chain complete.
    expect(client.messages()).toHaveLength(2);
    expect(client.conversationState().status).toBe("waiting_buyer");
    const events = client.auditEvents().map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "agent_message_claimed",
        "negotiation_decision_submitted",
        "negotiation_policy_accepted",
        "agent_message_processed",
      ]),
    );
  });

  it("is idempotent across runs: second run finds no work and writes nothing", async () => {
    const client = testClient();
    const first = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    await runMerchantTurn({ profile: testProfile(), client, streamFn: first.streamFn });

    const second = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const report = await runMerchantTurn({
      profile: testProfile(),
      client,
      streamFn: second.streamFn,
    });
    expect(report.outcome.kind).toBe("no_work");
    expect(client.messages()).toHaveLength(2);
  });

  it("a message under an active claim is not listed as work", async () => {
    const client = testClient();
    await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: "other-worker:1:shopping.negotiation/0.1",
    });
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("no_work");
  });

  it("retryable policy rejection is repaired by the model inside the turn", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      // First attempt leaks the private floor -> rejected_retryable.
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, validDecision({ public_message: "底价 80 元给你" })),
      ]),
      // Repaired attempt.
      fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, validDecision())]),
    ]);
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("accepted");
    expect(client.messages()).toHaveLength(2);
  });

  it("fails the claim when the policy gate keeps rejecting", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, validDecision({ public_message: "底价 80 元给你" })),
      ]),
      fauxAssistantMessage("好的我再想想。"),
    ]);
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("failed");
    expect(report.outcome.kind === "failed" && report.outcome.retriable).toBe(true);
    // No business message was written by the rejected decision.
    expect(client.messages()).toHaveLength(1);
    expect(client.auditEvents().map((e) => e.event)).toContain("agent_message_failed");
  });

  it("fails the claim when the model never submits a decision", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(null));
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("no_decision");
    expect(client.auditEvents().map((e) => e.event)).toContain("agent_message_failed");
  });

  it("enforces max_model_steps", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const profile = testProfile();
    profile.runtime.max_model_steps = 1;
    const report = await runMerchantTurn({ profile, client, streamFn });
    expect(report.outcome.kind).toBe("no_decision");
    expect(report.outcome.kind === "no_decision" && report.outcome.reason.includes("1 steps")).toBe(
      true,
    );
  });

  it("guard blocks a decision bound to another conversation; turn recovers", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_SUBMIT_DECISION, validDecision({ conversation_id: "conv-someone-else" })),
      ]),
      fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, validDecision())]),
    ]);
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("accepted");
    // Only the valid decision reached the gateway.
    expect(client.messages()).toHaveLength(2);
  });

  it("model attempts to call a non-allowlisted tool get an error result", async () => {
    const client = testClient();
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall("bash", { command: "env" })]),
      fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]),
      fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, validDecision())]),
    ]);
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("accepted");
    expect(client.messages()).toHaveLength(2);
  });

  it("escalate decision completes the claim and routes to a human", async () => {
    const client = testClient();
    const escalate = validDecision({
      action: "escalate",
      request_human_review: true,
      reason_codes: ["exceptional_warranty"],
    }) as unknown as Record<string, unknown>;
    delete escalate.proposal;
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(escalate));
    const report = await runMerchantTurn({ profile: testProfile(), client, streamFn });
    expect(report.outcome.kind).toBe("human_required");
    expect(client.conversationState().status).toBe("human_required");
    expect(client.auditEvents().map((e) => e.event)).toContain("agent_message_processed");
  });

  it("deterministic merchant fake (CLI path) completes a turn end to end", async () => {
    const { createDeterministicMerchantStreamFn } = await import("../src/runtime/fake-model.js");
    const client = testClient();
    const profile = testProfile();
    const report = await runMerchantTurn({
      profile,
      client,
      streamFn: createDeterministicMerchantStreamFn(profile),
    });
    expect(report.outcome.kind).toBe("accepted");
    const decision = client.messages()[1];
    expect(decision?.sender_role).toBe("merchant");
  });
});

describe("max_retries enforcement (first submission + repair attempts)", () => {
  /** Floor-leaking decisions are rejected_retryable; each attempt is unique (content-addressed idempotency). */
  function rejectionScript(leakingAttempts: number, thenValid: boolean): FauxResponseStep[] {
    const steps: FauxResponseStep[] = [fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})])];
    for (let i = 0; i < leakingAttempts; i++) {
      steps.push(
        fauxAssistantMessage([
          fauxToolCall(TOOL_SUBMIT_DECISION, {
            ...validDecision({ public_message: `底价 80 元给你（第 ${i + 1} 次）` }),
          }),
        ]),
      );
    }
    if (thenValid) {
      steps.push(fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, validDecision())]));
    }
    return steps;
  }

  it("max_retries=0: only the first submission reaches the gateway", async () => {
    const client = testClient();
    const profile = testProfile();
    profile.runtime.max_retries = 0;
    const { streamFn } = createScriptedFakeStreamFn(rejectionScript(1, true));
    const report = await runMerchantTurn({ profile, client, streamFn });
    expect(report.outcome.kind).toBe("failed");
    expect(report.outcome.kind === "failed" && report.outcome.error).toMatch(/budget exhausted/);
    // The repaired decision was blocked before the gateway: no write happened.
    expect(client.messages()).toHaveLength(1);
    expect(client.auditEvents().map((e) => e.event)).toContain("agent_message_failed");
  });

  it("max_retries=1: first attempt plus one repair; the third submission is blocked", async () => {
    const client = testClient();
    const profile = testProfile();
    profile.runtime.max_retries = 1;
    const { streamFn } = createScriptedFakeStreamFn(rejectionScript(2, true));
    const report = await runMerchantTurn({ profile, client, streamFn });
    expect(report.outcome.kind).toBe("failed");
    expect(report.outcome.kind === "failed" && report.outcome.error).toMatch(/budget exhausted/);
    expect(client.messages()).toHaveLength(1);
    // Both allowed attempts were rejected by the policy gate.
    expect(
      client.auditEvents().filter((e) => e.event === "negotiation_policy_denied"),
    ).toHaveLength(2);
  });

  it("max_retries=2: first attempt plus two repairs can still succeed", async () => {
    const client = testClient();
    const profile = testProfile();
    profile.runtime.max_retries = 2;
    const { streamFn } = createScriptedFakeStreamFn(rejectionScript(2, true));
    const report = await runMerchantTurn({ profile, client, streamFn });
    expect(report.outcome.kind).toBe("accepted");
    expect(client.messages()).toHaveLength(2);
  });
});

describe("thinking_level mapping", () => {
  it("passes thinking_level through to the model request as reasoning", async () => {
    const client = testClient();
    const profile = testProfile();
    profile.model.thinking_level = "high";
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const seen: (string | undefined)[] = [];
    const capturing: StreamFn = (m, c, o) => {
      seen.push(o?.reasoning);
      return streamFn(m, c, o);
    };
    const report = await runMerchantTurn({ profile, client, streamFn: capturing });
    expect(report.outcome.kind).toBe("accepted");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r === "high")).toBe(true);
  });

  it("omits reasoning when thinking_level is unset or off", async () => {
    for (const level of [undefined, "off"] as const) {
      const client = testClient();
      const profile = testProfile();
      if (level !== undefined) profile.model.thinking_level = level;
      const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
      const seen: (string | undefined)[] = [];
      const capturing: StreamFn = (m, c, o) => {
        seen.push(o?.reasoning);
        return streamFn(m, c, o);
      };
      const report = await runMerchantTurn({ profile, client, streamFn: capturing });
      expect(report.outcome.kind).toBe("accepted");
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((r) => r === undefined)).toBe(true);
    }
  });

  it("fails closed on unsupported thinking_level values", () => {
    const profile = testProfile();
    profile.model.thinking_level = "xhigh" as never;
    expect(() => resolveThinkingLevel(profile)).toThrow(/thinking_level/);
  });
});

describe("turn timeout", () => {
  it("times out deterministically: claim fails retriable and never completes", async () => {
    const client = testClient();
    const profile = testProfile();
    profile.runtime.turn_timeout_seconds = 0.05;
    const report = await runMerchantTurn({ profile, client, streamFn: hangingStreamFn() });
    expect(report.outcome.kind).toBe("timeout");
    expect(report.outcome.kind === "timeout" && report.outcome.reason).toMatch(/timed out/);
    const events = client.auditEvents().map((e) => e.event);
    expect(events).toContain("agent_message_failed");
    expect(events).not.toContain("agent_message_processed");
    expect(events).not.toContain("negotiation_decision_submitted");
    expect(client.messages()).toHaveLength(1);
  });

  it("a submit already in flight when the timeout fires still settles as accepted", async () => {
    const client = testClient();
    const original = client.submitNegotiationDecision.bind(client);
    client.submitNegotiationDecision = (async (input: Parameters<typeof original>[0]) => {
      await new Promise((r) => setTimeout(r, 100));
      return original(input);
    }) as typeof client.submitNegotiationDecision;
    const profile = testProfile();
    profile.runtime.turn_timeout_seconds = 0.02; // fires while the submit is in flight
    const { streamFn } = createScriptedFakeStreamFn(scriptedTurn(validDecision()));
    const report = await runMerchantTurn({ profile, client, streamFn });
    // The abort cannot cancel the in-flight gateway call: the decision the
    // gate accepted is recorded and the claim completes — never misreported.
    expect(report.outcome.kind).toBe("accepted");
    expect(client.claimStatus(1)).toBe("processed");
    const events = client.auditEvents().map((e) => e.event);
    expect(events).toContain("negotiation_policy_accepted");
    expect(events).not.toContain("agent_message_failed");
  });
});

describe("model error classification", () => {
  /** A stream whose first response ends in a model error with the given message. */
  function modelErrorStreamFn(errorMessage: string): StreamFn {
    return () => {
      const msg = fauxAssistantMessage("model call failed", {
        stopReason: "error",
        errorMessage,
      });
      const stream = {
        async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
          yield { type: "error", reason: "error", error: msg };
        },
        result: (): Promise<AssistantMessage> => Promise.resolve(msg),
      };
      return stream as unknown as ReturnType<StreamFn>;
    };
  }

  it.each([
    "The request failed with status 401 Unauthorized",
    "HTTP 403 Forbidden: permission denied",
    "insufficient_quota: your billing quota is exceeded",
  ])("auth/config model errors are non-retriable: %s", async (message) => {
    const client = testClient();
    const report = await runMerchantTurn({
      profile: testProfile(),
      client,
      streamFn: modelErrorStreamFn(message),
    });
    expect(report.outcome.kind).toBe("failed");
    expect(report.outcome.kind === "failed" && report.outcome.retriable).toBe(false);
  });

  it("ordinary model errors stay retriable", async () => {
    const client = testClient();
    const report = await runMerchantTurn({
      profile: testProfile(),
      client,
      streamFn: modelErrorStreamFn("connection reset by peer"),
    });
    expect(report.outcome.kind).toBe("failed");
    expect(report.outcome.kind === "failed" && report.outcome.retriable).toBe(true);
  });
});
