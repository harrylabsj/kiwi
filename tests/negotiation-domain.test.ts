/**
 * KNP/1.0 九类核心对象 tests（子规范 §9–§17）：
 *  - 子规范每个 JSON 示例作为正例向量（`...` 占位符替换为具体值）；
 *  - 反例（缺字段 / float 金额 / Agreement 副作用 flag / TargetRef 不一致 /
 *    Condition field 越界 / 嵌套过深）必须被拒绝，并给出对应 error code。
 */
import { describe, expect, it } from "vitest";
import {
  NegotiationValidationError,
  validateMoney,
  validateQuantity,
} from "../src/negotiation/domain/common.js";
import {
  CONDITION_FIELDS,
  KNP_ACTIONS,
  validateAcceptNonbinding,
  validateAcceptedNonbindingAgreement,
  validateClarification,
  validateConditionalOffer,
  validateCounterOffer,
  validateDecline,
  validateInquiry,
  validateOffer,
  validatePayloadForAction,
  validateRfq,
  validateWithdraw,
  type NegotiationPayload,
} from "../src/negotiation/domain/objects.js";
import {
  MONEY_83500,
  QUANTITY,
  validAcceptNonbinding,
  validAgreement,
  validClarification,
  validConditionalOffer,
  validCounterOffer,
  validDecline,
  validEnvelopeFields,
  validInquiry,
  validOffer,
  validRfq,
  validWithdraw,
} from "./negotiation-helpers.js";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof NegotiationValidationError ? e.code : "non-negotiation-error";
  }
}

describe("Money / Quantity（§7.1 / §7.2）", () => {
  it("accepts the sub-spec examples", () => {
    expect(validateMoney({ currency: "CNY", amount_minor: 83500 }, "/money")).toEqual(MONEY_83500);
    expect(validateQuantity(QUANTITY, "/quantity")).toEqual(QUANTITY);
  });

  it("rejects float amounts (no float money)", () => {
    expect(errorCode(() => validateMoney({ currency: "CNY", amount_minor: 83.5 }, "/money"))).toBe(
      "schema_invalid",
    );
    expect(() => validateMoney({ currency: "CNY", amount_minor: 83.5 }, "/money")).toThrow(
      /integer/,
    );
  });

  it("rejects non-uppercase or non-3-letter currency codes", () => {
    expect(() => validateMoney({ currency: "cny", amount_minor: 1 }, "/money")).toThrow(
      /uppercase/,
    );
    expect(() => validateMoney({ currency: "CN", amount_minor: 1 }, "/money")).toThrow(/uppercase/);
  });

  it("rejects non-positive quantity", () => {
    expect(() => validateQuantity({ value: 0, unit: "piece" }, "/quantity")).toThrow(/positive/);
    expect(() => validateQuantity({ value: -2, unit: "piece" }, "/quantity")).toThrow(/positive/);
  });
});

describe("Inquiry（§9）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateInquiry(validInquiry())).toEqual(validInquiry());
  });

  it("rejects a wrong type discriminant", () => {
    expect(errorCode(() => validateInquiry({ ...validInquiry(), type: "rfq" }))).toBe(
      "schema_invalid",
    );
  });
});

describe("RFQ（§10）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateRfq(validRfq())).toEqual(validRfq());
  });

  it("rejects missing or empty items", () => {
    expect(errorCode(() => validateRfq({ type: "rfq", items: [] }))).toBe("schema_invalid");
    expect(errorCode(() => validateRfq({ type: "rfq" }))).toBe("schema_invalid");
  });
});

describe("Offer（§11）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateOffer(validOffer())).toEqual(validOffer());
  });

  it("rejects an offer item without unit_price", () => {
    const offer = validOffer();
    const item = offer.terms.items?.[0];
    if (item === undefined) throw new Error("fixture offer must carry an item");
    const { unit_price: _dropped, ...itemWithoutPrice } = item;
    expect(
      errorCode(() =>
        validateOffer({ ...offer, terms: { ...offer.terms, items: [itemWithoutPrice] } }),
      ),
    ).toBe("schema_invalid");
  });

  it("rejects a missing offer_id", () => {
    expect(errorCode(() => validateOffer({ type: "offer", terms: validOffer().terms }))).toBe(
      "schema_invalid",
    );
  });
});

describe("CounterOffer（§12）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateCounterOffer(validCounterOffer())).toEqual(validCounterOffer());
  });

  it("rejects a missing responding_to_offer_id", () => {
    const counter = validCounterOffer();
    const { responding_to_offer_id: _dropped, ...rest } = counter;
    expect(errorCode(() => validateCounterOffer(rest))).toBe("schema_invalid");
  });
});

describe("ConditionalOffer（§13）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateConditionalOffer(validConditionalOffer())).toEqual(validConditionalOffer());
  });

  it("rejects an unsupported condition field with field_unsupported", () => {
    const conditional = validConditionalOffer();
    const [rule] = conditional.conditions;
    const bad = {
      ...conditional,
      conditions: [
        {
          when: { all: [{ field: "inventory.private_stock", op: "gte", value: 1 }] },
          then_terms: rule!.then_terms,
        },
      ],
    };
    expect(errorCode(() => validateConditionalOffer(bad))).toBe("field_unsupported");
  });

  it("rejects an unsupported comparison operator", () => {
    const conditional = validConditionalOffer();
    const [rule] = conditional.conditions;
    const bad = {
      ...conditional,
      conditions: [
        {
          when: { all: [{ field: "aggregate.total_quantity", op: "regex", value: 500 }] },
          then_terms: rule!.then_terms,
        },
      ],
    };
    expect(errorCode(() => validateConditionalOffer(bad))).toBe("schema_invalid");
  });

  it("rejects nesting deeper than 2 below the root", () => {
    const conditional = validConditionalOffer();
    const [rule] = conditional.conditions;
    const bad = {
      ...conditional,
      conditions: [
        {
          when: {
            all: [
              {
                any: [{ all: [{ field: "aggregate.total_quantity", op: "gte", value: 500 }] }],
              },
            ],
          },
          then_terms: rule!.then_terms,
        },
      ],
    };
    expect(errorCode(() => validateConditionalOffer(bad))).toBe("schema_invalid");
  });

  it("rejects a condition node carrying both all and a leaf", () => {
    const conditional = validConditionalOffer();
    const [rule] = conditional.conditions;
    const bad = {
      ...conditional,
      conditions: [
        {
          when: { all: [], field: "aggregate.total_quantity", op: "gte", value: 500 },
          then_terms: rule!.then_terms,
        },
      ],
    };
    expect(errorCode(() => validateConditionalOffer(bad))).toBe("schema_invalid");
  });
});

describe("Clarification（§14）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateClarification(validClarification())).toEqual(validClarification());
  });

  it("rejects empty questions", () => {
    expect(errorCode(() => validateClarification({ type: "clarification", questions: [] }))).toBe(
      "schema_invalid",
    );
  });
});

describe("AcceptNonbinding（§15）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateAcceptNonbinding(validAcceptNonbinding())).toEqual(validAcceptNonbinding());
  });

  it("rejects a malformed terms_digest", () => {
    const accept = validAcceptNonbinding();
    expect(
      errorCode(() => validateAcceptNonbinding({ ...accept, terms_digest: "sha256:..." })),
    ).toBe("schema_invalid");
    expect(errorCode(() => validateAcceptNonbinding({ ...accept, terms_digest: "md5:abc" }))).toBe(
      "schema_invalid",
    );
  });
});

describe("Withdraw / Decline（§17）", () => {
  it("accept the sub-spec examples", () => {
    expect(validateWithdraw(validWithdraw())).toEqual(validWithdraw());
    expect(validateDecline(validDecline())).toEqual(validDecline());
  });

  it("reject a missing target_message_id", () => {
    const withdraw = validWithdraw();
    const { target_message_id: _dropped, ...rest } = withdraw;
    expect(errorCode(() => validateWithdraw(rest))).toBe("schema_invalid");
  });

  it("reject scope=negotiation carrying target_offer_id as state_conflict", () => {
    const withdraw = { ...validWithdraw(), scope: "negotiation" };
    const decline = { ...validDecline(), scope: "negotiation" };
    expect(errorCode(() => validateWithdraw(withdraw))).toBe("state_conflict");
    expect(errorCode(() => validateDecline(decline))).toBe("state_conflict");
  });

  it("accept scope=negotiation without target_offer_id", () => {
    const withdraw = { type: "withdraw", target_message_id: "msg_03", scope: "negotiation" };
    const decline = { type: "decline", target_message_id: "msg_03", scope: "negotiation" };
    expect(validateWithdraw(withdraw).scope).toBe("negotiation");
    expect(validateDecline(decline).scope).toBe("negotiation");
  });
});

describe("AcceptedNonbindingAgreement（§16）", () => {
  it("accepts the sub-spec example", () => {
    expect(validateAcceptedNonbindingAgreement(validAgreement())).toEqual(validAgreement());
  });

  it("rejects any true side-effect flag (fail-closed)", () => {
    expect(
      errorCode(() =>
        validateAcceptedNonbindingAgreement({ ...validAgreement(), creates_order: true }),
      ),
    ).toBe("schema_invalid");
    expect(
      errorCode(() =>
        validateAcceptedNonbindingAgreement({ ...validAgreement(), reserves_inventory: true }),
      ),
    ).toBe("schema_invalid");
    expect(
      errorCode(() =>
        validateAcceptedNonbindingAgreement({ ...validAgreement(), authorizes_payment: true }),
      ),
    ).toBe("schema_invalid");
  });

  it("rejects a missing side-effect flag", () => {
    const agreement = validAgreement();
    const { creates_order: _dropped, ...rest } = agreement;
    expect(errorCode(() => validateAcceptedNonbindingAgreement(rest))).toBe("schema_invalid");
  });

  it("rejects a binding_effect other than nonbinding", () => {
    expect(
      errorCode(() =>
        validateAcceptedNonbindingAgreement({ ...validAgreement(), binding_effect: "binding" }),
      ),
    ).toBe("schema_invalid");
  });
});

describe("validatePayloadForAction dispatch", () => {
  it("validates every sub-spec example payload under its action", () => {
    const vectors: [string, NegotiationPayload][] = [
      ["inquiry", validInquiry()],
      ["rfq", validRfq()],
      ["offer", validOffer()],
      ["counter_offer", validCounterOffer()],
      ["conditional_offer", validConditionalOffer()],
      ["clarification", validClarification()],
      ["accept_nonbinding", validAcceptNonbinding()],
      ["withdraw", validWithdraw()],
      ["decline", validDecline()],
      ["cancel", { type: "cancel" }],
    ];
    for (const [action, payload] of vectors) {
      expect(validatePayloadForAction(action as (typeof KNP_ACTIONS)[number], payload)).toEqual(
        payload,
      );
    }
  });

  it("rejects an action/payload type mismatch", () => {
    expect(errorCode(() => validatePayloadForAction("offer", validRfq()))).toBe("schema_invalid");
    expect(() => validatePayloadForAction("offer", validRfq())).toThrow(/type must be offer/);
  });

  it("exposes the negotiated condition field vocabulary", () => {
    expect(CONDITION_FIELDS).toContain("aggregate.total_quantity");
  });
});

describe("envelope payloads stay schema-valid after validation", () => {
  it("validates the envelope example's counter_offer payload round-trip", () => {
    const fields = validEnvelopeFields();
    expect(validatePayloadForAction(fields.action, fields.payload)).toEqual(fields.payload);
  });
});
