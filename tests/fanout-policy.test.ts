/**
 * fanout/policy — WP2 FanoutPolicy 策略矩阵（基线 §30）。
 *
 * 覆盖：
 *   - minimum_trust 过滤（record 缺失按 T0；rejected 直接排除，fail-closed）；
 *   - category_sensitivity 提升披露门槛（minimum_trust 取更严格者；敏感品类
 *     强制匿名首轮；round 2 对信任不足者封顶为匿名档）；
 *   - max_recipients 截断（确定性排序：trust 降序 → identity 升序）；
 *   - anonymous_first_round 决定 round 1 档位；
 *   - 判定确定性（同输入 → 同输出）。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FANOUT_POLICY,
  judgeFanout,
  matchingCategorySensitivity,
  stricterTrust,
} from "../src/fanout/policy.js";
import type { FanoutPolicy } from "../src/fanout/policy.js";
import { profile } from "./fanout-helpers.js";

const A = profile("a.example");
const B = profile("b.example");
const C = profile("c.example");
const D = profile("d.example");
const E = profile("e.example");

/** 每人信任信号 helper。undefined = 无 record（→ T0）。 */
function trust(
  entries: Record<string, "T0" | "T1" | "T2" | "T3" | "rejected">,
): Record<string, { level: "T0" | "T1" | "T2" | "T3"; rejected?: boolean } | undefined> {
  const out: Record<string, { level: "T0" | "T1" | "T2" | "T3"; rejected?: boolean } | undefined> =
    {};
  for (const [identity, value] of Object.entries(entries)) {
    if (value === "rejected") {
      out[identity] = { level: "T3", rejected: true };
    } else {
      out[identity] = { level: value };
    }
  }
  return out;
}

describe("stricterTrust / matchingCategorySensitivity", () => {
  it("stricterTrust 取更高 rank（更严格的信任要求）", () => {
    expect(stricterTrust("T0", "T2")).toBe("T2");
    expect(stricterTrust("T3", "T1")).toBe("T3");
    expect(stricterTrust("T2", "T2")).toBe("T2");
  });

  it("matchingCategorySensitivity 大小写不敏感子串匹配；缺省 rule 匹配任意品类", () => {
    const policy: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      category_sensitivity: [{ category: "Medical", minimum_trust: "T2" }],
    };
    expect(matchingCategorySensitivity(policy, "medical-device")?.minimum_trust).toBe("T2");
    expect(matchingCategorySensitivity(policy, "office-supplies")).toBeUndefined();

    const catchAll: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      category_sensitivity: [{ minimum_trust: "T2" }],
    };
    expect(matchingCategorySensitivity(catchAll, "anything")).toBeDefined();
  });
});

describe("minimum_trust 过滤", () => {
  it("低于 minimum_trust 的候选被过滤；record 缺失按 T0；rejected 直接排除", () => {
    const policy: FanoutPolicy = { ...DEFAULT_FANOUT_POLICY, minimum_trust: "T2" };
    const decision = judgeFanout(policy, {
      profiles: [A, B, C, D, E],
      trust: trust({
        "a.example": "T3",
        "b.example": "T2",
        "c.example": "T1",
        "e.example": "rejected",
      }),
      round: 1,
    });

    expect(decision.recipients.map((r) => r.identity)).toEqual(["a.example", "b.example"]);
    // c.example T1 与 d.example（无 record → T0）都低于 T2。
    expect(decision.excluded).toEqual(
      expect.arrayContaining([
        { identity: "c.example", reason: "below_minimum_trust", trust_level: "T1" },
        { identity: "d.example", reason: "below_minimum_trust", trust_level: "T0" },
        { identity: "e.example", reason: "rejected", trust_level: "T3" },
      ]),
    );
    // 高信任优先。
    expect(decision.recipients[0]).toMatchObject({ identity: "a.example", trust_level: "T3" });
    expect(decision.recipients[1]).toMatchObject({ identity: "b.example", trust_level: "T2" });
  });
});

describe("max_recipients 截断", () => {
  it("同信任等级下按 identity 升序确定性截断；被截断者 reason=truncated", () => {
    const policy: FanoutPolicy = { ...DEFAULT_FANOUT_POLICY, max_recipients: 3 };
    const decision = judgeFanout(policy, {
      profiles: [D, C, B, A, E],
      trust: trust({
        "a.example": "T2",
        "b.example": "T2",
        "c.example": "T2",
        "d.example": "T2",
        "e.example": "T2",
      }),
      round: 1,
    });

    expect(decision.recipients.map((r) => r.identity)).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
    expect(decision.excluded).toEqual(
      expect.arrayContaining([
        { identity: "d.example", reason: "truncated", trust_level: "T2" },
        { identity: "e.example", reason: "truncated", trust_level: "T2" },
      ]),
    );
    expect(decision.eligible_count).toBe(5);
  });

  it("高信任优先进入截断后的接收者集合", () => {
    const policy: FanoutPolicy = { ...DEFAULT_FANOUT_POLICY, max_recipients: 2 };
    const decision = judgeFanout(policy, {
      profiles: [A, B, C],
      trust: trust({ "a.example": "T1", "b.example": "T2", "c.example": "T3" }),
      round: 1,
    });
    expect(decision.recipients.map((r) => r.identity)).toEqual(["c.example", "b.example"]);
    expect(decision.excluded).toEqual([
      { identity: "a.example", reason: "truncated", trust_level: "T1" },
    ]);
  });
});

describe("anonymous_first_round", () => {
  it("开启时 round 1 全匿名档；关闭时 round 1 直接 detailed", () => {
    const on: FanoutPolicy = { ...DEFAULT_FANOUT_POLICY, anonymous_first_round: true };
    const round1On = judgeFanout(on, {
      profiles: [A],
      trust: trust({ "a.example": "T2" }),
      round: 1,
    });
    expect(round1On.recipients[0]).toMatchObject({ tier: "anonymous" });

    const off: FanoutPolicy = { ...DEFAULT_FANOUT_POLICY, anonymous_first_round: false };
    const round1Off = judgeFanout(off, {
      profiles: [A],
      trust: trust({ "a.example": "T2" }),
      round: 1,
    });
    expect(round1Off.recipients[0]).toMatchObject({ tier: "detailed" });
  });

  it("round 2 默认 detailed（Top N 精化阶段）", () => {
    const policy: FanoutPolicy = { ...DEFAULT_FANOUT_POLICY, anonymous_first_round: true };
    const decision = judgeFanout(policy, {
      profiles: [A],
      trust: trust({ "a.example": "T2" }),
      round: 2,
    });
    expect(decision.recipients[0]).toMatchObject({ tier: "detailed" });
  });
});

describe("category_sensitivity 提升披露门槛", () => {
  it("敏感品类不改变 eligibility（base minimum_trust 过滤）；只提升披露门槛", () => {
    const policy: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      minimum_trust: "T1",
      category_sensitivity: [{ category: "medical", minimum_trust: "T2" }],
    };
    // round 1：A(T2) 与 B(T1) 都通过 base T1 过滤；敏感品类强制匿名档。
    const round1 = judgeFanout(policy, {
      profiles: [A, B],
      trust: trust({ "a.example": "T2", "b.example": "T1" }),
      category: "medical-device",
      round: 1,
    });
    expect(round1.category_sensitive).toBe(true);
    expect(round1.recipients.map((r) => r.identity)).toEqual(["a.example", "b.example"]);
    expect(round1.recipients.every((r) => r.tier === "anonymous")).toBe(true);
    // round 2：A(T2) 达到敏感 T2 → detailed；B(T1) 未达到 → 封顶匿名档。
    const round2 = judgeFanout(policy, {
      profiles: [A, B],
      trust: trust({ "a.example": "T2", "b.example": "T1" }),
      category: "medical-device",
      round: 2,
    });
    expect(round2.recipients.find((r) => r.identity === "a.example")?.tier).toBe("detailed");
    expect(round2.recipients.find((r) => r.identity === "b.example")?.tier).toBe("anonymous");
  });

  it("敏感品类强制匿名首轮（即使 policy.anonymous_first_round 关闭）", () => {
    const policy: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      anonymous_first_round: false,
      category_sensitivity: [{ category: "medical", anonymous_first_round: true }],
    };
    const decision = judgeFanout(policy, {
      profiles: [A],
      trust: trust({ "a.example": "T2" }),
      category: "medical",
      round: 1,
    });
    expect(decision.recipients[0]?.tier).toBe("anonymous");
  });

  it("round 2 对敏感品类信任不足的短名单候选封顶为匿名档", () => {
    const policy: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      category_sensitivity: [{ category: "medical", minimum_trust: "T2" }],
    };
    const decision = judgeFanout(policy, {
      profiles: [A, B],
      trust: trust({ "a.example": "T2", "b.example": "T1" }),
      category: "medical",
      round: 2,
    });
    expect(decision.recipients.find((r) => r.identity === "a.example")?.tier).toBe("detailed");
    expect(decision.recipients.find((r) => r.identity === "b.example")?.tier).toBe("anonymous");
  });

  it("非敏感品类不触发门槛提升", () => {
    const policy: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      minimum_trust: "T1",
      category_sensitivity: [{ category: "medical", minimum_trust: "T2" }],
    };
    const decision = judgeFanout(policy, {
      profiles: [A, B],
      trust: trust({ "a.example": "T2", "b.example": "T1" }),
      category: "office-supplies",
      round: 1,
    });
    expect(decision.category_sensitive).toBe(false);
    expect(decision.recipients.map((r) => r.identity)).toEqual(["a.example", "b.example"]);
  });
});

describe("判定确定性", () => {
  it("同输入两次判定输出完全一致", () => {
    const policy: FanoutPolicy = {
      ...DEFAULT_FANOUT_POLICY,
      max_recipients: 3,
      category_sensitivity: [{ category: "medical", minimum_trust: "T2" }],
    };
    const input: import("../src/fanout/policy.js").FanoutJudgeInput = {
      profiles: [E, A, C, D, B],
      trust: trust({
        "a.example": "T3",
        "b.example": "T2",
        "c.example": "T1",
        "d.example": "rejected",
        "e.example": "T2",
      }),
      category: "medical-device",
      round: 1,
    };
    expect(judgeFanout(policy, input)).toEqual(judgeFanout(policy, input));
  });
});
