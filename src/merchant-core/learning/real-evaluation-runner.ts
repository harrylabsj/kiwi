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
 * 真实 provider 评测 runner（M5-3）。
 *
 * 用调用方提供的 streamFn/model/商品源执行同一接待 runtime：基线变体不加载
 * 候选技能，候选变体加载冻结产物；两变体同模型、同夹具、同问题注册表。
 * 验收标准来自 `evaluation-suite-v1` 的冻结案例；硬门（越权工具、私密
 * 泄露、未经批准承诺、绕过批准）任一违反即计失败。
 *
 * 本文件不读取凭据、不写数据库；真实模型回放由 M5 运行环境注入。
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { getQuestionIdByReason } from "../../a2a/reception/question-spec.js";
import {
  DEFAULT_QUESTION_SPEC_REGISTRY,
  type QuestionSpecRegistry,
} from "../../a2a/reception/question-spec.js";
import {
  createPiReceptionRuntime,
  type ReceptionAgentRuntime,
} from "../../a2a/reception/agent-runtime.js";
import type { ReceptionProductSource } from "../../a2a/reception/engine.js";
import { InMemoryFactRegistry, publishResponsePlan } from "../../a2a/reception/publish.js";
import {
  createStaticSkillCatalog,
  type ReceptionSkillBinding,
} from "../../a2a/reception/skill-catalog.js";
import type { MerchantPolicy } from "../../config/profile.js";
import type {
  EvaluationRunner,
  EvaluationScenario,
} from "./evaluation.js";
import type {
  ReceptionAcceptanceCriteria,
  ReceptionEvaluationInput,
} from "./evaluation-suite-v1.js";
import type { LearningCandidate } from "./types.js";

export interface ReceptionEvaluationRunnerOptions {
  readonly merchantId: string;
  readonly streamFn: StreamFn;
  /** 可选：为基线/候选提供独立脚本（测试/对照夹具）；缺省沿用 streamFn。 */
  readonly streamFnForVariant?: (variant: "baseline" | "candidate") => StreamFn;
  readonly model: Model<Api>;
  readonly productSource?: ReceptionProductSource;
  readonly policy?: () => MerchantPolicy | undefined;
  readonly now: () => string;
  readonly questionRegistry?: QuestionSpecRegistry;
}

function candidateBinding(candidate: LearningCandidate): ReceptionSkillBinding {
  return {
    skill_key: candidate.skill_key,
    release_id: `eval_${candidate.candidate_id}_${candidate.revision}`,
    compiled_artifact_hash: candidate.compiled_artifact_hash,
    generation: candidate.revision,
    revocation_epoch: 0,
    trigger_text: candidate.trigger_text,
    question_schema_version: candidate.question_schema_version,
    tool_contract_digest: candidate.tool_contract_digest,
    body_text: candidate.compiled_artifact.body_text,
    steps: candidate.compiled_artifact.steps,
    required_tools: candidate.compiled_artifact.required_tools,
  };
}

function asInput(scenario: EvaluationScenario): ReceptionEvaluationInput {
  const input = scenario.input;
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as { text?: unknown }).text !== "string"
  ) {
    return { text: "" };
  }
  return input as ReceptionEvaluationInput;
}

function asCriteria(scenario: EvaluationScenario): ReceptionAcceptanceCriteria {
  const expected = scenario.expected;
  return typeof expected === "object" && expected !== null
    ? (expected as ReceptionAcceptanceCriteria)
    : {};
}

/**
 * 创建可注入评测执行器的真实 runner。基线/候选按 scenario+attempt 配对，
 * 候选相对基线的通过变化进入 improvement_delta。
 */
export function createReceptionEvaluationRunner(
  options: ReceptionEvaluationRunnerOptions,
): EvaluationRunner {
  const questions = options.questionRegistry ?? DEFAULT_QUESTION_SPEC_REGISTRY;
  const baselineResults = new Map<string, boolean>();

  function runtimeFor(variant: "baseline" | "candidate", candidate: LearningCandidate): ReceptionAgentRuntime {
    const catalog =
      variant === "candidate"
        ? createStaticSkillCatalog([candidateBinding(candidate)])
        : createStaticSkillCatalog([]);
    const streamFn =
      options.streamFnForVariant !== undefined
        ? options.streamFnForVariant(variant)
        : options.streamFn;
    return createPiReceptionRuntime({
      streamFn,
      model: options.model,
      skillCatalog: catalog,
      questionRegistry: questions,
      ...(options.productSource !== undefined ? { productSource: options.productSource } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      maxSteps: 6,
      maxToolAttempts: 10,
      timeoutMs: 30_000,
    });
  }

  return async ({ scenario, variant, attempt, candidate }) => {
    const input = asInput(scenario);
    const criteria = asCriteria(scenario);
    const now = options.now();
    const registry = new InMemoryFactRegistry();
    const runtime = runtimeFor(variant, candidate);
    let outcome: Awaited<ReturnType<ReceptionAgentRuntime["run"]>>;
    try {
      outcome = await runtime.run({
        merchantId: options.merchantId,
        identity: `eval:${scenario.scenario_id}:${variant}:${attempt}`,
        contextId: `eval:${scenario.scenario_id}:${variant}:${attempt}`,
        text: input.text,
        ...(input.structuredSku !== undefined ? { structuredSku: input.structuredSku } : {}),
        registry,
        now,
      });
    } catch {
      outcome = undefined;
    }
    if (outcome === undefined) {
      if (variant === "baseline") baselineResults.set(`${scenario.scenario_id}:${attempt}`, false);
      return { passed: false, hard_gate_failures: 0 };
    }

    const published = publishResponsePlan({
      plan: outcome.plan,
      registry,
      merchantId: options.merchantId,
      now,
      questions,
    });
    const blockKinds: readonly string[] = outcome.plan.blocks.map((block) => block.kind);
    const questionIds = [
      ...outcome.plan.blocks
        .filter(
          (block): block is Extract<typeof block, { kind: "ask_registered_question" }> =>
            block.kind === "ask_registered_question",
        )
        .map((block) => block.question_id),
      ...outcome.plan.blocks
        .filter(
          (block): block is Extract<typeof block, { kind: "ask_clarification" }> =>
            block.kind === "ask_clarification",
        )
        .map((block) => getQuestionIdByReason(block.reason))
        .filter((id): id is string => id !== undefined),
    ];
    const tools = Object.entries(outcome.metrics.toolCalls)
      .filter(([, count]) => count > 0)
      .map(([name]) => name);

    let hardGateFailures = 0;
    for (const forbidden of criteria.forbidden_block_kinds ?? []) {
      if (blockKinds.includes(forbidden)) hardGateFailures += 1;
    }
    for (const forbidden of criteria.forbidden_tools ?? []) {
      if (tools.includes(forbidden)) hardGateFailures += 1;
    }
    for (const forbidden of criteria.forbidden_text ?? []) {
      if (published.text.includes(forbidden)) hardGateFailures += 1;
    }
    const anyBlockOk =
      criteria.any_block_kinds === undefined ||
      criteria.any_block_kinds.length === 0 ||
      criteria.any_block_kinds.some((kind) => blockKinds.includes(kind));
    const anyQuestionOk =
      criteria.any_question_ids === undefined ||
      criteria.any_question_ids.length === 0 ||
      criteria.any_question_ids.some((id) => questionIds.includes(id));
    const passed = hardGateFailures === 0 && anyBlockOk && anyQuestionOk;

    if (variant === "baseline") {
      baselineResults.set(`${scenario.scenario_id}:${attempt}`, passed);
      return { passed, hard_gate_failures: hardGateFailures };
    }
    const baselinePassed = baselineResults.get(`${scenario.scenario_id}:${attempt}`) ?? false;
    return {
      passed,
      hard_gate_failures: hardGateFailures,
      improvement_delta: passed === baselinePassed ? 0 : passed ? 1 : -1,
    };
  };
}
