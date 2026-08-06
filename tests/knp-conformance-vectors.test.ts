/**
 * Cross-implementation conformance vectors（binding rc1 §8 gate 4, D12）。
 *
 * 双向锚定：shopping-cli 的 Python KNP port（tests/test_knp_envelope.py）以
 * 本实现（dist/）生成的 digest 作为 golden vectors；本测试反向持有
 * shopping-cli 的期望值——同一组 envelope 字段在两边必须产出逐字节相同
 * 的 sha256 digest。任一实现偏离立即在另一仓的红灯中暴露。
 *
 * 向量字段与 shopping-cli tests/test_knp_envelope.py 完全一致（capability
 * 已冻结为 com.harrylabsj.kiwi.shopping.negotiation，binding rc1 §8 gate 1）。
 */
import { describe, expect, it } from "vitest";
import { computeEnvelopeDigest } from "../src/negotiation/domain/envelope.js";
import {
  CAPABILITY,
  EXCHANGE_ID,
  IN_REPLY_TO,
  MESSAGE_ID,
  NEGOTIATION_ID,
  OFFER_ID_1,
  OFFER_ID_2,
  QUANTITY,
  SKU,
  TIMESTAMP,
  validEnvelopeFields,
  validInquiry,
  validOffer,
} from "./negotiation-helpers.js";

// shopping-cli golden vectors（tests/test_knp_envelope.py，由本实现生成）。
const SHOPPING_CLI_GOLDEN_DIGESTS = {
  counter_offer:
    "sha256:87517fc5c7d13be7abba1e02349632e891aa1062da9339e90dd6249c0e985295",
  offer: "sha256:99dfb819f5668835005582cfb1db4992d5bd13fa9059e4b2298dda1c466b5742",
  inquiry: "sha256:a08539767c6fc46ddc8111fd0b1f320e85978dd164c4ed7bf592646305e91736",
  accept_nonbinding:
    "sha256:0231490ea2ff95b8d9a230f2dfb8901ade73f56f0e1f71921bed4157b89c69da",
};

const MONEY_83500 = { currency: "CNY", amount_minor: 83500 };

describe("Cross-implementation conformance vectors（rc1 §8 gate 4）", () => {
  it("counter_offer digest matches the shopping-cli golden vector", () => {
    expect(computeEnvelopeDigest(validEnvelopeFields())).toBe(
      SHOPPING_CLI_GOLDEN_DIGESTS.counter_offer,
    );
  });

  it("offer digest matches the shopping-cli golden vector", () => {
    const envelope = {
      capability: CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: EXCHANGE_ID,
      message_id: "msg_02H5V8KXZqJ7Qp3mN2B6A",
      in_reply_to: IN_REPLY_TO,
      actor: "merchant",
      action: "offer",
      created_at: TIMESTAMP,
      payload: validOffer(),
      public_message: "We offer CNY 850.00 per unit, delivery before 2026-08-20.",
    };
    expect(computeEnvelopeDigest(envelope)).toBe(SHOPPING_CLI_GOLDEN_DIGESTS.offer);
  });

  it("inquiry digest matches the shopping-cli golden vector", () => {
    const envelope = {
      capability: CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: EXCHANGE_ID,
      message_id: "msg_03H5V8KXZqJ7Qp3mN2B6A",
      actor: "buyer",
      action: "inquiry",
      created_at: TIMESTAMP,
      payload: validInquiry(),
    };
    expect(computeEnvelopeDigest(envelope)).toBe(SHOPPING_CLI_GOLDEN_DIGESTS.inquiry);
  });

  it("accept_nonbinding digest matches the shopping-cli golden vector", () => {
    const envelope = {
      capability: CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: EXCHANGE_ID,
      message_id: "msg_04H5V8KXZqJ7Qp3mN2B6A",
      in_reply_to: MESSAGE_ID,
      actor: "buyer",
      action: "accept_nonbinding",
      created_at: TIMESTAMP,
      payload: {
        type: "accept_nonbinding",
        offer_id: OFFER_ID_1,
        terms_digest:
          "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      },
    };
    expect(computeEnvelopeDigest(envelope)).toBe(
      SHOPPING_CLI_GOLDEN_DIGESTS.accept_nonbinding,
    );
  });

  it("counter_offer payload structure matches the shopping-cli vector byte-for-byte", () => {
    // Same canonical digest from two independently-written payload shapes
    // (helpers' validCounterOffer vs the shopping-cli dict) proves the JCS
    // key-order independence contract on both implementations.
    const envelope = {
      capability: CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: EXCHANGE_ID,
      message_id: MESSAGE_ID,
      in_reply_to: IN_REPLY_TO,
      actor: "buyer",
      action: "counter_offer",
      created_at: TIMESTAMP,
      payload: {
        type: "counter_offer",
        offer_id: OFFER_ID_2,
        responding_to_offer_id: OFFER_ID_1,
        proposed_terms: {
          items: [{ sku: SKU, quantity: QUANTITY, unit_price: MONEY_83500 }],
        },
      },
      public_message: "If we order 200 units, we propose CNY 835.00 per unit.",
    };
    expect(computeEnvelopeDigest(envelope)).toBe(SHOPPING_CLI_GOLDEN_DIGESTS.counter_offer);
  });
});
