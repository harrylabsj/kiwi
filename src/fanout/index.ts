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
