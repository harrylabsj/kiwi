import type { AgentProfile, BuyerPolicy } from "../src/config/profile.js";
import {
  createFakeMarketplace,
  FakeCommerceClient,
  type FakeMarketplaceConfig,
  type FakeProduct,
} from "../src/commerce/fake-client.js";
import {
  fauxAssistantMessage,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { PROTOCOL_VERSION, type NegotiationDecision } from "../src/negotiation/types.js";

export const MERCHANT_ID = "merchant-001";
export const BUYER_ID = "buyer-001";
export const CONVERSATION_ID = `conv-${MERCHANT_ID}`;
export const NOW = "2026-08-03T15:00:00+08:00";

export function testProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    runtime_version: "0.5.0",
    protocol_version: PROTOCOL_VERSION,
    agent_id: "merchant-agent:merchant-001",
    role: "merchant",
    owner_id: MERCHANT_ID,
    commerce: {
      base_url: "http://127.0.0.1:8765",
      token_env: "SHOPPING_AGENT_TOKEN",
      backend: "local_marketplace",
    },
    model: { provider: "fake", model: "fake-merchant-model" },
    runtime: {
      mode: "once",
      poll_interval_seconds: 5,
      turn_timeout_seconds: 30,
      max_model_steps: 4,
      max_retries: 2,
    },
    merchant_policy: { min_unit_price_private: 80, quote_ttl_seconds: 300 },
    ...overrides,
  };
}

/** Test config overrides; `product` merges field-by-field over the defaults. */
export type TestClientOverrides = Omit<Partial<FakeMarketplaceConfig>, "product"> & {
  product?: Partial<FakeProduct>;
};

export function testClientConfig(overrides: TestClientOverrides = {}): FakeMarketplaceConfig {
  const { product, ...rest } = overrides;
  return {
    merchant_id: MERCHANT_ID,
    buyer_id: "buyer-001",
    now: NOW,
    buyer_message_text: "买 2 件可以便宜一点吗？",
    product: {
      sku: "sku-001",
      title: "手写陶瓷杯",
      currency: "CNY",
      list_price: 99,
      stock_quantity: 12,
      floor_price: 80,
      delivery: {
        eta_start: "2026-08-04T14:00:00+08:00",
        eta_end: "2026-08-04T18:00:00+08:00",
        fee: 0,
        notes: "市区当日达",
      },
      policies: [{ ref: "policy:return-7d", summary: "签收后 7 天内无理由退货。" }],
      ...product,
    },
    ...rest,
  };
}

export function testClient(overrides: TestClientOverrides = {}): FakeCommerceClient {
  return new FakeCommerceClient(testClientConfig(overrides));
}

/** One shared fake marketplace with both role clients bound to it. */
export function testMarketplace(overrides: TestClientOverrides = {}): {
  merchant: FakeCommerceClient;
  buyer: FakeCommerceClient;
} {
  const { merchant, buyer } = createFakeMarketplace(testClientConfig(overrides));
  return { merchant, buyer };
}

export function testBuyerPolicy(overrides: Partial<BuyerPolicy> = {}): BuyerPolicy {
  return {
    target_skus: ["sku-001"],
    quantity: 2,
    max_total_price_private: 200,
    // Durable far-future deadline: tests never expire.
    acceptable_eta_latest: "2099-12-31T23:59:59+08:00",
    required_after_sales_terms: ["policy:return-7d"],
    auto_negotiate: true,
    human_review_on: ["budget_exceeded", "ambiguous_after_sales"],
    ...overrides,
  };
}

export function testBuyerProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    runtime_version: "0.5.0",
    protocol_version: PROTOCOL_VERSION,
    agent_id: "buyer-agent:buyer-001",
    role: "buyer",
    owner_id: BUYER_ID,
    commerce: {
      base_url: "http://127.0.0.1:8765",
      token_env: "SHOPPING_BUYER_TOKEN",
      backend: "local_marketplace",
    },
    model: { provider: "fake", model: "fake-buyer-model" },
    runtime: {
      mode: "once",
      poll_interval_seconds: 5,
      turn_timeout_seconds: 30,
      max_model_steps: 4,
      max_retries: 2,
    },
    buyer_policy: testBuyerPolicy(),
    ...overrides,
  };
}

/** A buyer accept_nonbinding decision replying to the merchant counter (message 2). */
export function buyerAcceptDecision(overrides: Record<string, unknown> = {}): NegotiationDecision {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: CONVERSATION_ID,
    in_reply_to_message_id: 2,
    action: "accept_nonbinding",
    proposal: {
      sku: "sku-001",
      quantity: 2,
      unit_price: 89,
      currency: "CNY",
      stock: { status: "available", quantity: 12, observed_at: NOW, reserved: false },
      delivery: {
        eta_start: "2026-08-04T14:00:00+08:00",
        eta_end: "2026-08-04T18:00:00+08:00",
        fee: 0,
      },
      after_sales_policy_refs: ["policy:return-7d"],
      valid_until: "2026-08-03T15:05:00+08:00",
    },
    open_issues: [],
    public_message: "接受该报价，达成非约束性共识。",
    confidence: 0.9,
    reason_codes: ["within_policy"],
    request_human_review: false,
    ...overrides,
  } as NegotiationDecision;
}

/** A schema-valid counter decision against the default test marketplace. */
export function validDecision(overrides: Record<string, unknown> = {}): NegotiationDecision {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: CONVERSATION_ID,
    in_reply_to_message_id: 1,
    action: "counter",
    proposal: {
      sku: "sku-001",
      quantity: 2,
      unit_price: 89,
      currency: "CNY",
      stock: { status: "available", quantity: 12, observed_at: NOW, reserved: false },
      delivery: {
        eta_start: "2026-08-04T14:00:00+08:00",
        eta_end: "2026-08-04T18:00:00+08:00",
        fee: 0,
      },
      after_sales_policy_refs: ["policy:return-7d"],
      valid_until: "2026-08-03T15:05:00+08:00",
    },
    open_issues: [],
    public_message: "买 2 件的话，单价 89 元，明天下午送达。",
    confidence: 0.9,
    reason_codes: ["within_policy", "inventory_observed"],
    request_human_review: false,
    ...overrides,
  } as NegotiationDecision;
}

/** A stream that stays silent until the agent aborts it (deterministic, no sleep). */
export function hangingStreamFn(): StreamFn {
  return (_model, _context, options) => {
    const queue: AssistantMessageEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    const finalMessage = new Promise<AssistantMessage>((resolve) => {
      const onAbort = (): void => {
        const msg = fauxAssistantMessage("aborted", {
          stopReason: "aborted",
          errorMessage: "turn timeout",
        });
        queue.push({ type: "error", reason: "aborted", error: msg });
        done = true;
        notify?.();
        resolve(msg);
      };
      if (options?.signal?.aborted === true) {
        onAbort();
      } else {
        options?.signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
    const stream = {
      async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
        let i = 0;
        for (;;) {
          const event = queue[i];
          if (event !== undefined) {
            i += 1;
            yield event;
            continue;
          }
          if (done) return;
          await new Promise<void>((r) => {
            notify = r;
          });
        }
      },
      result: (): Promise<AssistantMessage> => finalMessage,
    };
    return stream as unknown as ReturnType<StreamFn>;
  };
}

/** 入站 KNP 信封快照（测试断言商家收到的 RFQ/CounterOffer 内容用）。 */
export interface CapturedInbound {
  action: string;
  senderIdentity: string;
  envelope: Record<string, unknown>;
}

/**
 * 本地 A2A 磋商测试栈（完全离线、确定性，零 marketplace）：
 * - 生产版 merchant handler（createMerchantHandler；可接 productSource 桩——
 *   商家从"商品库"按 SKU 报价，模拟真实商品层）挂临时 A2AServer；
 * - 可选 `capture` 数组：包装 handler 记录每次入站 envelope（断言买家参数穿入用）；
 * - 两路由 catalog stub（/v1/agent-catalog/agents/search + /agents/{id}），
 *   候选的 agent_card_url 指向 merchant 的 Agent Card。
 */
export async function startTestA2aStack(
  options: {
    productSource?: {
      getProduct(
        sku: string,
      ): Promise<{ price: number; currency: string; title?: string; stock?: number }>;
    };
    catalogAgentId?: string;
    /** 传入数组后，每次入站信封（action/senderIdentity/envelope）被 push 进来。 */
    capture?: CapturedInbound[];
  } = {},
): Promise<{
  catalogUrl: string;
  merchantUrl: string;
  merchantDir: string;
  stop: () => Promise<void>;
}> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");
  const { A2AServer } = await import("../src/a2a/server/index.js");
  const { createMerchantHandler } = await import("../src/a2a/server/merchant-handler.js");
  const { LedgerStore } = await import("../src/negotiation/ledger/index.js");
  const { IdempotencyStore } = await import("../src/negotiation/idempotency/index.js");

  const merchantDir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-stack-"));
  const ledger = new LedgerStore({ dir: merchantDir, now: () => NOW });
  const idempotency = new IdempotencyStore({ dir: merchantDir, now: () => NOW });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const inner = createMerchantHandler({
    ledger,
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    ...(options.productSource !== undefined ? { productSource: options.productSource } : {}),
  });
  const handler = options.capture !== undefined
    ? {
        name: inner.name,
        handle: async (ctx: {
          envelope: { action?: string };
          senderIdentity: string;
        }) => {
          options.capture?.push({
            action: String(ctx.envelope.action ?? ""),
            senderIdentity: ctx.senderIdentity,
            envelope: ctx.envelope as unknown as Record<string, unknown>,
          });
          return inner.handle(ctx as never);
        },
      }
    : inner;
  const server = new A2AServer({
    card: () => ({
      name: "Test Merchant",
      description: "a2a stack merchant",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
    }),
    ledger,
    idempotency,
    handler,
    now: () => NOW,
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address() as { port: number };
  holder.baseUrl = `http://127.0.0.1:${addr.port}`;

  const catalogAgentId = options.catalogAgentId ?? "cagt_test_merchant_001";
  const candidate = {
    catalog_agent_id: catalogAgentId,
    merchant: { id: "merchant-001", name: "Test Merchant", domain: "test.example" },
    discovery: { agent_card_url: `${holder.baseUrl}/.well-known/agent-card.json` },
    protocols: { a2a: ["1.0.0"] },
    capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
    verification: { status: "discovered", last_verified_at: NOW },
    hosting: { mode: "direct_only" },
    contract: { name: "candidate-agent", version: "1.0" },
  };
  // Kiwi 形状 agent record（agent-record.schema.json；KiwiCatalogSource 消费）
  const agentRecord = {
    catalog_agent_id: catalogAgentId,
    principal_type: "merchant",
    merchant_id: "merchant-001",
    display_name: "Test Merchant",
    canonical_domain: "test.example",
    agent_card_url: `${holder.baseUrl}/.well-known/agent-card.json`,
    hosting_mode: "direct_only",
    verification_level: "commerce_verified",
    freshness_state: "fresh",
    administrative_state: "active",
    created_at: NOW,
    updated_at: NOW,
  };
  // listing stub（/v1/listings/search + /{id}；authority/requires_direct_confirmation 恒值
  // 必须与 listing-search-result.schema.json 一致——测试内过 validateListingSearchResult）
  const listingSearchResult = {
    listing: {
      listing_id: "lst_test_001",
      listing_type: "product",
      owner_agent_id: catalogAgentId,
      merchant_id: "merchant-001",
      source_product_ref: "sku-001",
      title: "Test Product Sku-001",
      category: "test-category",
      listing_digest: "test-digest",
      publication_state: "ACTIVE",
      listing_freshness_state: "FRESH",
      published_at: NOW,
      updated_at: NOW,
      fresh_until: "2099-01-01T00:00:00Z",
      commercial_hints: { moq: 50, supports_bulk_quote: true },
    },
    merchant: { merchant_id: "merchant-001", display_name: "Test Merchant" },
    agent: {
      catalog_agent_id: catalogAgentId,
      verification_level: "commerce_verified",
      freshness_state: "fresh",
      administrative_state: "active",
    },
    listing_freshness_state: "FRESH",
    authority: "discovery_projection",
    requires_direct_confirmation: true,
  };
  const catalog = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "";
    if (url.includes("/v1/agent-catalog/agents/search")) {
      res.end(JSON.stringify({ results: [candidate] }));
      return;
    }
    if (url.includes("/v1/agent-catalog/agents/")) {
      res.end(JSON.stringify({ catalog_agent: candidate }));
      return;
    }
    if (url.includes("/v1/listings/search")) {
      res.end(JSON.stringify({ results: [listingSearchResult], next_cursor: "" }));
      return;
    }
    if (url.includes("/v1/listings/")) {
      res.end(JSON.stringify({ listing: listingSearchResult.listing }));
      return;
    }
    if (url.includes("/v1/agents/search")) {
      res.end(JSON.stringify({ results: [agentRecord], next_cursor: "" }));
      return;
    }
    if (url.includes("/v1/agents/")) {
      res.end(JSON.stringify({ agent: agentRecord }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => catalog.listen(0, "127.0.0.1", () => resolve()));
  const catalogAddr = catalog.address() as { port: number };
  const catalogUrl = `http://127.0.0.1:${catalogAddr.port}`;

  return {
    catalogUrl,
    merchantUrl: holder.baseUrl,
    merchantDir,
    stop: async () => {
      await new Promise<void>((resolve) => catalog.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
