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
 * trust/records — 评估器（从事实观察推导 trust_level 建议值，基线 §27 / §28）。
 *
 * 评估规则确定、可测、无模型参与：
 *   - 初始 T0；
 *   - 成功交换 ≥ successToT1 → T1（成功发现/交互）；
 *   - 连续验签成功 ≥ consecutiveVerifiedToT2 → T2（验签身份连续有效）；
 *   - 对端在 establishedRelationships（部署配置）→ T3；
 *   - signature_failure / replay 超阈值，或存在 third_party_adjudicated 争议
 *     → 拒绝（rejected），level 置 T0（fail-closed，§4.6）；
 *   - 未解决争议保守封顶：mutually_acknowledged → 封顶 T1；local_asserted → 封顶 T2。
 *
 * 维度分离（§27/§28）：trust level 只控制协议/自动化风险。dispute 是 reputation
 * 维度 —— 评估器只对已知事实做保守封顶/拒绝，不把本地单方标记伪装成全球事实，
 * 也不让 reputation 直接写进协议 level。reputation 以 ReputationSignal 透传，
 * 无数据时 Ranker 侧拿到显式 unknown（绝不 0.5）。
 */

import { trustLevelRank, type TrustLevel } from "../identity/trust-policy.js";
import type {
  CounterpartyTrustRecord,
  DisputeClassification,
  ReputationSignal,
  ReputationSource,
  TrustRecordFacts,
} from "./types.js";

export interface TrustEvaluatorConfig {
  /** 成功交换 ≥ 此值 → T1（成功发现/交互）。默认 1。 */
  successToT1: number;
  /** 连续验签成功 ≥ 此值 → T2（验签身份连续有效）。默认 3。 */
  consecutiveVerifiedToT2: number;
  /** signature_failure ≥ 此值 → 拒绝。默认 3。 */
  signatureFailureRejectThreshold: number;
  /** replay ≥ 此值 → 拒绝。默认 2。 */
  replayRejectThreshold: number;
}

export const DEFAULT_TRUST_EVALUATOR_CONFIG: TrustEvaluatorConfig = {
  successToT1: 1,
  consecutiveVerifiedToT2: 3,
  signatureFailureRejectThreshold: 3,
  replayRejectThreshold: 2,
};

export type EvaluationRule =
  | "initial_t0"
  | "successful_exchange_t1"
  | "signature_continuity_t2"
  | "established_relationship_t3"
  | "rejected_signature_failures"
  | "rejected_replay"
  | "rejected_adjudicated_dispute"
  | "capped_mutual_dispute"
  | "capped_local_dispute";

export interface EvaluationResult {
  /** 建议 trust level（T0-T3）。 */
  level: TrustLevel;
  /** 拒绝建议（超硬阈值 / 已裁决争议）：调用方应拒绝自动化交互。 */
  rejected: boolean;
  reason?: string;
  /** 生效的评估规则（升级路径 / 拒绝 / 封顶，diagnostic）。 */
  applied: EvaluationRule[];
  /** §27 Commercial Reputation：无数据必须是显式 unknown，绝不返回 0.5。 */
  reputation: ReputationSignal;
}

export interface EvaluateOptions {
  config?: TrustEvaluatorConfig;
  /** 已建立关系标记（部署配置）：在此集合中的对端 → T3。 */
  establishedRelationships?: ReadonlySet<string>;
  /** Reputation 来源；缺省恒返回显式 unknown。 */
  reputation?: ReputationSource;
}

/** 无 reputation 数据的默认来源：恒返回显式 unknown（§27：绝不 0.5）。 */
export const NO_REPUTATION: ReputationSource = {
  score: () => ({ status: "unknown" }),
};

/** 把 record 转成 evaluatePolicy 的 record 输入（WP1 集成，见 trust-policy.ts）。 */
export function recordPolicyInput(record: CounterpartyTrustRecord): {
  trustLevel: TrustLevel;
  rejected: boolean;
} {
  return { trustLevel: record.trust_level, rejected: record.rejected };
}

function hasDispute(record: TrustRecordFacts, classification: DisputeClassification): boolean {
  return record.local_asserted_disputes.some((d) => d.classification === classification);
}

function hasUnresolvedDispute(
  record: TrustRecordFacts,
  classification: DisputeClassification,
): boolean {
  return record.local_asserted_disputes.some(
    (d) => d.classification === classification && d.resolved !== true,
  );
}

/**
 * 从事实推导 trust_level 建议值（纯函数，无模型参与）。输入是 record 的事实面，
 * 结论字段（trust_level / rejected / evaluated_at）不参与推导。
 */
export function evaluateTrustRecord(
  record: TrustRecordFacts,
  options: EvaluateOptions = {},
): EvaluationResult {
  const cfg = options.config ?? DEFAULT_TRUST_EVALUATOR_CONFIG;
  const reputation =
    options.reputation?.score(record.counterparty_identity) ??
    NO_REPUTATION.score(record.counterparty_identity);

  // 1. 拒绝门（硬阈值，先于升级判定，fail-closed）。
  if (record.signature_failure_count >= cfg.signatureFailureRejectThreshold) {
    return {
      level: "T0",
      rejected: true,
      reason: `signature_failure_count ${record.signature_failure_count} >= ${cfg.signatureFailureRejectThreshold}`,
      applied: ["rejected_signature_failures"],
      reputation,
    };
  }
  if (record.replay_detected_count >= cfg.replayRejectThreshold) {
    return {
      level: "T0",
      rejected: true,
      reason: `replay_detected_count ${record.replay_detected_count} >= ${cfg.replayRejectThreshold}`,
      applied: ["rejected_replay"],
      reputation,
    };
  }
  if (hasDispute(record, "third_party_adjudicated")) {
    return {
      level: "T0",
      rejected: true,
      reason: "third_party_adjudicated dispute on record (adjudicated against counterparty)",
      applied: ["rejected_adjudicated_dispute"],
      reputation,
    };
  }

  // 2. 升级路径（一次性取最高）。
  let level: TrustLevel;
  const applied: EvaluationRule[] = [];
  if (options.establishedRelationships?.has(record.counterparty_identity)) {
    level = "T3";
    applied.push("established_relationship_t3");
  } else if (record.consecutive_verified_exchanges >= cfg.consecutiveVerifiedToT2) {
    level = "T2";
    applied.push("signature_continuity_t2");
  } else if (record.successful_exchanges >= cfg.successToT1) {
    level = "T1";
    applied.push("successful_exchange_t1");
  } else {
    level = "T0";
    applied.push("initial_t0");
  }

  // 3. 未解决争议保守封顶（只降不升）。
  if (
    hasUnresolvedDispute(record, "mutually_acknowledged") &&
    trustLevelRank(level) > trustLevelRank("T1")
  ) {
    level = "T1";
    applied.push("capped_mutual_dispute");
  }
  if (
    hasUnresolvedDispute(record, "local_asserted") &&
    trustLevelRank(level) > trustLevelRank("T2")
  ) {
    level = "T2";
    applied.push("capped_local_dispute");
  }

  return { level, rejected: false, applied, reputation };
}
