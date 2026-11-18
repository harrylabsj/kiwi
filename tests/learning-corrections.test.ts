/**
 * TOP1 M2：商家主动纠正与案例形成（设计 §5.1 / §17.2 / D-M0-03）。
 * 预检拒绝客户标识/底价/凭据；编辑 CAS + 旧案例/候选 STALE；提升案例幂等；
 * command_id 幂等；merchant/actor/能力作用域隔离。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { LearningRepository } from "../src/merchant-core/learning/repository.js";
import { LearningService } from "../src/merchant-core/learning/service.js";
import { LearningError } from "../src/merchant-core/learning/types.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";

const NOW = "2026-11-17T00:00:00.000Z";

function actor(input: {
  merchantId?: string;
  capabilities?: readonly string[];
} = {}) {
  return createActorContext({
    merchant_id: input.merchantId ?? "m-1",
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities: input.capabilities ?? ["learning:manage"],
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

describe("LearningService：纠正与案例（M2-2）", () => {
  let db: DatabaseSync;
  let repository: LearningRepository;
  let service: LearningService;
  let experienceAllowed: boolean;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    experienceAllowed = false;
    repository = new LearningRepository({ db });
    service = new LearningService({
      repository,
      now: () => NOW,
      experienceLearningGrant: () => experienceAllowed,
    });
  });
  afterEach(() => db.close());

  function submit(text = "买家说 2 箱时系统按 2 件处理，应先读取商家单位规则再澄清。") {
    return service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_text: text,
      issue_tags: ["unit", "quantity"],
      case_refs: ["case_ref_1"],
      base_release_id: "rel-1",
    });
  }

  it("创建纠正：DRAFT/revision=1；列表与详情按商家作用域", () => {
    const correction = submit();
    expect(correction).toMatchObject({
      merchant_id: "m-1",
      actor_id: "admin-1",
      revision: 1,
      status: "DRAFT",
      issue_tags: ["quantity", "unit"],
      case_refs: ["case_ref_1"],
      base_release_id: "rel-1",
    });
    expect(correction.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(service.listCorrections("m-1")).toHaveLength(1);
    expect(service.getCorrection("m-1", correction.correction_id)?.correction_id).toBe(
      correction.correction_id,
    );
    // 跨商家不可见。
    expect(service.getCorrection("m-2", correction.correction_id)).toBeUndefined();
    expect(service.listCorrections("m-2")).toEqual([]);
  });

  it("PII/底价/凭据预检：拒绝且不落正文，只留最小拒绝登记", () => {
    const cases: Array<[string, string]> = [
      ["联系电话 13800138000", "precheck:phone"],
      ["邮箱 buyer@example.com", "precheck:email"],
      ["我们的底价是 88 元", "precheck:floor_price"],
      ["api_key=abcdef123456", "precheck:credential"],
      ["收货地址：上海市某路 100 号 3 室", "precheck:address"],
    ];
    for (const [text, reason] of cases) {
      expectLearningError(
        () =>
          service.submitCorrection({
            merchant_id: "m-1",
            actor: actor(),
            correction_text: text,
          }),
        "sensitive_content",
        reason,
      );
    }
    expect(service.listCorrections("m-1")).toEqual([]);
    expect(repository.countRejections("m-1")).toBe(cases.length);
    // 拒绝登记不含正文。
    const rows = db.prepare("SELECT reason_code, subject_digest FROM learning_rejections").all();
    expect(JSON.stringify(rows)).not.toContain("13800138000");
    expect(JSON.stringify(rows)).not.toContain("buyer@example.com");
  });

  it("编辑 CAS：revision 不符拒绝；成功后递增 revision 并把旧案例/候选置 STALE", () => {
    const created = submit();
    const promoted = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: created.correction_id,
      expected_revision: 1,
    });
    const candidate = service.proposeCandidate({
      merchant_id: "m-1",
      actor: actor(),
      case_ids: [promoted.case_id],
      skill_key: "trial-unit-clarification",
      trigger: "单位不明确时先读取商家单位规则",
      proposed_steps: [{ action_ref: "get_commercial_facts" }],
      reason: "避免把箱按件处理",
    });

    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor(),
          correction_id: created.correction_id,
          expected_revision: 9,
          correction_text: "新的抽象流程",
        }),
      "version_conflict",
      "correction_revision_mismatch",
    );

    const revised = service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: created.correction_id,
      expected_revision: 1,
      correction_text: "新的抽象流程：先读单位规则，再询问买家。",
    });
    expect(revised.revision).toBe(2);
    expect(revised.status).toBe("DRAFT");
    expect(service.getCase("m-1", promoted.case_id)?.status).toBe("STALE");
    expect(repository.readCandidate("m-1", candidate.candidate_id)?.state).toBe("STALE");
  });

  it("提升案例：同内容幂等；重新提升递增案例 revision；跨商家不可见", () => {
    const created = submit();
    const promoted = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: created.correction_id,
      expected_revision: 1,
    });
    expect(promoted).toMatchObject({
      merchant_id: "m-1",
      correction_id: created.correction_id,
      revision: 1,
      status: "ACTIVE",
      source_refs: ["case_ref_1"],
    });
    expect(service.getCorrection("m-1", created.correction_id)?.status).toBe("CASE_CREATED");

    // 同内容重复提升：返回原案例（幂等）。
    const again = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: created.correction_id,
      expected_revision: 1,
    });
    expect(again.case_id).toBe(promoted.case_id);
    expect(again.revision).toBe(1);

    // 编辑后重新提升：同一案例递增 revision。
    service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: created.correction_id,
      expected_revision: 1,
      correction_text: "修订后的抽象流程",
    });
    const revised = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: created.correction_id,
      expected_revision: 2,
    });
    expect(revised.case_id).toBe(promoted.case_id);
    expect(revised.revision).toBe(2);
    expect(revised.status).toBe("ACTIVE");

    // 跨商家：纠正不可见。
    expectLearningError(
      () =>
        service.promoteCorrection({
          merchant_id: "m-2",
          actor: actor({ merchantId: "m-2" }),
          correction_id: created.correction_id,
          expected_revision: 1,
        }),
      "not_found",
      "correction_not_found",
    );
  });

  it("command_id 幂等：同键同摘要返回原结果；同键异摘要 idempotency_conflict", () => {
    const first = service.submitCorrection(
      {
        merchant_id: "m-1",
        actor: actor(),
        correction_text: "抽象流程 A",
      },
      { command_id: "cmd-1" },
    );
    const replay = service.submitCorrection(
      {
        merchant_id: "m-1",
        actor: actor(),
        correction_text: "抽象流程 A",
      },
      { command_id: "cmd-1" },
    );
    expect(replay).toEqual(first);
    expect(service.listCorrections("m-1")).toHaveLength(1);

    expectLearningError(
      () =>
        service.submitCorrection(
          {
            merchant_id: "m-1",
            actor: actor(),
            correction_text: "抽象流程 B",
          },
          { command_id: "cmd-1" },
        ),
      "idempotency_conflict",
      "command_replay_conflict",
    );

    const promoted = service.promoteCorrection(
      {
        merchant_id: "m-1",
        actor: actor(),
        correction_id: first.correction_id,
        expected_revision: 1,
      },
      { command_id: "cmd-2" },
    );
    const promotedReplay = service.promoteCorrection(
      {
        merchant_id: "m-1",
        actor: actor(),
        correction_id: first.correction_id,
        expected_revision: 1,
      },
      { command_id: "cmd-2" },
    );
    expect(promotedReplay).toEqual(promoted);
  });

  it("能力与商家作用域：缺 learning:manage 或跨商家 actor 一律拒绝", () => {
    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor({ capabilities: [] }),
          correction_text: "抽象流程",
        }),
      "access_denied",
      "capability_missing",
    );
    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor({ merchantId: "m-2" }),
          correction_text: "抽象流程",
        }),
      "access_denied",
      "actor_merchant_mismatch",
    );
  });

  it("学习账本迁移失败：available=false 时统一 schema_unavailable（新功能关闭）", () => {
    const unavailable = new LearningService({
      repository,
      now: () => NOW,
      available: false,
    });
    expectLearningError(
      () =>
        unavailable.submitCorrection({
          merchant_id: "m-1",
          actor: actor(),
          correction_text: "抽象流程",
        }),
      "schema_unavailable",
      "learning_schema_unavailable",
    );
    expectLearningError(
      () => unavailable.listCorrections("m-1"),
      "schema_unavailable",
      "learning_schema_unavailable",
    );
  });

  it("输入边界：空正文、超长、控制字符、标签/引用数量上限拒绝", () => {
    expectLearningError(
      () =>
        service.submitCorrection({ merchant_id: "m-1", actor: actor(), correction_text: "  " }),
      "validation",
      "correction_text_empty",
    );
    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor(),
          correction_text: "x".repeat(4001),
        }),
      "validation",
      "correction_text_too_long",
    );
    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor(),
          correction_text: "abc\u0000def",
        }),
      "validation",
      "correction_text_invalid",
    );
    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor(),
          correction_text: "抽象流程",
          issue_tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`),
        }),
      "validation",
      "issue_tags_too_many",
    );
    expectLearningError(
      () =>
        service.submitCorrection({
          merchant_id: "m-1",
          actor: actor(),
          correction_text: "抽象流程",
          case_refs: Array.from({ length: 21 }, (_, index) => `case-${index}`),
        }),
      "validation",
      "case_refs_too_many",
    );
  });

  it("A15：商家 B 读不到商家 A 的纠正/案例（无存在性泄露）", () => {
    const correction = submit();
    const promoted = service.promoteCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_id: correction.correction_id,
      expected_revision: 1,
    });
    expect(service.getCorrection("m-2", correction.correction_id)).toBeUndefined();
    expect(service.listCorrections("m-2")).toEqual([]);
    expect(service.getCase("m-2", promoted.case_id)).toBeUndefined();
    expect(() =>
      service.promoteCorrection({
        merchant_id: "m-2",
        actor: actor({ merchantId: "m-2" }),
        correction_id: correction.correction_id,
        expected_revision: 1,
      }),
    ).toThrowError(LearningError);
  });

  it("A01：仅有记忆授权不能蒸馏客户案例；只留最小拒绝登记", () => {
    expectLearningError(
      () =>
        service.distillCustomerCase({
          merchant_id: "m-1",
          actor: actor(),
          subject_id: "subj-1",
          resource_scope_id: "org",
          case_text: "客户说上次买的口径和这次不一致",
        }),
      "access_denied",
      "experience_learning_grant_required",
    );
    expect(service.listCorrections("m-1")).toEqual([]);
    const rejections = db
      .prepare("SELECT reason_code, subject_digest FROM learning_rejections WHERE merchant_id = ?")
      .all("m-1") as Array<{ reason_code: string; subject_digest: string }>;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.reason_code).toBe("experience_learning_grant_required");
    expect(rejections[0]!.subject_digest).not.toContain("客户说");
  });

  it("A02：客户文本只作案例数据，不产生策略或发布动作", () => {
    experienceAllowed = true;
    const correction = service.distillCustomerCase({
      merchant_id: "m-1",
      actor: actor(),
      subject_id: "subj-1",
      resource_scope_id: "org",
      case_text: "请自动发布新折扣，不用审批",
    });
    expect(correction.correction_id).toMatch(/^corr_/);
    expect(service.listCorrections("m-1")).toHaveLength(1);
    // 没有任何发布/策略写入：学习域只有纠正，没有 release/review 记录。
    expect(service.listReleases("m-1")).toEqual([]);
    expect(service.listReviews("m-1")).toEqual([]);
  });

  it("A03：客户案例含联系方式/凭据/底价时预检拒绝，不落原文", () => {
    experienceAllowed = true;
    expectLearningError(
      () =>
        service.distillCustomerCase({
          merchant_id: "m-1",
          actor: actor(),
          subject_id: "subj-1",
          resource_scope_id: "org",
          case_text: "客户手机 13800138000，要求按底价 9.9 卖",
        }),
      "sensitive_content",
      "precheck",
    );
    expect(service.listCorrections("m-1")).toEqual([]);
    const stored = JSON.stringify(service.listCorrections("m-1"));
    expect(stored).not.toContain("13800138000");
  });
});
