/**
 * 隔离回归：KNP structured SKU 是服务端不可变约束。
 * fake Pi 尝试读取/回复另一商品时，工具和真实 engine 都必须拒绝，
 * 并回退到 structured SKU 的确定性事实；无 structured SKU 时保留模糊选品。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Api, type JsonObject, type Model } from "@earendil-works/pi-ai";
import {
  createPiReceptionRuntime,
  TOOL_GET_COMMERCIAL_FACTS,
  TOOL_PROPOSE_NEED_PATCH,
  TOOL_PROPOSE_REPLY,
} from "../src/a2a/reception/agent-runtime.js";
import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { factRevision } from "../src/a2a/reception/publish.js";
import type { CommercialFacts, FactRef } from "../src/a2a/reception/types.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const NOW = "2026-11-04T03:40:00.000Z";
const MERCHANT = "merchant-structured";
const A = "SKU-A";
const B = "SKU-B";
const model = {
  id: "fake-model",
  name: "fake-model",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-structured-sku-"));
  dirs.push(dir);
  return dir;
}
function product(sku: string) {
  return {
    price: sku === A ? 110 : 90,
    currency: "CNY",
    stock: 50,
    unit: "piece",
  };
}
function refFor(sku: string): FactRef {
  const facts: CommercialFacts = {
    listPrice: product(sku).price,
    currency: "CNY",
    unit: "piece",
    stockAvailable: true,
  };
  const base = { merchantId: MERCHANT, sku, visibility: "public" as const, issuedAt: NOW, facts };
  return { sku, revision: factRevision(base) };
}
function engineFor(agent: ReturnType<typeof createPiReceptionRuntime>, dir: string) {
  const store = new ReceptionConversationStore({ file: path.join(dir, "c.json"), now: () => NOW });
  const outbox = new ReceptionReplyOutbox({ file: path.join(dir, "o.json"), now: () => NOW });
  return createMerchantReceptionEngine({
    store,
    outbox,
    agent,
    productSource: {
      async getProduct(sku: string) {
        if (sku !== A && sku !== B) throw new Error("unknown sku");
        return product(sku);
      },
    },
    policy: () => ({}),
    now: () => NOW,
  });
}
function runtimeFor(steps: Parameters<typeof createScriptedFakeStreamFn>[0]) {
  const { streamFn } = createScriptedFakeStreamFn(steps);
  return createPiReceptionRuntime({
    streamFn,
    model,
    productSource: {
      async getProduct(sku: string) {
        if (sku !== A && sku !== B) throw new Error("unknown sku");
        return product(sku);
      },
    },
    maxSteps: 6,
    timeoutMs: 5000,
  });
}
async function respond(engine: ReturnType<typeof createMerchantReceptionEngine>, structured?: string) {
  return engine.respond({
    merchantId: MERCHANT,
    identity: "buyer:1",
    identityVerified: false,
    contextId: `ctx-${Math.random()}`,
    text: "我需要1piece",
    ...(structured !== undefined ? { structured: { sku: structured } } : {}),
    now: NOW,
  });
}

describe("structured SKU is immutable through fake Pi to engine", () => {
  it("rejects a model fact read and reply for another SKU", async () => {
    const dir = temp();
    const agent = runtimeFor([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, { sku: B, quantity: 1, unit: "piece" } as JsonObject)]),
      fauxAssistantMessage([fauxToolCall(TOOL_PROPOSE_NEED_PATCH, { sku: B, quantity: 1, unit: "piece" } as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "show_commercial_terms", ref: refFor(B) }],
        } as unknown as JsonObject),
      ]),
    ]);
    const result = await respond(engineFor(agent, dir), A);
    expect(result.text).toContain("110.00 CNY");
    expect(result.text).not.toContain("90.00 CNY");
  });

  it("keeps the legitimate structured SKU positive path", async () => {
    const dir = temp();
    const agent = runtimeFor([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, { sku: A, quantity: 1, unit: "piece" } as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "show_commercial_terms", ref: refFor(A) }],
        } as unknown as JsonObject),
      ]),
    ]);
    const result = await respond(engineFor(agent, dir), A);
    expect(result.text).toContain("110.00 CNY");
    expect(result.text).not.toContain("90.00 CNY");
  });

  it("keeps fuzzy no-structured-SKU selection of another product", async () => {
    const dir = temp();
    const agent = runtimeFor([
      fauxAssistantMessage([fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, { sku: B, quantity: 1, unit: "piece" } as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [{ kind: "show_commercial_terms", ref: refFor(B) }],
        } as unknown as JsonObject),
      ]),
    ]);
    const result = await respond(engineFor(agent, dir));
    expect(result.text).toContain("90.00 CNY");
  });
});
