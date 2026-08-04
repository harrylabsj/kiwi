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
    runtime_version: "0.1.0",
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
    runtime_version: "0.1.0",
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
