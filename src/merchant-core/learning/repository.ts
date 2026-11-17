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
 * 学习域持久化（learning 账本 v1，设计 §18.1 / M2-0）。
 *
 * 所有查询带 merchant 作用域；写入由 service 放进 `inImmediateTransaction`
 * 与幂等复查同事务。本文件不校验业务规则，只做行映射与 SQL。
 */

import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";
import type {
  CandidateState,
  CaseStatus,
  CorrectionStatus,
  LearningCandidate,
  LearningCase,
  LearningCorrection,
  LearningEvaluation,
  LearningReview,
  SkillActivePointer,
  SkillRelease,
} from "./types.js";

interface CorrectionRow {
  correction_id: string;
  merchant_id: string;
  actor_id: string;
  revision: number;
  status: CorrectionStatus;
  correction_text: string;
  issue_tags_json: string;
  case_refs_json: string;
  base_release_id: string | null;
  content_digest: string;
  created_at: string;
  updated_at: string;
}

interface CaseRow {
  case_id: string;
  merchant_id: string;
  correction_id: string;
  revision: number;
  status: CaseStatus;
  source_refs_json: string;
  outcome_refs_json: string;
  issue_tags_json: string;
  content_digest: string;
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  candidate_id: string;
  merchant_id: string;
  revision: number;
  state: CandidateState;
  skill_key: string;
  audience: "customer_reception";
  base_release_id: string | null;
  trigger_text: string;
  proposed_steps_json: string;
  exclusions_json: string;
  reason: string;
  required_tools_json: string;
  question_schema_version: number;
  tool_contract_digest: string;
  compiled_artifact_json: string;
  compiled_artifact_hash: string;
  compiler_version: string;
  content_digest: string;
  eval_report_id: string | null;
  reviewer_id: string | null;
  approval_ref: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseStringArray(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function correctionToRecord(row: CorrectionRow): LearningCorrection {
  return {
    correction_id: row.correction_id,
    merchant_id: row.merchant_id,
    actor_id: row.actor_id,
    revision: row.revision,
    status: row.status,
    correction_text: row.correction_text,
    issue_tags: parseStringArray(row.issue_tags_json),
    case_refs: parseStringArray(row.case_refs_json),
    base_release_id: row.base_release_id,
    content_digest: row.content_digest,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function caseToRecord(row: CaseRow): LearningCase {
  return {
    case_id: row.case_id,
    merchant_id: row.merchant_id,
    correction_id: row.correction_id,
    revision: row.revision,
    status: row.status,
    source_refs: parseStringArray(row.source_refs_json),
    outcome_refs: parseStringArray(row.outcome_refs_json),
    issue_tags: parseStringArray(row.issue_tags_json),
    content_digest: row.content_digest,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface EvaluationRow {
  evaluation_id: string;
  merchant_id: string;
  candidate_id: string;
  candidate_revision: number;
  artifact_hash: string;
  content_digest: string;
  suite_version: string;
  state: LearningEvaluation["state"];
  run_status: LearningEvaluation["run_status"];
  runs_completed: number;
  budget_cap: number;
  results_json: string;
  report_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ReleaseRow {
  release_id: string;
  merchant_id: string;
  skill_key: string;
  trigger_text: string;
  generation: number;
  state: SkillRelease["state"];
  artifact_hash: string;
  content_hash: string;
  compiled_artifact_json: string;
  candidate_id: string;
  candidate_revision: number;
  compiler_version: string;
  question_schema_version: number;
  tool_contract_digest: string;
  eval_report_id: string;
  approval_ref: string;
  revocation_epoch: number;
  retired_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function releaseToRecord(row: ReleaseRow): SkillRelease {
  return {
    release_id: row.release_id,
    merchant_id: row.merchant_id,
    skill_key: row.skill_key,
    trigger_text: row.trigger_text,
    generation: row.generation,
    state: row.state,
    artifact_hash: row.artifact_hash,
    content_hash: row.content_hash,
    compiled_artifact: JSON.parse(
      row.compiled_artifact_json,
    ) as SkillRelease["compiled_artifact"],
    candidate_id: row.candidate_id,
    candidate_revision: row.candidate_revision,
    compiler_version: row.compiler_version,
    question_schema_version: row.question_schema_version,
    tool_contract_digest: row.tool_contract_digest,
    eval_report_id: row.eval_report_id,
    approval_ref: row.approval_ref,
    revocation_epoch: row.revocation_epoch,
    retired_at: row.retired_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function evaluationToRecord(row: EvaluationRow): LearningEvaluation {
  return {
    evaluation_id: row.evaluation_id,
    merchant_id: row.merchant_id,
    candidate_id: row.candidate_id,
    candidate_revision: row.candidate_revision,
    artifact_hash: row.artifact_hash,
    content_digest: row.content_digest,
    suite_version: row.suite_version,
    state: row.state,
    run_status: row.run_status,
    runs_completed: row.runs_completed,
    budget_cap: row.budget_cap,
    results: JSON.parse(row.results_json) as LearningEvaluation["results"],
    report:
      row.report_json === null
        ? null
        : (JSON.parse(row.report_json) as LearningEvaluation["report"]),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function candidateToRecord(row: CandidateRow, caseIds: string[]): LearningCandidate {
  return {
    candidate_id: row.candidate_id,
    merchant_id: row.merchant_id,
    revision: row.revision,
    state: row.state,
    skill_key: row.skill_key,
    audience: row.audience,
    base_release_id: row.base_release_id,
    case_ids: caseIds,
    trigger_text: row.trigger_text,
    proposed_steps: JSON.parse(row.proposed_steps_json) as LearningCandidate["proposed_steps"],
    exclusions: parseStringArray(row.exclusions_json),
    reason: row.reason,
    required_tools: JSON.parse(row.required_tools_json) as LearningCandidate["required_tools"],
    question_schema_version: row.question_schema_version,
    tool_contract_digest: row.tool_contract_digest,
    compiled_artifact: JSON.parse(
      row.compiled_artifact_json,
    ) as LearningCandidate["compiled_artifact"],
    compiled_artifact_hash: row.compiled_artifact_hash,
    compiler_version: row.compiler_version,
    content_digest: row.content_digest,
    eval_report_id: row.eval_report_id,
    reviewer_id: row.reviewer_id,
    approval_ref: row.approval_ref,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class LearningRepository {
  private readonly db: DatabaseSync;

  constructor(options: { db: DatabaseSync }) {
    this.db = options.db;
  }

  transaction<T>(work: () => T): T {
    return inImmediateTransaction(this.db, work);
  }

  readCorrection(merchantId: string, correctionId: string): LearningCorrection | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_corrections WHERE merchant_id = ? AND correction_id = ?")
      .get(merchantId, correctionId) as unknown as CorrectionRow | undefined;
    return row === undefined ? undefined : correctionToRecord(row);
  }

  listCorrections(merchantId: string, limit: number): LearningCorrection[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM learning_corrections
          WHERE merchant_id = ?
          ORDER BY updated_at DESC, correction_id ASC
          LIMIT ?`,
      )
      .all(merchantId, limit) as unknown as CorrectionRow[];
    return rows.map(correctionToRecord);
  }

  insertCorrection(record: LearningCorrection): void {
    this.db
      .prepare(
        `INSERT INTO learning_corrections
          (correction_id, merchant_id, actor_id, revision, status, correction_text,
           issue_tags_json, case_refs_json, base_release_id, content_digest,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.correction_id,
        record.merchant_id,
        record.actor_id,
        record.revision,
        record.status,
        record.correction_text,
        JSON.stringify(record.issue_tags),
        JSON.stringify(record.case_refs),
        record.base_release_id,
        record.content_digest,
        record.created_at,
        record.updated_at,
      );
  }

  updateCorrection(record: LearningCorrection): void {
    this.db
      .prepare(
        `UPDATE learning_corrections
            SET revision = ?, status = ?, correction_text = ?, issue_tags_json = ?,
                case_refs_json = ?, base_release_id = ?, content_digest = ?, updated_at = ?
          WHERE merchant_id = ? AND correction_id = ?`,
      )
      .run(
        record.revision,
        record.status,
        record.correction_text,
        JSON.stringify(record.issue_tags),
        JSON.stringify(record.case_refs),
        record.base_release_id,
        record.content_digest,
        record.updated_at,
        record.merchant_id,
        record.correction_id,
      );
  }

  readCaseByCorrection(merchantId: string, correctionId: string): LearningCase | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_cases WHERE merchant_id = ? AND correction_id = ?")
      .get(merchantId, correctionId) as unknown as CaseRow | undefined;
    return row === undefined ? undefined : caseToRecord(row);
  }

  readCase(merchantId: string, caseId: string): LearningCase | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_cases WHERE merchant_id = ? AND case_id = ?")
      .get(merchantId, caseId) as unknown as CaseRow | undefined;
    return row === undefined ? undefined : caseToRecord(row);
  }

  insertCase(record: LearningCase): void {
    this.db
      .prepare(
        `INSERT INTO learning_cases
          (case_id, merchant_id, correction_id, revision, status, source_refs_json,
           outcome_refs_json, issue_tags_json, content_digest, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.case_id,
        record.merchant_id,
        record.correction_id,
        record.revision,
        record.status,
        JSON.stringify(record.source_refs),
        JSON.stringify(record.outcome_refs),
        JSON.stringify(record.issue_tags),
        record.content_digest,
        record.created_at,
        record.updated_at,
      );
  }

  updateCase(record: LearningCase): void {
    this.db
      .prepare(
        `UPDATE learning_cases
            SET revision = ?, status = ?, source_refs_json = ?, outcome_refs_json = ?,
                issue_tags_json = ?, content_digest = ?, updated_at = ?
          WHERE merchant_id = ? AND case_id = ?`,
      )
      .run(
        record.revision,
        record.status,
        JSON.stringify(record.source_refs),
        JSON.stringify(record.outcome_refs),
        JSON.stringify(record.issue_tags),
        record.content_digest,
        record.updated_at,
        record.merchant_id,
        record.case_id,
      );
  }

  /** 标记案例失效（纠正已变化）；返回受影响行数。 */
  markCaseStale(merchantId: string, caseId: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE learning_cases SET status = 'STALE', updated_at = ?
          WHERE merchant_id = ? AND case_id = ? AND status = 'ACTIVE'`,
      )
      .run(now, merchantId, caseId);
    return Number(result.changes);
  }

  /** 案例内容变化后旧候选失效（A16）。返回受影响行数。 */
  markCandidatesStaleForCase(merchantId: string, caseId: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE learning_candidates SET state = 'STALE', updated_at = ?
          WHERE merchant_id = ? AND state NOT IN ('STALE','EXPIRED')
            AND candidate_id IN (
              SELECT candidate_id FROM learning_candidate_cases
               WHERE merchant_id = ? AND case_id = ?)`,
      )
      .run(now, merchantId, merchantId, caseId);
    return Number(result.changes);
  }

  readCandidate(merchantId: string, candidateId: string): LearningCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_candidates WHERE merchant_id = ? AND candidate_id = ?")
      .get(merchantId, candidateId) as unknown as CandidateRow | undefined;
    if (row === undefined) return undefined;
    return candidateToRecord(row, this.readCandidateCaseIds(candidateId));
  }

  listCandidates(merchantId: string, limit: number): LearningCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM learning_candidates
          WHERE merchant_id = ?
          ORDER BY updated_at DESC, candidate_id ASC
          LIMIT ?`,
      )
      .all(merchantId, limit) as unknown as CandidateRow[];
    return rows.map((row) => candidateToRecord(row, this.readCandidateCaseIds(row.candidate_id)));
  }

  insertCandidate(record: LearningCandidate): void {
    this.db
      .prepare(
        `INSERT INTO learning_candidates
          (candidate_id, merchant_id, revision, state, skill_key, audience,
           base_release_id, trigger_text, proposed_steps_json, exclusions_json,
           reason, required_tools_json, question_schema_version, tool_contract_digest,
           compiled_artifact_json, compiled_artifact_hash, compiler_version,
           content_digest, eval_report_id, reviewer_id, approval_ref, expires_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.candidate_id,
        record.merchant_id,
        record.revision,
        record.state,
        record.skill_key,
        record.audience,
        record.base_release_id,
        record.trigger_text,
        JSON.stringify(record.proposed_steps),
        JSON.stringify(record.exclusions),
        record.reason,
        JSON.stringify(record.required_tools),
        record.question_schema_version,
        record.tool_contract_digest,
        JSON.stringify(record.compiled_artifact),
        record.compiled_artifact_hash,
        record.compiler_version,
        record.content_digest,
        record.eval_report_id,
        record.reviewer_id,
        record.approval_ref,
        record.expires_at,
        record.created_at,
        record.updated_at,
      );
  }

  updateCandidate(record: LearningCandidate): void {
    this.db
      .prepare(
        `UPDATE learning_candidates
            SET revision = ?, state = ?, skill_key = ?, audience = ?, base_release_id = ?,
                trigger_text = ?, proposed_steps_json = ?, exclusions_json = ?, reason = ?,
                required_tools_json = ?, question_schema_version = ?, tool_contract_digest = ?,
                compiled_artifact_json = ?, compiled_artifact_hash = ?, compiler_version = ?,
                content_digest = ?, eval_report_id = ?, reviewer_id = ?, approval_ref = ?,
                expires_at = ?, updated_at = ?
          WHERE merchant_id = ? AND candidate_id = ?`,
      )
      .run(
        record.revision,
        record.state,
        record.skill_key,
        record.audience,
        record.base_release_id,
        record.trigger_text,
        JSON.stringify(record.proposed_steps),
        JSON.stringify(record.exclusions),
        record.reason,
        JSON.stringify(record.required_tools),
        record.question_schema_version,
        record.tool_contract_digest,
        JSON.stringify(record.compiled_artifact),
        record.compiled_artifact_hash,
        record.compiler_version,
        record.content_digest,
        record.eval_report_id,
        record.reviewer_id,
        record.approval_ref,
        record.expires_at,
        record.updated_at,
        record.merchant_id,
        record.candidate_id,
      );
  }

  /** 重设候选的案例关联（编辑候选时整体替换）。 */
  replaceCandidateCases(input: {
    merchantId: string;
    candidateId: string;
    caseIds: readonly string[];
    now: string;
  }): void {
    this.db
      .prepare("DELETE FROM learning_candidate_cases WHERE candidate_id = ? AND merchant_id = ?")
      .run(input.candidateId, input.merchantId);
    const insert = this.db.prepare(
      `INSERT INTO learning_candidate_cases (candidate_id, merchant_id, case_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const caseId of input.caseIds) {
      insert.run(input.candidateId, input.merchantId, caseId, input.now);
    }
  }

  private readCandidateCaseIds(candidateId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT case_id FROM learning_candidate_cases WHERE candidate_id = ? ORDER BY case_id ASC",
      )
      .all(candidateId) as unknown as Array<{ case_id: string }>;
    return rows.map((row) => row.case_id);
  }

  readEvaluation(merchantId: string, evaluationId: string): LearningEvaluation | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_evaluations WHERE merchant_id = ? AND evaluation_id = ?")
      .get(merchantId, evaluationId) as unknown as EvaluationRow | undefined;
    return row === undefined ? undefined : evaluationToRecord(row);
  }

  findEvaluation(
    merchantId: string,
    candidateId: string,
    artifactHash: string,
    suiteVersion: string,
  ): LearningEvaluation | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM learning_evaluations
          WHERE merchant_id = ? AND candidate_id = ? AND artifact_hash = ? AND suite_version = ?`,
      )
      .get(merchantId, candidateId, artifactHash, suiteVersion) as unknown as
      | EvaluationRow
      | undefined;
    return row === undefined ? undefined : evaluationToRecord(row);
  }

  listEvaluations(merchantId: string, limit: number): LearningEvaluation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM learning_evaluations
          WHERE merchant_id = ?
          ORDER BY updated_at DESC, evaluation_id ASC
          LIMIT ?`,
      )
      .all(merchantId, limit) as unknown as EvaluationRow[];
    return rows.map(evaluationToRecord);
  }

  insertEvaluation(record: LearningEvaluation): void {
    this.db
      .prepare(
        `INSERT INTO learning_evaluations
          (evaluation_id, merchant_id, candidate_id, candidate_revision, artifact_hash,
           content_digest, suite_version, state, run_status, runs_completed, budget_cap,
           results_json, report_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.evaluation_id,
        record.merchant_id,
        record.candidate_id,
        record.candidate_revision,
        record.artifact_hash,
        record.content_digest,
        record.suite_version,
        record.state,
        record.run_status,
        record.runs_completed,
        record.budget_cap,
        JSON.stringify(record.results),
        record.report === null ? null : JSON.stringify(record.report),
        record.created_at,
        record.updated_at,
      );
  }

  updateEvaluation(record: LearningEvaluation): void {
    this.db
      .prepare(
        `UPDATE learning_evaluations
            SET state = ?, run_status = ?, runs_completed = ?, results_json = ?,
                report_json = ?, updated_at = ?
          WHERE merchant_id = ? AND evaluation_id = ?`,
      )
      .run(
        record.state,
        record.run_status,
        record.runs_completed,
        JSON.stringify(record.results),
        record.report === null ? null : JSON.stringify(record.report),
        record.updated_at,
        record.merchant_id,
        record.evaluation_id,
      );
  }

  insertReview(record: LearningReview): void {
    this.db
      .prepare(
        `INSERT INTO learning_reviews
          (review_id, merchant_id, candidate_id, candidate_revision, content_hash,
           artifact_hash, compiler_version, question_schema_version, tool_contract_digest,
           eval_report_id, reviewer_id, decision, approval_ref, reason, approved_at,
           expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.review_id,
        record.merchant_id,
        record.candidate_id,
        record.candidate_revision,
        record.content_hash,
        record.artifact_hash,
        record.compiler_version,
        record.question_schema_version,
        record.tool_contract_digest,
        record.eval_report_id,
        record.reviewer_id,
        record.decision,
        record.approval_ref,
        record.reason,
        record.approved_at,
        record.expires_at,
        record.created_at,
      );
  }

  readReview(merchantId: string, reviewId: string): LearningReview | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_reviews WHERE merchant_id = ? AND review_id = ?")
      .get(merchantId, reviewId) as unknown as LearningReview | undefined;
    return row;
  }

  readReviewByApproval(merchantId: string, approvalRef: string): LearningReview | undefined {
    const row = this.db
      .prepare("SELECT * FROM learning_reviews WHERE merchant_id = ? AND approval_ref = ?")
      .get(merchantId, approvalRef) as unknown as LearningReview | undefined;
    return row;
  }

  listReviews(merchantId: string, limit: number): LearningReview[] {
    return this.db
      .prepare(
        `SELECT * FROM learning_reviews WHERE merchant_id = ?
          ORDER BY created_at DESC, review_id ASC LIMIT ?`,
      )
      .all(merchantId, limit) as unknown as LearningReview[];
  }

  insertRelease(record: SkillRelease): void {
    this.db
      .prepare(
        `INSERT INTO skill_releases
          (release_id, merchant_id, skill_key, trigger_text, generation, state, artifact_hash,
           content_hash, compiled_artifact_json, candidate_id, candidate_revision,
           compiler_version, question_schema_version, tool_contract_digest,
           eval_report_id, approval_ref, revocation_epoch, retired_at, revoked_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.release_id,
        record.merchant_id,
        record.skill_key,
        record.trigger_text,
        record.generation,
        record.state,
        record.artifact_hash,
        record.content_hash,
        JSON.stringify(record.compiled_artifact),
        record.candidate_id,
        record.candidate_revision,
        record.compiler_version,
        record.question_schema_version,
        record.tool_contract_digest,
        record.eval_report_id,
        record.approval_ref,
        record.revocation_epoch,
        record.retired_at,
        record.revoked_at,
        record.created_at,
        record.updated_at,
      );
  }

  updateRelease(record: SkillRelease): void {
    this.db
      .prepare(
        `UPDATE skill_releases
            SET state = ?, revocation_epoch = ?, retired_at = ?, revoked_at = ?, updated_at = ?
          WHERE merchant_id = ? AND release_id = ?`,
      )
      .run(
        record.state,
        record.revocation_epoch,
        record.retired_at,
        record.revoked_at,
        record.updated_at,
        record.merchant_id,
        record.release_id,
      );
  }

  readRelease(merchantId: string, releaseId: string): SkillRelease | undefined {
    const row = this.db
      .prepare("SELECT * FROM skill_releases WHERE merchant_id = ? AND release_id = ?")
      .get(merchantId, releaseId) as unknown as ReleaseRow | undefined;
    return row === undefined ? undefined : releaseToRecord(row);
  }

  findReleaseByApproval(merchantId: string, approvalRef: string): SkillRelease | undefined {
    const row = this.db
      .prepare("SELECT * FROM skill_releases WHERE merchant_id = ? AND approval_ref = ?")
      .get(merchantId, approvalRef) as unknown as ReleaseRow | undefined;
    return row === undefined ? undefined : releaseToRecord(row);
  }

  listReleases(merchantId: string, skillKey: string | undefined, limit: number): SkillRelease[] {
    const rows = (
      skillKey === undefined
        ? this.db
            .prepare(
              `SELECT * FROM skill_releases WHERE merchant_id = ?
                ORDER BY created_at DESC, release_id ASC LIMIT ?`,
            )
            .all(merchantId, limit)
        : this.db
            .prepare(
              `SELECT * FROM skill_releases WHERE merchant_id = ? AND skill_key = ?
                ORDER BY created_at DESC, release_id ASC LIMIT ?`,
            )
            .all(merchantId, skillKey, limit)
    ) as unknown as ReleaseRow[];
    return rows.map(releaseToRecord);
  }

  readPointer(merchantId: string, skillKey: string): SkillActivePointer | undefined {
    return this.db
      .prepare("SELECT * FROM skill_active_pointers WHERE merchant_id = ? AND skill_key = ?")
      .get(merchantId, skillKey) as unknown as SkillActivePointer | undefined;
  }

  upsertPointer(record: SkillActivePointer): void {
    this.db
      .prepare(
        `INSERT INTO skill_active_pointers
          (merchant_id, skill_key, release_id, generation, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(merchant_id, skill_key) DO UPDATE SET
           release_id = excluded.release_id,
           generation = excluded.generation,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.merchant_id,
        record.skill_key,
        record.release_id,
        record.generation,
        record.updated_at,
      );
  }

  appendEvent(input: {
    merchantId: string;
    subjectKind: string;
    subjectId: string;
    event: string;
    detail: unknown;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_events
          (merchant_id, subject_kind, subject_id, event, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.subjectKind,
        input.subjectId,
        input.event,
        JSON.stringify(input.detail),
        input.createdAt,
      );
  }

  /** 最小拒绝登记：仅原因与摘要，不存正文、不含客户数据。 */
  recordRejection(input: {
    merchantId: string;
    actorId: string;
    operation: string;
    reasonCode: string;
    subjectDigest: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_rejections
          (merchant_id, actor_id, operation, reason_code, subject_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.actorId,
        input.operation,
        input.reasonCode,
        input.subjectDigest,
        input.createdAt,
      );
  }

  countRejections(merchantId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM learning_rejections WHERE merchant_id = ?")
        .get(merchantId) as { n: number }
    ).n;
  }

  readIdempotent(
    merchantId: string,
    actorId: string,
    operation: string,
    commandId: string,
  ): { requestDigest: string; result: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT request_digest, result_json FROM learning_command_idempotency
          WHERE merchant_id = ? AND actor_id = ? AND operation = ? AND command_id = ?`,
      )
      .get(merchantId, actorId, operation, commandId) as
      | { request_digest: string; result_json: string }
      | undefined;
    return row === undefined
      ? undefined
      : { requestDigest: row.request_digest, result: row.result_json };
  }

  saveIdempotent(input: {
    merchantId: string;
    actorId: string;
    operation: string;
    commandId: string;
    requestDigest: string;
    result: unknown;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_command_idempotency
          (merchant_id, actor_id, operation, command_id, request_digest, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.actorId,
        input.operation,
        input.commandId,
        input.requestDigest,
        JSON.stringify(input.result),
        input.createdAt,
      );
  }
}
