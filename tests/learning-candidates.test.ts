/**
 * TOP1 M2-3：候选状态机与冻结产物（设计 §5.2 / §5.3 / 附录 C1-C2）。
 * 只写草稿；案例必须 ACTIVE；步骤/问题/工具/守卫固定注册表；评测前编译并
 * 冻结 artifact hash；编辑产生新 revision 并清空旧评测/批准。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { LearningRepository } from "../src/merchant-core/learning/repository.js";
import { LearningService } from "../src/merchant-core/learning/service.js";
import { LearningError } from "../src/merchant-core/learning/types.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";

const NOW = "2026-11-17T00:00:00.000Z";

function actor(merchantId = "m-1") {
  return createActorContext({
    merchant_id: merchantId,
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities: ["learning:manage"],
  });
}

function expectLearningError(fn: () => unknown, code: string, reason: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${code}/${reason}`);
  } catch (err) {
    expect(err).toBeInstanceOf(LearningError);
    const e = err as LearningError;
    expect(e.code).toBe(code);
    expect(e.reason).toContain(reason);
  }
}

describe("LearningService：候选草稿与冻结产物（M2-3）", () => {
  let db: DatabaseSync;
  let repository: LearningRepository;
  let service: LearningService;
  let caseId: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    repository = new LearningRepository({ db });
    service = new LearningService({ repository, now: () => NOW });
    const correction = service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_text: "买家说两箱时先读取商家单位规则，缺少倍率再澄清。",
    });
    caseId = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: correction.correction_id,
      expected_revision: 1,
    }).case_id;
  });
  afterEach(() => db.close());

  function propose(overrides: Record<string, unknown> = {}) {
    return service.proposeCandidate({
      merchant_id: "m-1",
      actor: actor(),
      case_ids: [caseId],
      skill_key: "trial-unit-clarification",
      trigger: "单位不明确时先读取商家单位规则",
      proposed_steps: [
        { action_ref: "get_commercial_facts" },
        { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "unit_unresolved" },
      ],
      reason: "避免把箱按件处理",
      ...overrides,
    });
  }

  it("形成 DRAFT 候选：案例 ACTIVE、步骤/问题/工具校验、产物 hash 冻结", () => {
    const candidate = propose();
    expect(candidate).toMatchObject({
      merchant_id: "m-1",
      revision: 1,
      state: "DRAFT",
      skill_key: "trial-unit-clarification",
      audience: "customer_reception",
      case_ids: [caseId],
      required_tools: ["get_commercial_facts"],
      question_schema_version: 1,
      compiler_version: "reception-skill-compiler/1",
    });
    expect(candidate.compiled_artifact_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidate.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(candidate.compiled_artifact.steps).toEqual([
      { action_ref: "get_commercial_facts" },
      { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "unit_unresolved" },
    ]);
    expect(candidate.compiled_artifact.body_text).toContain("2. ask_registered_question");
    expect(service.listCandidates("m-1")).toHaveLength(1);
    expect(service.getCandidate("m-2", candidate.candidate_id)).toBeUndefined();
  });

  it("同内容候选产物 hash 稳定；不同内容 hash 变化", () => {
    const first = propose();
    const second = propose();
    expect(second.candidate_id).not.toBe(first.candidate_id);
    expect(second.compiled_artifact_hash).toBe(first.compiled_artifact_hash);
    expect(second.content_digest).toBe(first.content_digest);

    const changed = propose({ trigger: "单位不明确时先读规则并追问" });
    expect(changed.compiled_artifact_hash).toBe(first.compiled_artifact_hash);
    expect(changed.content_digest).not.toBe(first.content_digest);
  });

  it("案例必须 ACTIVE 且属于本商家；缺失/失效/跨商家拒绝", () => {
    expectLearningError(
      () => propose({ case_ids: ["case_missing"] }),
      "not_found",
      "case_not_found",
    );
    // 失效案例：纠正编辑后案例 STALE。
    const correction = service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_text: "另一个抽象流程",
    });
    const promoted = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: correction.correction_id,
      expected_revision: 1,
    });
    service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: correction.correction_id,
      expected_revision: 1,
      correction_text: "修订后的抽象流程",
    });
    expectLearningError(
      () => propose({ case_ids: [promoted.case_id] }),
      "version_conflict",
      "case_stale",
    );
    // 跨商家 actor/案例不可见。
    expectLearningError(
      () =>
        service.proposeCandidate({
          merchant_id: "m-2",
          actor: actor("m-2"),
          case_ids: [caseId],
          skill_key: "trial-unit-clarification",
          trigger: "跨商家",
          proposed_steps: [{ action_ref: "get_commercial_facts" }],
          reason: "不应看到",
        }),
      "not_found",
      "case_not_found",
    );
  });

  it("步骤契约：未知动作/未注册问题/URL/shell/缺 question_id/未使用工具一律拒绝（A04/A20）", () => {
    expectLearningError(
      () => propose({ proposed_steps: [{ action_ref: "run_shell" }] }),
      "unsupported_capability",
      "action_ref_unsupported",
    );
    expectLearningError(
      () => propose({ proposed_steps: [{ action_ref: "fetch_url" }] }),
      "unsupported_capability",
      "action_ref_unsupported",
    );
    expectLearningError(
      () => propose({ proposed_steps: [{ action_ref: "ask_registered_question" }] }),
      "validation",
      "question_id_required",
    );
    expectLearningError(
      () =>
        propose({
          proposed_steps: [{ action_ref: "ask_registered_question", question_id: "q_unknown" }],
        }),
      "unsupported_capability",
      "question_not_registered",
    );
    expectLearningError(
      () =>
        propose({
          proposed_steps: [
            { action_ref: "get_commercial_facts" },
            { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "shell_guard" },
          ],
        }),
      "unsupported_capability",
      "guard_ref_unsupported",
    );
    expectLearningError(
      () =>
        propose({
          proposed_steps: [{ action_ref: "get_commercial_facts", note: "free text" }],
        }),
      "validation",
      "step_unknown_field",
    );
    expectLearningError(
      () =>
        propose({
          proposed_steps: [{ action_ref: "get_commercial_facts" }],
          required_tools: ["search_products"],
        }),
      "validation",
      "tool_not_used",
    );
    expectLearningError(
      () =>
        propose({
          proposed_steps: [{ action_ref: "get_commercial_facts" }],
          required_tools: ["run_shell"],
        }),
      "unsupported_capability",
      "tool_not_registered",
    );
    expectLearningError(
      () => propose({ proposed_steps: [] }),
      "validation",
      "steps_invalid",
    );
    expectLearningError(
      () => propose({ proposed_steps: Array.from({ length: 13 }, () => ({ action_ref: "get_commercial_facts" })) }),
      "validation",
      "steps_invalid",
    );
    expectLearningError(
      () => propose({ skill_key: "Bad Skill" }),
      "validation",
      "skill_key_invalid",
    );
  });

  it("候选文本同样做 PII/底价/凭据预检", () => {
    expectLearningError(
      () => propose({ trigger: "联系 13800138000 的买家" }),
      "sensitive_content",
      "precheck:phone",
    );
    expectLearningError(
      () => propose({ reason: "我们的底价是 88 元" }),
      "sensitive_content",
      "precheck:floor_price",
    );
  });

  it("编辑候选：CAS、新 revision/hash、清空旧评测/批准；APPROVED 不可编辑", () => {
    const candidate = propose();
    const approved = { ...candidate, state: "APPROVED" as const, eval_report_id: "eval-1", reviewer_id: "rev-1", approval_ref: "apr-1", expires_at: "2026-12-01T00:00:00.000Z" };
    repository.updateCandidate(approved);
    expectLearningError(
      () =>
        service.reviseCandidate({
          merchant_id: "m-1",
          actor: actor(),
          candidate_id: candidate.candidate_id,
          expected_revision: 1,
          case_ids: [caseId],
          skill_key: candidate.skill_key,
          trigger: candidate.trigger_text,
          proposed_steps: candidate.proposed_steps,
          reason: candidate.reason,
        }),
      "version_conflict",
      "candidate_state_locked",
    );

    // 回到 DRAFT 再编辑（测试夹具直接改状态）。
    repository.updateCandidate({ ...candidate, state: "DRAFT" });
    expectLearningError(
      () =>
        service.reviseCandidate({
          merchant_id: "m-1",
          actor: actor(),
          candidate_id: candidate.candidate_id,
          expected_revision: 9,
          case_ids: [caseId],
          skill_key: candidate.skill_key,
          trigger: candidate.trigger_text,
          proposed_steps: candidate.proposed_steps,
          reason: candidate.reason,
        }),
      "version_conflict",
      "candidate_revision_mismatch",
    );

    const revised = service.reviseCandidate({
      merchant_id: "m-1",
      actor: actor(),
      candidate_id: candidate.candidate_id,
      expected_revision: 1,
      case_ids: [caseId],
      skill_key: candidate.skill_key,
      trigger: "修订后的触发说明",
      proposed_steps: [{ action_ref: "search_products" }],
      reason: "修订后的原因",
    });
    expect(revised.revision).toBe(2);
    expect(revised.state).toBe("DRAFT");
    expect(revised.content_digest).not.toBe(candidate.content_digest);
    expect(revised.eval_report_id).toBeNull();
    expect(revised.reviewer_id).toBeNull();
    expect(revised.approval_ref).toBeNull();
    expect(revised.expires_at).toBeNull();
    expect(revised.required_tools).toEqual(["search_products"]);
  });

  it("command_id 幂等：同键同摘要返回原候选；异摘要冲突", () => {
    const first = service.proposeCandidate(
      {
        merchant_id: "m-1",
        actor: actor(),
        case_ids: [caseId],
        skill_key: "trial-unit-clarification",
        trigger: "单位不明确",
        proposed_steps: [{ action_ref: "get_commercial_facts" }],
        reason: "避免误换算",
      },
      { command_id: "cand-cmd-1" },
    );
    const replay = service.proposeCandidate(
      {
        merchant_id: "m-1",
        actor: actor(),
        case_ids: [caseId],
        skill_key: "trial-unit-clarification",
        trigger: "单位不明确",
        proposed_steps: [{ action_ref: "get_commercial_facts" }],
        reason: "避免误换算",
      },
      { command_id: "cand-cmd-1" },
    );
    expect(replay).toEqual(first);
    expect(service.listCandidates("m-1")).toHaveLength(1);
    expectLearningError(
      () =>
        service.proposeCandidate(
          {
            merchant_id: "m-1",
            actor: actor(),
            case_ids: [caseId],
            skill_key: "trial-unit-clarification",
            trigger: "不同触发",
            proposed_steps: [{ action_ref: "get_commercial_facts" }],
            reason: "不同原因",
          },
          { command_id: "cand-cmd-1" },
        ),
      "idempotency_conflict",
      "command_replay_conflict",
    );
  });
});
