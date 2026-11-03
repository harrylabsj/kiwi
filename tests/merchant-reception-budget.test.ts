/**
 * P0a：接待运行预算（D07/§18）。
 *
 * 验证：
 *  - 每商家每日 output token 上限（默认 200k）：attempt 预约 2048、按上报
 *    用量结算；未知用量不记零（保留预约额）；
 *  - 额度用尽或预算存储不可用：模型调用被拦截，降级规则路径并记录降级
 *    事件（提示商家）；结构化请求不受影响；
 *  - 30 秒硬截止：超时后不再发起模型/事实工具调用，降级确定性回复。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionBudget, RECEPTION_ATTEMPT_RESERVE_TOKENS } from "../src/a2a/reception/budget.js";
import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { createDeepSeekInquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { SqliteDailyBudgetStore } from "../src/merchant/ai-runtime/sqlite-budget-store.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";

const deepseekPayload = (outputTokens?: number) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          intent: "quote_request",
          topics: ["price"],
          sku: SKU,
          quantity: 2,
          language: "zh",
        }),
      },
    },
  ],
  ...(outputTokens !== undefined ? { usage: { completion_tokens: outputTokens } } : {}),
});

describe("reception budget（日 token 配额）", () => {
  let dir: string;
  let store: SqliteDailyBudgetStore;
  let budget: ReceptionBudget;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-budget-"));
    store = new SqliteDailyBudgetStore(join(dir, "budget.sqlite"));
    budget = new ReceptionBudget({
      store,
      now: () => NOW,
      degradationFile: join(dir, "degradations.json"),
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const dayKey = () => `merchant-1@${NOW.slice(0, 10)}`;

  it("上报用量按实际结算，不按预约额记账", async () => {
    const interpreter = createDeepSeekInquiryInterpreter({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify(deepseekPayload(150)), { status: 200 }),
      budget: budget.createAttemptHooks("merchant-1"),
    });
    const result = await interpreter.interpret({ buyer_message: "VQ-001 两件多少钱" });
    expect(result?.sku).toBe(SKU);
    expect(store.usedTokens(dayKey())).toBe(150);
  });

  it("未上报用量不记零：按预约额保留待核对额度", async () => {
    const interpreter = createDeepSeekInquiryInterpreter({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify(deepseekPayload()), { status: 200 }),
      budget: budget.createAttemptHooks("merchant-1"),
    });
    await interpreter.interpret({ buyer_message: "多少钱" });
    expect(store.usedTokens(dayKey())).toBe(RECEPTION_ATTEMPT_RESERVE_TOKENS);
  });

  it("请求失败（非 200）同样不记零", async () => {
    const interpreter = createDeepSeekInquiryInterpreter({
      apiKey: "test-key",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
      budget: budget.createAttemptHooks("merchant-1"),
    });
    const result = await interpreter.interpret({ buyer_message: "多少钱" });
    expect(result).toBeUndefined();
    expect(store.usedTokens(dayKey())).toBe(RECEPTION_ATTEMPT_RESERVE_TOKENS);
  });

  it("额度用尽：拦截模型调用、记录降级事件，不再请求 provider", async () => {
    const tight = new ReceptionBudget({
      store,
      now: () => NOW,
      dailyOutputTokenLimit: 100,
      degradationFile: join(dir, "degradations.json"),
    });
    let fetched = 0;
    const interpreter = createDeepSeekInquiryInterpreter({
      apiKey: "test-key",
      fetchImpl: async () => {
        fetched += 1;
        return new Response(JSON.stringify(deepseekPayload(10)), { status: 200 });
      },
      budget: tight.createAttemptHooks("merchant-1"),
    });
    const result = await interpreter.interpret({ buyer_message: "多少钱" });
    expect(result).toBeUndefined();
    expect(fetched).toBe(0);
    const events = tight.degradations("merchant-1");
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("merchant_quota_exhausted");
  });
});

describe("reception 引擎预算降级与 30 秒硬截止", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-deadline-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const engineFor = (
    deps: {
      interpreter?: Parameters<typeof createMerchantReceptionEngine>[0]["interpreter"];
      now?: () => string;
      deadlineMs?: number;
    } = {},
  ) =>
    createMerchantReceptionEngine({
      store: new ReceptionConversationStore({
        file: join(dir, "conversations.json"),
        now: () => NOW,
      }),
      outbox: new ReceptionReplyOutbox({ file: join(dir, "reply-outbox.json"), now: () => NOW }),
      ...(deps.interpreter !== undefined ? { interpreter: deps.interpreter } : {}),
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return { price: 110, currency: "CNY", stock: 50 };
        },
      },
      policy: () => ({ delivery_lead_days: 7 }) as never,
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
      now: deps.now ?? (() => NOW),
    });

  const input = (text: string, now = NOW) => ({
    merchantId: "merchant-1",
    identity: "buyer:1",
    identityVerified: false,
    contextId: "ctx_1",
    text,
    now,
  });

  it("入场即超 30 秒：不发起模型调用，走确定性澄清", async () => {
    let called = 0;
    const engine = engineFor({
      interpreter: {
        async interpret() {
          called += 1;
          return { intent: "quote_request", topics: ["price"], sku: SKU, language: "zh" };
        },
      },
      now: () => "2026-11-03T04:00:31.000Z",
    });
    const result = await engine.respond(input("VQ-001 多少钱"));
    expect(called).toBe(0);
    expect(result.text).toContain("请提供商品 SKU");
    expect(result.text).not.toContain("CNY");
  });

  it("模型返回后超 30 秒：不再调用事实工具，回复服务繁忙", async () => {
    let now = NOW;
    let productCalled = 0;
    const engine = createMerchantReceptionEngine({
      store: new ReceptionConversationStore({
        file: join(dir, "conversations.json"),
        now: () => NOW,
      }),
      outbox: new ReceptionReplyOutbox({ file: join(dir, "reply-outbox.json"), now: () => NOW }),
      interpreter: {
        async interpret() {
          now = "2026-11-03T04:00:31.000Z";
          return { intent: "quote_request", topics: ["price"], sku: SKU, language: "zh" };
        },
      },
      productSource: {
        async getProduct(sku: string) {
          productCalled += 1;
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return { price: 110, currency: "CNY", stock: 50 };
        },
      },
      policy: () => ({ delivery_lead_days: 7 }) as never,
      now: () => now,
    });
    const result = await engine.respond(input("VQ-001 多少钱"));
    expect(productCalled).toBe(0);
    expect(result.text).toContain("稍后重试");
    expect(result.text).not.toContain("CNY");
  });

  it("额度用尽：降级规则路径，结构化 SKU 的确定性回答不受影响", async () => {
    const store = new SqliteDailyBudgetStore(join(dir, "budget.sqlite"));
    try {
      const budget = new ReceptionBudget({
        store,
        now: () => NOW,
        dailyOutputTokenLimit: 100,
        degradationFile: join(dir, "degradations.json"),
      });
      const interpreter = createDeepSeekInquiryInterpreter({
        apiKey: "test-key",
        fetchImpl: async () => new Response(JSON.stringify(deepseekPayload(10)), { status: 200 }),
        budget: budget.createAttemptHooks("merchant-1"),
      });
      const engine = engineFor({ interpreter });
      const result = await engine.respond({ ...input("VQ-001 多少钱"), structured: { sku: SKU } });
      // 模型被预算拦截（返回 undefined），但结构化 SKU 仍按服务端事实回答。
      expect(result.text).toContain("当前公开标价 110.00 CNY");
      expect(budget.degradations("merchant-1")[0]?.reason).toBe("merchant_quota_exhausted");
    } finally {
      store.close();
    }
  });
});
