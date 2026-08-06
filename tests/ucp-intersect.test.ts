/**
 * UCP capability intersection（WP2，基线 §3.2 / §25 / §43）测试：
 *   - 四步 Intersection Algorithm 逐步用例：同名交集、版本互选最高、无共同版本排除、
 *     单/多 parent 剪枝、传递链剪枝到不动点；
 *   - requires 边界：min 含、max 含、max 缺省（无上限）、requires.capabilities parent 版本、
 *     声明非法（键 ⊄ extends / 非法日期 / min > max）；
 *   - 空交集 / 版本互不兼容 → capabilities_incompatible（业务结果，非 transport 错误）；
 *   - selectRelevantCapabilities：UCP 'Relevance' 选择矩阵（root 匹配 + 传递闭包）。
 */
import { describe, expect, it } from "vitest";
import {
  CapabilityIncompatibleError,
  compareUcpVersions,
  computeCapabilityIntersection,
  isUcpVersionDate,
  matchesOperationType,
  requireCapabilitiesCompatible,
  selectRelevantCapabilities,
  validateRequiresConstraint,
} from "../src/discovery/ucp/intersect.js";
import type { UcpCapabilityDeclaration, UcpProfile } from "../src/discovery/ucp/types.js";

function decl(version: string, overrides: Record<string, unknown> = {}): UcpCapabilityDeclaration {
  return {
    version,
    spec: `https://example.com/specs/${version}.json`,
    schema: `https://example.com/schemas/${version}.json`,
    ...overrides,
  } as UcpCapabilityDeclaration;
}

function profile(
  capabilities: Record<string, UcpCapabilityDeclaration[]>,
  version = "2026-04-08",
): UcpProfile {
  return { ucp: { version, capabilities } };
}

describe("Step 1 — 同名交集（no_mutual）", () => {
  it("keeps a capability both sides declare; drops a business-only one as no_mutual", () => {
    const business = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01")],
      "com.example.shopping.checkout": [decl("2026-01-01")],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(true);
    expect([...result.active.keys()]).toEqual(["com.example.shopping.negotiation"]);
    expect(result.active.get("com.example.shopping.negotiation")?.version).toBe("2026-01-01");
    expect(result.excluded).toEqual([
      { name: "com.example.shopping.checkout", reason: "no_mutual" },
    ]);
  });
});

describe("Step 2 — 版本互选最高（version_incompatible）", () => {
  it("selects the highest (newest) of the shared version arrays", () => {
    const business = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01"), decl("2026-03-01")],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01"), decl("2026-03-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.active.get("com.example.shopping.negotiation")?.version).toBe("2026-03-01");
    expect(result.active.get("com.example.shopping.negotiation")?.entry.version).toBe("2026-03-01");
    expect(result.excluded).toEqual([]);
  });

  it("selects the newest among versions shared with an asymmetric platform", () => {
    const business = profile({
      "com.example.shopping.negotiation": [
        decl("2026-01-01"),
        decl("2026-03-01"),
        decl("2026-05-01"),
      ],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-03-01"), decl("2026-05-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.active.get("com.example.shopping.negotiation")?.version).toBe("2026-05-01");
  });

  it("excludes a capability when the two version arrays share nothing (version_incompatible)", () => {
    const business = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01")],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-02-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(false);
    expect(result.active.size).toBe(0);
    expect(result.excluded).toEqual([
      { name: "com.example.shopping.negotiation", reason: "version_incompatible" },
    ]);
  });
});

describe("版本比较（YYYY-MM-DD 日期比较 + 占位版本回退）", () => {
  it("compares valid dates chronologically and rejects invalid dates", () => {
    expect(compareUcpVersions("2026-01-15", "2026-02-01")).toBeLessThan(0);
    expect(compareUcpVersions("2026-02-01", "2026-01-15")).toBeGreaterThan(0);
    expect(compareUcpVersions("2026-02-01", "2026-02-01")).toBe(0);
    expect(isUcpVersionDate("2026-04-08")).toBe(true);
    expect(isUcpVersionDate("2026-02-30")).toBe(false); // 非法日期（2 月无 30 日）
    expect(isUcpVersionDate("1.0")).toBe(false);
  });

  it("treats a valid date as newer than a non-date placeholder version", () => {
    expect(compareUcpVersions("2026-04-08", "1.0")).toBeGreaterThan(0);
    expect(compareUcpVersions("1.0", "2026-04-08")).toBeLessThan(0);
  });

  it("falls back to deterministic lexical comparison for non-date versions", () => {
    expect(compareUcpVersions("1.0", "1.1")).toBeLessThan(0);
    expect(compareUcpVersions("1.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("Step 3 — 单/多 parent 剪枝（orphaned_extension）", () => {
  it("prunes an extension whose single parent is not in the intersection", () => {
    const root = "com.example.shopping.order";
    const ext = "com.example.shopping.order.v2";
    const business = profile({
      [root]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01", { extends: root })],
    });
    const platform = profile({
      [ext]: [decl("2026-01-01")], // root 未声明 → no_mutual；ext 失去 parent → 孤儿
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(false);
    expect(result.excluded).toEqual([
      { name: root, reason: "no_mutual" },
      { name: ext, reason: "orphaned_extension" },
    ]);
  });

  it("keeps an extension when at least one multi-parent is active", () => {
    const order = "com.example.shopping.order";
    const checkout = "com.example.shopping.checkout";
    const ext = "com.example.shopping.combined";
    const business = profile({
      [order]: [decl("2026-01-01")],
      [checkout]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01", { extends: [order, checkout] })],
    });
    // platform 不声明 order，但声明 checkout → 多 parent 至少一个在 → ext 保留
    const platform = profile({
      [checkout]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.active.has(ext)).toBe(true);
    expect(result.excluded.map((e) => e.reason)).toEqual(["no_mutual"]); // 仅 order 被剔除
  });

  it("prunes an extension when none of its multi-parents is active", () => {
    const order = "com.example.shopping.order";
    const checkout = "com.example.shopping.checkout";
    const ext = "com.example.shopping.combined";
    const business = profile({
      [order]: [decl("2026-01-01")],
      [checkout]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01", { extends: [order, checkout] })],
    });
    const platform = profile({
      [ext]: [decl("2026-01-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.excluded).toContainEqual({ name: ext, reason: "orphaned_extension" });
  });
});

describe("Step 4 — 传递链剪枝到不动点", () => {
  it("prunes a whole transitive chain to the fixed point when the root drops out", () => {
    const root = "com.example.shopping.order";
    const e1 = "com.example.shopping.order.discount";
    const e2 = "com.example.shopping.order.discount.tax";
    const business = profile({
      [root]: [decl("2026-01-01")],
      [e1]: [decl("2026-01-01", { extends: root })],
      [e2]: [decl("2026-01-01", { extends: e1 })],
    });
    // platform 不声明 root → root no_mutual → e1 孤儿 → e2 孤儿（传递直到不动点）
    const platform = profile({
      [e1]: [decl("2026-01-01")],
      [e2]: [decl("2026-01-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(false);
    expect(result.active.size).toBe(0);
    const byName = new Map(result.excluded.map((e) => [e.name, e.reason]));
    expect(byName.get(root)).toBe("no_mutual");
    expect(byName.get(e1)).toBe("orphaned_extension");
    expect(byName.get(e2)).toBe("orphaned_extension");
  });

  it("re-prunes children after a parent is dropped for an unsatisfied requires", () => {
    const root = "com.example.shopping.negotiation";
    const ext = "com.example.shopping.negotiation.custom";
    const business = profile({
      [root]: [
        decl("2026-01-01", { requires: { protocol: { min: "2026-05-01" } } }),
      ],
      [ext]: [decl("2026-01-01", { extends: root })],
    });
    const platform = profile({
      [root]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.excluded).toContainEqual({ name: root, reason: "requires_unsatisfied" });
    expect(result.excluded).toContainEqual({ name: ext, reason: "orphaned_extension" });
    expect(result.active.size).toBe(0);
  });
});

describe("requires 边界（min 含 / max 含 / max 缺省）", () => {
  it("min is inclusive", () => {
    const business = profile({
      "com.example.shopping.negotiation": [
        decl("2026-01-01", { requires: { protocol: { min: "2026-04-08" } } }),
      ],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01")],
    });
    // 协商版本 === min → 满足
    expect(computeCapabilityIntersection(business, platform, "2026-04-08").active.size).toBe(1);
    // 协商版本 < min → 排除
    expect(computeCapabilityIntersection(business, platform, "2026-04-07").active.size).toBe(0);
  });

  it("max is inclusive", () => {
    const business = profile({
      "com.example.shopping.negotiation": [
        decl("2026-01-01", { requires: { protocol: { max: "2026-04-08" } } }),
      ],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01")],
    });
    expect(computeCapabilityIntersection(business, platform, "2026-04-08").active.size).toBe(1);
    expect(computeCapabilityIntersection(business, platform, "2026-04-09").active.size).toBe(0);
  });

  it("a missing max means no upper bound", () => {
    const business = profile({
      "com.example.shopping.negotiation": [
        decl("2026-01-01", { requires: { protocol: { min: "2026-04-08" } } }),
      ],
    });
    const platform = profile({
      "com.example.shopping.negotiation": [decl("2026-01-01")],
    });
    expect(computeCapabilityIntersection(business, platform, "2026-12-31").active.size).toBe(1);
  });

  it("requires.capabilities constrains the parent's selected version (inclusive)", () => {
    const root = "com.example.shopping.order";
    const ext = "com.example.shopping.order.early";
    const business = profile({
      [root]: [decl("2026-01-01")],
      [ext]: [
        decl("2026-01-01", {
          extends: root,
          requires: { capabilities: { [root]: { min: "2026-01-01", max: "2026-03-01" } } },
        }),
      ],
    });
    const platform = profile({
      [root]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01")],
    });
    // root 选中 2026-01-01，满足 [2026-01-01, 2026-03-01] → ext 保留
    const ok = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(ok.active.has(ext)).toBe(true);
    expect(ok.excluded).toEqual([]);
  });

  it("excludes an extension whose requires.capabilities min is not met by the parent's selected version", () => {
    const root = "com.example.shopping.order";
    const ext = "com.example.shopping.order.early";
    const business = profile({
      [root]: [decl("2026-01-01")],
      [ext]: [
        decl("2026-01-01", {
          extends: root,
          requires: { capabilities: { [root]: { min: "2026-02-01" } } },
        }),
      ],
    });
    const platform = profile({
      [root]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01")],
    });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.excluded).toContainEqual({ name: ext, reason: "requires_unsatisfied" });
  });
});

describe("requires 声明合法性（validateRequiresConstraint）", () => {
  it("rejects requires.capabilities keys that are not a subset of extends keys (illegal declaration)", () => {
    const result = validateRequiresConstraint(
      { capabilities: { "com.example.shopping.checkout": { min: "2026-01-01" } } },
      "com.example.shopping.order", // extends 只有 order，不含 checkout
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("extends");
  });

  it("rejects requires.capabilities on a root capability that has no extends", () => {
    const result = validateRequiresConstraint(
      { capabilities: { "com.example.shopping.order": { min: "2026-01-01" } } },
      undefined,
    );
    expect(result.valid).toBe(false);
  });

  it("accepts requires.capabilities whose keys are a subset of a multi-parent extends", () => {
    const result = validateRequiresConstraint(
      { capabilities: { "com.example.shopping.order": { min: "2026-01-01", max: "2026-12-31" } } },
      ["com.example.shopping.order", "com.example.shopping.checkout"],
    );
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("rejects invalid date bounds and min > max", () => {
    expect(validateRequiresConstraint({ protocol: { min: "2026-02-30" } }, undefined).valid).toBe(
      false,
    );
    expect(validateRequiresConstraint({ protocol: { max: "not-a-date" } }, undefined).valid).toBe(
      false,
    );
    expect(
      validateRequiresConstraint({ protocol: { min: "2026-06-01", max: "2026-01-01" } }, undefined)
        .valid,
    ).toBe(false);
  });

  it("treats a malformed requires (non-object) as invalid", () => {
    expect(validateRequiresConstraint("nope", undefined).valid).toBe(false);
    expect(validateRequiresConstraint(null, undefined).valid).toBe(false);
  });
});

describe("空交集 / 互不兼容 → capabilities_incompatible（业务结果）", () => {
  it("reports compatible=false for an empty intersection (no shared capabilities)", () => {
    const business = profile({ "com.example.shopping.negotiation": [decl("2026-01-01")] });
    const platform = profile({ "com.example.shopping.checkout": [decl("2026-01-01")] });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(false);
    expect(result.active.size).toBe(0);
    expect(result.excluded[0]?.reason).toBe("no_mutual");
  });

  it("reports compatible=false when every shared capability has no common version", () => {
    const business = profile({ "com.example.shopping.negotiation": [decl("2026-01-01")] });
    const platform = profile({ "com.example.shopping.negotiation": [decl("2026-02-01")] });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(false);
    expect(result.active.size).toBe(0);
  });

  it("requireCapabilitiesCompatible throws capability_incompatible (not a transport error)", () => {
    const business = profile({ "com.example.shopping.negotiation": [decl("2026-01-01")] });
    const platform = profile({});
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(false);
    expect(() => requireCapabilitiesCompatible(result)).toThrow(CapabilityIncompatibleError);
    expect(() => requireCapabilitiesCompatible(result)).toThrowError(/no mutually compatible/);
    const err = (() => {
      try {
        requireCapabilitiesCompatible(result);
        return undefined;
      } catch (e) {
        return e as { code: string };
      }
    })();
    expect(err?.code).toBe("capability_incompatible");
  });

  it("requireCapabilitiesCompatible returns the intersection untouched when compatible", () => {
    const business = profile({ "com.example.shopping.negotiation": [decl("2026-01-01")] });
    const platform = profile({ "com.example.shopping.negotiation": [decl("2026-01-01")] });
    const result = computeCapabilityIntersection(business, platform, "2026-04-08");
    expect(result.compatible).toBe(true);
    expect(requireCapabilitiesCompatible(result)).toBe(result);
  });
});

describe("selectRelevantCapabilities — UCP 'Relevance' 选择矩阵", () => {
  it("selects the matching root and extensions that reach it, leaving unrelated roots out", () => {
    const negotiation = "com.example.shopping.negotiation";
    const order = "com.example.shopping.order";
    const negotiationExt = "com.example.shopping.negotiation.take";
    const orderExt = "com.example.shopping.order.status";
    const caps: Record<string, UcpCapabilityDeclaration[]> = {
      [negotiation]: [decl("2026-01-01")],
      [order]: [decl("2026-01-01")],
      [negotiationExt]: [decl("2026-01-01", { extends: negotiation })],
      [orderExt]: [decl("2026-01-01", { extends: order })],
    };
    const result = computeCapabilityIntersection(profile(caps), profile(caps), "2026-04-08");
    const relevant = selectRelevantCapabilities(result.active, "negotiation");
    expect([...relevant.keys()].sort()).toEqual([negotiation, negotiationExt].sort());
  });

  it("matches by full capability name and follows multi-hop extends chains", () => {
    const root = "com.example.shopping.order";
    const e1 = "com.example.shopping.order.discount";
    const e2 = "com.example.shopping.order.discount.tax";
    const unrelated = "com.example.shopping.checkout";
    const caps: Record<string, UcpCapabilityDeclaration[]> = {
      [root]: [decl("2026-01-01")],
      [e1]: [decl("2026-01-01", { extends: root })],
      [e2]: [decl("2026-01-01", { extends: e1 })],
      [unrelated]: [decl("2026-01-01")],
    };
    const result = computeCapabilityIntersection(profile(caps), profile(caps), "2026-04-08");
    const relevant = selectRelevantCapabilities(result.active, "com.example.shopping.order");
    expect([...relevant.keys()].sort()).toEqual([root, e1, e2].sort());
  });

  it("keeps a multi-parent extension that reaches a relevant root even if the other parent is unrelated", () => {
    const order = "com.example.shopping.order";
    const checkout = "com.example.shopping.checkout";
    const ext = "com.example.shopping.combined";
    const caps: Record<string, UcpCapabilityDeclaration[]> = {
      [order]: [decl("2026-01-01")],
      [checkout]: [decl("2026-01-01")],
      [ext]: [decl("2026-01-01", { extends: [order, checkout] })],
    };
    const result = computeCapabilityIntersection(profile(caps), profile(caps), "2026-04-08");
    const relevant = selectRelevantCapabilities(result.active, "order");
    expect(relevant.has(ext)).toBe(true); // ext 经 order 命中相关 root
    expect(relevant.has(checkout)).toBe(false);
  });

  it("returns an empty set when no root matches the operation type", () => {
    const caps = { "com.example.shopping.order": [decl("2026-01-01")] };
    const result = computeCapabilityIntersection(profile(caps), profile(caps), "2026-04-08");
    const relevant = selectRelevantCapabilities(result.active, "negotiation");
    expect(relevant.size).toBe(0);
  });

  it("matchesOperationType: full name or last segment only", () => {
    expect(matchesOperationType("negotiation", "com.example.shopping.negotiation")).toBe(true);
    expect(
      matchesOperationType("com.example.shopping.negotiation", "com.example.shopping.negotiation"),
    ).toBe(true);
    expect(matchesOperationType("order", "com.example.shopping.negotiation")).toBe(false);
    expect(matchesOperationType("", "com.example.shopping.negotiation")).toBe(false);
  });
});
