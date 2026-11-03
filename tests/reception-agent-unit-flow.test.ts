/**
 * Pi 接待单位面：need 必须使用 facts 的换算后数量，同时保留买家原始输入。
 *
 * 合法配置：default_unit=piece、factor={box:12}、SKU 单位=piece、买家 2 box
 * → facts/need 24 piece；need→RFQ→offer→accept 的数量、单价和金额一致。
 * 同时覆盖 1:1、冲突、溢出和模型伪造/重复换算。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type FauxResponseStep,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createMerchantHandler,
  type MerchantProductSource,
} from "../src/a2a/server/merchant-handler.js";
import {
  createPiReceptionRuntime,
  TOOL_GET_COMMERCIAL_FACTS,
  TOOL_PROPOSE_NEED_PATCH,
  TOOL_PROPOSE_REPLY,
  TOOL_SEARCH_PRODUCTS,
} from "../src/a2a/reception/agent-runtime.js";
import { InMemoryFactRegistry } from "../src/a2a/reception/publish.js";
import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { evaluateConditionalOffer } from "../src/negotiation/condition/evaluator.js";
import type { NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
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
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "pi-unit-flow-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function productSource(unit: string, stock = 300): MerchantProductSource {
  return {
    async getProduct() {
      return {
        price: 70,
        currency: "CNY",
        stock,
        unit,
        handoff_destination: "https://example.com/item/1",
        source_evidence: { system: "fixture", source_version: "1" },
      };
    },
  };
}

function steps(
  quantity: number,
  unit: string,
  needQuantity = quantity,
  needUnit = unit,
): FauxResponseStep[] {
  return [
    fauxAssistantMessage([fauxToolCall(TOOL_SEARCH_PRODUCTS, { query: "精油" } as JsonObject)]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, { sku: SKU, quantity, unit } as JsonObject),
    ]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_PROPOSE_NEED_PATCH, {
        sku: SKU,
        quantity: needQuantity,
        unit: needUnit,
      } as JsonObject),
    ]),
    fauxAssistantMessage([
      fauxToolCall(TOOL_PROPOSE_REPLY, {
        blocks: [{ kind: "acknowledge_need", sku: SKU, quantity: needQuantity, unit: needUnit }],
      } as unknown as JsonObject),
    ]),
  ];
}

async function runPi(options: {
  quantity: number;
  unit: string;
  sourceUnit: string;
  factors?: Record<string, number>;
  defaultUnit?: string;
  aliases?: Record<string, string>;
  stock?: number;
  needQuantity?: number;
  needUnit?: string;
}) {
  const { streamFn } = createScriptedFakeStreamFn(
    steps(options.quantity, options.unit, options.needQuantity, options.needUnit),
  );
  const runtime = createPiReceptionRuntime({
    streamFn,
    model,
    productSource: productSource(options.sourceUnit, options.stock),
    policy: () => ({ price_floors: { [SKU]: 60 } }) as never,
    ...(options.factors !== undefined ? { unitPackageFactors: options.factors } : {}),
    ...(options.defaultUnit !== undefined ? { unitDefaultUnit: options.defaultUnit } : {}),
    ...(options.aliases !== undefined ? { unitAliases: options.aliases } : {}),
    maxSteps: 6,
    timeoutMs: 5000,
  });
  return runtime.run({
    merchantId: "m-1",
    identity: "buyer:1",
    contextId: "ctx-1",
    text: "来两box",
    registry: new InMemoryFactRegistry(),
    now: NOW,
  });
}

function outgoing(result: NegotiationHandlerResult) {
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("expected accepted");
  return (result.message?.parts[0] as unknown as {
    data: { knp_envelope: ReturnType<typeof finalizeEnvelope> };
  }).data.knp_envelope;
}

async function sendNeedToKnp(need: { sku: string; quantity: number; unit: string }) {
  const dir = temp();
  let seq = 0;
  const ledger = new LedgerStore({ dir, now: () => NOW });
  const handler = createMerchantHandler({
    ledger,
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    productSource: productSource("piece", 300),
  });
  const send = async (action: string, payload: Record<string, unknown>, inReplyTo = "msg_previous") => {
    const envelope = finalizeEnvelope({
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
      negotiation_id: "neg_need",
      exchange_id: `ex_${++seq}`,
      message_id: `msg_${seq}`,
      actor: "buyer",
      action: action as never,
      created_at: NOW,
      payload: payload as never,
      in_reply_to: inReplyTo,
    });
    return handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: "task-need",
      senderIdentity: "buyer:buyer-001",
    });
  };
  const quote = await send("rfq", {
    type: "rfq",
    items: [{ sku: need.sku, quantity: { value: need.quantity, unit: need.unit } }],
  });
  const offer = outgoing(quote);
  const accept = async (result: NegotiationHandlerResult) => {
    const envelope = outgoing(result);
    const payload = envelope.payload as {
      offer_id: string;
      terms?: Record<string, unknown>;
    };
    const terms =
      payload.terms ??
      evaluateConditionalOffer(payload as never, {
        "aggregate.total_quantity": need.quantity,
      });
    return send(
      "accept_nonbinding",
      {
        type: "accept_nonbinding",
        offer_id: payload.offer_id,
        terms_digest: contentDigest(terms as never),
      },
      envelope.message_id,
    );
  };
  return { offer, accepted: await accept(quote) };
}

describe("Pi reception unit need flow", () => {
  it("显式 factor 将 2 box 换算为 24 piece，并在 need/plan 中保留 input 追溯", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "box",
      sourceUnit: "piece",
      factors: { box: 12 },
      defaultUnit: "piece",
    });
    expect(result?.need).toMatchObject({
      sku: SKU,
      quantity: 24,
      unit: "piece",
      inputQuantity: 2,
      inputUnit: "box",
    });
    const ack = result?.plan.blocks.find((block) => block.kind === "acknowledge_need");
    expect(ack).toMatchObject({
      quantity: 24,
      unit: "piece",
      convertedFrom: { quantity: 2, unit: "box", factor: 12 },
    });
  });

  it("1:1 不套用倍率", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "piece",
      sourceUnit: "piece",
      factors: { box: 12 },
      defaultUnit: "piece",
    });
    expect(result?.need).toMatchObject({ quantity: 2, unit: "piece" });
    expect(result?.need?.inputQuantity).toBeUndefined();
  });

  it("单位冲突时 need 不被模型值盖章，不能伪造为 2 box", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "box",
      sourceUnit: "piece",
      aliases: { box: "piece" },
      factors: { box: 12 },
      defaultUnit: "piece",
    });
    expect(result?.need).toBeUndefined();
  });

  it("模型提交已换算的 24 piece 时不重复乘 12", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "box",
      sourceUnit: "piece",
      factors: { box: 12 },
      defaultUnit: "piece",
      needQuantity: 24,
      needUnit: "piece",
    });
    expect(result?.need).toMatchObject({
      quantity: 24,
      unit: "piece",
      inputQuantity: 2,
      inputUnit: "box",
    });
  });

  it("模型把原始 2 box 误写成 2 piece 时拒绝，不双重换算", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "box",
      sourceUnit: "piece",
      factors: { box: 12 },
      defaultUnit: "piece",
      needQuantity: 2,
      needUnit: "piece",
    });
    expect(result?.need).toBeUndefined();
  });

  it("模型伪造 3 piece 时拒绝 need patch", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "box",
      sourceUnit: "piece",
      factors: { box: 12 },
      defaultUnit: "piece",
      needQuantity: 3,
      needUnit: "piece",
    });
    expect(result?.need).toBeUndefined();
  });

  it("倍率溢出时 need 不被写入", async () => {
    const result = await runPi({
      quantity: Number.MAX_SAFE_INTEGER,
      unit: "box",
      sourceUnit: "piece",
      factors: { box: 10_000 },
      defaultUnit: "piece",
    });
    expect(result?.need).toBeUndefined();
  });

  it("人工审批跨两轮：候选登记为 24 piece，第二轮回环消费", async () => {
    const dir = temp();
    const store = new ReceptionConversationStore({
      file: join(dir, "conversation.json"),
      now: () => NOW,
    });
    const outbox = new ReceptionReplyOutbox({
      file: join(dir, "outbox.json"),
      now: () => NOW,
    });
    const approvals = new NegotiationApprovalStore(dir, () => NOW);
    const stepsWithHuman: FauxResponseStep[] = [
      fauxAssistantMessage([fauxToolCall(TOOL_GET_COMMERCIAL_FACTS, { sku: SKU, quantity: 2, unit: "box" } as JsonObject)]),
      fauxAssistantMessage([fauxToolCall(TOOL_PROPOSE_NEED_PATCH, { sku: SKU, quantity: 2, unit: "box" } as JsonObject)]),
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_REPLY, {
          blocks: [
            { kind: "acknowledge_need", sku: SKU, quantity: 2, unit: "box" },
            { kind: "request_human_help", topic: "price_below_public_bound", buyerTargetPrice: 50, currency: "CNY" },
          ],
        } as unknown as JsonObject),
      ]),
    ];
    const { streamFn } = createScriptedFakeStreamFn(stepsWithHuman);
    const agent = createPiReceptionRuntime({
      streamFn,
      model,
      productSource: productSource("piece", 300),
      policy: () => ({ price_floors: { [SKU]: 60 }, max_auto_discount_percent: 5 }) as never,
      unitPackageFactors: { box: 12 },
      unitDefaultUnit: "piece",
      maxSteps: 6,
      timeoutMs: 5000,
    });
    const interpreter: InquiryInterpreter = {
      async interpret() {
        return {
          intent: "quote_request",
          topics: ["price"],
          sku: SKU,
          quantity: 2,
          unit: "box",
          target_price: 50,
          language: "zh",
        };
      },
    };
    const engine = createMerchantReceptionEngine({
      store,
      outbox,
      interpreter,
      productSource: productSource("piece", 300),
      policy: () => ({ price_floors: { [SKU]: 60 }, max_auto_discount_percent: 5 }) as never,
      approvals,
      unitPackageFactors: { box: 12 },
      unitDefaultUnit: "piece",
      now: () => NOW,
      agent,
    });
    const first = await engine.respond({
      merchantId: "m-1",
      identity: "buyer:1",
      identityVerified: false,
      contextId: "ctx-approval",
      text: "两箱",
      now: NOW,
    });
    expect(first.conversation.need).toMatchObject({
      sku: SKU,
      quantity: 24,
      unit: "piece",
      inputQuantity: 2,
      inputUnit: "box",
    });
    const pending = approvals.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ quantity: 24, unit: "piece", sku: SKU });
    approvals.approve({ approval_id: pending[0]!.approval_id, approved_minor: 6_500 });
    const second = await engine.respond({
      merchantId: "m-1",
      identity: "buyer:1",
      identityVerified: false,
      contextId: "ctx-approval",
      text: "确认",
      now: NOW,
    });
    expect(second.text).toContain("商家确认价 65.00 CNY");
  });

  it("Pi need→RFQ→offer→accept 数量、单价、金额一致", async () => {
    const result = await runPi({
      quantity: 2,
      unit: "box",
      sourceUnit: "piece",
      factors: { box: 12 },
      defaultUnit: "piece",
    });
    expect(result?.need?.quantity).toBe(24);
    const need = result?.need;
    if (need?.sku === undefined || need.quantity === undefined || need.unit === undefined) {
      throw new Error("expected converted need");
    }
    const { offer, accepted } = await sendNeedToKnp({
      sku: need.sku,
      quantity: need.quantity,
      unit: need.unit,
    });
    const terms = (offer.payload as {
      terms: { items: Array<{ quantity: { value: number; unit: string }; unit_price: { amount_minor: number; currency: string } }> };
    }).terms;
    expect(terms.items[0]?.quantity).toEqual({ value: 24, unit: "piece" });
    expect(terms.items[0]?.unit_price).toEqual({ currency: "CNY", amount_minor: 7000 });
    expect(accepted.kind).toBe("accepted");
  });
});
