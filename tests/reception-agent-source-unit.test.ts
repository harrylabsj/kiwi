import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createPiReceptionRuntime,
  TOOL_COMPARE_PRODUCTS,
  TOOL_GET_COMMERCIAL_FACTS,
  TOOL_PROPOSE_REPLY,
} from "../src/a2a/reception/agent-runtime.js";
import {
  factRevision,
  InMemoryFactRegistry,
  publishResponsePlan,
} from "../src/a2a/reception/publish.js";
import type { CommercialFacts, FactRef } from "../src/a2a/reception/types.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const NOW = "2026-11-03T04:00:00.000Z";
const MERCHANT = "merchant-source-unit";
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

function ref(sku: string, facts: CommercialFacts): FactRef {
  const base = { merchantId: MERCHANT, sku, visibility: "public" as const, issuedAt: NOW, facts };
  return { sku, revision: factRevision(base) };
}

async function run(input: { sourceUnit?: string; comparedUnit?: string }) {
  const quantity = 10;
  const sourceFacts: CommercialFacts = {
    listPrice: 90,
    currency: "CNY",
    ...(input.sourceUnit !== undefined
      ? { unit: input.sourceUnit, stockAvailable: true }
      : {}),
    // No stockAvailable: the source unit is absent in the negative case, so
    // the server cannot bind coverage.
  };
  const comparedFacts: CommercialFacts = {
    listPrice: 100,
    currency: "CNY",
    ...(input.comparedUnit !== undefined ? { unit: input.comparedUnit } : {}),
    stockAvailable: true,
  };
  const sourceRef = ref("SOURCE", sourceFacts);
  const comparedRef = ref("COMPARED", comparedFacts);
  const steps = [
    fauxAssistantMessage([
      fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, {
        sku: "SOURCE",
        quantity,
        unit: "piece",
      } as JsonObject),
    ]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_COMPARE_PRODUCTS, {
        skus: ["COMPARED"],
        quantity,
        unit: "piece",
      } as JsonObject),
    ]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_PROPOSE_REPLY, {
        blocks: [
          {
            kind: "recommend_option",
            ref: sourceRef,
            comparedRefs: [comparedRef],
            reasonCode: "lowest_public_price",
          },
        ],
      } as unknown as JsonObject),
    ]),
  ];
  const { streamFn } = createScriptedFakeStreamFn(steps);
  const runtime = createPiReceptionRuntime({
    streamFn,
    model,
    productSource: {
      async getProduct(sku: string) {
        return sku === "SOURCE"
          ? {
              price: 90,
              currency: "CNY",
              stock: 10,
              ...(input.sourceUnit !== undefined ? { unit: input.sourceUnit } : {}),
            }
          : {
              price: 100,
              currency: "CNY",
              stock: 10,
              ...(input.comparedUnit !== undefined ? { unit: input.comparedUnit } : {}),
            };
      },
    },
    maxSteps: 6,
    timeoutMs: 5000,
  });
  const registry = new InMemoryFactRegistry();
  const result = await runtime.run({
    merchantId: MERCHANT,
    identity: "buyer:1",
    contextId: "ctx-source-unit",
    text: "我要10piece",
    registry,
    now: NOW,
  });
  expect(result).toBeDefined();
  return publishResponsePlan({
    plan: result!.plan,
    registry,
    merchantId: MERCHANT,
    now: NOW,
  });
}

describe("source unit provenance for comparison claims", () => {
  it("model-supplied unit on a source without unit does not become comparable", async () => {
    const result = await run({ comparedUnit: "piece" });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
    expect(result.text).not.toContain("公开标价更低");
  });

  it("explicit matching source and compared units keep the safe positive case", async () => {
    const result = await run({ sourceUnit: "piece", comparedUnit: "piece" });
    expect(result.rejected).toHaveLength(0);
    expect(result.text).toContain("公开标价更低");
  });
});
