import { describe, expect, it } from "vitest";
import { firstGroundingRead, groundingReads } from "../src/agent/context/grounding.js";
import {
  MERCHANT_GROUNDING_RULES,
  merchantGroundingContext,
} from "../src/agent/merchant/merchant-grounding.js";
import { testProfile } from "./helpers.js";

const profile = testProfile({
  merchant_experience: { enabled: true, grounding: true, intelligence: true },
});

describe("Merchant grounding", () => {
  it("returns up to two independent reads for a multi-domain question", () => {
    const reads = groundingReads(
      MERCHANT_GROUNDING_RULES,
      merchantGroundingContext(profile, "看看当前磋商，顺便检查一下库存"),
      2,
    );
    expect(reads.map((read) => read.tool)).toEqual([
      "get_negotiation_digest",
      "get_catalog_health",
    ]);
  });

  it("keeps the first-read compatibility helper", () => {
    const read = firstGroundingRead(
      MERCHANT_GROUNDING_RULES,
      merchantGroundingContext(profile, "经营指标和商品目录怎么样？"),
    );
    expect(read?.tool).toBe("list_catalog_products");
  });

  it("never returns more than the configured cap", () => {
    const reads = groundingReads(
      MERCHANT_GROUNDING_RULES,
      merchantGroundingContext(profile, "待审批、磋商、人工审核、库存和经营情况都看一下"),
      2,
    );
    expect(reads).toHaveLength(2);
    expect(reads.every((read) => !/approve|update|submit/i.test(read.tool))).toBe(true);
  });
});
