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
