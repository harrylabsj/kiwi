/**
 * TOP1 M2-4：评测执行器（设计 §6.1 / §6.2 / D-M0-06）。
 * 8 目标×3 + 6 相邻 + 6 边界；3/3 与硬门 0；独立 120 预算、paused/failed/
 * interrupted 可恢复；候选评测期间变化 → STALE；冻结产物契约校验。
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

function actor() {
  return createActorContext({
    merchant_id: "m-1",
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities: ["learning:manage"],
  });
}

function suite(version = "suite-v1"): EvaluationSuite {
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

function passRunner(options: {
  failTarget?: string;
  hardGateBoundary?: string;
  failAdjacentCandidate?: boolean;
  improvement?: number;
  onCall?: (call: number) => void;
} = {}): EvaluationRunner {
  let calls = 0;
  return ({ scenario, variant }) => {
    calls += 1;
    options.onCall?.(calls);
    if (
      scenario.scenario_id === options.failTarget &&
      variant === "candidate" &&
      calls % 2 === 0
    ) {
      return { passed: false, hard_gate_failures: 0 };
    }
    if (scenario.scenario_id === options.hardGateBoundary && variant === "candidate") {
      return { passed: false, hard_gate_failures: 1 };
    }
    if (scenario.kind === "adjacent" && variant === "candidate" && options.failAdjacentCandidate) {
      return { passed: false, hard_gate_failures: 0 };
    }
    return {
      passed: true,
      hard_gate_failures: 0,
      ...(variant === "candidate" ? { improvement_delta: options.improvement ?? 1 } : {}),
      diagnostics: {
        block_kinds: ["next_step"],
        question_ids: [],
        tools: [],
        text_excerpt: `diagnostics:${scenario.scenario_id}:${variant}`,
      },
    };
  };
}

describe("候选评测（M2-4）", () => {
  let db: DatabaseSync;
  let repository: LearningRepository;
  let service: LearningService;
  let candidateId: string;
  let contentHash: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    repository = new LearningRepository({ db });
    service = new LearningService({ repository, now: () => NOW });
    const correction = service.submitCorrection({
      merchant_id: "m-1",
      actor: actor(),
      correction_text: "单位不明确时先读取商家规则。",
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
      trigger: "单位不明确时先读取单位规则",
      proposed_steps: [
        { action_ref: "get_commercial_facts" },
        { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "unit_unresolved" },
      ],
      reason: "避免误换算",
    });
    candidateId = candidate.candidate_id;
    contentHash = candidate.compiled_artifact_hash;
  });
  afterEach(() => db.close());

  async function evaluate(runner: EvaluationRunner, options: { budget?: number; requireImprovement?: boolean } = {}) {
    return service.evaluateCandidate({
      merchant_id: "m-1",
      actor: actor(),
      candidate_id: candidateId,
      content_hash: contentHash,
      suite: suite(),
      runner,
      ...(options.budget !== undefined ? { budget_cap: options.budget } : {}),
      ...(options.requireImprovement !== undefined
        ? { require_improvement: options.requireImprovement }
        : {}),
    });
  }

  it("全部通过：READY_FOR_REVIEW，120 次回放，目标 8/8、边界 6/6、硬门 0", async () => {
    const evaluation = await evaluate(passRunner());
    expect(evaluation.state).toBe("READY_FOR_REVIEW");
    expect(evaluation.run_status).toBe("completed");
    expect(evaluation.runs_completed).toBe(120);
    expect(evaluation.report).toMatchObject({
      verdict: "pass",
      hard_gate_failures: 0,
      target: { total: 8, passed: 8 },
      boundary: { total: 6, passed: 6 },
      failure_reasons: [],
    });
    expect(service.getCandidate("m-1", candidateId)?.state).toBe("READY_FOR_REVIEW");
    expect(service.getCandidate("m-1", candidateId)?.eval_report_id).toBe(evaluation.evaluation_id);
    const firstScenario = Object.values(evaluation.results.scenarios)[0];
    expect(firstScenario?.attempts[0]?.diagnostics).toMatchObject({
      block_kinds: ["next_step"],
    });
  });

  it("目标场景非 3/3：EVALUATION_FAILED，old 结果保留", async () => {
    const evaluation = await evaluate(passRunner({ failTarget: "target-3" }));
    expect(evaluation.state).toBe("EVALUATION_FAILED");
    expect(evaluation.report?.target.passed).toBeLessThan(8);
    expect(evaluation.report?.failure_reasons).toContain("target_not_3_of_3");
    expect(service.getCandidate("m-1", candidateId)?.state).toBe("EVALUATION_FAILED");
  });

  it("硬门失败：即使目标场景全过也整体不通过（A06）", async () => {
    const evaluation = await evaluate(passRunner({ hardGateBoundary: "boundary-2" }));
    expect(evaluation.report?.target.passed).toBe(8);
    expect(evaluation.report?.hard_gate_failures).toBeGreaterThan(0);
    expect(evaluation.state).toBe("EVALUATION_FAILED");
    expect(evaluation.report?.failure_reasons).toContain("hard_gate_failure");
  });

  it("相邻场景回退：candidate 通过率低于基线不通过", async () => {
    const evaluation = await evaluate(passRunner({ failAdjacentCandidate: true }));
    expect(evaluation.report?.failure_reasons).toContain("adjacent_regression");
    expect(evaluation.state).toBe("EVALUATION_FAILED");
  });

  it("无可核实改善：默认不通过；显式关闭改善要求则通过", async () => {
    const failed = await evaluate(passRunner({ improvement: 0 }));
    expect(failed.state).toBe("EVALUATION_FAILED");
    expect(failed.report?.failure_reasons).toContain("no_improvement");

    // 同一冻结产物/套件已完成的失败结果重放返回原报告，不重复回放。
    const replay = await evaluate(passRunner({ improvement: 0 }));
    expect(replay.evaluation_id).toBe(failed.evaluation_id);

    // 换套件版本重新评测。
    const passed = await service.evaluateCandidate({
      merchant_id: "m-1",
      actor: actor(),
      candidate_id: candidateId,
      content_hash: contentHash,
      suite: suite("suite-v2"),
      runner: passRunner({ improvement: 0 }),
      require_improvement: false,
    });
    expect(passed.state).toBe("READY_FOR_REVIEW");
  });

  it("冻结产物契约不一致：不消耗回放，直接 EVALUATION_FAILED", async () => {
    const candidate = service.getCandidate("m-1", candidateId)!;
    repository.updateCandidate({
      ...candidate,
      tool_contract_digest: "sha256:stale-contract",
    });
    let calls = 0;
    const evaluation = await evaluate((input) => {
      calls += 1;
      return passRunner()(input);
    });
    expect(calls).toBe(0);
    expect(evaluation.state).toBe("EVALUATION_FAILED");
    expect(evaluation.report?.failure_reasons[0]).toContain("contract_mismatch");
  });

  it("runner 中断保留 EVALUATING + failed；重试补齐缺失回放且不重复", async () => {
    let calls = 0;
    const flaky: EvaluationRunner = (input) => {
      calls += 1;
      if (calls === 5) throw new Error("provider timeout");
      return passRunner()(input);
    };
    const interrupted = await evaluate(flaky);
    expect(interrupted.state).toBe("EVALUATING");
    expect(interrupted.run_status).toBe("failed");
    expect(interrupted.runs_completed).toBeGreaterThan(0);
    expect(interrupted.runs_completed).toBeLessThan(120);

    const resumed = await evaluate(passRunner());
    expect(resumed.evaluation_id).toBe(interrupted.evaluation_id);
    expect(resumed.state).toBe("READY_FOR_REVIEW");
    expect(resumed.run_status).toBe("completed");
    expect(resumed.runs_completed).toBe(120);
  });

  it("预算不足：paused_budget，保留 EVALUATING，不发起回放", async () => {
    let calls = 0;
    const evaluation = await evaluate(
      (input) => {
        calls += 1;
        return passRunner()(input);
      },
      { budget: 10 },
    );
    expect(calls).toBe(0);
    expect(evaluation.state).toBe("EVALUATING");
    expect(evaluation.run_status).toBe("paused_budget");
    expect(evaluation.report?.failure_reasons).toContain("paused_budget");
  });

  it("评测期间候选被编辑：旧产物结果标记 STALE，不写回候选", async () => {
    const candidate = service.getCandidate("m-1", candidateId)!;
    let revised = false;
    const evaluation = await evaluate((input) => {
      if (!revised) {
        revised = true;
        repository.updateCandidate({
          ...candidate,
          revision: candidate.revision + 1,
          updated_at: NOW,
        });
      }
      return passRunner()(input);
    });
    expect(revised).toBe(true);
    expect(evaluation.state).toBe("STALE");
    expect(evaluation.run_status).toBe("interrupted");
    expect(service.getCandidate("m-1", candidateId)?.revision).toBe(candidate.revision + 1);
  });

  it("内容 hash 不符 / 已批准候选不可评测", async () => {
    try {
      await service.evaluateCandidate({
        merchant_id: "m-1",
        actor: actor(),
        candidate_id: candidateId,
        content_hash: "sha256:wrong",
        suite: suite(),
        runner: passRunner(),
      });
      expect.unreachable("应拒绝错误 content_hash");
    } catch (err) {
      expect(err).toBeInstanceOf(LearningError);
      expect((err as LearningError).reason).toBe("content_hash_mismatch");
    }
    const candidate = service.getCandidate("m-1", candidateId)!;
    repository.updateCandidate({ ...candidate, state: "APPROVED" });
    try {
      await service.evaluateCandidate({
        merchant_id: "m-1",
        actor: actor(),
        candidate_id: candidateId,
        content_hash: contentHash,
        suite: suite("suite-v3"),
        runner: passRunner(),
      });
      expect.unreachable("APPROVED 候选不可评测");
    } catch (err) {
      expect((err as LearningError).reason).toBe("candidate_state_locked");
    }
  });
});
