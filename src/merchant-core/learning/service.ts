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
 * TOP1 经验学习服务：商家主动纠正与案例形成（设计 §5.1 / §17.2 / D-M0-03）。
 *
 * - `submitCorrection`：入库前做 PII/底价/凭据预检；正文有界；编辑走
 *   `expected_revision` CAS，产生新 revision 并把旧案例/候选置 STALE；
 * - `promoteCorrection`：商家确认后形成不可重复的案例（每纠正一条）；重复
 *   提升同内容幂等返回原案例；案例内容变化时旧候选 STALE；
 * - 所有写命令支持 `command_id` 幂等（merchant + actor + operation +
 *   command_id；同键异摘要 `idempotency_conflict`）；
 * - merchant/actor/能力全部由服务端注入的 ActorContext 决定，模型与请求
 *   正文不能自报；查询一律带 merchant 作用域。
 *
 * 本文件不持有商务写权限、不写商品/价格事实，也不直接生成候选（M2-3）。
 */

import { randomUUID } from "node:crypto";

import { contentDigest } from "../../negotiation/jcs.js";
import {
  compileReceptionSkillArtifact,
  isValidSkillKey,
  SkillContractError,
} from "../../a2a/reception/skill-contract.js";
import { hasCapability } from "../context-governance/actor-context.js";
import {
  GOVERNANCE_POLICY_VERSION,
  type ActorCapability,
} from "../context-governance/types.js";
import type { ActorContext } from "../context-governance/actor-context.js";
import {
  runCandidateEvaluation,
  type EvaluationRunner,
  type EvaluationSuite,
} from "./evaluation.js";
import { LearningRepository } from "./repository.js";
import {
  CONTROL_CHARS_PATTERN,
  detectCorrectionSensitiveContent,
} from "./precheck.js";
import {
  LearningError,
  type LearningCandidate,
  type LearningCase,
  type LearningCommandOptions,
  type LearningCorrection,
  type LearningEvaluation,
  type LearningReview,
  type SkillRelease,
} from "./types.js";

const MAX_CORRECTION_CHARS = 4_000;
const MAX_ISSUE_TAGS = 10;
const MAX_CASE_REFS = 20;
const MAX_TAG_CHARS = 64;
const MAX_CASE_IDS = 20;
const MAX_TRIGGER_CHARS = 400;
const MAX_REASON_CHARS = 500;
const MAX_EXCLUSIONS = 10;
const MAX_EXCLUSION_CHARS = 200;
const REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLISH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LearningServiceOptions {
  repository: LearningRepository;
  now: () => string;
  /**
   * 学习账本是否就绪。装配方迁移失败时传 false：新功能保持关闭，查询与
   * 写入统一 `schema_unavailable`，不影响现有接待/经营路径。
   */
  available?: boolean;
  /** A01：客户案例蒸馏必须持有 experience_learning 授权（非记忆授权）。 */
  experienceLearningGrant?: (input: {
    merchant_id: string;
    subject_id: string;
    resource_scope_id: string;
  }) => boolean;
  /** A12：来源被删除/封存后旧案例派生失效；审核与发布前重新核验。 */
  sourceAvailable?: (merchantId: string, sourceRef: string) => boolean;
}

function requireOpaque(value: string, field: string, maxLength = 128): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LearningError("validation", `${field}_empty`, `${field} 必须是非空字符串`);
  }
  if (value.length > maxLength) {
    throw new LearningError("validation", `${field}_too_long`, `${field} 长度超过 ${maxLength}`);
  }
  if (CONTROL_CHARS_PATTERN.test(value)) {
    throw new LearningError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

function requireRevision(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LearningError("validation", `${field}_invalid`, `${field} 必须是正整数`);
  }
  return value;
}

function normalizeCorrectionText(raw: string): string {
  if (typeof raw !== "string") {
    throw new LearningError("validation", "correction_text_invalid", "correction_text 必须是字符串");
  }
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) {
    throw new LearningError("validation", "correction_text_empty", "correction_text 不能为空");
  }
  if (text.length > MAX_CORRECTION_CHARS) {
    throw new LearningError(
      "validation",
      "correction_text_too_long",
      `correction_text 超过 ${MAX_CORRECTION_CHARS} 字符`,
    );
  }
  if (CONTROL_CHARS_PATTERN.test(text)) {
    throw new LearningError("validation", "correction_text_invalid", "correction_text 含控制字符");
  }
  return text;
}

function normalizeStringList(
  raw: readonly string[] | undefined,
  field: string,
  maxItems: number,
  maxChars: number,
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new LearningError("validation", `${field}_invalid`, `${field} 必须是字符串数组`);
  }
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new LearningError("validation", `${field}_invalid`, `${field} 必须是字符串数组`);
    }
    const value = item.trim();
    if (value.length === 0) {
      throw new LearningError("validation", `${field}_empty`, `${field} 不能含空字符串`);
    }
    if (value.length > maxChars) {
      throw new LearningError(
        "validation",
        `${field}_too_long`,
        `${field} 单项长度超过 ${maxChars}`,
      );
    }
    if (CONTROL_CHARS_PATTERN.test(value)) {
      throw new LearningError("validation", `${field}_invalid`, `${field} 含控制字符`);
    }
    seen.add(value);
  }
  if (seen.size > maxItems) {
    throw new LearningError("validation", `${field}_too_many`, `${field} 最多 ${maxItems} 项`);
  }
  // 稳定排序：同集合不同顺序不应产生不同摘要。
  return [...seen].sort();
}

function requireActorCapability(
  merchantId: string,
  actor: ActorContext,
  capability: ActorCapability,
): void {
  if (actor.merchant_id !== merchantId) {
    throw new LearningError(
      "access_denied",
      "actor_merchant_mismatch",
      "ActorContext 与商家作用域不一致",
    );
  }
  if (actor.policy_version !== GOVERNANCE_POLICY_VERSION) {
    throw new LearningError(
      "validation",
      "policy_version_mismatch",
      "ActorContext policy_version 与当前治理策略不一致",
    );
  }
  if (!hasCapability(actor, capability)) {
    throw new LearningError("access_denied", "capability_missing", `actor 缺少 ${capability}`);
  }
}

function requireActor(merchantId: string, actor: ActorContext): void {
  requireActorCapability(merchantId, actor, "learning:manage");
}

function correctionDigest(input: {
  merchantId: string;
  text: string;
  issueTags: readonly string[];
  caseRefs: readonly string[];
  baseReleaseId: string | null;
}): string {
  return contentDigest({
    kind: "learning.correction",
    merchant_id: input.merchantId,
    correction_text: input.text,
    issue_tags: input.issueTags,
    case_refs: input.caseRefs,
    base_release_id: input.baseReleaseId,
  });
}

function requireBoundedText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new LearningError("validation", `${field}_invalid`, `${field} 必须是字符串`);
  }
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length === 0) {
    throw new LearningError("validation", `${field}_empty`, `${field} 不能为空`);
  }
  if (text.length > maxLength) {
    throw new LearningError("validation", `${field}_too_long`, `${field} 超过 ${maxLength} 字符`);
  }
  if (CONTROL_CHARS_PATTERN.test(text)) {
    throw new LearningError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return text;
}

/** 发布/回滚前复核：冻结产物必须仍与当前编译器与工具/问题契约一致。 */
function verifyReleaseArtifact(input: {
  skill_key: string;
  artifact_hash: string;
  tool_contract_digest: string;
  compiler_version: string;
  compiled_artifact: LearningCandidate["compiled_artifact"];
}): void {
  const compiled = compileReceptionSkillArtifact({
    skill_key: input.skill_key,
    steps: input.compiled_artifact.steps,
    required_tools: input.compiled_artifact.required_tools,
  });
  if (
    compiled.artifact_hash !== input.artifact_hash ||
    compiled.tool_contract_digest !== input.tool_contract_digest ||
    compiled.compiler_version !== input.compiler_version
  ) {
    throw new LearningError(
      "unsupported_capability",
      "release_incompatible",
      "版本产物与当前工具/问题契约或编译器不兼容；不能发布或回滚",
    );
  }
}

function caseDigest(input: {
  merchantId: string;
  correctionId: string;
  correctionDigest: string;
  sourceRefs: readonly string[];
  outcomeRefs: readonly string[];
  issueTags: readonly string[];
}): string {
  return contentDigest({
    kind: "learning.case",
    merchant_id: input.merchantId,
    correction_id: input.correctionId,
    correction_digest: input.correctionDigest,
    source_refs: input.sourceRefs,
    outcome_refs: input.outcomeRefs,
    issue_tags: input.issueTags,
  });
}

export class LearningService {
  private readonly repository: LearningRepository;
  private readonly now: () => string;
  private readonly experienceLearningGrant?: LearningServiceOptions["experienceLearningGrant"];
  private readonly sourceAvailable?: LearningServiceOptions["sourceAvailable"];
  private readonly available: boolean;

  constructor(options: LearningServiceOptions) {
    this.repository = options.repository;
    this.now = options.now;
    this.experienceLearningGrant = options.experienceLearningGrant;
    this.sourceAvailable = options.sourceAvailable;
    this.available = options.available ?? true;
  }

  private ensureAvailable(): void {
    if (!this.available) {
      throw new LearningError(
        "schema_unavailable",
        "learning_schema_unavailable",
        "学习域迁移失败或未就绪；新功能保持关闭，现有接待路径不受影响",
      );
    }
  }

  /**
   * 提交或编辑商家主动纠正。编辑必须带 `correction_id` 与
   * `expected_revision`；成功返回新 revision，旧案例与候选置 STALE。
   */
  /**
   * A01/A02：从客户案例蒸馏学习材料。
   *
   * 必须持有 experience_learning 授权（记忆授权不能替代）；未授权时只写
   * 最小拒绝登记（原因 + 摘要，不含原文），客户正文不进入模型或学习库。
   * 授权通过后仍走同一纠正经预检/持久化路径；本方法不暴露任何策略或
   * 发布工具，客户文本只作为案例数据。
   */
  distillCustomerCase(input: {
    merchant_id: string;
    actor: ActorContext;
    subject_id: string;
    resource_scope_id: string;
    case_text: string;
    issue_tags?: readonly string[];
  }): LearningCorrection {
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActorCapability(merchantId, input.actor, "learning:manage");
    const subjectId = requireOpaque(input.subject_id, "subject_id");
    const scopeId = requireOpaque(input.resource_scope_id, "resource_scope_id");
    const authorized =
      this.experienceLearningGrant?.({
        merchant_id: merchantId,
        subject_id: subjectId,
        resource_scope_id: scopeId,
      }) === true;
    if (!authorized) {
      this.repository.recordRejection({
        merchantId,
        actorId: input.actor.actor_id,
        operation: "learning.distill_customer_case",
        reasonCode: "experience_learning_grant_required",
        subjectDigest: contentDigest({ operation: "customer_case", case_text: input.case_text }),
        createdAt: this.now(),
      });
      throw new LearningError(
        "access_denied",
        "experience_learning_grant_required",
        "客户案例蒸馏需要 experience_learning 授权；记忆授权不能替代",
      );
    }
    return this.submitCorrection({
      merchant_id: merchantId,
      actor: input.actor,
      correction_text: input.case_text,
      issue_tags: input.issue_tags ?? ["customer_case"],
      case_refs: [`customer_case:${subjectId}:${scopeId}`],
    });
  }

  /** A12：来源删除/封存后旧案例派生不能继续审核或发布。 */
  private assertCandidateSourcesAvailable(
    merchantId: string,
    candidate: LearningCandidate,
  ): void {
    if (this.sourceAvailable === undefined) return;
    for (const caseId of candidate.case_ids) {
      const learningCase = this.repository.readCase(merchantId, caseId);
      if (learningCase === undefined) continue;
      for (const ref of learningCase.source_refs) {
        if (!this.sourceAvailable(merchantId, ref)) {
          throw new LearningError(
            "version_conflict",
            "source_unavailable",
            "来源已删除/封存；旧案例派生失效，需要重新形成候选",
          );
        }
      }
    }
  }

  submitCorrection(
    input: {
      merchant_id: string;
      actor: ActorContext;
      correction_text: string;
      issue_tags?: readonly string[];
      case_refs?: readonly string[];
      base_release_id?: string;
      correction_id?: string;
      expected_revision?: number;
    },
    command: LearningCommandOptions = {},
  ): LearningCorrection {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActor(merchantId, input.actor);
    const text = normalizeCorrectionText(input.correction_text);
    const issueTags = normalizeStringList(input.issue_tags, "issue_tags", MAX_ISSUE_TAGS, MAX_TAG_CHARS);
    const caseRefs = normalizeStringList(input.case_refs, "case_refs", MAX_CASE_REFS, 128);
    const baseReleaseId =
      input.base_release_id === undefined
        ? null
        : requireOpaque(input.base_release_id, "base_release_id");
    const correctionId =
      input.correction_id === undefined
        ? undefined
        : requireOpaque(input.correction_id, "correction_id");
    if ((correctionId === undefined) !== (input.expected_revision === undefined)) {
      throw new LearningError(
        "validation",
        "expected_revision_required",
        "编辑纠正必须同时提供 correction_id 与 expected_revision",
      );
    }
    if (input.expected_revision !== undefined) {
      requireRevision(input.expected_revision, "expected_revision");
    }

    const sensitive = detectCorrectionSensitiveContent(text);
    if (sensitive !== undefined) {
      // 最小拒绝登记：不存正文，只存原因与不可逆摘要类别。
      this.repository.transaction(() => {
        this.repository.recordRejection({
          merchantId,
          actorId: input.actor.actor_id,
          operation: "learning.submitCorrection",
          reasonCode: `precheck:${sensitive}`,
          subjectDigest: contentDigest({
            operation: "learning.submitCorrection",
            reason_code: sensitive,
            actor_id: input.actor.actor_id,
            text_length: text.length,
          }),
          createdAt: this.now(),
        });
      });
      throw new LearningError(
        "sensitive_content",
        `precheck:${sensitive}`,
        "纠正正文包含客户标识、联系方式、凭据或价格底线；请改为抽象流程描述后重试",
      );
    }

    const request = {
      correction_id: correctionId ?? null,
      expected_revision: input.expected_revision ?? 0,
      correction_text: text,
      issue_tags: issueTags,
      case_refs: caseRefs,
      base_release_id: baseReleaseId,
    };
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.submitCorrection",
      request,
      command,
      () => {
        const now = this.now();
        const digest = correctionDigest({
          merchantId,
          text,
          issueTags,
          caseRefs,
          baseReleaseId,
        });
        if (correctionId !== undefined) {
          const existing = this.repository.readCorrection(merchantId, correctionId);
          if (existing === undefined) {
            throw new LearningError("not_found", "correction_not_found", "纠正不存在或不可见");
          }
          if (existing.revision !== input.expected_revision) {
            throw new LearningError(
              "version_conflict",
              "correction_revision_mismatch",
              `纠正 revision 已变化（当前 ${existing.revision}）`,
            );
          }
          const updated: LearningCorrection = {
            ...existing,
            revision: existing.revision + 1,
            status: "DRAFT",
            correction_text: text,
            issue_tags: issueTags,
            case_refs: caseRefs,
            base_release_id: baseReleaseId,
            content_digest: digest,
            updated_at: now,
          };
          this.repository.updateCorrection(updated);
          const staleCase = this.repository.readCaseByCorrection(merchantId, correctionId);
          if (staleCase !== undefined) {
            const staleCases = this.repository.markCaseStale(merchantId, staleCase.case_id, now);
            const staleCandidates = this.repository.markCandidatesStaleForCase(
              merchantId,
              staleCase.case_id,
              now,
            );
            if (staleCases > 0 || staleCandidates > 0) {
              this.repository.appendEvent({
                merchantId,
                subjectKind: "correction",
                subjectId: correctionId,
                event: "case_staled",
                detail: { case_id: staleCase.case_id, stale_candidates: staleCandidates },
                createdAt: now,
              });
            }
          }
          this.repository.appendEvent({
            merchantId,
            subjectKind: "correction",
            subjectId: correctionId,
            event: "correction_revised",
            detail: { revision: updated.revision },
            createdAt: now,
          });
          return updated;
        }
        const created: LearningCorrection = {
          correction_id: `corr_${randomUUID()}`,
          merchant_id: merchantId,
          actor_id: input.actor.actor_id,
          revision: 1,
          status: "DRAFT",
          correction_text: text,
          issue_tags: issueTags,
          case_refs: caseRefs,
          base_release_id: baseReleaseId,
          content_digest: digest,
          created_at: now,
          updated_at: now,
        };
        this.repository.insertCorrection(created);
        this.repository.appendEvent({
          merchantId,
          subjectKind: "correction",
          subjectId: created.correction_id,
          event: "correction_drafted",
          detail: { revision: 1 },
          createdAt: now,
        });
        return created;
      },
    );
  }

  /**
   * 商家确认形成案例。每纠正一条案例；同内容重复提升幂等返回原案例；
   * 纠正已编辑后重新提升会递增案例 revision 并让旧候选 STALE。
   */
  promoteCorrection(
    input: {
      merchant_id: string;
      actor: ActorContext;
      correction_id: string;
      expected_revision: number;
    },
    command: LearningCommandOptions = {},
  ): LearningCase {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActor(merchantId, input.actor);
    const correctionId = requireOpaque(input.correction_id, "correction_id");
    const expectedRevision = requireRevision(input.expected_revision, "expected_revision");
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.promoteCorrection",
      { correction_id: correctionId, expected_revision: expectedRevision },
      command,
      () => {
        const now = this.now();
        const correction = this.repository.readCorrection(merchantId, correctionId);
        if (correction === undefined) {
          throw new LearningError("not_found", "correction_not_found", "纠正不存在或不可见");
        }
        if (correction.revision !== expectedRevision) {
          throw new LearningError(
            "version_conflict",
            "correction_revision_mismatch",
            `纠正 revision 已变化（当前 ${correction.revision}）`,
          );
        }
        const digest = caseDigest({
          merchantId,
          correctionId,
          correctionDigest: correction.content_digest,
          sourceRefs: correction.case_refs,
          outcomeRefs: [],
          issueTags: correction.issue_tags,
        });
        const existing = this.repository.readCaseByCorrection(merchantId, correctionId);
        if (existing !== undefined && existing.content_digest === digest) {
          // 幂等：同纠正内容再次提升返回原案例（案例摘要覆盖纠正摘要）。
          if (existing.status !== "ACTIVE") {
            this.repository.updateCase({ ...existing, status: "ACTIVE", updated_at: now });
          }
          if (correction.status !== "CASE_CREATED") {
            this.repository.updateCorrection({
              ...correction,
              status: "CASE_CREATED",
              updated_at: now,
            });
          }
          return { ...existing, status: "ACTIVE" as const };
        }
        let promoted: LearningCase;
        if (existing === undefined) {
          promoted = {
            case_id: `case_${randomUUID()}`,
            merchant_id: merchantId,
            correction_id: correctionId,
            revision: 1,
            status: "ACTIVE",
            source_refs: correction.case_refs,
            outcome_refs: [],
            issue_tags: correction.issue_tags,
            content_digest: digest,
            created_at: now,
            updated_at: now,
          };
          this.repository.insertCase(promoted);
          this.repository.appendEvent({
            merchantId,
            subjectKind: "case",
            subjectId: promoted.case_id,
            event: "case_created",
            detail: { correction_id: correctionId, revision: 1 },
            createdAt: now,
          });
        } else {
          promoted = {
            ...existing,
            revision: existing.revision + 1,
            status: "ACTIVE",
            source_refs: correction.case_refs,
            outcome_refs: [],
            issue_tags: correction.issue_tags,
            content_digest: digest,
            updated_at: now,
          };
          this.repository.updateCase(promoted);
          const staleCandidates = this.repository.markCandidatesStaleForCase(
            merchantId,
            promoted.case_id,
            now,
          );
          this.repository.appendEvent({
            merchantId,
            subjectKind: "case",
            subjectId: promoted.case_id,
            event: "case_revised",
            detail: { correction_id: correctionId, revision: promoted.revision, stale_candidates: staleCandidates },
            createdAt: now,
          });
        }
        this.repository.updateCorrection({
          ...correction,
          status: "CASE_CREATED",
          updated_at: now,
        });
        return promoted;
      },
    );
  }

  /**
   * 形成候选草稿（`learning.propose`）：案例必须 ACTIVE；技能步骤按固定
   * 动作/问题/守卫注册表校验，评测前编译并冻结产物（hash/compiler_version/
   * 工具契约摘要）。候选只写草稿，不启用规则、不改商品事实或价格权限。
   */
  proposeCandidate(
    input: {
      merchant_id: string;
      actor: ActorContext;
      case_ids: readonly string[];
      skill_key: string;
      trigger: string;
      proposed_steps: readonly unknown[];
      exclusions?: readonly string[];
      reason: string;
      base_release_id?: string;
      required_tools?: readonly string[];
    },
    command: LearningCommandOptions = {},
  ): LearningCandidate {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActor(merchantId, input.actor);
    const caseIds = normalizeStringList(input.case_ids, "case_ids", MAX_CASE_IDS, 128);
    if (caseIds.length === 0) {
      throw new LearningError("validation", "case_ids_empty", "候选至少关联一个案例");
    }
    if (!isValidSkillKey(input.skill_key)) {
      throw new LearningError("validation", "skill_key_invalid", "skill_key 必须是 lowercase kebab-case");
    }
    const text = this.validateCandidateText(merchantId, input.actor.actor_id, "learning.proposeCandidate", {
      trigger: input.trigger,
      reason: input.reason,
      ...(input.exclusions !== undefined ? { exclusions: input.exclusions } : {}),
    });
    const baseReleaseId =
      input.base_release_id === undefined
        ? null
        : requireOpaque(input.base_release_id, "base_release_id");
    const request = {
      case_ids: caseIds,
      skill_key: input.skill_key,
      base_release_id: baseReleaseId,
      trigger: text.trigger,
      proposed_steps: input.proposed_steps,
      exclusions: text.exclusions,
      reason: text.reason,
      required_tools: input.required_tools ?? null,
    };
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.proposeCandidate",
      request,
      command,
      () => {
        const content = this.buildCandidateContent(merchantId, {
          skillKey: input.skill_key,
          caseIds,
          trigger: text.trigger,
          steps: input.proposed_steps,
          exclusions: text.exclusions,
          reason: text.reason,
          baseReleaseId,
          ...(input.required_tools !== undefined
            ? { requiredTools: input.required_tools }
            : {}),
        });
        const now = this.now();
        const candidate: LearningCandidate = {
          candidate_id: `cand_${randomUUID()}`,
          merchant_id: merchantId,
          revision: 1,
          state: "DRAFT",
          skill_key: input.skill_key,
          audience: "customer_reception",
          base_release_id: baseReleaseId,
          case_ids: caseIds,
          trigger_text: text.trigger,
          proposed_steps: content.compiled.artifact.steps,
          exclusions: text.exclusions,
          reason: text.reason,
          required_tools: content.compiled.artifact.required_tools,
          question_schema_version: content.compiled.artifact.question_schema_version,
          tool_contract_digest: content.compiled.tool_contract_digest,
          compiled_artifact: content.compiled.artifact,
          compiled_artifact_hash: content.compiled.artifact_hash,
          compiler_version: content.compiled.compiler_version,
          content_digest: content.contentDigest,
          eval_report_id: null,
          reviewer_id: null,
          approval_ref: null,
          expires_at: null,
          created_at: now,
          updated_at: now,
        };
        this.repository.insertCandidate(candidate);
        this.repository.replaceCandidateCases({
          merchantId,
          candidateId: candidate.candidate_id,
          caseIds,
          now,
        });
        this.repository.appendEvent({
          merchantId,
          subjectKind: "candidate",
          subjectId: candidate.candidate_id,
          event: "candidate_drafted",
          detail: {
            revision: 1,
            artifact_hash: candidate.compiled_artifact_hash,
            content_digest: candidate.content_digest,
          },
          createdAt: now,
        });
        return candidate;
      },
    );
  }

  /**
   * 编辑候选：CAS revision；任何内容变化都产生新 revision 与新的冻结产物，
   * 并清空旧评测/审核/批准（A07/A16）。APPROVED/STALE/EXPIRED 不可编辑。
   */
  reviseCandidate(
    input: {
      merchant_id: string;
      actor: ActorContext;
      candidate_id: string;
      expected_revision: number;
      case_ids: readonly string[];
      skill_key: string;
      trigger: string;
      proposed_steps: readonly unknown[];
      exclusions?: readonly string[];
      reason: string;
      base_release_id?: string;
      required_tools?: readonly string[];
    },
    command: LearningCommandOptions = {},
  ): LearningCandidate {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActor(merchantId, input.actor);
    const candidateId = requireOpaque(input.candidate_id, "candidate_id");
    const expectedRevision = requireRevision(input.expected_revision, "expected_revision");
    const caseIds = normalizeStringList(input.case_ids, "case_ids", MAX_CASE_IDS, 128);
    if (caseIds.length === 0) {
      throw new LearningError("validation", "case_ids_empty", "候选至少关联一个案例");
    }
    if (!isValidSkillKey(input.skill_key)) {
      throw new LearningError("validation", "skill_key_invalid", "skill_key 必须是 lowercase kebab-case");
    }
    const text = this.validateCandidateText(merchantId, input.actor.actor_id, "learning.reviseCandidate", {
      trigger: input.trigger,
      reason: input.reason,
      ...(input.exclusions !== undefined ? { exclusions: input.exclusions } : {}),
    });
    const baseReleaseId =
      input.base_release_id === undefined
        ? null
        : requireOpaque(input.base_release_id, "base_release_id");
    const request = {
      candidate_id: candidateId,
      expected_revision: expectedRevision,
      case_ids: caseIds,
      skill_key: input.skill_key,
      base_release_id: baseReleaseId,
      trigger: text.trigger,
      proposed_steps: input.proposed_steps,
      exclusions: text.exclusions,
      reason: text.reason,
      required_tools: input.required_tools ?? null,
    };
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.reviseCandidate",
      request,
      command,
      () => {
        const existing = this.repository.readCandidate(merchantId, candidateId);
        if (existing === undefined) {
          throw new LearningError("not_found", "candidate_not_found", "候选不存在或不可见");
        }
        if (existing.revision !== expectedRevision) {
          throw new LearningError(
            "version_conflict",
            "candidate_revision_mismatch",
            `候选 revision 已变化（当前 ${existing.revision}）`,
          );
        }
        if (existing.state === "APPROVED" || existing.state === "STALE" || existing.state === "EXPIRED") {
          throw new LearningError(
            "version_conflict",
            "candidate_state_locked",
            `候选状态 ${existing.state} 不可编辑；请从新案例形成候选`,
          );
        }
        const content = this.buildCandidateContent(merchantId, {
          skillKey: input.skill_key,
          caseIds,
          trigger: text.trigger,
          steps: input.proposed_steps,
          exclusions: text.exclusions,
          reason: text.reason,
          baseReleaseId,
          ...(input.required_tools !== undefined
            ? { requiredTools: input.required_tools }
            : {}),
        });
        const now = this.now();
        const updated: LearningCandidate = {
          ...existing,
          revision: existing.revision + 1,
          state: "DRAFT",
          skill_key: input.skill_key,
          base_release_id: baseReleaseId,
          case_ids: caseIds,
          trigger_text: text.trigger,
          proposed_steps: content.compiled.artifact.steps,
          exclusions: text.exclusions,
          reason: text.reason,
          required_tools: content.compiled.artifact.required_tools,
          question_schema_version: content.compiled.artifact.question_schema_version,
          tool_contract_digest: content.compiled.tool_contract_digest,
          compiled_artifact: content.compiled.artifact,
          compiled_artifact_hash: content.compiled.artifact_hash,
          compiler_version: content.compiled.compiler_version,
          content_digest: content.contentDigest,
          eval_report_id: null,
          reviewer_id: null,
          approval_ref: null,
          expires_at: null,
          updated_at: now,
        };
        this.repository.updateCandidate(updated);
        this.repository.replaceCandidateCases({
          merchantId,
          candidateId,
          caseIds,
          now,
        });
        this.repository.appendEvent({
          merchantId,
          subjectKind: "candidate",
          subjectId: candidateId,
          event: "candidate_revised",
          detail: {
            revision: updated.revision,
            artifact_hash: updated.compiled_artifact_hash,
            content_digest: updated.content_digest,
          },
          createdAt: now,
        });
        return updated;
      },
    );
  }

  getCandidate(merchantId: string, candidateId: string): LearningCandidate | undefined {
    this.ensureAvailable();
    return this.repository.readCandidate(
      requireOpaque(merchantId, "merchant_id"),
      requireOpaque(candidateId, "candidate_id"),
    );
  }

  listCandidates(merchantId: string, limit = 100): LearningCandidate[] {
    this.ensureAvailable();
    const merchant = requireOpaque(merchantId, "merchant_id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new LearningError("validation", "limit_invalid", "limit 必须在 1..200");
    }
    return this.repository.listCandidates(merchant, limit);
  }

  /**
   * `learning.evaluate`：在隔离执行器中回放冻结套件；预算不足/中断保留
   * EVALUATING 并可续跑。模型调用由注入的 runner 执行，不在 DB 事务内。
   */
  async evaluateCandidate(
    input: {
      merchant_id: string;
      actor: ActorContext;
      candidate_id: string;
      content_hash: string;
      suite: EvaluationSuite;
      runner: EvaluationRunner;
      budget_cap?: number;
      require_improvement?: boolean;
    },
    command: LearningCommandOptions = {},
  ): Promise<LearningEvaluation> {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActor(merchantId, input.actor);
    const candidateId = requireOpaque(input.candidate_id, "candidate_id");
    const contentHash = requireOpaque(input.content_hash, "content_hash", 128);
    const candidate = this.repository.readCandidate(merchantId, candidateId);
    if (candidate === undefined) {
      throw new LearningError("not_found", "candidate_not_found", "候选不存在或不可见");
    }
    if (candidate.compiled_artifact_hash !== contentHash) {
      throw new LearningError(
        "version_conflict",
        "content_hash_mismatch",
        "content_hash 与当前冻结产物不一致；请重新读取候选",
      );
    }
    if (
      candidate.state === "APPROVED" ||
      candidate.state === "STALE" ||
      candidate.state === "EXPIRED"
    ) {
      throw new LearningError(
        "version_conflict",
        "candidate_state_locked",
        `候选状态 ${candidate.state} 不可评测`,
      );
    }
    const commandId =
      command.command_id === undefined
        ? undefined
        : requireOpaque(command.command_id, "command_id");
    const requestDigest = contentDigest({
      operation: "learning.evaluateCandidate",
      request: {
        candidate_id: candidateId,
        content_hash: contentHash,
        suite_version: input.suite.suite_version,
      },
    });
    if (commandId !== undefined) {
      const existing = this.repository.readIdempotent(
        merchantId,
        input.actor.actor_id,
        "learning.evaluateCandidate",
        commandId,
      );
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) {
          throw new LearningError(
            "idempotency_conflict",
            "command_replay_conflict",
            "同一 command_id 已用于不同评测请求",
          );
        }
        return JSON.parse(existing.result) as LearningEvaluation;
      }
    }
    const evaluation = await runCandidateEvaluation({
      repository: this.repository,
      now: this.now,
      candidate,
      suite: input.suite,
      runner: input.runner,
      ...(input.budget_cap !== undefined ? { budgetCap: input.budget_cap } : {}),
      ...(input.require_improvement !== undefined
        ? { requireImprovement: input.require_improvement }
        : {}),
    });
    if (commandId !== undefined) {
      this.repository.transaction(() => {
        this.repository.saveIdempotent({
          merchantId,
          actorId: input.actor.actor_id,
          operation: "learning.evaluateCandidate",
          commandId,
          requestDigest,
          result: evaluation,
          createdAt: this.now(),
        });
      });
    }
    return evaluation;
  }

  getEvaluation(merchantId: string, evaluationId: string): LearningEvaluation | undefined {
    this.ensureAvailable();
    return this.repository.readEvaluation(
      requireOpaque(merchantId, "merchant_id"),
      requireOpaque(evaluationId, "evaluation_id"),
    );
  }

  listEvaluations(merchantId: string, limit = 100): LearningEvaluation[] {
    this.ensureAvailable();
    const merchant = requireOpaque(merchantId, "merchant_id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new LearningError("validation", "limit_invalid", "limit 必须在 1..200");
    }
    return this.repository.listEvaluations(merchant, limit);
  }

  /**
   * `learning.review`：真实管理员审核。批准绑定确切内容、冻结产物、评测
   * 报告与截止（待审 7 天；批准后须在 min(批准+24h, expires_at) 内发布）。
   */
  reviewCandidate(
    input: {
      merchant_id: string;
      actor: ActorContext;
      candidate_id: string;
      content_hash: string;
      evaluation_id: string;
      decision: "approve" | "reject";
      reason?: string;
    },
    command: LearningCommandOptions = {},
  ): LearningReview {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActorCapability(merchantId, input.actor, "learning:review");
    const candidateId = requireOpaque(input.candidate_id, "candidate_id");
    const contentHash = requireOpaque(input.content_hash, "content_hash");
    const evaluationId = requireOpaque(input.evaluation_id, "evaluation_id");
    if (input.decision !== "approve" && input.decision !== "reject") {
      throw new LearningError("validation", "decision_invalid", "decision 只能是 approve/reject");
    }
    const reason =
      input.reason === undefined
        ? null
        : requireBoundedText(input.reason, "reason", MAX_REASON_CHARS);
    const request = {
      candidate_id: candidateId,
      content_hash: contentHash,
      evaluation_id: evaluationId,
      decision: input.decision,
      reason,
    };
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.reviewCandidate",
      request,
      command,
      () => {
        const now = this.now();
        const candidate = this.repository.readCandidate(merchantId, candidateId);
        if (candidate === undefined) {
          throw new LearningError("not_found", "candidate_not_found", "候选不存在或不可见");
        }
        if (candidate.compiled_artifact_hash !== contentHash) {
          throw new LearningError("version_conflict", "content_hash_mismatch", "候选内容已变化");
        }
        if (candidate.state !== "READY_FOR_REVIEW") {
          throw new LearningError(
            "version_conflict",
            "candidate_not_ready",
            `候选状态 ${candidate.state} 不可审核`,
          );
        }
        this.assertCandidateSourcesAvailable(merchantId, candidate);
        const evaluation = this.repository.readEvaluation(merchantId, evaluationId);
        if (
          evaluation === undefined ||
          evaluation.candidate_id !== candidateId ||
          evaluation.artifact_hash !== candidate.compiled_artifact_hash ||
          evaluation.state !== "READY_FOR_REVIEW" ||
          evaluation.report?.verdict !== "pass"
        ) {
          throw new LearningError(
            "version_conflict",
            "evaluation_not_passed",
            "评测报告不存在或未通过；不能审核",
          );
        }
        if (candidate.eval_report_id !== evaluationId) {
          throw new LearningError(
            "version_conflict",
            "evaluation_mismatch",
            "候选绑定的评测报告与审核引用不一致",
          );
        }
        const approvedAt = now;
        const expiresAt = new Date(Date.parse(approvedAt) + REVIEW_TTL_MS).toISOString();
        const review: LearningReview = {
          review_id: `rev_${randomUUID()}`,
          merchant_id: merchantId,
          candidate_id: candidateId,
          candidate_revision: candidate.revision,
          content_hash: candidate.content_digest,
          artifact_hash: candidate.compiled_artifact_hash,
          compiler_version: candidate.compiler_version,
          question_schema_version: candidate.question_schema_version,
          tool_contract_digest: candidate.tool_contract_digest,
          eval_report_id: evaluationId,
          reviewer_id: input.actor.actor_id,
          decision: input.decision === "approve" ? "APPROVE" : "REJECT",
          approval_ref: `apr_${randomUUID()}`,
          reason,
          approved_at: approvedAt,
          expires_at: expiresAt,
          created_at: approvedAt,
        };
        this.repository.insertReview(review);
        this.repository.updateCandidate({
          ...candidate,
          state: input.decision === "approve" ? "APPROVED" : "REJECTED",
          reviewer_id: input.actor.actor_id,
          approval_ref: input.decision === "approve" ? review.approval_ref : null,
          expires_at: input.decision === "approve" ? expiresAt : null,
          updated_at: approvedAt,
        });
        this.repository.appendEvent({
          merchantId,
          subjectKind: "candidate",
          subjectId: candidateId,
          event: input.decision === "approve" ? "candidate_approved" : "candidate_rejected",
          detail: { approval_ref: review.approval_ref, reviewer_id: review.reviewer_id },
          createdAt: approvedAt,
        });
        return review;
      },
    );
  }

  /**
   * `learning.publish`：只核验并激活已批准冻结产物，不重新生成正文；CAS
   * 生效指针 generation，旧 ACTIVE 版本转 RETIRED。
   */
  publishRelease(
    input: {
      merchant_id: string;
      actor: ActorContext;
      approval_ref: string;
      expected_generation: number;
    },
    command: LearningCommandOptions = {},
  ): SkillRelease {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActorCapability(merchantId, input.actor, "learning:publish");
    const approvalRef = requireOpaque(input.approval_ref, "approval_ref");
    if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) {
      throw new LearningError("validation", "expected_generation_invalid", "expected_generation 必须是非负整数");
    }
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.publishRelease",
      { approval_ref: approvalRef, expected_generation: input.expected_generation },
      command,
      () => {
        const existing = this.repository.findReleaseByApproval(merchantId, approvalRef);
        if (existing !== undefined) {
          if (existing.state === "REVOKED") {
            throw new LearningError(
              "unsupported_capability",
              "release_revoked",
              "该批准对应的版本已撤回；不能再次发布",
            );
          }
          return existing;
        }
        const now = this.now();
        const review = this.repository.readReviewByApproval(merchantId, approvalRef);
        if (review === undefined || review.decision !== "APPROVE") {
          throw new LearningError("not_found", "approval_not_found", "批准不存在或不是批准决定");
        }
        const candidate = this.repository.readCandidate(merchantId, review.candidate_id);
        if (candidate === undefined || candidate.state !== "APPROVED") {
          throw new LearningError(
            "version_conflict",
            "candidate_not_approved",
            "候选不再是已批准状态；请重新审核",
          );
        }
        this.assertCandidateSourcesAvailable(merchantId, candidate);
        if (
          candidate.revision !== review.candidate_revision ||
          candidate.content_digest !== review.content_hash ||
          candidate.compiled_artifact_hash !== review.artifact_hash ||
          candidate.tool_contract_digest !== review.tool_contract_digest ||
          candidate.compiler_version !== review.compiler_version
        ) {
          throw new LearningError(
            "version_conflict",
            "approval_dependency_changed",
            "批准绑定的内容/产物/工具契约已变化；需要重新评测与审核",
          );
        }
        const publishDeadline = Math.min(
          Date.parse(review.approved_at) + PUBLISH_WINDOW_MS,
          Date.parse(review.expires_at),
        );
        if (!(Date.parse(now) < publishDeadline)) {
          throw new LearningError(
            "version_conflict",
            "approval_expired",
            "批准已过发布窗口；需要重新审核",
          );
        }
        verifyReleaseArtifact({
          skill_key: candidate.skill_key,
          artifact_hash: candidate.compiled_artifact_hash,
          tool_contract_digest: candidate.tool_contract_digest,
          compiler_version: candidate.compiler_version,
          compiled_artifact: candidate.compiled_artifact,
        });
        const pointer = this.repository.readPointer(merchantId, candidate.skill_key);
        const currentGeneration = pointer?.generation ?? 0;
        if (currentGeneration !== input.expected_generation) {
          throw new LearningError(
            "version_conflict",
            "generation_mismatch",
            `生效指针 generation 已变化（当前 ${currentGeneration}）`,
          );
        }
        if (pointer?.release_id !== null && pointer?.release_id !== undefined) {
          const previous = this.repository.readRelease(merchantId, pointer.release_id);
          if (previous !== undefined && previous.state === "ACTIVE") {
            this.repository.updateRelease({
              ...previous,
              state: "RETIRED",
              retired_at: now,
              updated_at: now,
            });
          }
        }
        const release: SkillRelease = {
          release_id: `rel_${randomUUID()}`,
          merchant_id: merchantId,
          skill_key: candidate.skill_key,
          trigger_text: candidate.trigger_text,
          generation: currentGeneration + 1,
          state: "ACTIVE",
          artifact_hash: candidate.compiled_artifact_hash,
          content_hash: candidate.content_digest,
          compiled_artifact: candidate.compiled_artifact,
          candidate_id: candidate.candidate_id,
          candidate_revision: candidate.revision,
          compiler_version: candidate.compiler_version,
          question_schema_version: candidate.question_schema_version,
          tool_contract_digest: candidate.tool_contract_digest,
          eval_report_id: review.eval_report_id,
          approval_ref: approvalRef,
          revocation_epoch: 0,
          retired_at: null,
          revoked_at: null,
          created_at: now,
          updated_at: now,
        };
        this.repository.insertRelease(release);
        this.repository.upsertPointer({
          merchant_id: merchantId,
          skill_key: release.skill_key,
          release_id: release.release_id,
          generation: release.generation,
          updated_at: now,
        });
        this.repository.appendEvent({
          merchantId,
          subjectKind: "release",
          subjectId: release.release_id,
          event: "release_published",
          detail: {
            skill_key: release.skill_key,
            generation: release.generation,
            artifact_hash: release.artifact_hash,
            // A08：审计真实发布人（服务端 actor，不接受请求正文自报）。
            publisher_id: input.actor.actor_id,
          },
          createdAt: now,
        });
        return release;
      },
    );
  }

  /**
   * `learning.rollback`：切回仍兼容且已审核的历史版本；只新增 pointer
   * generation，不覆盖历史；REVOKED 或不兼容版本拒绝。
   */
  rollbackRelease(
    input: {
      merchant_id: string;
      actor: ActorContext;
      target_release_id: string;
      expected_generation: number;
      reason: string;
    },
    command: LearningCommandOptions = {},
  ): { release_id: string; generation: number; skill_key: string; previous_release_id: string | null } {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActorCapability(merchantId, input.actor, "learning:publish");
    const targetReleaseId = requireOpaque(input.target_release_id, "target_release_id");
    if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 1) {
      throw new LearningError("validation", "expected_generation_invalid", "expected_generation 必须是正整数");
    }
    const reason = requireBoundedText(input.reason, "reason", MAX_REASON_CHARS);
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.rollbackRelease",
      { target_release_id: targetReleaseId, expected_generation: input.expected_generation, reason },
      command,
      () => {
        const now = this.now();
        const target = this.repository.readRelease(merchantId, targetReleaseId);
        if (target === undefined) {
          throw new LearningError("not_found", "release_not_found", "目标版本不存在或不可见");
        }
        if (target.state === "REVOKED") {
          throw new LearningError(
            "unsupported_capability",
            "release_revoked",
            "已撤回版本不能回滚；只能回滚到仍兼容的已审核版本",
          );
        }
        verifyReleaseArtifact(target);
        const pointer = this.repository.readPointer(merchantId, target.skill_key);
        const currentGeneration = pointer?.generation ?? 0;
        if (currentGeneration !== input.expected_generation) {
          throw new LearningError(
            "version_conflict",
            "generation_mismatch",
            `生效指针 generation 已变化（当前 ${currentGeneration}）`,
          );
        }
        const previousReleaseId = pointer?.release_id ?? null;
        if (previousReleaseId === target.release_id) {
          return {
            release_id: target.release_id,
            generation: currentGeneration,
            skill_key: target.skill_key,
            previous_release_id: previousReleaseId,
          };
        }
        if (previousReleaseId !== null) {
          const previous = this.repository.readRelease(merchantId, previousReleaseId);
          if (previous !== undefined && previous.state === "ACTIVE") {
            this.repository.updateRelease({
              ...previous,
              state: "RETIRED",
              retired_at: now,
              updated_at: now,
            });
          }
        }
        // 回滚目标重新成为生效版本；历史内容不变，只切指针与状态。
        if (target.state !== "ACTIVE") {
          this.repository.updateRelease({
            ...target,
            state: "ACTIVE",
            retired_at: null,
            updated_at: now,
          });
        }
        this.repository.upsertPointer({
          merchant_id: merchantId,
          skill_key: target.skill_key,
          release_id: target.release_id,
          generation: currentGeneration + 1,
          updated_at: now,
        });
        this.repository.appendEvent({
          merchantId,
          subjectKind: "release",
          subjectId: target.release_id,
          event: "release_rolled_back",
          detail: { generation: currentGeneration + 1, reason },
          createdAt: now,
        });
        return {
          release_id: target.release_id,
          generation: currentGeneration + 1,
          skill_key: target.skill_key,
          previous_release_id: previousReleaseId,
        };
      },
    );
  }

  /**
   * `learning.revoke`：安全撤回。REVOKED 版本在加载/工具/发布门都被拒绝；
   * 撤回当前生效版本会清空生效指针（回到原接待），并递增 revocation_epoch。
   */
  revokeRelease(
    input: {
      merchant_id: string;
      actor: ActorContext;
      release_id: string;
      expected_generation: number;
      reason: string;
    },
    command: LearningCommandOptions = {},
  ): SkillRelease {
    this.ensureAvailable();
    const merchantId = requireOpaque(input.merchant_id, "merchant_id");
    requireActorCapability(merchantId, input.actor, "learning:publish");
    const releaseId = requireOpaque(input.release_id, "release_id");
    if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) {
      throw new LearningError("validation", "expected_generation_invalid", "expected_generation 必须是非负整数");
    }
    const reason = requireBoundedText(input.reason, "reason", MAX_REASON_CHARS);
    return this.withCommand(
      merchantId,
      input.actor.actor_id,
      "learning.revokeRelease",
      { release_id: releaseId, expected_generation: input.expected_generation, reason },
      command,
      () => {
        const now = this.now();
        const release = this.repository.readRelease(merchantId, releaseId);
        if (release === undefined) {
          throw new LearningError("not_found", "release_not_found", "版本不存在或不可见");
        }
        if (release.state === "REVOKED") return release;
        const pointer = this.repository.readPointer(merchantId, release.skill_key);
        const currentGeneration = pointer?.generation ?? 0;
        if (currentGeneration !== input.expected_generation) {
          throw new LearningError(
            "version_conflict",
            "generation_mismatch",
            `生效指针 generation 已变化（当前 ${currentGeneration}）`,
          );
        }
        const revoked: SkillRelease = {
          ...release,
          state: "REVOKED",
          revocation_epoch: release.revocation_epoch + 1,
          revoked_at: now,
          updated_at: now,
        };
        this.repository.updateRelease(revoked);
        if (pointer?.release_id === release.release_id) {
          this.repository.upsertPointer({
            merchant_id: merchantId,
            skill_key: release.skill_key,
            release_id: null,
            generation: currentGeneration + 1,
            updated_at: now,
          });
        }
        this.repository.appendEvent({
          merchantId,
          subjectKind: "release",
          subjectId: release.release_id,
          event: "release_revoked",
          detail: { revocation_epoch: revoked.revocation_epoch, reason },
          createdAt: now,
        });
        return revoked;
      },
    );
  }

  getReview(merchantId: string, reviewId: string): LearningReview | undefined {
    this.ensureAvailable();
    return this.repository.readReview(
      requireOpaque(merchantId, "merchant_id"),
      requireOpaque(reviewId, "review_id"),
    );
  }

  listReviews(merchantId: string, limit = 100): LearningReview[] {
    this.ensureAvailable();
    const merchant = requireOpaque(merchantId, "merchant_id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new LearningError("validation", "limit_invalid", "limit 必须在 1..200");
    }
    return this.repository.listReviews(merchant, limit);
  }

  getRelease(merchantId: string, releaseId: string): SkillRelease | undefined {
    this.ensureAvailable();
    return this.repository.readRelease(
      requireOpaque(merchantId, "merchant_id"),
      requireOpaque(releaseId, "release_id"),
    );
  }

  listReleases(merchantId: string, skillKey?: string, limit = 100): SkillRelease[] {
    this.ensureAvailable();
    const merchant = requireOpaque(merchantId, "merchant_id");
    const key = skillKey === undefined ? undefined : requireOpaque(skillKey, "skill_key");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new LearningError("validation", "limit_invalid", "limit 必须在 1..200");
    }
    return this.repository.listReleases(merchant, key, limit);
  }

  getActiveRelease(merchantId: string, skillKey: string): SkillRelease | undefined {
    this.ensureAvailable();
    const merchant = requireOpaque(merchantId, "merchant_id");
    const key = requireOpaque(skillKey, "skill_key");
    const pointer = this.repository.readPointer(merchant, key);
    if (pointer === undefined || pointer.release_id === null) return undefined;
    return this.repository.readRelease(merchant, pointer.release_id);
  }

  getCorrection(merchantId: string, correctionId: string): LearningCorrection | undefined {
    this.ensureAvailable();
    return this.repository.readCorrection(
      requireOpaque(merchantId, "merchant_id"),
      requireOpaque(correctionId, "correction_id"),
    );
  }

  listCorrections(merchantId: string, limit = 100): LearningCorrection[] {
    this.ensureAvailable();
    const merchant = requireOpaque(merchantId, "merchant_id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new LearningError("validation", "limit_invalid", "limit 必须在 1..200");
    }
    return this.repository.listCorrections(merchant, limit);
  }

  getCase(merchantId: string, caseId: string): LearningCase | undefined {
    this.ensureAvailable();
    return this.repository.readCase(
      requireOpaque(merchantId, "merchant_id"),
      requireOpaque(caseId, "case_id"),
    );
  }

  /** 候选文本预检：与纠正相同的客户数据/底价/凭据拒绝规则。 */
  private validateCandidateText(
    merchantId: string,
    actorId: string,
    operation: string,
    input: { trigger: string; reason: string; exclusions?: readonly string[] },
  ): { trigger: string; reason: string; exclusions: string[] } {
    const trigger = requireBoundedText(input.trigger, "trigger", MAX_TRIGGER_CHARS);
    const reason = requireBoundedText(input.reason, "reason", MAX_REASON_CHARS);
    const exclusions = normalizeStringList(
      input.exclusions,
      "exclusions",
      MAX_EXCLUSIONS,
      MAX_EXCLUSION_CHARS,
    );
    const sensitive = detectCorrectionSensitiveContent(
      [trigger, reason, ...exclusions].join("\n"),
    );
    if (sensitive !== undefined) {
      this.repository.transaction(() => {
        this.repository.recordRejection({
          merchantId,
          actorId,
          operation,
          reasonCode: `precheck:${sensitive}`,
          subjectDigest: contentDigest({
            operation,
            reason_code: sensitive,
            actor_id: actorId,
            text_length: trigger.length + reason.length,
          }),
          createdAt: this.now(),
        });
      });
      throw new LearningError(
        "sensitive_content",
        `precheck:${sensitive}`,
        "候选内容包含客户标识、联系方式、凭据或价格底线；请改为抽象流程描述后重试",
      );
    }
    return { trigger, reason, exclusions };
  }

  /** 校验案例状态并编译冻结产物；任何内容变化都产生不同 content_digest。 */
  private buildCandidateContent(
    merchantId: string,
    input: {
      skillKey: string;
      caseIds: readonly string[];
      trigger: string;
      steps: readonly unknown[];
      exclusions: readonly string[];
      reason: string;
      baseReleaseId?: string | null;
      requiredTools?: readonly string[];
    },
  ): {
    compiled: ReturnType<typeof compileReceptionSkillArtifact>;
    contentDigest: string;
  } {
    for (const caseId of input.caseIds) {
      const record = this.repository.readCase(merchantId, caseId);
      if (record === undefined) {
        throw new LearningError("not_found", "case_not_found", "案例不存在或不可见");
      }
      if (record.status !== "ACTIVE") {
        throw new LearningError(
          "version_conflict",
          "case_stale",
          `案例 ${caseId} 已失效；请先重新提升纠正形成新案例`,
        );
      }
    }
    let compiled: ReturnType<typeof compileReceptionSkillArtifact>;
    try {
      compiled = compileReceptionSkillArtifact({
        skill_key: input.skillKey,
        steps: input.steps,
        ...(input.requiredTools !== undefined ? { required_tools: input.requiredTools } : {}),
      });
    } catch (err) {
      if (err instanceof SkillContractError) {
        throw new LearningError(
          err.code === "unsupported_capability" ? "unsupported_capability" : "validation",
          err.reason,
          err.message,
        );
      }
      throw err;
    }
    const digest = contentDigest({
      kind: "learning.candidate",
      skill_key: input.skillKey,
      base_release_id: input.baseReleaseId ?? null,
      case_ids: input.caseIds,
      trigger: input.trigger,
      proposed_steps: compiled.artifact.steps,
      exclusions: input.exclusions,
      reason: input.reason,
      required_tools: compiled.artifact.required_tools,
      question_schema_version: compiled.artifact.question_schema_version,
      tool_contract_digest: compiled.tool_contract_digest,
    });
    return { compiled, contentDigest: digest };
  }

  /** 命令幂等：事务内复查（并发同键只执行一次）；同键异摘要冲突。 */
  private withCommand<T>(
    merchantId: string,
    actorId: string,
    operation: string,
    request: unknown,
    command: LearningCommandOptions,
    work: () => T,
  ): T {
    const commandId =
      command.command_id === undefined
        ? undefined
        : requireOpaque(command.command_id, "command_id");
    const digest = contentDigest({ operation, request });
    return this.repository.transaction(() => {
      if (commandId !== undefined) {
        const existing = this.repository.readIdempotent(
          merchantId,
          actorId,
          operation,
          commandId,
        );
        if (existing !== undefined) {
          if (existing.requestDigest !== digest) {
            throw new LearningError(
              "idempotency_conflict",
              "command_replay_conflict",
              "同一 command_id 已用于不同内容",
            );
          }
          return JSON.parse(existing.result) as T;
        }
      }
      const result = work();
      if (commandId !== undefined) {
        this.repository.saveIdempotent({
          merchantId,
          actorId,
          operation,
          commandId,
          requestDigest: digest,
          result,
          createdAt: this.now(),
        });
      }
      return result;
    });
  }
}
