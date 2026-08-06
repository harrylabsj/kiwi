/**
 * KNP/1.0 Negotiation Envelope tests（子规范 §8，§19.2）：
 *  - §8 示例 envelope 作为正例向量（digest 由 finalizeEnvelope 计算）；
 *  - digest：JCS+SHA-256，排除 digest 自身与 transport signature，键序无关；
 *  - fail-closed：unknown protocol_version / actor=system / 缺字段 /
 *    action-payload 类型不匹配 / clarification_response 缺 in_reply_to /
 *    digest 格式错误 / 摘要被篡改。
 */
import { describe, expect, it } from "vitest";
import { NegotiationValidationError } from "../src/negotiation/domain/common.js";
import {
  computeEnvelopeDigest,
  finalizeEnvelope,
  validateEnvelope,
  verifyEnvelopeDigest,
  type NegotiationEnvelope,
} from "../src/negotiation/domain/envelope.js";
import {
  CAPABILITY,
  EXCHANGE_ID,
  IN_REPLY_TO,
  MESSAGE_ID,
  NEGOTIATION_ID,
  OFFER_ID_2,
  validAgreement,
  validEnvelopeFields,
  validRfq,
} from "./negotiation-helpers.js";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof NegotiationValidationError ? e.code : "non-negotiation-error";
  }
}

describe("Envelope schema（§8）", () => {
  it("accepts the sub-spec envelope example", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(validateEnvelope(envelope)).toEqual(envelope);
  });

  it("round-trips a signed envelope and verifies its digest", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(envelope.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyEnvelopeDigest(envelope)).toBe(true);
  });

  it("exposes the negotiated capability and ids", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(validateEnvelope(envelope)).toMatchObject({
      capability: CAPABILITY,
      negotiation_id: NEGOTIATION_ID,
      exchange_id: EXCHANGE_ID,
      message_id: MESSAGE_ID,
      in_reply_to: IN_REPLY_TO,
    });
  });
});

describe("Envelope digest（§19.2）", () => {
  it("is stable across object key order", () => {
    const fields = validEnvelopeFields();
    const scrambled = {
      payload: fields.payload,
      action: fields.action,
      public_message: fields.public_message,
      actor: fields.actor,
      created_at: fields.created_at,
      message_id: fields.message_id,
      negotiation_id: fields.negotiation_id,
      exchange_id: fields.exchange_id,
      in_reply_to: fields.in_reply_to,
      protocol_version: fields.protocol_version,
      capability: fields.capability,
    };
    expect(computeEnvelopeDigest(fields)).toBe(computeEnvelopeDigest(scrambled));
  });

  it("excludes digest itself and transport signature fields", () => {
    const fields = validEnvelopeFields();
    const base = computeEnvelopeDigest(fields);
    const withSignature = computeEnvelopeDigest({
      ...fields,
      signature: { alg: "hmac-sha256", value: "0000" },
      http_message_signature: "sig1",
    });
    expect(withSignature).toBe(base);

    const envelope = finalizeEnvelope(fields);
    expect(
      verifyEnvelopeDigest({
        ...envelope,
        signature: { alg: "hmac-sha256", value: "0000" },
      } as unknown as NegotiationEnvelope),
    ).toBe(true);
  });

  it("changes when any bound field changes", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const tamperedPayload = finalizeEnvelope({ ...validEnvelopeFields(), payload: validRfq() });
    const tamperedMessage = finalizeEnvelope({ ...validEnvelopeFields(), message_id: "msg_09..." });
    expect(tamperedPayload.digest).not.toBe(envelope.digest);
    expect(tamperedMessage.digest).not.toBe(envelope.digest);
  });

  it("detects a tampered digest after signing", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(verifyEnvelopeDigest({ ...envelope, payload: validRfq() })).toBe(false);
    expect(verifyEnvelopeDigest({ ...envelope, actor: "merchant" })).toBe(false);
  });
});

describe("Envelope fail-closed", () => {
  it("rejects an unknown protocol_version with protocol_version_unsupported", () => {
    const fields = validEnvelopeFields();
    expect(errorCode(() => validateEnvelope({ ...fields, protocol_version: "2.0" }))).toBe(
      "protocol_version_unsupported",
    );
    expect(errorCode(() => validateEnvelope({ ...fields, protocol_version: "banana" }))).toBe(
      "protocol_version_unsupported",
    );
  });

  it("rejects actor=system (only buyer|merchant)", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(errorCode(() => validateEnvelope({ ...envelope, actor: "system" }))).toBe(
      "schema_invalid",
    );
  });

  it("rejects missing required envelope fields", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const { negotiation_id: _dropped, ...withoutNegotiation } = envelope;
    expect(errorCode(() => validateEnvelope(withoutNegotiation))).toBe("schema_invalid");
    expect(errorCode(() => validateEnvelope({ ...envelope, digest: undefined }))).toBe(
      "schema_invalid",
    );
  });

  it("rejects an action outside the KNP vocabulary", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(errorCode(() => validateEnvelope({ ...envelope, action: "purchase" }))).toBe(
      "schema_invalid",
    );
  });

  it("rejects a non-RFC3339 created_at", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(
      errorCode(() => validateEnvelope({ ...envelope, created_at: "2026-08-05 12:00:00" })),
    ).toBe("schema_invalid");
  });

  it("rejects an action/payload type mismatch", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(
      errorCode(() => validateEnvelope({ ...envelope, action: "offer", payload: validRfq() })),
    ).toBe("schema_invalid");
  });

  it("rejects a clarification_response without in_reply_to", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const { in_reply_to: _dropped, ...noReplyTo } = envelope;
    expect(
      errorCode(() =>
        validateEnvelope({
          ...noReplyTo,
          action: "clarification_response",
          payload: { type: "clarification_response", answer: "delivery_before = 2026-08-20" },
        }),
      ),
    ).toBe("schema_invalid");
  });

  it("accepts a clarification_response that references the clarification", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(
      validateEnvelope({
        ...envelope,
        action: "clarification_response",
        payload: { type: "clarification_response", answer: "delivery_before = 2026-08-20" },
      }),
    ).toMatchObject({ action: "clarification_response" });
  });

  it("rejects a malformed digest string", () => {
    const envelope = finalizeEnvelope(validEnvelopeFields());
    expect(errorCode(() => validateEnvelope({ ...envelope, digest: "sha256:zzzz" }))).toBe(
      "schema_invalid",
    );
    expect(errorCode(() => validateEnvelope({ ...envelope, digest: "md5:abc" }))).toBe(
      "schema_invalid",
    );
  });

  it("rejects a float amount inside an offer payload", () => {
    const fields = validEnvelopeFields();
    const offer = validEnvelopeFields().payload;
    const floatTerms = {
      ...offer,
      proposed_terms: {
        items: [
          {
            sku: "SKU-001",
            quantity: { value: 200, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 83.5 },
          },
        ],
      },
    };
    expect(errorCode(() => validateEnvelope({ ...fields, payload: floatTerms }))).toBe(
      "schema_invalid",
    );
  });

  it("rejects the agreement artifact as an envelope action (it is an artifact, not an action)", () => {
    const fields = validEnvelopeFields();
    const envelope = finalizeEnvelope(fields);
    expect(
      errorCode(() =>
        validateEnvelope({
          ...envelope,
          action: "accepted_nonbinding_agreement",
          payload: validAgreement(),
        }),
      ),
    ).toBe("schema_invalid");
  });
});

describe("finalizeEnvelope / computeEnvelopeDigest", () => {
  it("produces a deterministic digest for the same content", () => {
    const a = finalizeEnvelope(validEnvelopeFields());
    const b = finalizeEnvelope(validEnvelopeFields());
    expect(a.digest).toBe(b.digest);
  });

  it("includes the payload in the digest (payload is protocol truth)", () => {
    const fields = validEnvelopeFields();
    const offerDigest = finalizeEnvelope({
      ...fields,
      action: "offer",
      payload: {
        type: "offer",
        offer_id: OFFER_ID_2,
        terms: {
          items: [
            {
              sku: "SKU-001",
              quantity: { value: 200, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 85000 },
            },
          ],
        },
      },
    });
    expect(verifyEnvelopeDigest(offerDigest)).toBe(true);
  });
});
