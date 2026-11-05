import { describe, expect, it } from "vitest";
import { buildRfqEnvelope } from "../src/buyer-core/a2a-knp.js";

describe("RFQ public_message", () => {
  it("carries a merchant-visible test marker on the outbound envelope", () => {
    const envelope = buildRfqEnvelope({
      negotiationId: "neg-test-marker",
      sku: "10225485016481",
      quantity: { value: 2, unit: "box" },
      publicMessage: "【测试，请勿履约】linkluck 验收询价，不下单/不付款/不锁库存",
      now: () => "2026-11-05T00:00:00.000Z",
    });
    expect(envelope.action).toBe("rfq");
    expect(envelope.public_message).toBe("【测试，请勿履约】linkluck 验收询价，不下单/不付款/不锁库存");
    expect(envelope.payload).toMatchObject({ type: "rfq", items: [{ sku: "10225485016481", quantity: { value: 2, unit: "box" } }] });
  });

  it("omits public_message when no marker is supplied", () => {
    const envelope = buildRfqEnvelope({ negotiationId: "neg-no-marker", sku: "s", quantity: { value: 1 }, now: () => "2026-11-05T00:00:00.000Z" });
    expect(envelope.public_message).toBeUndefined();
  });
});
