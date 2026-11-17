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
 * TOP1 经验学习域类型（设计 v1.1 §5 / §17.2）。
 *
 * 纠正、案例、候选分别管理：纠正编辑产生新 revision；已生成案例/候选在
 * 纠正变化后标记 STALE；候选的正文、评测、审核与发布在 M2-3/M2-5 扩展，
 * 本文件先固定状态机与命令结果形状。
 */

import type {
  CompiledReceptionSkill,
  ReceptionSkillStep,
  ReceptionSkillTool,
} from "../../a2a/reception/skill-contract.js";

export const CORRECTION_STATUSES = ["DRAFT", "CASE_CREATED", "STALE"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export const CASE_STATUSES = ["ACTIVE", "STALE"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CANDIDATE_STATES = [
  "DRAFT",
  "EVALUATING",
  "EVALUATION_FAILED",
  "READY_FOR_REVIEW",
  "APPROVED",
  "REJECTED",
  "STALE",
  "EXPIRED",
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export type LearningErrorCode =
  | "validation"
  | "sensitive_content"
  | "access_denied"
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "unsupported_capability"
  | "schema_unavailable";

export class LearningError extends Error {
  readonly code: LearningErrorCode;
  /** 稳定原因码（进 trace/审计，不进客户可见文案）。 */
  readonly reason: string;

  constructor(code: LearningErrorCode, reason: string, message: string) {
    super(message);
    this.name = "LearningError";
    this.code = code;
    this.reason = reason;
  }
}

export interface LearningCorrection {
  readonly correction_id: string;
  readonly merchant_id: string;
  readonly actor_id: string;
  readonly revision: number;
  readonly status: CorrectionStatus;
  readonly correction_text: string;
  readonly issue_tags: readonly string[];
  readonly case_refs: readonly string[];
  readonly base_release_id: string | null;
  readonly content_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LearningCase {
  readonly case_id: string;
  readonly merchant_id: string;
  readonly correction_id: string;
  readonly revision: number;
  readonly status: CaseStatus;
  readonly source_refs: readonly string[];
  readonly outcome_refs: readonly string[];
  readonly issue_tags: readonly string[];
  readonly content_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LearningCandidate {
  readonly candidate_id: string;
  readonly merchant_id: string;
  readonly revision: number;
  readonly state: CandidateState;
  readonly skill_key: string;
  readonly audience: "customer_reception";
  readonly base_release_id: string | null;
  readonly case_ids: readonly string[];
  readonly trigger_text: string;
  readonly proposed_steps: readonly ReceptionSkillStep[];
  readonly exclusions: readonly string[];
  readonly reason: string;
  readonly required_tools: readonly ReceptionSkillTool[];
  readonly question_schema_version: number;
  readonly tool_contract_digest: string;
  /** 评测前冻结的可加载产物；发布只核验并激活，不重新生成。 */
  readonly compiled_artifact: CompiledReceptionSkill;
  readonly compiled_artifact_hash: string;
  readonly compiler_version: string;
  readonly content_digest: string;
  readonly eval_report_id: string | null;
  readonly reviewer_id: string | null;
  readonly approval_ref: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 写命令幂等：同 command_id 同摘要返回原结果，异摘要 idempotency_conflict。 */
export interface LearningCommandOptions {
  readonly command_id?: string;
}

export const EVALUATION_STATES = [
  "EVALUATING",
  "READY_FOR_REVIEW",
  "EVALUATION_FAILED",
  "STALE",
] as const;
export type EvaluationState = (typeof EVALUATION_STATES)[number];

export const EVALUATION_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "interrupted",
  "paused_budget",
] as const;
export type EvaluationRunStatus = (typeof EVALUATION_RUN_STATUSES)[number];

export interface EvaluationAttemptResult {
  readonly variant: "baseline" | "candidate";
  readonly attempt: number;
  readonly passed: boolean;
  readonly hard_gate_failures: number;
  readonly improvement_delta?: number;
  readonly trace_ref?: string;
}

export interface EvaluationScenarioResult {
  readonly scenario_id: string;
  readonly kind: "target" | "adjacent" | "boundary";
  readonly repetitions: number;
  readonly attempts: readonly EvaluationAttemptResult[];
}

export interface EvaluationResults {
  readonly scenarios: Readonly<Record<string, EvaluationScenarioResult>>;
}

export interface EvaluationReport {
  readonly suite_version: string;
  readonly artifact_hash: string;
  readonly content_digest: string;
  readonly planned_runs: number;
  readonly runs_completed: number;
  readonly budget_cap: number;
  readonly hard_gate_failures: number;
  readonly target: { readonly total: number; readonly passed: number };
  readonly adjacent: {
    readonly total: number;
    readonly baseline_passed: number;
    readonly candidate_passed: number;
  };
  readonly boundary: { readonly total: number; readonly passed: number };
  readonly improvement_delta_max: number;
  readonly require_improvement: boolean;
  readonly verdict: "pass" | "fail";
  readonly failure_reasons: readonly string[];
}

export interface LearningReview {
  readonly review_id: string;
  readonly merchant_id: string;
  readonly candidate_id: string;
  readonly candidate_revision: number;
  readonly content_hash: string;
  readonly artifact_hash: string;
  readonly compiler_version: string;
  readonly question_schema_version: number;
  readonly tool_contract_digest: string;
  readonly eval_report_id: string;
  readonly reviewer_id: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly approval_ref: string;
  readonly reason: string | null;
  readonly approved_at: string;
  readonly expires_at: string;
  readonly created_at: string;
}

export type ReleaseState = "ACTIVE" | "RETIRED" | "REVOKED";

export interface SkillRelease {
  readonly release_id: string;
  readonly merchant_id: string;
  readonly skill_key: string;
  readonly trigger_text: string;
  readonly generation: number;
  readonly state: ReleaseState;
  readonly artifact_hash: string;
  readonly content_hash: string;
  readonly compiled_artifact: CompiledReceptionSkill;
  readonly candidate_id: string;
  readonly candidate_revision: number;
  readonly compiler_version: string;
  readonly question_schema_version: number;
  readonly tool_contract_digest: string;
  readonly eval_report_id: string;
  readonly approval_ref: string;
  readonly revocation_epoch: number;
  readonly retired_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SkillActivePointer {
  readonly merchant_id: string;
  readonly skill_key: string;
  readonly release_id: string | null;
  readonly generation: number;
  readonly updated_at: string;
}

export interface LearningEvaluation {
  readonly evaluation_id: string;
  readonly merchant_id: string;
  readonly candidate_id: string;
  readonly candidate_revision: number;
  readonly artifact_hash: string;
  readonly content_digest: string;
  readonly suite_version: string;
  readonly state: EvaluationState;
  readonly run_status: EvaluationRunStatus;
  readonly runs_completed: number;
  readonly budget_cap: number;
  readonly results: EvaluationResults;
  readonly report: EvaluationReport | null;
  readonly created_at: string;
  readonly updated_at: string;
}
