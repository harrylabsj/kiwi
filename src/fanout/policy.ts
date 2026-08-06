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
 * fanout — RFQ Fan-out 隐私策略（基线 §30）。
 *
 * Fan-out 受 max_recipients / minimum_trust / disclosure_profile /
 * anonymous_first_round / category_sensitivity 控制（§30）。本模块实现
 * FanoutPolicy 类型 + 确定性判定函数 judgeFanout：
 *
 *   输入候选 CounterpartyProfile 集合（含每人的 TrustRecord 推导 trust level）
 *   → 输出接受者集合 + 每人的披露档位（DisclosureTier）。
 *
 * 判定规则确定、可测、无模型参与：
 *   - minimum_trust 过滤（eligibility，§30）：record 缺失按 T0 判定；rejected
 *     对端直接排除（fail-closed，§4.6）；只按 base minimum_trust 过滤，敏感品类
 *     不改变谁能收 RFQ；
 *   - category_sensitivity 提升披露门槛（disclosure gate）：命中敏感品类时
 *     round 1 强制匿名首轮；round 2 对信任低于 sensitivity.minimum_trust 的
 *     接收者封顶为匿名档（拿不到精确数量/交期）；
 *   - max_recipients 截断：先按 trust 降序 + identity 升序确定性排序，再取前 N，
 *     其余以 reason=truncated 记录；
 *   - 每人的披露档位由 round（1 匿名首轮 / 2 Top N 精化）与敏感性共同决定
 *     （§30 推荐 progressive disclosure，而非默认广播完整需求）。
 *
 * §28 语义沿用：trust level 只控制协议/自动化风险，不构成产品推荐等级。
 */

import type { CounterpartyProfile } from "../counterparty/index.js";
import { trustLevelRank } from "../trust/identity/index.js";
import type { TrustLevel } from "../trust/identity/index.js";

/** 披露档位：anonymous = 匿名首轮（SKU + 数量区间，无精确数量/交期/身份线索）；detailed = Top N 后的精确数量 + 交期要求。 */
export type DisclosureTier = "anonymous" | "detailed";

export const DISCLOSURE_TIERS: readonly DisclosureTier[] = ["anonymous", "detailed"];

/** §29 NetworkDisclosurePolicy 控制的属性清单。 */
export const DISCLOSURE_ATTRIBUTES = [
  "location_precision",
  "organization_identity",
  "buyer_urgency",
  "contact_information",
  "purchase_quantity",
  "budget_hints",
  "customer_segment",
  "historical_preferences",
] as const;
export type DisclosureAttribute = (typeof DISCLOSURE_ATTRIBUTES)[number];

/** 披露档位（§30）：只声明「哪些 §29 属性允许公开」；余者一律私有。 */
export interface DisclosureProfile {
  allowed_attributes: readonly DisclosureAttribute[];
}

/** 默认披露档位：仅允许采购数量（round 2 精确数量）。预算/急迫度/身份等默认私有（§4.4）。 */
export const DEFAULT_DISCLOSURE_PROFILE: DisclosureProfile = {
  allowed_attributes: ["purchase_quantity"],
};

/** 敏感品类规则：匹配 category 时提升披露门槛（§30）。 */
export interface CategorySensitivity {
  /** 品类匹配（大小写不敏感子串；缺省匹配任意品类）。 */
  category?: string;
  /** 敏感品类的最低信任要求（与 policy.minimum_trust 取更严格者）。 */
  minimum_trust?: TrustLevel;
  /** 敏感品类是否强制匿名首轮（无论 policy.anonymous_first_round）。 */
  anonymous_first_round?: boolean;
}

/** §30 五个控制字段。max_recipients 缺省不限；minimum_trust 必填。 */
export interface FanoutPolicy {
  /** 接收者上限；0/负数视为不限。 */
  max_recipients?: number;
  /** 默认最低信任要求；无 record 对端按 T0 判定。 */
  minimum_trust: TrustLevel;
  /** §29 属性 allowlist（detailed 档的可选项）。 */
  disclosure_profile: DisclosureProfile;
  /** 匿名首轮：round 1 向所有接收者发匿名档（progressive disclosure）。 */
  anonymous_first_round?: boolean;
  /** 敏感品类提升披露门槛。 */
  category_sensitivity?: readonly CategorySensitivity[];
}

/** 默认部署策略：推荐 progressive disclosure（§30），最多 5 家、最低 T1。 */
export const DEFAULT_FANOUT_POLICY: FanoutPolicy = {
  max_recipients: 5,
  minimum_trust: "T1",
  disclosure_profile: DEFAULT_DISCLOSURE_PROFILE,
  anonymous_first_round: true,
};

/** 每人信任信号：level + rejected（来自 TrustRecord 评估）；缺省 undefined → T0 且不拒绝。 */
export interface FanoutTrustSignal {
  level: TrustLevel;
  rejected?: boolean;
}

export type FanoutTrustInput = Readonly<Record<string, FanoutTrustSignal | undefined>>;

export interface FanoutRecipient {
  identity: string;
  profile: CounterpartyProfile;
  /** 解析后的信任等级（record 缺失 → T0）。 */
  trust_level: TrustLevel;
  /** 该轮次给此接收者的披露档位。 */
  tier: DisclosureTier;
}

export type FanoutExcludeReason = "rejected" | "below_minimum_trust" | "truncated";

export interface FanoutExcluded {
  identity: string;
  reason: FanoutExcludeReason;
  trust_level: TrustLevel;
}

export interface FanoutDecision {
  round: 1 | 2;
  /** 通过过滤 + 截断的接收者（确定性排序：trust 降序 → identity 升序）。 */
  recipients: FanoutRecipient[];
  /** 被过滤/截断的候选（reason 明确，供审计）。 */
  excluded: FanoutExcluded[];
  /** 过滤后、截断前的候选数（diagnostic）。 */
  eligible_count: number;
  /** 本次判定是否命中敏感品类。 */
  category_sensitive: boolean;
}

export interface FanoutJudgeInput {
  profiles: CounterpartyProfile[];
  /** identity → 信任信号；undefined = 无 TrustRecord → T0（§30）。 */
  trust?: FanoutTrustInput;
  /** 品类（category_sensitivity 匹配用）。 */
  category?: string;
  /** 轮次：1 = 匿名首轮，2 = Top N 后精化。决定每档 tier。 */
  round: 1 | 2;
}

/** 取更严格（更高 rank）的信任要求：T3 比 T0 更严格。通用工具，供策略组合使用。 */
export function stricterTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return trustLevelRank(a) >= trustLevelRank(b) ? a : b;
}

/** 命中敏感品类规则（大小写不敏感子串匹配；缺省 rule 匹配任意品类）。 */
export function matchingCategorySensitivity(
  policy: FanoutPolicy,
  category: string | undefined,
): CategorySensitivity | undefined {
  if (policy.category_sensitivity === undefined) return undefined;
  const cat = category?.toLowerCase();
  return policy.category_sensitivity.find((rule) => {
    if (rule.category === undefined) return true;
    if (cat === undefined) return false;
    return cat.includes(rule.category.toLowerCase());
  });
}

function tierFor(
  level: TrustLevel,
  round: 1 | 2,
  anonymousFirstRound: boolean,
  sensitive: CategorySensitivity | undefined,
): DisclosureTier {
  if (round === 1) {
    return anonymousFirstRound ? "anonymous" : "detailed";
  }
  // round 2：敏感品类且对端信任不足 → 披露门槛提升，只能拿匿名档。
  if (
    sensitive?.minimum_trust !== undefined &&
    trustLevelRank(level) < trustLevelRank(sensitive.minimum_trust)
  ) {
    return "anonymous";
  }
  return "detailed";
}

/**
 * Fan-out 确定性判定（§30）。纯函数、无模型参与、无 I/O。
 *
 * 管线：解析信任 → 过滤（rejected / below_minimum_trust，按 base minimum_trust）
 * → 确定性排序 → 截断（max_recipients）→ 按 round + 敏感性定每档 tier。
 */
export function judgeFanout(policy: FanoutPolicy, input: FanoutJudgeInput): FanoutDecision {
  const { profiles, trust = {}, category, round } = input;
  const sensitive = matchingCategorySensitivity(policy, category);
  // Eligibility 只按 base minimum_trust 过滤；category_sensitivity 只提升披露门槛
  // （tier），不改变谁能收 RFQ。
  const minTrust = policy.minimum_trust;

  const eligible: { identity: string; profile: CounterpartyProfile; level: TrustLevel }[] = [];
  const excluded: FanoutExcluded[] = [];

  for (const profile of profiles) {
    const signal = trust[profile.identity];
    // §30：record 缺失按 T0；rejected 直接排除（fail-closed）。
    const level = signal?.level ?? "T0";
    const rejected = signal?.rejected === true;
    if (rejected) {
      excluded.push({ identity: profile.identity, reason: "rejected", trust_level: level });
      continue;
    }
    if (trustLevelRank(level) < trustLevelRank(minTrust)) {
      excluded.push({
        identity: profile.identity,
        reason: "below_minimum_trust",
        trust_level: level,
      });
      continue;
    }
    eligible.push({ identity: profile.identity, profile, level });
  }

  // 确定性排序：trust 降序（高信任优先）→ identity 升序（稳定 tie-break）。
  eligible.sort((a, b) => {
    const rankDelta = trustLevelRank(b.level) - trustLevelRank(a.level);
    if (rankDelta !== 0) return rankDelta;
    return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
  });

  const max =
    policy.max_recipients !== undefined && policy.max_recipients > 0
      ? policy.max_recipients
      : Number.POSITIVE_INFINITY;
  const chosen = eligible.slice(0, max);
  for (const t of eligible.slice(max)) {
    excluded.push({ identity: t.identity, reason: "truncated", trust_level: t.level });
  }

  const anonymousFirstRound =
    policy.anonymous_first_round === true || sensitive?.anonymous_first_round === true;

  const recipients: FanoutRecipient[] = chosen.map((c) => ({
    identity: c.identity,
    profile: c.profile,
    trust_level: c.level,
    tier: tierFor(c.level, round, anonymousFirstRound, sensitive),
  }));

  return {
    round,
    recipients,
    excluded,
    eligible_count: eligible.length,
    category_sensitive: sensitive !== undefined,
  };
}
