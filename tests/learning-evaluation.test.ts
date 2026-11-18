/**
 * TOP1 M2-4：评测执行器（设计 §6.1 / §6.2 / D-M0-06）。
 * 8 目标×3 + 6 相邻 + 6 边界；3/3 与硬门 0；独立 120 预算、paused/failed/
 * interrupted 可恢复；候选评测期间变化 → STALE；冻结产物契约校验。
 */
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxToolCall, type Api, type Model } from "@earendil-works/pi-ai";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import { createReceptionEvaluationRunner } from "../src/merchant-core/learning/real-evaluation-runner.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  let tempDir: string;
  let repository: LearningRepository;
  let service: LearningService;
  let candidateId: string;
  let contentHash: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kiwi-evaluation-"));
    db = new DatabaseSync(join(tempDir, "state.sqlite"));
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
  afterEach(() => { db.close(); rmSync(tempDir, { recursive: true, force: true }); });

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
    expect(service.getCandidate("m-1", candidateId)?.state).toBe("EVALUATION_FAILED");

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

  it("runner 中断后结果不确定，禁止自动重跑", async () => {
    let calls = 0;
    const flaky: EvaluationRunner = (input) => {
      calls += 1;
      if (calls === 5) throw new Error("provider timeout");
      return passRunner()(input);
    };
    await expect(evaluate(flaky)).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    await expect(evaluate(passRunner())).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    expect(calls).toBe(5);
  });

  it("持久化基线会传入恢复后的候选回放", async () => {
    let calls = 0;
    await expect(evaluate(() => {
      calls++;
      if (calls === 2) throw new Error("interrupted");
      return { passed: true, hard_gate_failures: 0 };
    })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    // 模拟操作者已核对第二次调用未执行，清除不确定标记。
    db.prepare("UPDATE learning_evaluation_config SET pending_attempt = NULL").run();
    let observed: boolean | undefined;
    const result = await evaluate((input) => {
      if (input.scenario.scenario_id === "target-0" && input.variant === "candidate" && input.attempt === 1) observed = input.baseline_passed;
      return { passed: true, hard_gate_failures: 0, improvement_delta: 0 };
    }, { requireImprovement: true });
    expect(observed).toBe(true);
    expect(result.report?.improvement_delta_max).toBe(0);
    expect(result.state).toBe("EVALUATION_FAILED");
  });

  it("不同连接并发相同评测只允许一个执行者", async () => {
    const db2 = new DatabaseSync(join(tempDir, "state.sqlite"));
    const service2 = new LearningService({ repository: new LearningRepository({ db: db2 }), now: () => NOW });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const first = evaluate(async (input) => {
      calls++;
      if (calls === 1) { entered(); await gate; }
      return passRunner()(input);
    });
    await started;
    try {
      await expect(service2.evaluateCandidate({ merchant_id: "m-1", actor: actor(), candidate_id: candidateId,
        content_hash: contentHash, suite: suite(), runner: passRunner() }))
        .rejects.toMatchObject({ reason: "evaluation_in_progress" });
    } finally { release(); }
    expect((await first).runs_completed).toBe(120);
    expect(calls).toBe(120);
    db2.close();
  });

  it("两个独立进程竞争同一评测时只派发一次", async () => {
    const entry = join(tempDir, "worker.mjs");
    const bundle = join(tempDir, "bundle.mjs");
    const marker = join(tempDir, "entered");
    const release = join(tempDir, "release");
    writeFileSync(entry, `
      import { DatabaseSync } from "node:sqlite";
      import { existsSync, writeFileSync } from "node:fs";
      import { LearningRepository } from ${JSON.stringify(resolve("src/merchant-core/learning/repository.ts"))};
      import { LearningService } from ${JSON.stringify(resolve("src/merchant-core/learning/service.ts"))};
      import { createActorContext } from ${JSON.stringify(resolve("src/merchant-core/context-governance/actor-context.ts"))};
      const [file, candidate, hash, spec, entered, release, mode] = process.argv.slice(2);
      const db = new DatabaseSync(file);
      const service = new LearningService({ repository: new LearningRepository({ db }), now: () => ${JSON.stringify(NOW)} });
      const actor = createActorContext({ merchant_id:"m-1", actor_id:"admin-1", auth_strength:"verified", subject_binding:"organization", capabilities:["learning:manage"] });
      let count = 0;
      try {
        const result = await service.evaluateCandidate({ merchant_id:"m-1", actor, candidate_id:candidate, content_hash:hash, suite:JSON.parse(spec), runner:async () => {
          count++;
          if (mode === "hold" && count === 1) {
            writeFileSync(entered,"1");
            while (!existsSync(release)) await new Promise(r => setTimeout(r, 10));
          }
          return { passed:true, hard_gate_failures:0, improvement_delta:1 };
        } }, { command_id:"shared-command" });
        process.stdout.write(JSON.stringify({ count, status:result.run_status }));
      } catch (e) { process.stdout.write(JSON.stringify({ count, reason:e.reason })); }
      db.close();
    `);
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const run = (mode: string) => {
      const child = spawn(process.execPath, [bundle, join(tempDir, "state.sqlite"), candidateId, contentHash,
        JSON.stringify(suite()), marker, release, mode], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; let error = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
      return { child, done: new Promise<{ count: number; status?: string; reason?: string }>((res, rej) => {
        child.on("error", rej); child.on("close", (code) => code === 0 ? res(JSON.parse(output)) : rej(new Error(error)));
      }) };
    };
    const first = run("hold");
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(existsSync(marker)).toBe(true);
      const second = run("other");
      const rejected = await second.done;
      expect(rejected).toMatchObject({ count: 0, reason: "evaluation_in_progress" });
      writeFileSync(release, "1");
      expect(await first.done).toMatchObject({ count: 120, status: "completed" });
    } finally { writeFileSync(release, "1"); if (first.child.exitCode === null) first.child.kill(); }
  }, 20_000);

  it("完成命令重放在候选审批后仍返回原结果，并拒绝内容变更", async () => {
    const input = { merchant_id: "m-1", actor: actor(), candidate_id: candidateId, content_hash: contentHash,
      suite: suite(), runner: passRunner() };
    const done = await service.evaluateCandidate(input, { command_id: "replay" });
    const candidate = service.getCandidate("m-1", candidateId)!;
    repository.updateCandidate({ ...candidate, state: "APPROVED" });
    expect(await service.evaluateCandidate(input, { command_id: "replay" })).toEqual(done);
    const changed = { ...input, suite: { ...input.suite, scenarios: input.suite.scenarios.map((scenario, i) => i === 0 ? { ...scenario, input: "changed" } : scenario) } };
    await expect(service.evaluateCandidate(changed, { command_id: "replay" })).rejects.toMatchObject({ reason: "command_replay_conflict" });
  });

  it("旧完成报告可查询，但缺少冻结配置的旧命令不可重放", async () => {
    const input = { merchant_id: "m-1", actor: actor(), candidate_id: candidateId, content_hash: contentHash,
      suite: suite(), runner: passRunner() };
    const done = await service.evaluateCandidate(input, { command_id: "legacy" });
    db.prepare("DELETE FROM learning_evaluation_config").run();
    db.prepare("UPDATE learning_command_idempotency SET request_digest = 'legacy-digest'").run();
    expect(service.getEvaluation("m-1", done.evaluation_id)).toEqual(done);
    await expect(service.evaluateCandidate(input, { command_id: "legacy" })).rejects.toMatchObject({ reason: "command_replay_conflict" });
    await expect(service.evaluateCandidate(input)).rejects.toMatchObject({ reason: "evaluation_legacy_unverified" });
  });

  it("相同产物跨候选 revision 不复用旧评测", async () => {
    await evaluate(passRunner(), { budget: 10 });
    const candidate = service.getCandidate("m-1", candidateId)!;
    repository.updateCandidate({ ...candidate, revision: candidate.revision + 1 });
    await expect(evaluate(passRunner())).rejects.toMatchObject({ reason: "evaluation_revision_mismatch" });
  });

  it("无效套件不占用命令和套件版本，有效请求仍可执行", async () => {
    const input = { merchant_id: "m-1", actor: actor(), candidate_id: candidateId, content_hash: contentHash,
      suite: suite(), runner: passRunner() };
    const invalid = { ...input, suite: { ...input.suite, scenarios: [] } };
    await expect(service.evaluateCandidate(invalid, { command_id: "corrected" })).rejects.toMatchObject({ reason: "suite_empty" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM learning_evaluation_config").get() as { n: number }).n).toBe(0);
    expect((await service.evaluateCandidate(input, { command_id: "corrected" })).run_status).toBe("completed");
  });

  it("续跑拒绝同版本套件内容和改善要求变更", async () => {
    await evaluate(passRunner(), { budget: 10 });
    const altered = suite();
    const changed = { ...altered, scenarios: altered.scenarios.map((item, i) => i === 0 ? { ...item, input: { changed: true } } : item) };
    await expect(service.evaluateCandidate({ merchant_id: "m-1", actor: actor(), candidate_id: candidateId,
      content_hash: contentHash, suite: changed, runner: passRunner() })).rejects.toMatchObject({ reason: "evaluation_config_mismatch" });
    await expect(evaluate(passRunner(), { requireImprovement: false })).rejects.toMatchObject({ reason: "evaluation_config_mismatch" });
  });

  it("过期租约被接管后，旧持有者无法通过栅栏", () => {
    repository.transaction(() => repository.claimEvaluation(["evaluation:test"], "first", "digest", 100, 10));
    repository.transaction(() => repository.claimEvaluation(["evaluation:test"], "second", "digest", 111, 10));
    expect(() => repository.assertEvaluationClaim(["evaluation:test"], "first", 112)).toThrowError(LearningError);
    expect(() => repository.assertEvaluationClaim(["evaluation:test"], "second", 112)).not.toThrow();
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

  it.each(["normal", "budget", "contract"])("%s 启动事务复核已拒绝状态", async (path) => {
    const initial = service.getCandidate("m-1", candidateId)!;
    if (path === "contract") repository.updateCandidate({ ...initial, tool_contract_digest: "sha256:stale" });
    const candidate = service.getCandidate("m-1", candidateId)!;
    const transaction = repository.transaction.bind(repository);
    const spy = vi.spyOn(repository, "transaction").mockImplementation((work) => {
      spy.mockRestore();
      repository.updateCandidate({ ...candidate, state: "REJECTED" });
      return transaction(work);
    });
    let calls = 0;
    await expect(evaluate((input) => { calls++; return passRunner()(input); },
      path === "budget" ? { budget: 1 } : {})).rejects.toMatchObject({ reason: "candidate_state_locked" });
    expect(calls).toBe(0);
    expect(service.getCandidate("m-1", candidateId)?.state).toBe("REJECTED");
    expect(service.listEvaluations("m-1")).toHaveLength(0);
  });

  it("已拒绝候选不能原样重评", async () => {
    const candidate = service.getCandidate("m-1", candidateId)!;
    repository.updateCandidate({ ...candidate, state: "REJECTED" });
    await expect(evaluate(passRunner())).rejects.toMatchObject({ reason: "candidate_state_locked" });
  });

  it("评测期间状态改变不会被结果覆盖", async () => {
    const candidate = service.getCandidate("m-1", candidateId)!;
    const result = await evaluate(passRunner({ onCall: (call) => {
      if (call === 1) repository.updateCandidate({ ...candidate, state: "APPROVED" });
    } }));
    expect(result).toMatchObject({ state: "STALE", run_status: "interrupted" });
    expect(service.getCandidate("m-1", candidateId)?.state).toBe("APPROVED");
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
  it("真实 runner 评分回执跨连接恢复，结果落账前故障不重复执行", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    const model = { id: "fake-model", name: "fake-model", api: "openai-completions", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 } as Model<Api>;
    const streamFn = createScriptedFakeStreamFn([fauxAssistantMessage([fauxToolCall("propose_reply", { blocks: [{ kind: "next_step", action: "send_rfq" }] })]), fauxAssistantMessage("完成")]).streamFn;
    const runner = createReceptionEvaluationRunner({ merchantId: "m-1", streamFn, model, now: () => NOW });
    const update = vi.spyOn(repository, "updateEvaluation").mockImplementationOnce(() => { throw new Error("injected primary write failure"); });
    await expect(evaluate(runner)).rejects.toThrow("injected primary write failure");
    update.mockRestore();
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    const db2 = new DatabaseSync(join(tempDir, "state.sqlite"));
    try {
      const resumed = new LearningService({ repository: new LearningRepository({ db: db2 }), now: () => NOW });
      const pending = resumed.getPendingEvaluation(query);
      expect(pending.evidence_ref).toBe(`local:${pending.binding!.dispatch_id}`);
      const request = { ...query, expected_dispatch_id: pending.binding!.dispatch_id, evidence_ref: pending.evidence_ref!, command_id: "recover-local" };
      const external = vi.fn(async (binding: typeof pending.binding & {}) => ({ status: "not_executed" as const, binding }));
      const withExternal = new LearningService({ repository: new LearningRepository({ db: db2 }), now: () => NOW, recoveryVerifier: external });
      await expect(withExternal.resolvePendingEvaluation({ ...request, evidence_ref: "external-proof" })).rejects.toMatchObject({ reason: "evaluation_evidence_mismatch" });
      await expect(withExternal.resolvePendingEvaluation({ ...request, evidence_ref: "local:wrong" })).rejects.toMatchObject({ reason: "evaluation_evidence_mismatch" });
      expect(external).not.toHaveBeenCalled();
      expect(resumed.getPendingEvaluation(query).evidence_ref).toBe(request.evidence_ref);
      expect((db2.prepare("SELECT COUNT(*) AS n FROM learning_evaluation_receipts").get() as { n: number }).n).toBe(1);
      expect(await resumed.resolvePendingEvaluation(request)).toEqual({ status: "completed" });
      expect(resumed.getEvaluation("m-1", query.evaluation_id)?.runs_completed).toBe(1);
      expect((db2.prepare("SELECT COUNT(*) AS n FROM learning_evaluation_receipts").get() as { n: number }).n).toBe(0);
    } finally { db2.close(); }
    expect((await evaluate(passRunner())).run_status).toBe("completed");
  });

  it("核对只接受绑定当前 dispatch 的可信结果并允许续跑", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    await expect(evaluate(async () => { throw new Error("uncertain"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    const binding = service.getPendingEvaluation(query).binding!;
    expect(binding.dispatch_id).toBeTruthy();
    const request = { ...query, evidence_ref: "receipt-1", expected_dispatch_id: binding.dispatch_id, command_id: "resolve-1" };
    await expect(service.resolvePendingEvaluation(request)).rejects.toMatchObject({ reason: "evaluation_recovery_unavailable" });
    const verifier = vi.fn(async (actual: typeof binding) => ({ status: "completed" as const, binding: actual, outcome: { passed: true, hard_gate_failures: 0 } }));
    const trusted = new LearningService({ repository, now: () => NOW, recoveryVerifier: verifier });
    await expect(trusted.resolvePendingEvaluation({ ...request, evidence_ref: "local:missing" })).rejects.toMatchObject({ reason: "evaluation_recovery_unavailable" });
    expect(verifier).not.toHaveBeenCalled();
    expect(await trusted.resolvePendingEvaluation(request)).toEqual({ status: "completed" });
    expect(await trusted.resolvePendingEvaluation(request)).toEqual({ status: "completed" });
    await expect(trusted.resolvePendingEvaluation({ ...request, evidence_ref: "other" })).rejects.toMatchObject({ reason: "command_replay_conflict" });
    expect((await evaluate(passRunner())).run_status).toBe("completed");
  });

  it("未执行证明只解锁本次 dispatch，旧证明不能解锁新的调用", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    await expect(evaluate(async () => { throw new Error("uncertain"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    const binding = service.getPendingEvaluation(query).binding!;
    const trusted = new LearningService({ repository, now: () => NOW, recoveryVerifier: async () => ({ status: "not_executed", binding }) });
    const request = { ...query, evidence_ref: "proof", expected_dispatch_id: binding.dispatch_id, command_id: "one" };
    expect(await trusted.resolvePendingEvaluation(request)).toEqual({ status: "not_executed" });
    await expect(evaluate(async () => { throw new Error("uncertain again"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const next = service.getPendingEvaluation(query).binding!;
    expect(next.dispatch_id).not.toBe(binding.dispatch_id);
    await expect(trusted.resolvePendingEvaluation({ ...request, command_id: "two" })).rejects.toMatchObject({ reason: "evaluation_attempt_changed" });
    await expect(trusted.resolvePendingEvaluation({ ...request, command_id: "three", expected_dispatch_id: next.dispatch_id })).rejects.toMatchObject({ reason: "evaluation_evidence_mismatch" });
    expect(service.getPendingEvaluation(query).binding).toEqual(next);
  });

  it("未知证据和旧版标记保持阻塞，权限不足不可查看", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    await expect(evaluate(async () => { throw new Error("uncertain"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    expect(() => service.getPendingEvaluation({ ...query, actor: actor() })).toThrowError(LearningError);
    const binding = service.getPendingEvaluation(query).binding!;
    const request = { ...query, evidence_ref: "proof", expected_dispatch_id: binding.dispatch_id, command_id: "unknown" };
    const unknown = new LearningService({ repository, now: () => NOW, recoveryVerifier: async () => ({ status: "unknown" }) });
    await expect(unknown.resolvePendingEvaluation(request)).rejects.toMatchObject({ reason: "evaluation_evidence_unknown" });
    expect(unknown.getPendingEvaluation(query).binding).toEqual(binding);
    db.prepare("UPDATE learning_evaluation_config SET pending_attempt = ?").run("target-0:baseline:1");
    expect(unknown.getPendingEvaluation(query)).toEqual({ pending: "legacy_unverifiable" });
    await expect(unknown.resolvePendingEvaluation(request)).rejects.toMatchObject({ reason: "evaluation_recovery_unavailable" });
  });

  it("核验期间候选变化时不写入成绩或清除标记", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    await expect(evaluate(async () => { throw new Error("uncertain"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    const binding = service.getPendingEvaluation(query).binding!;
    const trusted = new LearningService({ repository, now: () => NOW, recoveryVerifier: async (current) => {
      const candidate = service.getCandidate("m-1", candidateId)!;
      repository.updateCandidate({ ...candidate, state: "STALE" });
      return { status: "completed", binding: current, outcome: { passed: true, hard_gate_failures: 0 } };
    } });
    await expect(trusted.resolvePendingEvaluation({ ...query, evidence_ref: "receipt", expected_dispatch_id: binding.dispatch_id, command_id: "stale" })).rejects.toMatchObject({ reason: "evaluation_attempt_changed" });
    expect(service.getPendingEvaluation(query).binding).toEqual(binding);
    expect(service.getEvaluation("m-1", query.evaluation_id)!.runs_completed).toBe(0);
  });

  it("恢复执行权过期后旧核验不能提交；账本不可用时幂等重放也被拒绝", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    await expect(evaluate(async () => { throw new Error("uncertain"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    const binding = service.getPendingEvaluation(query).binding!;
    const request = { ...query, evidence_ref: "receipt", expected_dispatch_id: binding.dispatch_id, command_id: "fence" };
    let currentTime = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    try {
      const expired = new LearningService({ repository, now: () => NOW, recoveryVerifier: async (current) => {
        currentTime += 300_001;
        return { status: "completed", binding: current, outcome: { passed: true, hard_gate_failures: 0 } };
      } });
      await expect(expired.resolvePendingEvaluation(request)).rejects.toMatchObject({ reason: "evaluation_claim_lost" });
      expect(service.getPendingEvaluation(query).binding).toEqual(binding);
      const trusted = new LearningService({ repository, now: () => NOW, recoveryVerifier: async (current) => ({ status: "completed", binding: current, outcome: { passed: true, hard_gate_failures: 0 } }) });
      expect(await trusted.resolvePendingEvaluation(request)).toEqual({ status: "completed" });
      const unavailable = new LearningService({ repository, now: () => NOW, available: false });
      await expect(unavailable.resolvePendingEvaluation(request)).rejects.toMatchObject({ reason: "learning_schema_unavailable" });
    } finally { clock.mockRestore(); }
  });

  it("释放租约时写权限失效，不覆盖核验错误或已提交结果", async () => {
    const reviewer = createActorContext({ merchant_id: "m-1", actor_id: "reviewer", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:review"] });
    await expect(evaluate(async () => { throw new Error("uncertain"); })).rejects.toMatchObject({ reason: "evaluation_attempt_uncertain" });
    const query = { merchant_id: "m-1", actor: reviewer, evaluation_id: service.listEvaluations("m-1")[0]!.evaluation_id };
    const binding = service.getPendingEvaluation(query).binding!;
    const request = { ...query, evidence_ref: "receipt", expected_dispatch_id: binding.dispatch_id, command_id: "guard" };
    let nowMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      let calls = 0;
      const uncertain = new LearningService({ repository, now: () => NOW, recoveryWriteGuard: (work) => { if (++calls === 2) throw new Error("lost guard"); return work(); }, recoveryVerifier: async () => ({ status: "unknown" }) });
      await expect(uncertain.resolvePendingEvaluation(request)).rejects.toMatchObject({ reason: "evaluation_evidence_unknown" });
      nowMs += 300_001;
      calls = 0;
      const trusted = new LearningService({ repository, now: () => NOW, recoveryWriteGuard: (work) => { if (++calls === 3) throw new Error("lost guard"); return work(); }, recoveryVerifier: async (current) => ({ status: "completed", binding: current, outcome: { passed: true, hard_gate_failures: 0 } }) });
      expect(await trusted.resolvePendingEvaluation(request)).toEqual({ status: "completed" });
      expect(await trusted.resolvePendingEvaluation(request)).toEqual({ status: "completed" });
    } finally { clock.mockRestore(); }
  });

});
