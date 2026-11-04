/**
 * M2：接待 Pi 工具循环。
 *
 * 用脚本化 fake provider 验证：
 *  - search → facts → need patch → propose_reply 的受控工具链；
 *  - 事实只以 fact ref 进入计划，发布器从快照渲染；
 *  - 非白名单 block / 非法工具被拒绝；
 *  - 引擎在有 agent 时使用模型计划，agent 失败时回退确定性路径。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type FauxResponseStep,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";

import {
  createPiReceptionRuntime,
  sanitizeReceptionBlocks,
  TOOL_COMPARE_PRODUCTS,
  TOOL_GET_COMMERCIAL_FACTS,
  TOOL_PROPOSE_NEED_PATCH,
  TOOL_PROPOSE_REPLY,
  TOOL_SEARCH_PRODUCTS,
} from "../src/a2a/reception/agent-runtime.js";
import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { factRevision, InMemoryFactRegistry } from "../src/a2a/reception/publish.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
const policy = {
  price_floors: { [SKU]: 100 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

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

const expectedFacts = {
  listPrice: 110,
  currency: "CNY",
  unit: "piece",
  stockAvailable: true,
  deliveryBefore: "2026-11-10T04:00:00.000Z",
};
const expectedRef = {
  sku: SKU,
  revision: factRevision({
    merchantId: "merchant-1",
    sku: SKU,
    visibility: "public",
    issuedAt: NOW,
    facts: expectedFacts,
  }),
};

const productSource = {
  async searchProducts() {
    return [
      { sku: SKU, title: "办公款", price: 110, currency: "CNY", stock: 50 },
      { sku: "VQ-002", title: "基础款", price: 90, currency: "CNY", stock: 50 },
    ];
  },
  async getProduct(sku: string) {
    return sku === "VQ-002"
      ? { price: 90, currency: "CNY", stock: 50, unit: "piece" }
      : { price: 110, currency: "CNY", stock: 50, unit: "piece" };
  },
};

describe("Pi reception runtime", () => {
  it("按 search → facts → need patch → propose_reply 完成一轮", async () => {
    const steps: FauxResponseStep[] = [
      fauxAssistantMessage([fauxToolCall(TOOL_SEARCH_PRODUCTS, { query: "办公" } as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_COMPARE_PRODUCTS, { skus: [SKU, "VQ-002"] } as unknown as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, {
          sku: SKU,
          quantity: 2,
          unit: "piece",
        } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_NEED_PATCH, {
          sku: SKU,
          quantity: 2,
          unit: "piece",
        } as JsonObject),
      ]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [
            { kind: "acknowledge_need", sku: SKU, quantity: 2, unit: "piece" },
            { kind: "show_commercial_terms", ref: expectedRef },
            { kind: "next_step", action: "send_rfq" },
          ],
        } as unknown as JsonObject),
      ]),
    ];
    const { streamFn } = createScriptedFakeStreamFn(steps);
    let recordedMetrics:
      | { steps: number; toolCalls: Record<string, number> }
      | undefined;
    const runtime = createPiReceptionRuntime({
      streamFn,
      model,
      productSource,
      policy: () => policy as never,
      maxSteps: 8,
      timeoutMs: 5_000,
      onMetrics: (metrics) => {
        recordedMetrics = metrics;
      },
    });
    const registry = new InMemoryFactRegistry();
    const result = await runtime.run({
      merchantId: "merchant-1",
      identity: "buyer:1",
      contextId: "ctx_agent",
      text: "办公室用的那款来两盒",
      registry,
      now: NOW,
    });
    expect(result?.plan.blocks.map((block) => block.kind)).toEqual([
      "acknowledge_need",
      "show_commercial_terms",
      "next_step",
    ]);
    expect(result?.need).toMatchObject({ sku: SKU, quantity: 2, unit: "piece" });
    expect(registry.resolve(expectedRef)?.facts).toEqual(expectedFacts);
    expect(recordedMetrics?.steps).toBeGreaterThanOrEqual(5);
    expect(recordedMetrics?.toolCalls).toEqual({
      [TOOL_SEARCH_PRODUCTS]: 1,
      [TOOL_COMPARE_PRODUCTS]: 1,
      [TOOL_GET_COMMERCIAL_FACTS]: 1,
      [TOOL_PROPOSE_NEED_PATCH]: 1,
      [TOOL_PROPOSE_REPLY]: 1,
    });
  });

  it("预算准入被拒时中止并返回 undefined", async () => {
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall(TOOL_SEARCH_PRODUCTS, { query: "办公" } as JsonObject)]),
    ]);
    let rejected: string | undefined;
    let quotaRejected = false;
    const runtime = createPiReceptionRuntime({
      streamFn,
      model,
      productSource,
      policy: () => policy as never,
      maxSteps: 6,
      timeoutMs: 5_000,
      budget: {
        begin: () => ({ rejected: "merchant_quota_exhausted" }),
        settle: () => {},
        onRejected: (reason) => {
          rejected = reason;
        },
      },
      onMetrics: (metrics) => {
        quotaRejected = metrics.quotaRejected === true;
      },
    });
    const result = await runtime.run({
      merchantId: "merchant-1",
      identity: "buyer:1",
      contextId: "ctx_quota",
      text: "办公款",
      registry: new InMemoryFactRegistry(),
      now: NOW,
    });
    expect(result).toBeUndefined();
    expect(rejected).toBe("merchant_quota_exhausted");
    expect(quotaRejected).toBe(true);
  });

  it("拒绝自由文本块与非白名单工具", async () => {
    expect(sanitizeReceptionBlocks([{ kind: "free_text", text: "包邮" }])).toBeUndefined();
    expect(
      sanitizeReceptionBlocks([
        { kind: "show_commercial_terms", ref: { sku: SKU, revision: "x" }, topics: ["bogus"] },
      ]),
    ).toEqual([{ kind: "show_commercial_terms", ref: { sku: SKU, revision: "x" } }]);
  });
});

describe("engine uses Pi runtime when configured", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-agent-engine-"));
    store = new ReceptionConversationStore({ file: join(dir, "c.json"), now: () => NOW });
    outbox = new ReceptionReplyOutbox({ file: join(dir, "o.json"), now: () => NOW });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("agent 的 typed plan 经发布器渲染", async () => {
    const engine = createMerchantReceptionEngine({
      store,
      outbox,
      productSource,
      policy: () => policy as never,
      now: () => NOW,
      agent: {
        async run({ registry }) {
          const ref = registry.register({
            merchantId: "merchant-1",
            sku: SKU,
            visibility: "public",
            issuedAt: NOW,
            facts: expectedFacts,
            revision: expectedRef.revision,
          });
          return {
            plan: {
              locale: "zh-CN",
              blocks: [
                { kind: "acknowledge_need", sku: SKU, quantity: 2, unit: "piece" },
                { kind: "show_commercial_terms", ref },
                { kind: "next_step", action: "send_rfq" },
              ],
            },
            need: { sku: SKU, quantity: 2, unit: "piece" },
            metrics: { steps: 1, toolCalls: {}, usage: { input: 0, output: 0, total: 0 } },
          };
        },
      },
    });
    const result = await engine.respond({
      merchantId: "merchant-1",
      identity: "buyer:1",
      identityVerified: false,
      contextId: "ctx_agent_engine",
      text: "办公款来两盒",
      now: NOW,
    });
    expect(result.text).toContain("已记录需求：SKU VQ-001，2 piece");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.text).toContain("请发送 RFQ");
  });

  it("存在已批准候选时跳过 agent，确定性路径消费批准价", async () => {
    const approvals = new NegotiationApprovalStore(dir, () => NOW);
    const pending = approvals.recordPending({
      negotiation_id: "ctx_agent_engine2",
      sku: SKU,
      currency: "CNY",
      quantity: 2,
      buyer_offer_minor: 9_800,
      ttl_seconds: 900,
    });
    approvals.approve({ approval_id: pending.approval_id, approved_minor: 10_000 });

    let agentCalled = false;
    const interpreter: InquiryInterpreter = {
      async interpret() {
        return {
          intent: "quote_request",
          topics: ["price"],
          sku: SKU,
          quantity: 2,
          unit: "piece",
          target_price: 98,
          language: "zh",
        };
      },
    };
    const engine = createMerchantReceptionEngine({
      store,
      outbox,
      interpreter,
      productSource,
      policy: () => policy as never,
      approvals,
      now: () => NOW,
      agent: {
        async run() {
          agentCalled = true;
          return undefined;
        },
      },
    });
    const result = await engine.respond({
      merchantId: "merchant-1",
      identity: "buyer:1",
      identityVerified: false,
      contextId: "ctx_agent_engine2",
      text: "还是要两盒",
      now: NOW,
    });
    expect(agentCalled).toBe(false);
    expect(result.text).toContain("商家确认价 100.00 CNY（仅本次）");
  });
});
