/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createWeixinOwnerDecider } from "../src/merchant/weixin-owner-agent.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const ACTION = "handle_merchant_request";
const turn = { text: "请帮我回忆一下刚才说的。", history: [] };
const signal = new AbortController().signal;

describe("WeChat owner Pi decider (offline only)", () => {
  it("allows a structured local action and never uses model text alongside it", async () => {
    const { streamFn, handle } = createScriptedFakeStreamFn([
      fauxAssistantMessage([{ type: "text", text: "伪造的店铺数据" }, fauxToolCall(ACTION, { action: "today" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall(ACTION, { action: "draft", ordinal: 2, reference: "L-1234abcd" })], { stopReason: "toolUse" }),
    ]);
    const stream = vi.fn(streamFn);
    const decide = createWeixinOwnerDecider({ model: handle.getModel(), streamFn: stream, getApiKey: () => "fixture" });
    await expect(decide(turn, signal)).resolves.toEqual({ kind: "today" });
    await expect(decide(turn, signal)).resolves.toEqual({ kind: "draft", index: 1, ref: "L-1234ABCD" });
    expect(stream.mock.calls[0]?.[2]).toMatchObject({ maxTokens: 600, timeoutMs: 25_000, maxRetries: 0, cacheRetention: "none" });
  });

  it("accepts a bounded range stats action and rejects missing, guessed, or out-of-range days", async () => {
    const { streamFn, handle } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(ACTION, { action: "range", days: 7 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall(ACTION, { action: "range" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall(ACTION, { action: "range", days: 0 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall(ACTION, { action: "range", days: 31 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall(ACTION, { action: "range", days: 7, ordinal: 1 })], { stopReason: "toolUse" }),
    ]);
    const decide = createWeixinOwnerDecider({ model: handle.getModel(), streamFn, getApiKey: () => "fixture" });
    await expect(decide(turn, signal)).resolves.toEqual({ kind: "range", days: 7 });
    for (let i = 0; i < 4; i++) await expect(decide(turn, signal)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses writes, arbitrary recipients, out-of-range ordinals, and multiple actions in one response", async () => {    const arrays = [
      [fauxToolCall("publish_quote", {})],
      [fauxToolCall(ACTION, { action: "list", to: "other" })],
      [fauxToolCall(ACTION, { action: "draft", ordinal: 4 })],
      [fauxToolCall(ACTION, { action: "list" }), fauxToolCall(ACTION, { action: "today" })],
    ];
    const { streamFn, handle } = createScriptedFakeStreamFn(arrays.map((calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" })));
    const decide = createWeixinOwnerDecider({ model: handle.getModel(), streamFn, getApiKey: () => "fixture" });
    for (const _ of arrays) await expect(decide(turn, signal)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("cancels the underlying stream signal and does not wait for a provider that ignores it", async () => {
    const { handle } = createScriptedFakeStreamFn([]);
    const stream: StreamFn = (_model, _context, options) => {
      expect(options?.signal?.aborted).toBe(false);
      return new Promise(() => {});
    };
    const mocked = vi.fn(stream);
    const decide = createWeixinOwnerDecider({ model: handle.getModel(), streamFn: mocked, getApiKey: () => "fixture" });
    const controller = new AbortController();
    const pending = decide(turn, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "deadline" });
    expect(mocked.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });
});
