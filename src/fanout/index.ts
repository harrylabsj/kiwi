/**
 * fanout — WP2 RFQ Fan-out 隐私策略 + 多商家 RFQ 编排（基线 §30 / §29 / §4.4 / §16 / §19）。
 *
 * 子模块：
 *   - policy.ts         FanoutPolicy 类型 + 确定性判定（max_recipients /
 *                       minimum_trust / disclosure_profile /
 *                       anonymous_first_round / category_sensitivity）；
 *   - disclosure.ts     渐进披露构造器（anonymous / detailed 档，私有字段结构性排除）；
 *   - orchestrator.ts   多商家并行 RFQ + 超时 Offer 收集 + 部分失败容忍 +
 *                       比较集聚合（每腿独立 Ledger 链与幂等键）。
 */

export {
  DEFAULT_DISCLOSURE_PROFILE,
  DEFAULT_FANOUT_POLICY,
  DISCLOSURE_ATTRIBUTES,
  DISCLOSURE_TIERS,
  judgeFanout,
  matchingCategorySensitivity,
  stricterTrust,
} from "./policy.js";
export type {
  CategorySensitivity,
  DisclosureAttribute,
  DisclosureProfile,
  DisclosureTier,
  FanoutDecision,
  FanoutExcludeReason,
  FanoutExcluded,
  FanoutJudgeInput,
  FanoutPolicy,
  FanoutRecipient,
  FanoutTrustInput,
  FanoutTrustSignal,
} from "./policy.js";

export {
  ALWAYS_PRIVATE_ATTRIBUTES,
  FanoutDisclosureError,
  buildDisclosedRfq,
  rangeMidpoint,
  validateNetworkDisclosure,
} from "./disclosure.js";
export type {
  AnonymousRfqPayload,
  DetailedRfqPayload,
  DisclosedRfqPayload,
  DisclosureBuildInput,
  DisclosureValidationResult,
  QuantityRange,
  RfqIntent,
  RfqIntentItem,
} from "./disclosure.js";

export {
  DEFAULT_FANOUT_CAPABILITY,
  DEFAULT_FANOUT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  FanoutOrchestrator,
  buildComparisonSet,
  compareRows,
  extractDelivery,
  extractKnpEnvelopeFromState,
  extractUnitPrice,
} from "./orchestrator.js";
export type {
  FanoutComparisonRow,
  FanoutLegResult,
  FanoutLegSpec,
  FanoutOrchestratorDeps,
  FanoutResult,
  LegOutcomeKind,
} from "./orchestrator.js";
