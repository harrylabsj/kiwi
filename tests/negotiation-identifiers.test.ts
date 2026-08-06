/**
 * KNP/1.0 Identifier 模型 tests（子规范 §6，基线 §9）：
 *  - 生成器产出 `<前缀>_<uuidv7>`，按时间可排序、碰撞抵抗；
 *  - 校验器对 opaque identifier 做非空/空白/控制字符/长度约束；
 *  - TargetRef 扁平引用 + checkTargetRefAgreement 的 state_conflict 语义。
 */
import { describe, expect, it } from "vitest";
import { NegotiationValidationError } from "../src/negotiation/domain/common.js";
import {
  checkTargetRefAgreement,
  generateId,
  newAgreementId,
  newExchangeId,
  newMessageId,
  newNegotiationId,
  newOfferId,
  uuidv7,
  validateContextId,
  validateIdentifier,
  validateTargetRef,
  validateTaskId,
  type TargetRef,
} from "../src/negotiation/domain/identifiers.js";

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("identifier generators", () => {
  it("produce prefixed uuidv7 values", () => {
    expect(newNegotiationId()).toMatch(/^neg_/);
    expect(newExchangeId()).toMatch(/^ex_/);
    expect(newMessageId()).toMatch(/^msg_/);
    expect(newOfferId()).toMatch(/^off_/);
    expect(newAgreementId()).toMatch(/^agr_/);
  });

  it("uuidv7 carries version 7 and variant bits and is sortable", () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).toMatch(UUIDV7);
    // 48 位毫秒时间戳在前，连续生成应单调不减（同毫秒则靠随机尾）。
    expect(a <= b).toBe(true);
  });

  it("generateId scopes the prefix per kind", () => {
    expect(generateId("negotiation")).toMatch(/^neg_/);
    expect(generateId("message")).toMatch(/^msg_/);
  });

  it("never collides across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newMessageId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("validateIdentifier", () => {
  it("accepts prefixed, plain UUID, and sub-spec placeholder ids", () => {
    expect(validateIdentifier(newNegotiationId(), "/negotiation_id")).toBeTruthy();
    expect(validateIdentifier("neg_01...", "/negotiation_id")).toBe("neg_01...");
    expect(validateIdentifier("550e8400-e29b-41d4-a716-446655440000", "/message_id")).toBeTruthy();
  });

  it("rejects empty, whitespace-only, and surrounding-whitespace ids", () => {
    expect(() => validateIdentifier("", "/negotiation_id")).toThrow(/non-empty/);
    expect(() => validateIdentifier("   ", "/negotiation_id")).toThrow(/whitespace/);
    expect(() => validateIdentifier(" neg_01", "/negotiation_id")).toThrow(/whitespace/);
    expect(() => validateIdentifier("neg_01 ", "/negotiation_id")).toThrow(/whitespace/);
  });

  it("rejects control characters and over-long ids", () => {
    expect(() => validateIdentifier(`neg_01${String.fromCharCode(1)}`, "/negotiation_id")).toThrow(
      /control/,
    );
    expect(() => validateIdentifier("x".repeat(257), "/negotiation_id")).toThrow(/256/);
  });

  it("rejects non-strings", () => {
    expect(() => validateIdentifier(42, "/negotiation_id")).toThrow(/string/);
    expect(() => validateIdentifier(undefined, "/negotiation_id")).toThrow(/string/);
  });
});

describe("A2A contextId / taskId", () => {
  it("are opaque non-empty strings", () => {
    expect(validateContextId("ctx_01", "/contextId")).toBe("ctx_01");
    expect(validateTaskId("task_01", "/taskId")).toBe("task_01");
  });

  it("reject empty values (fail closed)", () => {
    expect(() => validateContextId("", "/contextId")).toThrow(NegotiationValidationError);
    expect(() => validateTaskId(undefined, "/taskId")).toThrow(NegotiationValidationError);
  });
});

describe("TargetRef", () => {
  it("requires target_message_id and allows an optional target_offer_id", () => {
    expect(validateTargetRef({ target_message_id: "msg_01" }, "/")).toEqual({
      target_message_id: "msg_01",
    });
    expect(
      validateTargetRef({ target_message_id: "msg_01", target_offer_id: "off_01" }, "/"),
    ).toEqual({ target_message_id: "msg_01", target_offer_id: "off_01" });
  });

  it("rejects a missing target_message_id", () => {
    expect(() => validateTargetRef({}, "/")).toThrow(NegotiationValidationError);
    expect(() => validateTargetRef({ target_offer_id: "off_01" }, "/")).toThrow(
      NegotiationValidationError,
    );
  });
});

describe("checkTargetRefAgreement", () => {
  const ledger: TargetRef = { target_message_id: "msg_03", target_offer_id: "off_03" };
  const resolver = {
    resolveMessageOffer: (id: string): string | null => (id === "msg_03" ? "off_03" : null),
    resolveOfferMessage: (id: string): string | null => (id === "off_03" ? "msg_03" : null),
  };

  it("accepts a consistent reference", () => {
    expect(() => checkTargetRefAgreement(ledger, resolver)).not.toThrow();
  });

  it("throws state_conflict when message and offer resolve to different objects", () => {
    let error: NegotiationValidationError | undefined;
    try {
      checkTargetRefAgreement({ target_message_id: "msg_03", target_offer_id: "off_99" }, resolver);
    } catch (e) {
      error = e as NegotiationValidationError;
    }
    expect(error?.code).toBe("state_conflict");

    try {
      checkTargetRefAgreement({ target_message_id: "msg_07", target_offer_id: "off_03" }, resolver);
    } catch (e) {
      error = e as NegotiationValidationError;
    }
    expect(error?.code).toBe("state_conflict");
  });

  it("is a no-op when target_offer_id is absent", () => {
    expect(() => checkTargetRefAgreement({ target_message_id: "msg_03" }, resolver)).not.toThrow();
  });
});
