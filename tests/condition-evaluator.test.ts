/**
 * KNP/1.0 ConditionalOffer 求值器 tests（子规范 §13，基线 §12）：
 *  - base/单命中/多命中的 §13.6 结果语义；
 *  - 全部比较符 eq/neq/gt/gte/lt/lte/in（含边界与无强转）；
 *  - all/any 组合与嵌套深度边界（≤2，更深 fail-closed）；
 *  - 多命中不同 then_terms → condition_conflict；canonical 字节一致 → 同一结果；
 *  - field 越界 → field_unsupported；未披露事实永不命中（含 neq，§12.3）。
 */
import { describe, expect, it } from "vitest";
import { NegotiationValidationError } from "../src/negotiation/domain/common.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import type {
  ConditionOperator,
  ConditionRule,
  ConditionalOffer,
} from "../src/negotiation/domain/objects.js";
import { evaluateConditionalOffer } from "../src/negotiation/condition/evaluator.js";

const HIT: TermSet = { price_terms: { discount: "hit" } };
const BASE: TermSet = { price_terms: { discount: "base" } };

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof NegotiationValidationError ? e.code : "non-negotiation-error";
  }
}

function rule(
  op: ConditionOperator,
  value: number | string | (number | string)[],
  field = "aggregate.total_quantity",
  then_terms: TermSet = HIT,
): ConditionRule {
  return { when: { all: [{ field, op, value }] }, then_terms };
}

function offer(conditions: ConditionRule[], base_terms: TermSet = BASE): ConditionalOffer {
  return { type: "conditional_offer", offer_id: "off_eval", base_terms, conditions };
}

describe("§13.6 result semantics", () => {
  it("uses base_terms when there are no conditions", () => {
    expect(evaluateConditionalOffer(offer([]), {})).toEqual(BASE);
  });

  it("uses base_terms when no rule matches", () => {
    const co = offer([rule("gte", 500)]);
    expect(evaluateConditionalOffer(co, { "aggregate.total_quantity": 200 })).toEqual(BASE);
  });

  it("uses the complete then_terms of the single matching rule", () => {
    const co = offer([rule("gte", 500)]);
    expect(evaluateConditionalOffer(co, { "aggregate.total_quantity": 800 })).toEqual(HIT);
  });

  it("evaluates every rule independently (rules are alternatives, not cumulative)", () => {
    const co = offer([
      rule("gte", 500, "aggregate.total_quantity", { price_terms: { tier: "large" } }),
      rule("lt", 100, "aggregate.total_quantity", { price_terms: { tier: "small" } }),
    ]);
    // 只有第二条命中，完整返回第二条 then_terms。
    expect(evaluateConditionalOffer(co, { "aggregate.total_quantity": 50 })).toEqual({
      price_terms: { tier: "small" },
    });
  });
});

describe("§13.4 comparison operators", () => {
  it("evaluates every operator and its numeric boundaries", () => {
    const cases: Array<{
      op: ConditionOperator;
      value: number | string | (number | string)[];
      fact: number;
      hits: boolean;
    }> = [
      { op: "eq", value: 500, fact: 500, hits: true },
      { op: "eq", value: 500, fact: 501, hits: false },
      { op: "neq", value: 500, fact: 501, hits: true },
      { op: "neq", value: 500, fact: 500, hits: false },
      { op: "gt", value: 500, fact: 501, hits: true },
      { op: "gt", value: 500, fact: 500, hits: false },
      { op: "gte", value: 500, fact: 500, hits: true },
      { op: "gte", value: 500, fact: 499, hits: false },
      { op: "lt", value: 500, fact: 499, hits: true },
      { op: "lt", value: 500, fact: 500, hits: false },
      { op: "lte", value: 500, fact: 500, hits: true },
      { op: "lte", value: 500, fact: 501, hits: false },
      { op: "in", value: [400, 500, 600], fact: 500, hits: true },
      { op: "in", value: [400, 500, 600], fact: 550, hits: false },
    ];
    for (const c of cases) {
      const co = offer([rule(c.op, c.value)]);
      const result = evaluateConditionalOffer(co, { "aggregate.total_quantity": c.fact });
      expect(result).toEqual(c.hits ? HIT : BASE);
    }
  });

  it("never coerces between number and string (fail-closed)", () => {
    const eq = offer([rule("eq", 500)]);
    expect(evaluateConditionalOffer(eq, { "aggregate.total_quantity": "500" })).toEqual(BASE);

    const inOp = offer([rule("in", [500, 600])]);
    expect(evaluateConditionalOffer(inOp, { "aggregate.total_quantity": "500" })).toEqual(BASE);
  });

  it("returns no match when an ordering op sees non-numeric operands", () => {
    const stringValue = offer([rule("gt", "many")]);
    expect(evaluateConditionalOffer(stringValue, { "aggregate.total_quantity": 100 })).toEqual(
      BASE,
    );

    const stringFact = offer([rule("gte", 500)]);
    expect(evaluateConditionalOffer(stringFact, { "aggregate.total_quantity": "500" })).toEqual(
      BASE,
    );
  });

  it("supports in with string members", () => {
    const co = offer([rule("in", ["first", "second"], "aggregate.total_quantity")]);
    expect(evaluateConditionalOffer(co, { "aggregate.total_quantity": "second" })).toEqual(HIT);
    expect(evaluateConditionalOffer(co, { "aggregate.total_quantity": "third" })).toEqual(BASE);
  });
});

describe("§13.3 all/any grammar", () => {
  it("all requires every child to match", () => {
    const co = offer([
      {
        when: {
          all: [
            { field: "aggregate.total_quantity", op: "gte", value: 500 },
            { field: "commercial.commitment_days", op: "lte", value: 90 },
          ],
        },
        then_terms: HIT,
      },
    ]);
    expect(
      evaluateConditionalOffer(co, {
        "aggregate.total_quantity": 800,
        "commercial.commitment_days": 60,
      }),
    ).toEqual(HIT);
    expect(
      evaluateConditionalOffer(co, {
        "aggregate.total_quantity": 800,
        "commercial.commitment_days": 120,
      }),
    ).toEqual(BASE);
  });

  it("any matches when at least one child matches", () => {
    const co = offer([
      {
        when: {
          any: [
            { field: "aggregate.total_quantity", op: "gte", value: 500 },
            { field: "commercial.commitment_days", op: "lte", value: 90 },
          ],
        },
        then_terms: HIT,
      },
    ]);
    expect(
      evaluateConditionalOffer(co, {
        "aggregate.total_quantity": 200,
        "commercial.commitment_days": 60,
      }),
    ).toEqual(HIT);
    expect(
      evaluateConditionalOffer(co, {
        "aggregate.total_quantity": 200,
        "commercial.commitment_days": 120,
      }),
    ).toEqual(BASE);
  });

  it("allows one level of nested all/any (depth ≤ 2)", () => {
    const co = offer([
      {
        when: {
          all: [
            {
              any: [
                { field: "aggregate.total_quantity", op: "gte", value: 500 },
                { field: "aggregate.total_quantity", op: "lte", value: 50 },
              ],
            },
            { field: "fulfillment.batch_count", op: "gte", value: 3 },
          ],
        },
        then_terms: HIT,
      },
    ]);
    expect(
      evaluateConditionalOffer(co, {
        "aggregate.total_quantity": 30,
        "fulfillment.batch_count": 4,
      }),
    ).toEqual(HIT);
    expect(
      evaluateConditionalOffer(co, {
        "aggregate.total_quantity": 300,
        "fulfillment.batch_count": 1,
      }),
    ).toEqual(BASE);
  });

  it("rejects nesting deeper than 2 (fail-closed)", () => {
    const deep = offer([
      {
        when: {
          all: [
            {
              any: [{ all: [{ field: "aggregate.total_quantity", op: "gte", value: 500 }] }],
            },
          ],
        },
        then_terms: HIT,
      },
    ]);
    expect(
      errorCode(() => evaluateConditionalOffer(deep, { "aggregate.total_quantity": 800 })),
    ).toBe("schema_invalid");
  });
});

describe("§13.6.5/§13.6.7 multi-hit conflict", () => {
  it("returns condition_conflict when matching then_terms differ", () => {
    const co = offer([
      rule("gte", 500, "aggregate.total_quantity", { price_terms: { discount: "10%" } }),
      rule("gte", 400, "aggregate.total_quantity", { price_terms: { discount: "12%" } }),
    ]);
    expect(errorCode(() => evaluateConditionalOffer(co, { "aggregate.total_quantity": 600 }))).toBe(
      "condition_conflict",
    );
  });

  it("treats byte-identical canonical then_terms as one result", () => {
    // 两个 then_terms 键插入顺序不同，但 canonical（JCS 排序键）字节完全一致。
    const co = offer([
      rule("gte", 500, "aggregate.total_quantity", {
        price_terms: { discount: "10%", min_qty: 500 },
      }),
      rule("gte", 400, "aggregate.total_quantity", {
        price_terms: { min_qty: 500, discount: "10%" },
      }),
    ]);
    expect(evaluateConditionalOffer(co, { "aggregate.total_quantity": 600 })).toEqual({
      price_terms: { discount: "10%", min_qty: 500 },
    });
  });
});

describe("§13.5 field allowlist / §12.3 disclosure", () => {
  it("rejects a non-allowlisted field with field_unsupported", () => {
    const co = offer([
      {
        when: { all: [{ field: "inventory.private_stock", op: "gte", value: 1 }] },
        then_terms: HIT,
      },
    ]);
    expect(errorCode(() => evaluateConditionalOffer(co, {}))).toBe("field_unsupported");
  });

  it("fail-closes even when the fact context carries the private field", () => {
    const co = offer([
      {
        when: { all: [{ field: "buyer.segment", op: "eq", value: "enterprise" }] },
        then_terms: HIT,
      },
    ]);
    expect(errorCode(() => evaluateConditionalOffer(co, { "buyer.segment": "enterprise" }))).toBe(
      "field_unsupported",
    );
  });

  it("never matches on an undisclosed/absent fact, including neq", () => {
    const neq = offer([rule("neq", 12, "service.warranty_months")]);
    // 事实缺失时即使 neq "自然成立" 也不命中：防止借反例探测私有属性（§12.3）。
    expect(evaluateConditionalOffer(neq, {})).toEqual(BASE);
  });

  it("ignores extra non-allowlisted keys in the fact context", () => {
    // 求值器只读取条件引用的 allowlist 字段；额外键是惰性的。
    const co = offer([rule("gte", 500)]);
    expect(
      evaluateConditionalOffer(co, { "aggregate.total_quantity": 800, "buyer.income": 999999 }),
    ).toEqual(HIT);
  });
});
