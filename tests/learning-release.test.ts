/**
 * TOP1 M2-5：审核、发布、回滚与撤回（设计 §5.3 / §6.3 / A07-A11）。
 * 批准绑定内容/产物/评测；7 天待审、24h 发布窗；发布只激活冻结产物；
 * 回滚新增 generation、不覆盖历史；撤回阻断旧版本。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { LearningRepository } from "../src/merchant-core/learning/repository.js";
import { LearningService } from "../src/merchant-core/learning/service.js";
import type {
  EvaluationRunner,
  EvaluationSuite,
} from "../src/merchant-core/learning/evaluation.js";
import { LearningError } from "../src/merchant-core/learning/types.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";

const NOW = "2026-11-17T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;

function actor(capabilities: readonly string[] = ["learning:manage"]) {
  return createActorContext({
    merchant_id: "m-1",
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities,
  });
}

const OWNER = ["learning:manage", "learning:review", "learning:publish"] as const;

function suite(version: string): EvaluationSuite {
  return {
    suite_version: version,
    scenarios: [
      ...Array.from({ length: 8 }, (_, index) => ({
        scenario_id: `target-${index}`,
        kind: "target" as const,
        input: { index },
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        scenario_id: `adjacent-${index}`,
        kind: "adjacent" as const,
        input: { index },
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        scenario_id: `boundary-${index}`,
        kind: "boundary" as const,
        input: { index },
      })),
    ],
  };
}

const passRunner: EvaluationRunner = ({ variant }) => ({
  passed: true,
  hard_gate_failures: 0,
  ...(variant === "candidate" ? { improvement_delta: 1 } : {}),
});

function expectLearningError(fn: () => unknown, reason: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${reason}`);
  } catch (err) {
    expect(err).toBeInstanceOf(LearningError);
    expect((err as LearningError).reason).toContain(reason);
  }
}

describe("审核/发布/回滚/撤回（M2-5）", () => {
  let db: DatabaseSync;
  let repository: LearningRepository;
  let service: LearningService;
  let clock: string;
  let suiteCounter: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    repository = new LearningRepository({ db });
    clock = NOW;
    suiteCounter = 0;
    service = new LearningService({ repository, now: () => clock });
  });
  afterEach(() => db.close());

  async function readyCandidate(input: {
    skillKey?: string;
    text?: string;
  } = {}): Promise<{ candidateId: string; contentHash: string; evaluationId: string }> {
    const skillKey = input.skillKey ?? "trial-unit-clarification";
    const correction = service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_text: input.text ?? "单位不明确时先读取商家规则。",
    });
    const promoted = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: correction.correction_id,
      expected_revision: 1,
    });
    const candidate = service.proposeCandidate({
      merchant_id: "m-1",
      actor: actor(),
      case_ids: [promoted.case_id],
      skill_key: skillKey,
      trigger: "单位不明确时先读取单位规则",
      proposed_steps: [{ action_ref: "get_commercial_facts" }],
      reason: "避免误换算",
    });
    suiteCounter += 1;
    const evaluation = await service.evaluateCandidate({
      merchant_id: "m-1",
      actor: actor(),
      candidate_id: candidate.candidate_id,
      content_hash: candidate.compiled_artifact_hash,
      suite: suite(`suite-release-${suiteCounter}`),
      runner: passRunner,
    });
    expect(evaluation.state).toBe("READY_FOR_REVIEW");
    return {
      candidateId: candidate.candidate_id,
      contentHash: candidate.compiled_artifact_hash,
      evaluationId: evaluation.evaluation_id,
    };
  }

  async function approved(candidateId: string, contentHash: string, evaluationId: string) {
    return service.reviewCandidate({
      merchant_id: "m-1",
      actor: actor(OWNER),
      candidate_id: candidateId,
      content_hash: contentHash,
      evaluation_id: evaluationId,
      decision: "approve",
    });
  }

  it("审核：缺少 learning:review 拒绝；批准绑定内容/产物/评测与 7 天截止", async () => {
    const { candidateId, contentHash, evaluationId } = await readyCandidate();
    expectLearningError(
      () =>
        service.reviewCandidate({
          merchant_id: "m-1",
          actor: actor(),
          candidate_id: candidateId,
          content_hash: contentHash,
          evaluation_id: evaluationId,
          decision: "approve",
        }),
      "capability_missing",
    );
    const review = await approved(candidateId, contentHash, evaluationId);
    expect(review).toMatchObject({
      decision: "APPROVE",
      candidate_id: candidateId,
      artifact_hash: contentHash,
      eval_report_id: evaluationId,
      reviewer_id: "admin-1",
    });
    expect(review.approval_ref).toMatch(/^apr_/);
    expect(Date.parse(review.expires_at) - Date.parse(review.approved_at)).toBe(7 * 24 * HOUR);
    const candidate = service.getCandidate("m-1", candidateId)!;
    expect(candidate.state).toBe("APPROVED");
    expect(candidate.approval_ref).toBe(review.approval_ref);
    expect(candidate.expires_at).toBe(review.expires_at);
  });

  it("发布：CAS generation=0 → release generation 1 ACTIVE；同批准幂等；generation 不符拒绝", async () => {
    const { candidateId, contentHash, evaluationId } = await readyCandidate();
    const review = await approved(candidateId, contentHash, evaluationId);
    const release = service.publishRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      approval_ref: review.approval_ref,
      expected_generation: 0,
    });
    expect(release).toMatchObject({
      skill_key: "trial-unit-clarification",
      generation: 1,
      state: "ACTIVE",
      artifact_hash: contentHash,
      approval_ref: review.approval_ref,
    });
    expect(service.getActiveRelease("m-1", "trial-unit-clarification")?.release_id).toBe(
      release.release_id,
    );
    // A08：审计真实发布人（服务端 actor），不是请求正文自报。
    const publishedEvent = db
      .prepare(
        "SELECT detail_json FROM learning_events WHERE subject_id = ? AND event = 'release_published'",
      )
      .get(release.release_id) as { detail_json: string };
    expect(JSON.parse(publishedEvent.detail_json)).toMatchObject({
      generation: 1,
      publisher_id: "admin-1",
    });
    // 幂等：同批准再次发布返回原 release。
    expect(
      service.publishRelease({
        merchant_id: "m-1",
        actor: actor(OWNER),
        approval_ref: review.approval_ref,
        expected_generation: 0,
      }).release_id,
    ).toBe(release.release_id);
    // generation 不符（新批准需要 generation=1）。
    const second = await readyCandidate({ text: "第二个抽象流程" });
    const review2 = await approved(second.candidateId, second.contentHash, second.evaluationId);
    expectLearningError(
      () =>
        service.publishRelease({
          merchant_id: "m-1",
          actor: actor(OWNER),
          approval_ref: review2.approval_ref,
          expected_generation: 0,
        }),
      "generation_mismatch",
    );
  });

  it("批准后内容/产物变化：旧批准失效，不能发布（A07）", async () => {
    const { candidateId, contentHash, evaluationId } = await readyCandidate();
    const review = await approved(candidateId, contentHash, evaluationId);
    const candidate = service.getCandidate("m-1", candidateId)!;
    // 模拟二进制/存储漂移：批准绑定的内容摘要与候选当前值不一致。
    repository.updateCandidate({ ...candidate, content_digest: "sha256:drifted" });
    expectLearningError(
      () =>
        service.publishRelease({
          merchant_id: "m-1",
          actor: actor(OWNER),
          approval_ref: review.approval_ref,
          expected_generation: 0,
        }),
      "approval_dependency_changed",
    );
  });

  it("发布窗口：超过批准 24h 后拒绝发布", async () => {
    const { candidateId, contentHash, evaluationId } = await readyCandidate();
    const review = await approved(candidateId, contentHash, evaluationId);
    clock = new Date(Date.parse(review.approved_at) + 24 * HOUR).toISOString();
    expectLearningError(
      () =>
        service.publishRelease({
          merchant_id: "m-1",
          actor: actor(OWNER),
          approval_ref: review.approval_ref,
          expected_generation: 0,
        }),
      "approval_expired",
    );
  });

  it("回滚：切回仍兼容的历史版本并新增 generation；REVOKED 版本拒绝", async () => {
    const first = await readyCandidate();
    const review1 = await approved(first.candidateId, first.contentHash, first.evaluationId);
    const release1 = service.publishRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      approval_ref: review1.approval_ref,
      expected_generation: 0,
    });

    const second = await readyCandidate({ text: "第二个抽象流程" });
    const review2 = await approved(second.candidateId, second.contentHash, second.evaluationId);
    const release2 = service.publishRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      approval_ref: review2.approval_ref,
      expected_generation: 1,
    });
    expect(release2.generation).toBe(2);
    expect(service.getRelease("m-1", release1.release_id)?.state).toBe("RETIRED");

    const rolled = service.rollbackRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      target_release_id: release1.release_id,
      expected_generation: 2,
      reason: "新版本回退",
    });
    expect(rolled).toMatchObject({
      release_id: release1.release_id,
      generation: 3,
      previous_release_id: release2.release_id,
    });
    expect(service.getActiveRelease("m-1", "trial-unit-clarification")?.release_id).toBe(
      release1.release_id,
    );
    expect(service.getRelease("m-1", release1.release_id)?.state).toBe("ACTIVE");
    expect(service.getRelease("m-1", release2.release_id)?.state).toBe("RETIRED");

    service.revokeRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      release_id: release1.release_id,
      expected_generation: 3,
      reason: "安全撤回",
    });
    expectLearningError(
      () =>
        service.rollbackRelease({
          merchant_id: "m-1",
          actor: actor(OWNER),
          target_release_id: release1.release_id,
          expected_generation: 4,
          reason: "不能回滚已撤回版本",
        }),
      "release_revoked",
    );
  });

  it("A11：回滚到不兼容/已删除版本被拒绝", async () => {
    const first = await readyCandidate();
    const review1 = await approved(first.candidateId, first.contentHash, first.evaluationId);
    const release1 = service.publishRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      approval_ref: review1.approval_ref,
      expected_generation: 0,
    });
    const second = await readyCandidate({ text: "第二个抽象流程" });
    const review2 = await approved(second.candidateId, second.contentHash, second.evaluationId);
    const release2 = service.publishRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      approval_ref: review2.approval_ref,
      expected_generation: 1,
    });
    // 模拟历史版本产物损坏/不兼容：回滚前必须重新核验冻结产物。
    db.prepare("UPDATE skill_releases SET artifact_hash = ? WHERE release_id = ?").run(
      "sha256:incompatible",
      release1.release_id,
    );
    expectLearningError(
      () =>
        service.rollbackRelease({
          merchant_id: "m-1",
          actor: actor(OWNER),
          target_release_id: release1.release_id,
          expected_generation: release2.generation,
          reason: "回滚到不兼容版本",
        }),
      "release_incompatible",
    );
  });

  it("撤回：当前生效版本 REVOKED、清空指针、revocation_epoch+1；同批准不能重新发布", async () => {
    const { candidateId, contentHash, evaluationId } = await readyCandidate();
    const review = await approved(candidateId, contentHash, evaluationId);
    const release = service.publishRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      approval_ref: review.approval_ref,
      expected_generation: 0,
    });
    const revoked = service.revokeRelease({
      merchant_id: "m-1",
      actor: actor(OWNER),
      release_id: release.release_id,
      expected_generation: 1,
      reason: "紧急撤回",
    });
    expect(revoked).toMatchObject({ state: "REVOKED", revocation_epoch: 1 });
    expect(service.getActiveRelease("m-1", "trial-unit-clarification")).toBeUndefined();
    // 幂等撤回。
    expect(
      service.revokeRelease({
        merchant_id: "m-1",
        actor: actor(OWNER),
        release_id: release.release_id,
        expected_generation: 2,
        reason: "重复撤回",
      }).state,
    ).toBe("REVOKED");
    expectLearningError(
      () =>
        service.publishRelease({
          merchant_id: "m-1",
          actor: actor(OWNER),
          approval_ref: review.approval_ref,
          expected_generation: 2,
        }),
      "release_revoked",
    );
  });

  it("审核权限与状态：operator 无 review/publish；未通过评测不能审核", async () => {
    const correction = service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_text: "未评测候选",
    });
    const promoted = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: correction.correction_id,
      expected_revision: 1,
    });
    const candidate = service.proposeCandidate({
      merchant_id: "m-1",
      actor: actor(),
      case_ids: [promoted.case_id],
      skill_key: "trial-unit-clarification",
      trigger: "未评测",
      proposed_steps: [{ action_ref: "get_commercial_facts" }],
      reason: "未评测",
    });
    expectLearningError(
      () =>
        service.reviewCandidate({
          merchant_id: "m-1",
          actor: actor(["learning:manage"]),
          candidate_id: candidate.candidate_id,
          content_hash: candidate.compiled_artifact_hash,
          evaluation_id: "eval_missing",
          decision: "approve",
        }),
      "capability_missing",
    );
    expectLearningError(
      () =>
        service.reviewCandidate({
          merchant_id: "m-1",
          actor: actor(OWNER),
          candidate_id: candidate.candidate_id,
          content_hash: candidate.compiled_artifact_hash,
          evaluation_id: "eval_missing",
          decision: "approve",
        }),
      "candidate_not_ready",
    );
  });
});
