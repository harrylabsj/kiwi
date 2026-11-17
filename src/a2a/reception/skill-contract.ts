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
 * 接待技能编译契约（设计 v1.1 §5.2 / §7.1 / 附录 C1-C2 / M2-3）。
 *
 * 候选只能改接待流程与已批准的问题选择：步骤 action_ref 来自固定注册表，
 * question_id 必须已注册，guard_ref 来自固定守卫表；不能注册工具、读取任意
 * URL/脚本或改写 HardPolicy。编译产物在评测前冻结——评测、审核与发布都绑定
 * 同一 `compiled_artifact_hash`，发布只核验并激活，不重新生成正文。
 */

import { contentDigest } from "../../negotiation/jcs.js";
import {
  DEFAULT_QUESTION_SPEC_REGISTRY,
  QUESTION_SCHEMA_VERSION,
  type QuestionSpecRegistry,
} from "./question-spec.js";

/** 技能步骤允许的动作（工具 + 受控问题/转人工/回复）。 */
export const RECEPTION_SKILL_ACTIONS = [
  "search_products",
  "compare_products",
  "get_commercial_facts",
  "propose_need_patch",
  "ask_registered_question",
  "request_human_help",
  "propose_reply",
] as const;
export type ReceptionSkillAction = (typeof RECEPTION_SKILL_ACTIONS)[number];

/** 可声明为 required_tools 的工具子集（问题块与转人工不是工具）。 */
export const RECEPTION_SKILL_TOOLS = [
  "search_products",
  "compare_products",
  "get_commercial_facts",
  "propose_need_patch",
  "propose_reply",
] as const;
export type ReceptionSkillTool = (typeof RECEPTION_SKILL_TOOLS)[number];

/** 固定守卫注册表：技能只能用这些已实现的槽位/事实守卫。 */
export const RECEPTION_SKILL_GUARDS = [
  "sku_unresolved",
  "quantity_unresolved",
  "unit_unresolved",
  "facts_stale",
] as const;
export type ReceptionSkillGuard = (typeof RECEPTION_SKILL_GUARDS)[number];

/** 工具契约版本；工具/动作/守卫注册表变化必须递增并重新评测。 */
export const RECEPTION_TOOL_CONTRACT_VERSION = "reception-tools/1";
export const RECEPTION_SKILL_COMPILER_VERSION = "reception-skill-compiler/1";
export const MAX_SKILL_STEPS = 12;
export const MAX_SKILL_BODY_CHARS = 3_000;

export type SkillContractErrorCode = "validation" | "unsupported_capability";

export class SkillContractError extends Error {
  readonly code: SkillContractErrorCode;
  readonly reason: string;

  constructor(code: SkillContractErrorCode, reason: string, message: string) {
    super(message);
    this.name = "SkillContractError";
    this.code = code;
    this.reason = reason;
  }
}

export interface ReceptionSkillStep {
  readonly action_ref: ReceptionSkillAction;
  readonly question_id?: string;
  readonly guard_ref?: ReceptionSkillGuard;
}

export interface CompiledReceptionSkill {
  readonly schema_version: 1;
  readonly skill_key: string;
  readonly audience: "customer_reception";
  readonly steps: readonly ReceptionSkillStep[];
  readonly body_text: string;
  readonly question_schema_version: number;
  readonly required_tools: readonly ReceptionSkillTool[];
  readonly tool_contract_version: string;
}

export interface CompiledArtifact {
  readonly artifact: CompiledReceptionSkill;
  readonly artifact_hash: string;
  readonly compiler_version: string;
  readonly tool_contract_digest: string;
}

const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEP_KEYS = new Set(["action_ref", "question_id", "guard_ref"]);

function fail(code: SkillContractErrorCode, reason: string, message: string): never {
  throw new SkillContractError(code, reason, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 工具契约摘要：动作/工具/守卫/版本任何变化都会让旧评测与批准失效。 */
export function receptionToolContractDigest(): string {
  return contentDigest({
    version: RECEPTION_TOOL_CONTRACT_VERSION,
    actions: [...RECEPTION_SKILL_ACTIONS],
    tools: [...RECEPTION_SKILL_TOOLS],
    guards: [...RECEPTION_SKILL_GUARDS],
  });
}

export function isValidSkillKey(value: string): boolean {
  return SKILL_KEY_PATTERN.test(value);
}

/**
 * 校验并编译技能步骤。调用方负责 trigger/reason/exclusions 的文本预检；
 * 本函数只处理结构化步骤、问题 ID、工具与守卫注册表。
 */
export function compileReceptionSkillArtifact(input: {
  skill_key: string;
  steps: readonly unknown[];
  required_tools?: readonly string[];
  questionRegistry?: QuestionSpecRegistry;
}): CompiledArtifact {
  if (!isValidSkillKey(input.skill_key)) {
    fail("validation", "skill_key_invalid", "skill_key 必须是 lowercase kebab-case（<=64）");
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_SKILL_STEPS) {
    fail("validation", "steps_invalid", `steps 必须为 1..${MAX_SKILL_STEPS} 步`);
  }
  const questions = input.questionRegistry ?? DEFAULT_QUESTION_SPEC_REGISTRY;
  const steps: ReceptionSkillStep[] = [];
  for (const [index, raw] of input.steps.entries()) {
    if (!isObject(raw)) fail("validation", "step_invalid", `第 ${index + 1} 步必须是对象`);
    for (const key of Object.keys(raw)) {
      if (!STEP_KEYS.has(key)) {
        fail("validation", "step_unknown_field", `第 ${index + 1} 步含未知字段 ${key}`);
      }
    }
    const actionRef = raw.action_ref;
    if (
      typeof actionRef !== "string" ||
      !(RECEPTION_SKILL_ACTIONS as readonly string[]).includes(actionRef)
    ) {
      fail(
        "unsupported_capability",
        "action_ref_unsupported",
        `第 ${index + 1} 步 action_ref 不在固定注册表中`,
      );
    }
    const questionId = raw.question_id;
    const guardRef = raw.guard_ref;
    if (questionId !== undefined) {
      if (actionRef !== "ask_registered_question") {
        fail("validation", "question_id_not_allowed", "只有 ask_registered_question 步骤可带 question_id");
      }
      if (typeof questionId !== "string" || questions.resolve(questionId) === undefined) {
        fail(
          "unsupported_capability",
          "question_not_registered",
          `question_id ${String(questionId)} 未注册`,
        );
      }
    }
    if (actionRef === "ask_registered_question" && questionId === undefined) {
      fail("validation", "question_id_required", "ask_registered_question 必须带已注册 question_id");
    }
    if (guardRef !== undefined) {
      if (
        typeof guardRef !== "string" ||
        !(RECEPTION_SKILL_GUARDS as readonly string[]).includes(guardRef)
      ) {
        fail("unsupported_capability", "guard_ref_unsupported", `guard_ref ${String(guardRef)} 未注册`);
      }
    }
    steps.push({
      action_ref: actionRef as ReceptionSkillAction,
      ...(questionId !== undefined ? { question_id: questionId as string } : {}),
      ...(guardRef !== undefined ? { guard_ref: guardRef as ReceptionSkillGuard } : {}),
    });
  }

  const usedTools = [...new Set(steps.map((step) => step.action_ref))]
    .filter((action): action is ReceptionSkillTool =>
      (RECEPTION_SKILL_TOOLS as readonly string[]).includes(action),
    )
    .sort();
  const requiredTools = input.required_tools === undefined ? usedTools : input.required_tools;
  if (!Array.isArray(requiredTools)) {
    fail("validation", "required_tools_invalid", "required_tools 必须是字符串数组");
  }
  const normalizedTools = [...new Set(requiredTools)].sort();
  for (const tool of normalizedTools) {
    if (!(RECEPTION_SKILL_TOOLS as readonly string[]).includes(tool)) {
      fail("unsupported_capability", "tool_not_registered", `required_tools 含未注册工具 ${tool}`);
    }
    if (!usedTools.includes(tool as ReceptionSkillTool)) {
      fail("validation", "tool_not_used", `required_tools 声明了步骤中未使用的工具 ${tool}`);
    }
  }

  const bodyText = steps
    .map((step, index) => {
      const parts = [`${index + 1}. ${step.action_ref}`];
      if (step.question_id !== undefined) parts.push(`question=${step.question_id}`);
      if (step.guard_ref !== undefined) parts.push(`guard=${step.guard_ref}`);
      return parts.join(" ");
    })
    .join("\n");
  if (bodyText.length > MAX_SKILL_BODY_CHARS) {
    fail("validation", "body_too_long", `技能正文超过 ${MAX_SKILL_BODY_CHARS} 字符`);
  }

  const artifact: CompiledReceptionSkill = {
    schema_version: 1,
    skill_key: input.skill_key,
    audience: "customer_reception",
    steps,
    body_text: bodyText,
    question_schema_version: QUESTION_SCHEMA_VERSION,
    required_tools: normalizedTools,
    tool_contract_version: RECEPTION_TOOL_CONTRACT_VERSION,
  };
  return {
    artifact,
    artifact_hash: contentDigest(artifact),
    compiler_version: RECEPTION_SKILL_COMPILER_VERSION,
    tool_contract_digest: receptionToolContractDigest(),
  };
}
