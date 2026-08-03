import { describe, expect, it } from "vitest";
import {
  buildMerchantTools,
  createToolGuard,
  MAX_TOOL_ARGS_BYTES,
  MERCHANT_TOOL_ALLOWLIST,
  TOOL_GET_SNAPSHOT,
  TOOL_SUBMIT_DECISION,
  type ConversationBinding,
  type ToolOutcomeTracker,
} from "../src/runtime/tools.js";
import { testClient, validDecision } from "./helpers.js";

const BINDING: ConversationBinding = {
  conversation_id: "conv-merchant-001",
  message_id: 1,
  idempotency_key: "agent:1:shopping.negotiation/0.1",
};

function guardContext(name: string, args: unknown) {
  return {
    toolCall: {
      type: "toolCall" as const,
      id: "t1",
      name,
      arguments: args as Record<string, unknown>,
    },
    args,
    assistantMessage: {} as never,
    context: {} as never,
  };
}

describe("tool surface", () => {
  it("merchant gets exactly snapshot + submit_decision, nothing else", () => {
    const tracker: ToolOutcomeTracker = { submissions: 0 };
    const tools = buildMerchantTools(testClient(), BINDING, tracker, 4);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [TOOL_GET_SNAPSHOT, TOOL_SUBMIT_DECISION].sort(),
    );
    // No file/shell/edit/http/install tools exist anywhere in the surface.
    const names = JSON.stringify(tools.map((t) => t.name));
    for (const banned of ["read", "write", "edit", "bash", "shell", "fetch", "http", "install"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("allowlist contains no search_products for merchant M1", () => {
    expect(MERCHANT_TOOL_ALLOWLIST).not.toContain("search_products");
  });

  it("submit tool parameters match the frozen decision schema (closed)", () => {
    const tracker: ToolOutcomeTracker = { submissions: 0 };
    const tools = buildMerchantTools(testClient(), BINDING, tracker, 4);
    const submit = tools.find((t) => t.name === TOOL_SUBMIT_DECISION);
    const params = JSON.stringify(submit?.parameters);
    expect(params).toContain('"additionalProperties":false');
    expect(params).toContain("shopping.negotiation/0.1");
    expect(params).not.toContain("$ref");
  });
});

describe("beforeToolCall guard", () => {
  const guard = createToolGuard(MERCHANT_TOOL_ALLOWLIST, BINDING);

  it("blocks tools outside the allowlist", async () => {
    for (const name of ["bash", "read_file", "write_file", "http_request", "install_tool"]) {
      const result = await guard(guardContext(name, {}));
      expect(result?.block, name).toBe(true);
    }
  });

  it("blocks snapshot calls that pass any argument", async () => {
    const result = await guard(guardContext(TOOL_GET_SNAPSHOT, { conversation_id: "conv-other" }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/no arguments/);
  });

  it("blocks decisions for a different conversation (lateral move)", async () => {
    const decision = validDecision({ conversation_id: "conv-other-merchant" });
    const result = await guard(guardContext(TOOL_SUBMIT_DECISION, decision));
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/conv-merchant-001/);
  });

  it("blocks decisions replying to a different message", async () => {
    const decision = validDecision({ in_reply_to_message_id: 999 });
    const result = await guard(guardContext(TOOL_SUBMIT_DECISION, decision));
    expect(result?.block).toBe(true);
  });

  it("blocks wrong protocol versions", async () => {
    const decision = validDecision({ protocol_version: "shopping.negotiation/0.2" } as never);
    const result = await guard(guardContext(TOOL_SUBMIT_DECISION, decision));
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/protocol_version/);
  });

  it("blocks oversized arguments", async () => {
    const decision = validDecision({ public_message: "x".repeat(MAX_TOOL_ARGS_BYTES) });
    const result = await guard(guardContext(TOOL_SUBMIT_DECISION, decision));
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/byte cap/);
  });

  it("measures the cap in UTF-8 bytes, not string length (multibyte chars)", async () => {
    // 12_000 CJK characters: ~12 KB as a JS string but 36 KB as UTF-8.
    // A length-based check would pass this; the byte cap must block it.
    const decision = validDecision({ public_message: "汉".repeat(12_000) });
    const json = JSON.stringify(decision);
    expect(json.length).toBeLessThan(MAX_TOOL_ARGS_BYTES);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(MAX_TOOL_ARGS_BYTES);
    const result = await guard(guardContext(TOOL_SUBMIT_DECISION, decision));
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/byte cap/);
  });

  it("byte-cap boundary: exactly at the cap passes, one byte over blocks", async () => {
    const base = validDecision({ public_message: "" });
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    const atCap = validDecision({ public_message: "x".repeat(MAX_TOOL_ARGS_BYTES - baseBytes) });
    expect(Buffer.byteLength(JSON.stringify(atCap), "utf8")).toBe(MAX_TOOL_ARGS_BYTES);
    expect(await guard(guardContext(TOOL_SUBMIT_DECISION, atCap))).toBeUndefined();

    const overCap = validDecision({
      public_message: "x".repeat(MAX_TOOL_ARGS_BYTES - baseBytes + 1),
    });
    const result = await guard(guardContext(TOOL_SUBMIT_DECISION, overCap));
    expect(result?.block).toBe(true);
  });

  it("allows a well-formed bound snapshot call and decision", async () => {
    expect(await guard(guardContext(TOOL_GET_SNAPSHOT, {}))).toBeUndefined();
    expect(await guard(guardContext(TOOL_SUBMIT_DECISION, validDecision()))).toBeUndefined();
  });
});

describe("tool execution", () => {
  it("snapshot tool returns the bound conversation snapshot", async () => {
    const client = testClient();
    await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: BINDING.idempotency_key,
    });
    const tracker: ToolOutcomeTracker = { submissions: 0 };
    const tools = buildMerchantTools(client, BINDING, tracker, 4);
    const snapshotTool = tools.find((t) => t.name === TOOL_GET_SNAPSHOT);
    const result = await snapshotTool?.execute("t1", {});
    const text = (result?.content[0] as { text: string }).text;
    const snapshot = JSON.parse(text);
    expect(snapshot.conversation.id).toBe("conv-merchant-001");
    expect(snapshot.role).toBe("merchant");
    expect(JSON.stringify(snapshot)).not.toContain("floor_price");
    expect(JSON.stringify(snapshot)).not.toContain("80");
  });

  it("submit tool records the policy result and terminates on accept", async () => {
    const client = testClient();
    await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: BINDING.idempotency_key,
    });
    const tracker: ToolOutcomeTracker = { submissions: 0 };
    const tools = buildMerchantTools(client, BINDING, tracker, 4);
    const submit = tools.find((t) => t.name === TOOL_SUBMIT_DECISION);
    const result = await submit?.execute("t2", validDecision());
    expect(tracker.submissions).toBe(1);
    expect(tracker.decisionResult?.result).toBe("accepted");
    expect(result?.terminate).toBe(true);
  });

  it("blocks submissions beyond the max_retries budget without hitting the gateway", async () => {
    const client = testClient();
    await client.claimMessage({
      conversation_id: "conv-merchant-001",
      message_id: 1,
      idempotency_key: BINDING.idempotency_key,
    });
    const tracker: ToolOutcomeTracker = { submissions: 0 };
    // max_retries = 0 -> exactly one submission allowed.
    const tools = buildMerchantTools(client, BINDING, tracker, 1);
    const submit = tools.find((t) => t.name === TOOL_SUBMIT_DECISION);

    const first = await submit?.execute("t2", validDecision());
    expect(tracker.submissions).toBe(1);
    expect(first?.terminate).toBe(true);

    const blocked = await submit?.execute("t3", validDecision({ public_message: "修复后的报价" }));
    expect(tracker.submissions).toBe(1);
    expect(tracker.submissionLimitExceeded).toBe(true);
    expect(blocked?.terminate).toBe(true);
    expect(JSON.stringify(blocked?.details)).toContain("submission_limit_exceeded");
    // The blocked attempt never reached the gateway: still 2 messages total.
    expect(client.messages()).toHaveLength(2);
  });
});
