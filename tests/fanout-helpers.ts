/**
 * fan-out 测试 fixture：CounterpartyProfile / RfqIntent / 披露 payload / Offer
 * envelope 构造器。profile 形状对齐基线 §26 Agent Card + §33 channel candidates。
 */

import type { CounterpartyProfile } from "../src/counterparty/index.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { buildDisclosedRfq } from "../src/fanout/index.js";
import type {
  DisclosedRfqPayload,
  DisclosureAttribute,
  DisclosureTier,
  RfqIntent,
} from "../src/fanout/index.js";

/** 最小 CounterpartyProfile（direct 通道候选）。 */
export function profile(identity: string): CounterpartyProfile {
  return {
    identity,
    source: `card:https://${identity}/a2a/agent-card.json`,
    agent_card: {
      name: identity,
      description: `${identity} agent card`,
      provider: { organization: identity, url: `https://${identity}` },
      version: "1.0",
      supportedInterfaces: [
        { url: `https://${identity}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
    },
    intersection: {
      compatible: true,
      candidates: [
        { url: `https://${identity}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      incompatible: [],
      unknownShared: [],
      oneSided: [],
    },
    channel_candidates: [{ kind: "a2a-direct", url: `https://${identity}/a2a` }],
  };
}

/** 带私有字段的 RFQ 意图（§4.4 默认 private：预算 / 急迫度 / 身份 / 联系方式）。 */
export function intent(overrides: Partial<RfqIntent> = {}): RfqIntent {
  return {
    items: [{ sku: "SKU-001", quantity: 42, quantity_range: { min: 10, max: 50 }, unit: "piece" }],
    delivery_before: "2026-08-20T18:00:00Z",
    budget: { currency: "CNY", amount_minor: 50000 },
    urgency: "high",
    contact: { organization: "Acme Buying", email: "buyer@acme.example", phone: "+8613800000000" },
    location_precision: "district",
    customer_segment: "enterprise",
    preferences: ["priority-delivery"],
    category: "office-supplies",
    ...overrides,
  };
}

/** 按档位构造披露 payload（默认允许 purchase_quantity）。 */
export function disclosurePayload(
  tier: DisclosureTier,
  allowed: readonly DisclosureAttribute[] = ["purchase_quantity"],
): DisclosedRfqPayload {
  return buildDisclosedRfq({ intent: intent(), tier, allowed_attributes: allowed });
}

/** Offer envelope（actor=merchant；message_id 与出站 RFQ 不同，模拟远端回复）。 */
export function offerEnvelope(
  negotiationId: string,
  priceMinor: number,
  overrides: {
    currency?: string;
    delivery_before?: string;
    offer_id?: string;
    /** 省略 unit_price（用于无价格行的比较集排序测试）。 */
    omitUnitPrice?: boolean;
  } = {},
): NegotiationEnvelope {
  const {
    currency = "CNY",
    delivery_before = "2026-08-18T00:00:00Z",
    offer_id,
    omitUnitPrice,
  } = overrides;
  const items: Array<{
    sku: string;
    quantity: { value: number; unit: string };
    unit_price?: { currency: string; amount_minor: number };
  }> = [{ sku: "SKU-001", quantity: { value: 50, unit: "piece" } }];
  if (omitUnitPrice !== true) {
    items[0]!.unit_price = { currency, amount_minor: priceMinor };
  }
  return finalizeEnvelope({
    capability: "knp.a2a.direct",
    protocol_version: "1.0",
    negotiation_id: negotiationId,
    exchange_id: `ex-offer-${negotiationId}`,
    message_id: `msg-offer-${negotiationId}`,
    actor: "merchant",
    action: "offer",
    created_at: "2026-08-06T00:00:01Z",
    payload: {
      type: "offer",
      offer_id: offer_id ?? `off-${negotiationId}`,
      terms: {
        items,
        fulfillment_terms: { delivery_before },
        valid_until: "2026-08-07T00:00:00Z",
      },
    },
  });
}
