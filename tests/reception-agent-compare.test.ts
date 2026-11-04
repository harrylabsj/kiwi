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
const MERCHANT = "merchant-compare";
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

interface Product {
  sku: string;
  price: number;
  currency: string;
  stock: number;
  unit: string;
}
const A: Product = { sku: "A", price: 90, currency: "CNY", stock: 10, unit: "piece" };
const B: Product = { sku: "B", price: 100, currency: "CNY", stock: 10, unit: "piece" };

function expectedRef(
  product: Product,
  quantity?: number,
  requestedUnit?: string,
  stockAvailableOverride?: boolean | null,
): FactRef {
  let effective = quantity;
  if (product.unit === "piece" && requestedUnit === "box" && quantity !== undefined) {
    effective = quantity * 12;
  }
  const facts: CommercialFacts = {
    listPrice: product.price,
    currency: product.currency,
    unit: product.unit,
    ...(stockAvailableOverride === null
      ? {}
      : stockAvailableOverride !== undefined
        ? { stockAvailable: stockAvailableOverride }
        : quantity !== undefined && requestedUnit !== undefined
          ? { stockAvailable: product.stock >= (effective as number) }
          : {}),
  };
  const base = {
    merchantId: MERCHANT,
    sku: product.sku,
    visibility: "public" as const,
    issuedAt: NOW,
    facts,
  };
  return { sku: product.sku, revision: factRevision(base) };
}

async function runCompare(input: {
  a: Product;
  b: Product;
  quantity?: number;
  unit?: string;
  buyerText?: string;
  expectedStockAvailable?: boolean | null;
  reason: "in_stock" | "lowest_public_price";
}) {
  const mainRef = expectedRef(input.a, input.quantity, input.unit, input.expectedStockAvailable);
  const comparedRef = expectedRef(input.b, input.quantity, input.unit, input.expectedStockAvailable);
  const steps = [
    fauxAssistantMessage([
      fauxToolCall(TOOL_COMPARE_PRODUCTS, {
        skus: [input.a.sku, input.b.sku],
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
      } as unknown as JsonObject),
    ]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_PROPOSE_REPLY, {
        blocks: [
          {
            kind: "recommend_option",
            ref: mainRef,
            ...(input.reason === "lowest_public_price" ? { comparedRefs: [comparedRef] } : {}),
            reasonCode: input.reason,
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
        const product = sku === "A" ? input.a : sku === "B" ? input.b : undefined;
        return product === undefined
          ? { price: 0, currency: "CNY" }
          : {
              price: product.price,
              currency: product.currency,
              stock: product.stock,
              unit: product.unit,
            };
      },
    },
    maxSteps: 4,
    timeoutMs: 5000,
  });
  const registry = new InMemoryFactRegistry();
  const result = await runtime.run({
    merchantId: MERCHANT,
    identity: "buyer:1",
    contextId: "ctx-compare",
    text:
      input.buyerText ??
      (input.quantity !== undefined && input.unit !== undefined
        ? `我要${input.quantity}${input.unit}`
        : "compare"),
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

describe("Pi compare_products → recommend_option publisher claims", () => {
  it("足够库存和更低价格时可发布", async () => {
    const result = await runCompare({ a: A, b: B, quantity: 2, unit: "piece", reason: "in_stock" });
    expect(result.rejected).toHaveLength(0);
    expect(result.text).toContain("库存可以覆盖本次数量");
    const price = await runCompare({
      a: A,
      b: B,
      quantity: 2,
      unit: "piece",
      reason: "lowest_public_price",
    });
    expect(price.rejected).toHaveLength(0);
    expect(price.text).toContain("公开标价更低");
  });

  it("库存不足时不声称覆盖", async () => {
    const result = await runCompare({
      a: { ...A, stock: 1 },
      b: B,
      quantity: 2,
      unit: "piece",
      reason: "in_stock",
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
    expect(result.text).not.toContain("库存可以覆盖本次数量");
  });

  it("数量或单位未知时不声称库存覆盖", async () => {
    const unknownQuantity = await runCompare({ a: A, b: B, unit: "piece", reason: "in_stock" });
    expect(unknownQuantity.rejected[0]?.reason).toBe("unverified_claim");
    const unknownUnit = await runCompare({ a: A, b: B, quantity: 2, reason: "in_stock" });
    expect(unknownUnit.rejected[0]?.reason).toBe("unverified_claim");
  });

  it("不同币种不声称更低价格", async () => {
    const result = await runCompare({
      a: A,
      b: { ...B, currency: "USD" },
      quantity: 2,
      unit: "piece",
      reason: "lowest_public_price",
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
  });

  it("相同价格不声称更低价格", async () => {
    const result = await runCompare({
      a: A,
      b: { ...B, price: A.price },
      quantity: 2,
      unit: "piece",
      reason: "lowest_public_price",
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
  });
  it("buyer asks 10 but model supplies 1: never claims stock coverage", async () => {
    const result = await runCompare({
      a: { ...A, stock: 1 },
      b: B,
      quantity: 1,
      unit: "piece",
      buyerText: "我要10件",
      expectedStockAvailable: null,
      reason: "in_stock",
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
    expect(result.text).not.toContain("库存可以覆盖本次数量");
  });

  it("buyer asks 10 and model supplies 10: stock 1 still does not cover", async () => {
    const result = await runCompare({
      a: { ...A, stock: 1 },
      b: B,
      quantity: 10,
      unit: "piece",
      buyerText: "我要10件",
      expectedStockAvailable: null,
      reason: "in_stock",
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
    expect(result.text).not.toContain("库存可以覆盖本次数量");
  });

});
