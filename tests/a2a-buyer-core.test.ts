/**
 * kiwi-buyer-mcp A2A 轨测试（战略 v2.5 Phase 2 接线 A2A/UCP）。
 *
 * 覆盖：
 *  - KiwiCatalogMerchantIndex listings 感知发现（/v1/listings/search → matching_skus +
 *    agent_card_url）；
 *  - A2AQuoteFetcher 经 agent card 解析 JSONRPC 端点 → 发 rfq envelope → 轮询拿真实
 *    offer（startTestA2aStack + capture 断言入站 action）；
 *  - A2ANegotiator 读 candidate provenance → counter_offer → 拿商家真实回复。
 */
import { afterEach, describe, expect, it } from "vitest";

import { startTestA2aStack, type CapturedInbound } from "./helpers.js";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../src/negotiation/jcs.js";
const recoveryDirs:string[]=[];
function protocolOptions(){const dir=mkdtempSync(path.join(tmpdir(),"a373-a2a-reg-"));recoveryDirs.push(dir);return {protocolStateDir:dir,localBuyerAgentId:"buyer-a2a-test"};}
afterEach(()=>{for(const dir of recoveryDirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function protocolContext(){return {taskId:"task-a2a-001",createdAt:new Date().toISOString(),intentBindingDigest:contentDigest(INTENT)};}

const INTENT = {
  intent_id: "intent-a2a-0001",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 2, unit: "台" } }],
  constraints: {
    currency: "CNY",
    deadline: "2026-08-30T18:00:00Z",
  },
  context_projection: {
    disclosure_boundary: "commerce_required",
    projected_fields: ["items", "constraints"],
  },
};

describe("KiwiCatalogMerchantIndex（listings 感知发现）", () => {
  it("商品查询经 /v1/listings/search 返回商家 + matching_skus + agent_card_url", async () => {
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    // A659：merchant 栈与 buyer 侧默认真实时钟端到端一致（原固定 August ×
    // 真实 October 混用被 receive gate 如实判 offer_expired，probe-1 实证）。
    const stack = await startTestA2aStack({ now: () => new Date().toISOString() });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      expect(merchants).toHaveLength(1);
      const merchant = merchants[0]!;
      expect(merchant.merchant_id).toBe("merchant-001");
      expect(merchant.name).toBe("Test Merchant");
      expect(merchant.verified).toBe(true);
      // listings 商品事实 → matching_skus；agents 身份 → agent_card_url（A2A 磋商必需）。
      expect(merchant.matching_skus).toEqual(["sku-001"]);
      expect(merchant.agent_card_url).toBe(`${stack.merchantUrl}/.well-known/agent-card.json`);
      // 商家配送时效（commercial_hints.lead_time_hint）透出为发现指标。
      expect(merchant.delivery).toBe("华东 1-2天");
      expect(merchant.capabilities).toContain("com.harrylabsj.kiwi.shopping.negotiation");
    } finally {
      await stack.stop();
    }
  });
});

describe("A2AQuoteFetcher（catalog 发现 → A2A 直连 merchant RFQ）", () => {
  it("解析 agent card 端点、发送 rfq envelope、轮询拿真实 offer", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const capture: Array<{ action: string; senderIdentity: string; envelope: Record<string, unknown> }> = [];
    const stack = await startTestA2aStack({
      // A659：merchant 栈真实时钟，与 buyer 侧端到端一致（见上）。
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
      capture,
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      const fetcher = new A2AQuoteFetcher({
        ...protocolOptions(),
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      const results = await fetcher.requestQuotes(INTENT, merchants, protocolContext());
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.status).toBe("succeeded");
      expect(result.provenance?.source).toBe("a2a");
      expect(result.provenance?.negotiation_id).toBeDefined();
      expect(result.provenance?.offer_id).toBeDefined();
      // a2a_endpoint = agent card JSONRPC 端点（供 A2ANegotiator 复用）。
      expect(result.provenance?.a2a_endpoint).toBe(`${stack.merchantUrl}/`);
      // 真实回复：商家 offer 的单价（189 元 → 18900 minor）从回复 envelope 解析。
      const offer = JSON.parse(result.provenance!.reply_text!) as {
        payload: { terms: { items: Array<{ unit_price: { amount_minor: number } }> } };
      };
      expect(offer.payload.terms.items[0]!.unit_price.amount_minor).toBe(18900);
      // 入站第一条是 rfq envelope（capture 数组由 startTestA2aStack 填充）。
      expect(capture[0]?.action).toBe("rfq");
    } finally {
      await stack.stop();
    }
  });

  it("merchant 无 agent_card_url → failed + 可解释 classification", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const fetcher = new A2AQuoteFetcher({ allowPrivateRanges: true, skipDnsCheck: true });
    const results = await fetcher.requestQuotes(INTENT, [
      { merchant_id: "merchant-no-card", name: "无 card 商家", verified: false, capabilities: [] },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.failure?.classification).toBe("unreachable");
  });

  it("intent query 文本不匹配 catalog 时仍按 merchant_id 解析成功（回归：不丢 agent_card_url）", async () => {
    const { buildBuyerService } = await import("../src/buyer-core/build-service.js");
    const { buildKiwiTools } = await import("../src/mcp/tools.js");
    const { DEFAULT_DELEGATION_POLICY } = await import("../src/mcp/cli.js");
    const stack = await startTestA2aStack({
      // A659：merchant 栈真实时钟，与 buyer 侧端到端一致（见上）。
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "个", source_evidence: { system: "owned-test-fixture" } }),
      },
    });
    try {
      const service = buildBuyerService({
        dbPath: ":memory:",
        protocolStateDir:protocolOptions().protocolStateDir,
        principal: "hermes:probe",
        buyerAgentId: "buyer-agent:hermes",
        sessionId: "repro-no-card",
        policy: { ...DEFAULT_DELEGATION_POLICY, principal: "hermes:probe" },
        catalogUrl: stack.catalogUrl,
        a2aAllowPrivateRanges: true,
        a2aSkipDnsCheck: true,
        a2aTimeoutMs: 8000,
      });
      const tools = buildKiwiTools(service);
      const call = (name: string, args: Record<string, unknown>) =>
        tools.find((t) => t.name === name)!.handle(args);
      const text = (r: { content?: Array<{ text?: string }> }) => r.content?.[0]?.text ?? "";

      // 先 search 拿到 merchant（带 agent_card_url）
      const s = JSON.parse(text(await call("kiwi_search", { query: "Test Product" }))) as {
        merchants?: Array<{ merchant_id: string; agent_card_url?: string }>;
      };
      const merchant = s.merchants?.[0];
      expect(merchant).toBeDefined();
      expect(merchant?.agent_card_url).toContain("agent-card.json");

      // request_quotes 用完全不同的意图措辞（catalog LIKE 匹配不上）—— 应仍按 id 解析成功
      const rq = await call("kiwi_request_quotes", {
        intent: {
          intent_id: "repro-no-card-1",
          intent_type: "purchase",
          items: [{ query: "买一个完全不同的商品 预算不知道", quantity: { value: 1, unit: "个" } }],
          constraints: { currency: "CNY" },
          context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items", "constraints"] },
        },
        merchant_ids: [merchant!.merchant_id],
      });
      expect(rq.isError).toBeUndefined();
      const taskId = (JSON.parse(text(rq)) as { task_id: string }).task_id;
      const gt = JSON.parse(text(await call("kiwi_get_task", { task_id: taskId }))) as {
        task?: { candidates?: Array<{ status: string; failure?: { classification?: string } }> };
      };
      const candidates = gt.task?.candidates ?? [];
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.status).toBe("succeeded");
    } finally {
      await stack.stop();
    }
  });
});


describe("Buyer MCP 端到端：预算还价 → 候选刷新 → 商家 accept", () => {
  it("negotiate 后 get_task 显示商家最新条款，accept 向商家发送并写入 agreed_terms", async () => {
    const { buildBuyerService } = await import("../src/buyer-core/build-service.js");
    const { buildKiwiTools } = await import("../src/mcp/tools.js");
    const { DEFAULT_DELEGATION_POLICY } = await import("../src/mcp/cli.js");
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
      merchantPolicy: { price_floors: { "sku-001": 180 }, max_auto_discount_percent: 5 },
      capture,
    });
    try {
      const service = buildBuyerService({
        dbPath: ":memory:",
        protocolStateDir: protocolOptions().protocolStateDir,
        principal: "hermes:probe",
        buyerAgentId: "buyer-agent:hermes",
        sessionId: "e2e-accept",
        policy: {
          ...DEFAULT_DELEGATION_POLICY,
          principal: "hermes:probe",
          actions: { ...DEFAULT_DELEGATION_POLICY.actions, accept_nonbinding: { mode: "auto" } },
        },
        catalogUrl: stack.catalogUrl,
        a2aAllowPrivateRanges: true,
        a2aSkipDnsCheck: true,
        a2aTimeoutMs: 8000,
      });
      const tools = buildKiwiTools(service);
      const call = (name: string, args: Record<string, unknown>) =>
        tools.find((t) => t.name === name)!.handle(args);
      const text = (r: { content?: Array<{ text?: string }> }) => r.content?.[0]?.text ?? "";
      const search = JSON.parse(text(await call("kiwi_search", { query: "Test Product" }))) as {
        merchants: Array<{ merchant_id: string }>;
      };
      const rq = await call("kiwi_request_quotes", {
        intent: {
          intent_id: "e2e-accept-1",
          intent_type: "purchase",
          items: [{ query: "Test Product", quantity: { value: 1, unit: "台" } }],
          constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 18000 } },
          context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items", "constraints"] },
        },
        merchant_ids: [search.merchants[0]!.merchant_id],
      });
      expect(rq.isError).toBeUndefined();
      const taskId = (JSON.parse(text(rq)) as { task_id: string }).task_id;
      const negotiated = await call("kiwi_negotiate", {
        task_id: taskId,
        action: "counter_offer",
        summary: "预算上限 180 元",
      });
      expect(negotiated.isError).toBeUndefined();
      const counter = capture.find((c) => c.action === "counter_offer");
      const proposed = (counter?.envelope.payload as { proposed_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } } | undefined)
        ?.proposed_terms?.items?.[0]?.unit_price?.amount_minor;
      expect(proposed).toBe(18000);

      const taskAfter = JSON.parse(text(await call("kiwi_get_task", { task_id: taskId }))) as {
        task: { candidates: Array<{ candidate_id: string; provenance?: { _quote_terms?: { total_price_minor?: number } } }> };
      };
      const candidate = taskAfter.task.candidates[0]!;
      // 商家回复（含条件报价）已回写候选，不再停留在初始 18900。
      expect(candidate.provenance?._quote_terms?.total_price_minor).toBeDefined();
      expect(candidate.provenance?._quote_terms?.total_price_minor).not.toBe(18900);

      const accepted = await call("kiwi_accept_agreement", { task_id: taskId, candidate_id: candidate.candidate_id });
      expect(accepted.isError).toBeUndefined();
      const result = JSON.parse(text(accepted)) as { agreement: { agreed_terms?: Record<string, unknown>; merchant_agreement?: Record<string, unknown> } };
      const agreed = result.agreement.agreed_terms as { items: Array<{ unit_price: { amount_minor: number } }> };
      expect(agreed.items[0]!.unit_price.amount_minor).toBeLessThan(18900);
      expect(agreed.items[0]!.unit_price.amount_minor).toBeGreaterThan(0);
      expect(result.agreement.merchant_agreement).toBeDefined();
      expect(capture.some((c) => c.action === "accept_nonbinding")).toBe(true);
    } finally {
      await stack.stop();
    }
  });
});

describe("A2ANegotiator（A2A 直连 merchant CounterOffer）", () => {
  it("读 candidate provenance → counter_offer → 拿商家真实回复", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const stack = await startTestA2aStack({
      // A659：merchant 栈真实时钟，与 buyer 侧端到端一致（见上）。
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      // A651 接缝修正（claude-ds 待运行复验）：A647 起 negotiator 只从与
      // fetcher 同一 protocol directory 的持久 journal 读真实报价定价（裸
      // provenance 不再当价格权威），且 validatedQuote 强校验 task_created_at
      // ——两个 adapter 必须共享同一 protocolStateDir 与同一 context 对象，
      // 各建新目录/新 context 会使 journal 查不到而无法真实还价。
      const protocolOpts = protocolOptions();
      const context = protocolContext();
      const fetcher = new A2AQuoteFetcher({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      const fetched = await fetcher.requestQuotes(INTENT, merchants, context);
      expect(fetched[0]?.status).toBe("succeeded");

      const negotiator = new A2ANegotiator({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        defaultDiscountRate: 0.1,
      });
      const step = await negotiator.negotiate(
        "task-a2a-001",
        INTENT,
        { round: 1, action: "counter_offer", summary: "还价 10%" },
        [fetched[0]!] as unknown as Array<Record<string, unknown>>,
        context,
      );
      // 商家对 counter 有真实回复（step.reply），且不是"无上下文"失败。
      expect(step.reply).toBeDefined();
      expect(step.summary).not.toContain("无 A2A 会话上下文");
      const reply = JSON.parse(step.reply!) as { action?: string };
      expect(reply.action).toBeDefined();
    } finally {
      await stack.stop();
    }
  });

  it("预算驱动还价价与商家 accept：counter 用预算单价，accept 绑定商家最新条款", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
      merchantPolicy: { price_floors: { "sku-001": 180 }, max_auto_discount_percent: 5 },
      capture,
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      const protocolOpts = protocolOptions();
      const context = protocolContext();
      const fetcher = new A2AQuoteFetcher({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      // 预算 180 元、数量 1：还价目标必须是 18000，而不是 18900×0.9=17010。
      const intent = {
        ...INTENT,
        items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 1, unit: "台" } }],
        constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 18000 } },
      };
      const fetched = await fetcher.requestQuotes(intent, merchants, context);
      expect(fetched[0]?.status).toBe("succeeded");
      const negotiator = new A2ANegotiator({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        defaultDiscountRate: 0.1,
      });
      const step = await negotiator.negotiate(
        "task-a2a-001",
        intent,
        { round: 1, action: "counter_offer", summary: "预算上限 180 元" },
        [fetched[0]!] as unknown as Array<Record<string, unknown>>,
        context,
      );
      const counter = capture.find((c) => c.action === "counter_offer");
      const proposed = (counter?.envelope.payload as { proposed_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } } | undefined)
        ?.proposed_terms?.items?.[0]?.unit_price?.amount_minor;
      expect(proposed).toBe(18000);
      expect(step.merchant_offer).toBeDefined();
      // 模拟 service 的候选回写，然后向商家发送 accept_nonbinding。
      const candidate = {
        ...fetched[0]!,
        provenance: {
          ...(fetched[0]!.provenance ?? {}),
          offer_id: step.merchant_offer!.offer_id,
          merchant_reply_id: step.merchant_offer!.reply_message_id,
          latest_terms_digest: step.merchant_offer!.terms_digest,
          latest_agreed_terms: step.merchant_offer!.agreed_terms,
          latest_offer_type: step.merchant_offer!.offer_type,
        },
      };
      const accepted = await negotiator.acceptNonbinding({
        taskId: "task-a2a-001",
        candidate: candidate as unknown as Record<string, unknown>,
      });
      expect(accepted.agreement.accepted_offer_id).toBe(step.merchant_offer!.offer_id);
      expect(accepted.agreement.terms_digest).toBe(step.merchant_offer!.terms_digest);
      expect(capture.some((c) => c.action === "accept_nonbinding")).toBe(true);
    } finally {
      await stack.stop();
    }
  });

  it("B2：越界还价登记审批，批准后买家重试命中一次性授权价", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const { NegotiationApprovalStore } = await import(
      "../src/a2a/server/negotiation-approvals.js"
    );
    // 商家：189 元、5% 自动折扣（179.55）、私有底价 180 元——买家 10% 还价
    // （170.10）落在自动边界外，只能转人工。
    const approvalDir = mkdtempSync(path.join(tmpdir(), "a2a-b2-approvals-"));
    recoveryDirs.push(approvalDir);
    const approvals = new NegotiationApprovalStore(approvalDir, () => new Date().toISOString());
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
      // price_floors 以元写（major），180 元 > 自动边界 179.55 元。
      merchantPolicy: { price_floors: { "sku-001": 180 }, max_auto_discount_percent: 5 },
      negotiationApprovals: approvals,
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      const protocolOpts = protocolOptions();
      const context = protocolContext();
      const fetcher = new A2AQuoteFetcher({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      const fetched = await fetcher.requestQuotes(INTENT, merchants, context);
      expect(fetched[0]?.status).toBe("succeeded");
      const negotiator = new A2ANegotiator({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        defaultDiscountRate: 0.1,
      });

      const first = await negotiator.negotiate(
        "task-a2a-001",
        INTENT,
        { round: 1, action: "counter_offer", summary: "还价 10%" },
        [fetched[0]!] as unknown as Array<Record<string, unknown>>,
        context,
      );
      expect(first.summary).toContain("人工审批");
      const pending = approvals.list("pending");
      expect(pending).toHaveLength(1);
      approvals.approve({
        approval_id: pending[0]!.approval_id,
        approved_minor: 17_010,
        ttl_seconds: 600,
        approved_by: "merchant:operator",
      });

      // 买家换新恢复槽位重试（每次还价独立）：命中商家已批准的一次性价格。
      const second = await negotiator.negotiate(
        "task-a2a-001",
        INTENT,
        { round: 2, action: "counter_offer", summary: "还价 10%" },
        [fetched[0]!] as unknown as Array<Record<string, unknown>>,
        context,
      );
      const reply = JSON.parse(second.reply!) as {
        action?: string;
        payload?: { base_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } };
      };
      expect(reply.action).toBe("conditional_offer");
      expect(reply.payload?.base_terms?.items?.[0]?.unit_price?.amount_minor).toBe(17_010);
      expect(approvals.list("consumed")).toHaveLength(1);
    } finally {
      await stack.stop();
    }
  });

  it("clarification → 商家按问题字段应答 clarification_response", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      const protocolOpts = protocolOptions();
      const context = protocolContext();
      const fetcher = new A2AQuoteFetcher({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      const fetched = await fetcher.requestQuotes(INTENT, merchants, context);
      expect(fetched[0]?.status).toBe("succeeded");

      const negotiator = new A2ANegotiator({
        ...protocolOpts,
        allowPrivateRanges: true,
        skipDnsCheck: true,
      });
      const step = await negotiator.negotiate(
        "task-a2a-001",
        INTENT,
        {
          round: 2,
          action: "clarification",
          summary: "询问交期与库存",
          questions: [{ field: "delivery" }, { field: "stock" }],
        },
        [fetched[0]!] as unknown as Array<Record<string, unknown>>,
        context,
      );
      expect(step.reply).toBeDefined();
      const reply = JSON.parse(step.reply!) as {
        action?: string;
        payload?: { answers?: Array<{ field: string; answer: string }> };
      };
      expect(reply.action).toBe("clarification_response");
      expect(reply.payload?.answers?.map((a) => a.field)).toEqual(["delivery", "stock"]);
      // 商家按字段回答，而不是同一句固定文本。
      expect(reply.payload?.answers?.[0]?.answer).not.toBe(reply.payload?.answers?.[1]?.answer);
    } finally {
      await stack.stop();
    }
  });

  it("缺 A2A 会话上下文 → 追加可解释 summary，不编造还价", async () => {
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const negotiator = new A2ANegotiator({ allowPrivateRanges: true, skipDnsCheck: true });
    const step = await negotiator.negotiate("task-a2a-002", INTENT, {
      round: 1,
      action: "counter_offer",
      summary: "还价",
    }, []);
    expect(step.reply).toBeUndefined();
    expect(step.summary).toContain("无 A2A 会话上下文");
  });
});
