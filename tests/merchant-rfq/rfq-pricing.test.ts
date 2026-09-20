/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * M2 门槛：确定性计价与契约算例（设计 v0.1.1 §7、§19.2 计价组）。
 *
 *   - 10 个金标算例（交接包 04_reference/pricing-vectors.json）逐例一致；
 *   - 16 个反例（negative-vectors.json）全部拒绝（schema/语义）；
 *   - rfq-canonical-json-v1 与既有 contentHash 在合法值域内一致；
 *   - 中间量越界、未知运费、逐行舍入、含税/未税边界。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calculatePricing, MAX_LINES, MAX_QUANTITY } from "../../src/merchant-core/rfq/pricing.js";
import { canonicalJson, rfqContentDigest, RfqError } from "../../src/merchant-core/rfq/types.js";
import { contentHash } from "../../src/agent/merchant/action-candidate.js";
import type { PricingInput } from "../../src/merchant-core/rfq/types.js";

const fixturesDir = path.join(import.meta.dirname, "fixtures");

const goldenVectors = JSON.parse(
  readFileSync(path.join(fixturesDir, "pricing-vectors.json"), "utf8"),
) as Array<{ id: string; input: PricingInput; expected_totals: Record<string, number> }>;

const negativeVectors = JSON.parse(
  readFileSync(path.join(fixturesDir, "negative-vectors.json"), "utf8"),
) as Array<{ id: string; schema: string; data: unknown; expected_failure: string }>;

const baseVector = goldenVectors[0]!;
const baseInput = baseVector.input;
const baseLine = baseInput.lines[0]!;

describe("确定性计价：金标算例", () => {
  it.each(goldenVectors.map((v) => [v.id, v] as const))(
    "%s：逐位一致",
    (_id, vector) => {
      const output = calculatePricing(vector.input);
      expect(output.totals).toEqual(vector.expected_totals);
    },
  );

  it("行级明细与总额可重算（求和一致性）", () => {
    const output = calculatePricing(baseVector.input);
    const sum = output.lines.reduce((acc, l) => acc + l.net_minor, output.shipping.net_minor);
    expect(sum).toBe(output.totals.net_minor);
  });

  it("同输入同输出（纯函数；两次调用字节一致）", () => {
    expect(JSON.stringify(calculatePricing(baseInput))).toBe(
      JSON.stringify(calculatePricing(structuredClone(baseInput))),
    );
  });
});

describe("确定性计价：反例全部拒绝", () => {
  it.each(negativeVectors.map((v) => [v.id, v] as const))("%s：拒绝", (_id, vector) => {
    if (vector.schema !== "pricing-input") {
      // rfq-case / fact-snapshot 等对象级反例由 schema 校验与测试组覆盖；
      // 本文件聚焦计价引擎本身。
      return;
    }
    expect(() => calculatePricing(vector.data as PricingInput)).toThrow(RfqError);
  });

  it("quantity 越界拒绝", () => {
    expect(() =>
      calculatePricing({ ...baseInput, lines: [{ ...baseLine, quantity: MAX_QUANTITY + 1 }] }),
    ).toThrow(RfqError);
    expect(() =>
      calculatePricing({ ...baseInput, lines: [{ ...baseLine, quantity: 10.5 }] }),
    ).toThrow(RfqError);
  });

  it("行数超过上限拒绝", () => {
    const lines = Array.from({ length: MAX_LINES + 1 }, (_, i) => ({
      ...baseLine,
      line_id: `L${i + 1}`,
    }));
    expect(() => calculatePricing({ ...baseInput, lines })).toThrow(RfqError);
  });

  it("中间量溢出（quantity × unit_price 超上限）按 PRICING_INVALID 整单拒绝", () => {
    expect(() =>
      calculatePricing({
        ...baseInput,
        lines: [{ ...baseLine, quantity: 100_000, unit_price_minor: 1_000_000_000_000, discount_minor: 0 }],
      }),
    ).toThrow(/上限/u);
  });

  it("行优惠超过行基数拒绝（优惠越界）", () => {
    expect(() =>
      calculatePricing({ ...baseInput, lines: [{ ...baseLine, discount_minor: 999_999_999 }] }),
    ).toThrow(/优惠/u);
  });

  it("含税/未税拆分与交接包参考实现一致（双向核验）", () => {
    // 未税 1300bps：B=10000 → tax 1300；含税 1300bps：B=11300 → tax 1300。
    const input: PricingInput = {
      schema_version: "0.1.0",
      currency: "CNY",
      rounding: "HALF_UP_LINE",
      lines: [
        { line_id: "A", quantity: 1, unit_price_minor: 10000, discount_minor: 0, tax_basis: "EXCLUSIVE", tax_rate_bps: 1300 },
        { line_id: "B", quantity: 1, unit_price_minor: 11300, discount_minor: 0, tax_basis: "INCLUSIVE", tax_rate_bps: 1300 },
      ],
      shipping: { amount_minor: 0, tax_basis: "EXCLUSIVE", tax_rate_bps: 0 },
    };
    const out = calculatePricing(input);
    expect(out.lines[0]).toMatchObject({ net_minor: 10000, tax_minor: 1300, gross_minor: 11300 });
    expect(out.lines[1]).toMatchObject({ net_minor: 10000, tax_minor: 1300, gross_minor: 11300 });
  });
});

describe("rfq-canonical-json-v1", () => {
  it("与既有 contentHash 在合法值域内一致（契约测试，§10.3）", () => {
    const samples = [
      { b: 1, a: "中文", c: [1, 2, { d: true, e: null }] },
      [3, 2, 1],
      "plain",
      42,
      null,
    ];
    for (const sample of samples) {
      expect(rfqContentDigest(sample)).toBe(contentHash(sample));
    }
  });

  it("浮点与非有限值拒绝", () => {
    expect(() => canonicalJson({ price: 12.5 })).toThrow(RfqError);
    expect(() => canonicalJson({ price: Number.NaN })).toThrow(RfqError);
    expect(() => canonicalJson({ price: Number.POSITIVE_INFINITY })).toThrow(RfqError);
  });

  it("非 ASCII 对象键拒绝", () => {
    expect(() => canonicalJson({ 价格: 100 })).toThrow(/ASCII/u);
  });

  it("键序归一：等价对象同摘要", () => {
    expect(rfqContentDigest({ a: 1, b: 2 })).toBe(rfqContentDigest({ b: 2, a: 1 }));
  });
});
