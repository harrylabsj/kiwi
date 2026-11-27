/**
 * 买家识别与交易回执 · K3 WorkBuddy 真实回访（A2/A5 服务层验收）。
 *
 * 全栈：第一笔任务正常 RFQ（商家自动建档 + 报价索引 + 委托授权）；
 * 新任务 `reuse_history: true` → 历史解析发生在正式 RFQ 之前，实际出站
 * SKU 是上次那款（即使目录匹配列表第一项是另一 SKU）；本次数量生效；
 * 两笔任务是不同 negotiation、同一本店客户 subject；无授权回访返回
 * clarification_needed；Pi 关闭（无模型）不影响确定性分支。
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";

import { startTestA2aStack, type CapturedInbound } from "./helpers.js";

const recoveryDirs: string[] = [];

afterEach(() => {
  for (const dir of recoveryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 开放询价会话身份（买方持久密钥；重启回访同钥）。 */
function makeBuyerIdentity() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawPublic = spki.subarray(spki.length - 32);
  const encoded = rawPublic.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `kiwi-inquiry-session-v1:${encoded}`;
}

describe("K3 沿用上次规格真实回访（A5）", () => {
  it.each([false, true])("同键重试读取原任务，无需再次查询历史（旧任务=%s）", async (legacyTask) => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-quote-replay-"));
    recoveryDirs.push(dir);
    const dbPath = path.join(dir, "buyer.sqlite");
    const store = new TaskApprovalStore({ dbPath });
    onTestFinished(() => store.close());
    const service = new KiwiBuyerService({
      store,
      principal: "buyer:review",
      buyerAgentId: "buyer-agent:review",
      sessionId: "same-owner",
      delegationPolicy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:review" },
    });
    const merchant = "merchant-001";
    const history = vi.spyOn(service, "resolveQuoteHistory").mockResolvedValueOnce({
      status: "ok",
      merchant_id: merchant,
      candidates: [{
        negotiation_id: "neg-1", offer_id: "offer-1", offer_version: 1, sku: "previous-sku",
        quantity: 1, unit: "piece", price: { currency: "CNY", amount_minor: 100 },
        terms_digest: "test", spec: {}, quoted_at: "2026-01-01T00:00:00.000Z",
      }],
    }).mockRejectedValue(new Error("history became unavailable"));
    const input = {
      intent: {
        intent_id: "quote-replay", intent_type: "purchase",
        items: [{ query: "Product", quantity: { value: 2, unit: "piece" } }],
        context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items"] },
      },
      merchant_ids: [merchant],
      idempotency_key: "quote-replay-key",
      reuse_history: true,
    };
    await expect(service.requestQuotes({ ...input, merchant_ids: [] }))
      .rejects.toMatchObject({ code: "clarification_needed", detail: { reason: "merchant_required" } });
    expect(history).not.toHaveBeenCalled();
    const first = await service.requestQuotes(input);
    expect(first.created).toBe(true);
    if (legacyTask) {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mcp_tasks SET quote_request_digest = NULL WHERE task_id = ?").run(String(first.task.task_id));
      } finally {
        db.close();
      }
    }
    expect(await service.requestQuotes(input)).toMatchObject({
      created: false,
      task: { task_id: first.task.task_id, intent: { items: [{ sku: "previous-sku" }] } },
    });
    await expect(service.requestQuotes({ ...input, merchant_ids: ["other-merchant"] }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("两笔任务同 subject；出站 SKU=上次那款；本次数量生效", async () => {
    const { buildBuyerService } = await import("../src/buyer-core/build-service.js");
    const { buildKiwiTools } = await import("../src/mcp/tools.js");
    // 目录匹配列表第一项是另一 SKU（B 目录缺陷模拟）：历史解析必须覆盖它。
    // authVerifier 模拟开放询价中继的服务端验签语义（identity=会话 keyid、
    // identityVerified=true），使 K1 建档与 K2 委托在直连测试栈上成立。
    const buyerIdentity = makeBuyerIdentity();
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async (sku: string) => {
          if (sku !== "sku-last-time") throw new Error(`unknown sku ${sku}`);
          return { price: 189, currency: "CNY", title: "500mL 白色瓶", stock: 500, unit: "个", source_evidence: { system: "owned-test-fixture" } };
        },
      },
      merchantPolicy: { price_floors: { "sku-last-time": 180 }, max_auto_discount_percent: 5 },
      quoteHistory: true,
      merchantId: "merchant-001",
      capture,
      // 目录匹配列表第一项是另一 SKU（sku-001）：历史解析必须覆盖它（A5）。
      extraListing: {
        listing: {
          listing_id: "lst_test_002",
          listing_type: "product",
          owner_agent_id: "cagt_test_merchant_001",
          merchant_id: "merchant-001",
          source_product_ref: "sku-last-time",
          title: "500mL 白色瓶（上次那款）",
          category: "test-category",
          listing_digest: "test-digest-2",
          publication_state: "ACTIVE",
          listing_freshness_state: "FRESH",
          published_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          fresh_until: "2099-01-01T00:00:00Z",
          commercial_hints: {
            moq: 50,
            supports_bulk_quote: true,
            lead_time_hint: "华东 1-2天",
          },
        },
        merchant: { merchant_id: "merchant-001", display_name: "Test Merchant" },
        agent: {
          catalog_agent_id: "cagt_test_merchant_001",
          verification_level: "commerce_verified",
        },
      },
      authVerifier: {
        name: "open-inquiry-test",
        verify: async () => ({
          authenticated: true,
          identity: buyerIdentity,
          identityVerified: true,
          trustLevel: "T0",
        }),
      },
    });
    const protocolDir = mkdtempSync(path.join(tmpdir(), "k3-buyer-"));
    recoveryDirs.push(protocolDir);
    try {
      const service = buildBuyerService({
        dbPath: ":memory:",
        protocolStateDir: protocolDir,
        principal: "hermes:probe",
        buyerAgentId: "buyer-agent:hermes",
        sessionId: "e2e-revisit",
        policy: {
          ...DEFAULT_DELEGATION_POLICY,
          principal: "hermes:probe",
          actions: { ...DEFAULT_DELEGATION_POLICY.actions, accept_nonbinding: { mode: "auto" } },
        },
        catalogUrl: stack.catalogUrl,
        a2aAllowPrivateRanges: true,
        a2aSkipDnsCheck: true,
        a2aTimeoutMs: 8000,
        historyDelegation: { merchantIds: ["merchant-001"] },
      });
      const tools = buildKiwiTools(service);
      const call = (name: string, args: Record<string, unknown>) =>
        tools.find((t) => t.name === name)!.handle(args);
      const text = (r: { content?: Array<{ text?: string }> }) => r.content?.[0]?.text ?? "";
      const search = JSON.parse(text(await call("kiwi_search", { query: "Test" }))) as {
        merchants: Array<{ merchant_id: string }>;
      };
      const merchantId = search.merchants[0]!.merchant_id;

      // 第一笔任务：普通 RFQ（数量 50），委托随请求签名覆盖的 metadata 到达。
      // 第一笔：明确要上次那款（显式 SKU）×50。委托随请求签名覆盖的
      // metadata 到达；报价正式发布后商家建立本店客户并索引已发报价。
      const rq1 = await call("kiwi_request_quotes", {
        intent: {
          intent_id: "k3-first",
          intent_type: "purchase",
          items: [{ query: "Test", sku: "sku-last-time", quantity: { value: 50, unit: "个" } }],
          constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 20000 } },
          context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items", "constraints"] },
        },
        merchant_ids: [merchantId],
        idempotency_key: "k3-first-key",
      });
      if (rq1.isError) console.error("rq1 error:", text(rq1).slice(0, 600));
      expect(rq1.isError).toBeUndefined();

      // 诊断：商家侧 state.sqlite 应有建档 + 委托 + 索引。
      const { DatabaseSync } = await import("node:sqlite");
      const merchantDb = new DatabaseSync(path.join(stack.merchantDir, "state.sqlite"));
      const diag = {
        subjects: merchantDb.prepare("SELECT COUNT(*) AS n FROM customer_subjects").get(),
        mappings: merchantDb.prepare("SELECT * FROM verified_customer_identities").all(),
        delegations: merchantDb.prepare("SELECT * FROM quote_history_delegations").all(),
        offers: merchantDb.prepare("SELECT negotiation_id, offer_id, sku, quantity FROM published_offers").all(),
        grants: merchantDb.prepare("SELECT purpose, status, subject_id FROM data_grants").all(),
      };
      console.error("K3 diag:", JSON.stringify(diag, null, 1));
      console.error(
        "K3 inbound actions:",
        JSON.stringify(capture.map((c) => ({ action: c.action, metadata: (c as unknown as { message?: { metadata?: unknown } }).message?.metadata }))),
      );
      merchantDb.close();

      // 第二笔任务（新任务、新 negotiation）：“上次那款，改 200 个”。
      const rq2 = await call("kiwi_request_quotes", {
        intent: {
          intent_id: "k3-second",
          intent_type: "purchase",
          items: [{ query: "Test", quantity: { value: 200, unit: "个" } }],
          constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 50000 } },
          context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items", "constraints"] },
        },
        merchant_ids: [merchantId],
        idempotency_key: "k3-second-key",
        reuse_history: true,
      });
      if (rq2.isError) {
        // 诊断输出：历史解析失败时打印工具错误（CI 可读）。
        console.error("rq2 error:", text(rq2));
      }
      expect(rq2.isError).toBeUndefined();
      const second = JSON.parse(text(rq2)) as {
        task_id: string;
        reused_history?: Record<string, unknown>;
      };
      expect(second.task_id).not.toBe((JSON.parse(text(rq1)) as { task_id: string }).task_id);
      // 历史价格参考（时间）随响应展示。
      expect(second.reused_history).toBeDefined();
      expect(second.reused_history?.["sku"]).toBe("sku-last-time");
      expect(second.reused_history?.["quantity"]).toBe(50);

      // 本次实际报价按 200 个计算（出站 SKU = 上次那款；出站数量 = 本次数量）。
      const task2 = JSON.parse(text(await call("kiwi_get_task", { task_id: second.task_id }))) as {
        task: {
          status: string;
          candidates: Array<{
            status: string;
            provenance?: { _quote_terms?: { items?: Array<{ sku?: string; quantity_value?: number }> } };
          }>;
        };
      };
      expect(task2.task.candidates.length).toBeGreaterThan(0);
      const candidate = task2.task.candidates[0]!;
      expect(candidate.status).toBe("succeeded");
      const terms = candidate.provenance?._quote_terms;
      expect(terms?.items?.[0]?.sku).toBe("sku-last-time");
      expect(terms?.items?.[0]?.quantity_value).toBe(200);
    } finally {
      await stack.stop();
    }
  });

  it("无授权/无历史 → clarification_needed 且不创建任务（A4/A6 边界）", async () => {
    const { buildBuyerService } = await import("../src/buyer-core/build-service.js");
    const { buildKiwiTools } = await import("../src/mcp/tools.js");
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "T", stock: 10, unit: "个", source_evidence: { system: "owned-test-fixture" } }),
      },
      quoteHistory: true,
      merchantId: "mkt-shop-a",
    });
    const protocolDir = mkdtempSync(path.join(tmpdir(), "k3-buyer-noauth-"));
    recoveryDirs.push(protocolDir);
    try {
      // 未配置 historyDelegation（旧客户端语义）。
      const service = buildBuyerService({
        dbPath: ":memory:",
        protocolStateDir: protocolDir,
        principal: "hermes:probe",
        buyerAgentId: "buyer-agent:hermes",
        sessionId: "e2e-revisit-noauth",
        policy: { ...DEFAULT_DELEGATION_POLICY, principal: "hermes:probe" },
        catalogUrl: stack.catalogUrl,
        a2aAllowPrivateRanges: true,
        a2aSkipDnsCheck: true,
        a2aTimeoutMs: 8000,
      });
      const tools = buildKiwiTools(service);
      const call = (name: string, args: Record<string, unknown>) =>
        tools.find((t) => t.name === name)!.handle(args);
      const search = JSON.parse(
        (await call("kiwi_search", { query: "Test" })).content?.[0]?.text ?? "{}",
      ) as { merchants: Array<{ merchant_id: string }> };
      const merchantId = search.merchants[0]!.merchant_id;
      const result = await call("kiwi_request_quotes", {
        intent: {
          intent_id: "k3-noauth",
          intent_type: "purchase",
          items: [{ query: "Test", quantity: { value: 1, unit: "个" } }],
          context_projection: { disclosure_boundary: "commerce_required", projected_fields: ["items"] },
        },
        merchant_ids: [merchantId],
        reuse_history: true,
      });
      const payloadText = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
      // 结构化澄清：不创建任务（无 task_id），reason 可读。
      expect(payloadText).toContain("clarification_needed");
      expect(payloadText).not.toContain("task_id");
    } finally {
      await stack.stop();
    }
  });
});
