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
 * trust/records — WP1 CounterpartyTrustRecord（对端信任记录）。
 *
 * 观察是事实，评估是结论，两者分离：TrustRecordStore.observe 只聚合事实；
 * 评估器从事实推导 trust_level 建议值（T0-T3）。TrustPolicy 可选用 record 作为
 * 输入（trust-policy.ts 的 PolicyEvaluationInput.record）。
 */

export { TrustRecordStore } from "./store.js";
export type { EvaluateResult, ObservationResult, TrustRecordStoreOptions } from "./store.js";

export {
  DEFAULT_TRUST_EVALUATOR_CONFIG,
  evaluateTrustRecord,
  NO_REPUTATION,
  recordPolicyInput,
} from "./evaluator.js";
export type {
  EvaluateOptions,
  EvaluationResult,
  EvaluationRule,
  TrustEvaluatorConfig,
} from "./evaluator.js";

export {
  computeAgentCardFingerprint,
  DISPUTE_CLASSIFICATIONS,
  TRUST_RECORD_SCHEMA_VERSION,
} from "./types.js";
export type {
  AgentCardIdentityMaterial,
  CounterpartyTrustRecord,
  DisputeClassification,
  DisputeRecord,
  ObservationKind,
  ReputationSignal,
  ReputationSource,
  TrustObservation,
  TrustRecordFacts,
} from "./types.js";
