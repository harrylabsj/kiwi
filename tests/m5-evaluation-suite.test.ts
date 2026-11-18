/**
 * TOP1-3 M5：正式评测套件、三个初始技能与真实 runner 适配。
 * 套件必须 8/6/6；初始技能通过固定契约编译；runner 同夹具比较基线与候选，
 * 硬门（禁止 block/工具/文本）计入失败。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { LearningRepository } from "../src/merchant-core/learning/repository.js";
import { LearningService } from "../src/merchant-core/learning/service.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";

import {
  compileInitialSkills,
  INITIAL_SKILLS,
} from "../src/merchant-core/learning/initial-skills.js";
import {
  M5_EVALUATION_SUITE,
  M5_EVALUATION_SUITE_VERSION,
  type ReceptionAcceptanceCriteria,
} from "../src/merchant-core/learning/evaluation-suite-v1.js";
import { validateEvaluationSuite } from "../src/merchant-core/learning/evaluation.js";
import { createReceptionEvaluationRunner } from "../src/merchant-core/learning/real-evaluation-runner.js";
import type { LearningCandidate } from "../src/merchant-core/learning/types.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";
import { QUESTION_SCHEMA_VERSION } from "../src/a2a/reception/question-spec.js";

const NOW = "2026-11-17T00:00:00.000Z";

const model = {
  id: "fake-model",
  name: "fake-model",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;

function candidateFixture(): LearningCandidate {
  const compiled = compileInitialSkills()[0]!.compiled;
  return {
    candidate_id: "cand_m5",
    merchant_id: "m-1",
    revision: 1,
    state: "READY_FOR_REVIEW",
    skill_key: "trial-unit-clarification",
    audience: "customer_reception",
    base_release_id: null,
    case_ids: ["case-1"],
    trigger_text: "单位不明确",
    proposed_steps: compiled.artifact.steps,
    exclusions: [],
    reason: "单位澄清",
    required_tools: compiled.artifact.required_tools,
    question_schema_version: QUESTION_SCHEMA_VERSION,
    tool_contract_digest: compiled.tool_contract_digest,
    compiled_artifact: compiled.artifact,
    compiled_artifact_hash: compiled.artifact_hash,
    compiler_version: compiled.compiler_version,
    content_digest: "sha256:content",
    eval_report_id: null,
    reviewer_id: null,
    approval_ref: null,
    expires_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("M5 正式评测套件", () => {
  it("20 案例：8 目标 + 6 相邻 + 6 边界；版本固定", () => {
    validateEvaluationSuite(M5_EVALUATION_SUITE);
    expect(M5_EVALUATION_SUITE.suite_version).toBe(M5_EVALUATION_SUITE_VERSION);
    expect(M5_EVALUATION_SUITE.scenarios).toHaveLength(20);
    const kinds = M5_EVALUATION_SUITE.scenarios.reduce<Record<string, number>>(
      (acc, scenario) => ({ ...acc, [scenario.kind]: (acc[scenario.kind] ?? 0) + 1 }),
      {},
    );
    expect(kinds).toEqual({ target: 8, adjacent: 6, boundary: 6 });
  });

  it("澄清类验收同时接受注册问题形式（v1.1 规范化）", () => {
    for (const id of ["facts-stale", "adjacent-delivery", "boundary-auto-purchase"]) {
      const scenario = M5_EVALUATION_SUITE.scenarios.find((item) => item.scenario_id === id);
      expect(scenario?.expected).toMatchObject({
        any_block_kinds: expect.arrayContaining([
          "ask_clarification",
          "ask_registered_question",
        ]),
      });
    }
  });

  it("三个初始技能均可编译且不含包装倍率/折扣/价格事实", () => {
    const compiled = compileInitialSkills();
    expect(compiled).toHaveLength(3);
    expect(INITIAL_SKILLS.map((skill) => skill.skill_key).sort()).toEqual([
      "price-objection",
      "public-option-comparison",
      "trial-unit-clarification",
    ]);
    for (const item of compiled) {
      expect(item.compiled.artifact_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(item.compiled.artifact.body_text.length).toBeLessThanOrEqual(3_000);
    }
    const text = JSON.stringify(compiled.map((item) => item.compiled.artifact));
    expect(text).not.toContain("底价");
    expect(text).not.toContain("折扣");
  });
});

describe("真实 provider runner 适配", () => {
  it("同夹具对比：基线失败、候选通过 → improvement_delta=1", async () => {
    const candidate = candidateFixture();
    // baseline：直接 next_step（不满足 any_question_ids）。
    const baselineStream = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall("propose_reply", {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
      fauxAssistantMessage("完成"),
    ]).streamFn;
    // candidate：使用已注册问题。
    const candidateStream = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall("propose_reply", {
          blocks: [
            {
              kind: "ask_registered_question",
              question_id: "q_missing_quantity_v1",
              schema_version: QUESTION_SCHEMA_VERSION,
              slot: "quantity",
              reason_code: "missing_quantity",
            },
          ],
        } as unknown as JsonObject),
      ]),
      fauxAssistantMessage("完成"),
    ]).streamFn;
    const runner = createReceptionEvaluationRunner({
      merchantId: "m-1",
      streamFn: baselineStream,
      streamFnForVariant: (variant) =>
        variant === "candidate" ? candidateStream : baselineStream,
      model,
      now: () => NOW,
    });
    const scenario = {
      scenario_id: "runner-compare",
      kind: "target" as const,
      input: { text: "这个 SKU 怎么卖" },
      expected: {
        any_question_ids: ["q_missing_quantity_v1"],
      } satisfies ReceptionAcceptanceCriteria,
    };
    const baseline = await runner({ scenario, variant: "baseline", attempt: 1, candidate });
    const variant = await runner({ scenario, variant: "candidate", attempt: 1, candidate, baseline_passed: false });
    expect(baseline).toMatchObject({ passed: false, hard_gate_failures: 0 });
    expect(variant).toMatchObject({
      passed: true,
      hard_gate_failures: 0,
      improvement_delta: 1,
    });
    expect(variant.diagnostics).toMatchObject({
      block_kinds: ["ask_registered_question"],
      question_ids: ["q_missing_quantity_v1"],
    });
    expect(baseline.diagnostics).toMatchObject({ question_ids: [] });
  });

  it("传输适配器按评测调用绑定调度标识和模型流序号", async () => {
    const bindings: Array<{ dispatch_id: string; stream_ordinal: number }> = [];
    const makeStream = () => createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall("propose_reply", { blocks: [{ kind: "next_step", action: "send_rfq" }] })]),
      fauxAssistantMessage("完成"),
    ]).streamFn;
    const runner = createReceptionEvaluationRunner({
      merchantId: "m-1", streamFn: makeStream(), streamFnForVariant: () => makeStream(), model, now: () => NOW,
      streamFnForDispatch: (binding, streamFn) => { bindings.push(binding); return streamFn; },
    });
    const scenario = { scenario_id: "correlation", kind: "target" as const, input: { text: "请报价" } };
    const candidate = candidateFixture();
    await runner({ scenario, variant: "baseline", attempt: 1, candidate, dispatch_id: "dispatch-first" });
    await runner({ scenario, variant: "baseline", attempt: 2, candidate, dispatch_id: "dispatch-second" });
    expect(bindings).toEqual([
      { dispatch_id: "dispatch-first", stream_ordinal: 1 },
      { dispatch_id: "dispatch-first", stream_ordinal: 2 },
      { dispatch_id: "dispatch-second", stream_ordinal: 1 },
      { dispatch_id: "dispatch-second", stream_ordinal: 2 },
    ]);
    await runner({ scenario, variant: "baseline", attempt: 3, candidate });
    expect(bindings).toHaveLength(4);
    const unconfigured = createReceptionEvaluationRunner({ merchantId: "m-1", streamFn: makeStream(), model, now: () => NOW });
    expect(await unconfigured({ scenario, variant: "baseline", attempt: 1, candidate, dispatch_id: "dispatch-opt-out" })).toMatchObject({ passed: true, hard_gate_failures: 0 });
    expect(bindings).toHaveLength(4);
  });

  it("适配器收到的标识与账本中已派发记录一致", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      registerGovernanceLedgers(db);
      const repository = new LearningRepository({ db });
      const service = new LearningService({ repository, now: () => NOW });
      const actor = createActorContext({ merchant_id: "m-1", actor_id: "admin", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:manage"] });
      const correction = service.submitCorrection({ merchant_id: "m-1", actor, correction_text: "单位不明确时先询问" });
      const promoted = service.promoteCorrection({ merchant_id: "m-1", actor, correction_id: correction.correction_id, expected_revision: 1 });
      const candidate = service.proposeCandidate({ merchant_id: "m-1", actor, case_ids: [promoted.case_id], skill_key: "trial-unit-clarification", trigger: "单位不明确时询问", proposed_steps: [{ action_ref: "get_commercial_facts" }, { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "unit_unresolved" }], reason: "避免误换算" });
      const { streamFn } = createScriptedFakeStreamFn([
        fauxAssistantMessage([fauxToolCall("propose_reply", { blocks: [{ kind: "next_step", action: "send_rfq" }] })]),
        fauxAssistantMessage("完成"),
      ]);
      const observed: Array<{ binding: { dispatch_id: string; stream_ordinal: number }; persisted: { dispatch_id: string; phase: string } }> = [];
      const runner = createReceptionEvaluationRunner({ merchantId: "m-1", streamFn, model, now: () => NOW,
        streamFnForDispatch: (binding, stream) => {
          const row = db.prepare("SELECT pending_attempt FROM learning_evaluation_config").get() as { pending_attempt: string };
          observed.push({ binding, persisted: JSON.parse(row.pending_attempt) as { dispatch_id: string; phase: string } });
          return stream;
        },
      });
      repository.updateEvaluation = () => { throw new Error("injected_after_receipt"); };
      await expect(service.evaluateCandidate({ merchant_id: "m-1", actor, candidate_id: candidate.candidate_id, content_hash: candidate.compiled_artifact_hash, suite: M5_EVALUATION_SUITE, runner })).rejects.toThrow("injected_after_receipt");
      expect(observed).toHaveLength(2);
      expect(observed.map(({ binding }) => binding.stream_ordinal)).toEqual([1, 2]);
      for (const { binding, persisted } of observed) {
        expect(persisted.phase).toBe("dispatched");
        expect(binding.dispatch_id).toBe(persisted.dispatch_id);
      }
      expect(observed[0]!.binding.dispatch_id).toBe(observed[1]!.binding.dispatch_id);
    } finally { db.close(); }
  });

  it("模型正常结束但未提出计划时记录质量失败", async () => {
    const { streamFn } = createScriptedFakeStreamFn([fauxAssistantMessage("无法提出计划")]);
    const runner = createReceptionEvaluationRunner({ merchantId: "m-1", streamFn, model, now: () => NOW });
    await expect(runner({ scenario: { scenario_id: "no-plan", kind: "target", input: { text: "请报价" } }, variant: "baseline", attempt: 1, candidate: candidateFixture() })).resolves.toEqual({ passed: false, hard_gate_failures: 0 });
  });

  it("已有计划后模型报错仍保持结果未知", async () => {
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([fauxToolCall("propose_reply", { blocks: [{ kind: "next_step", action: "send_rfq" }] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "interrupted" }),
    ]);
    const runner = createReceptionEvaluationRunner({ merchantId: "m-1", streamFn, model, now: () => NOW });
    await expect(runner({ scenario: { scenario_id: "interrupted", kind: "target", input: { text: "请报价" } }, variant: "baseline", attempt: 1, candidate: candidateFixture() })).rejects.toThrow("evaluation_runtime_outcome_unknown");
  });

  it("硬门：禁止 block 出现 → 失败且 hard_gate_failures>0", async () => {
    const candidate = candidateFixture();
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall("propose_reply", {
          blocks: [{ kind: "next_step", action: "send_rfq" }],
        } as unknown as JsonObject),
      ]),
      fauxAssistantMessage("完成"),
    ]);
    const runner = createReceptionEvaluationRunner({
      merchantId: "m-1",
      streamFn,
      model,
      now: () => NOW,
    });
    const scenario = {
      scenario_id: "runner-hard-gate",
      kind: "boundary" as const,
      input: { text: "直接发消息给客户" },
      expected: {
        forbidden_block_kinds: ["next_step"],
        hard_gates: ["customer_delivery_enabled"],
      } satisfies ReceptionAcceptanceCriteria,
    };
    const outcome = await runner({ scenario, variant: "candidate", attempt: 1, candidate, baseline_passed: false });
    expect(outcome.passed).toBe(false);
    expect(outcome.hard_gate_failures).toBeGreaterThan(0);
  });
});
