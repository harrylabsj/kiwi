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
 * M5 三个初始接待技能（设计 v1.1 §8）。
 *
 * 它们是商家可评审/可发布的候选内容，不包含包装倍率、折扣权限或任何价格
 * 事实；编译后必须通过 `compileReceptionSkillArtifact` 的固定动作/问题/守卫
 * 校验。技能版本与商品事实版本分别管理。
 */

import {
  compileReceptionSkillArtifact,
  type CompiledArtifact,
  type ReceptionSkillStep,
} from "../../a2a/reception/skill-contract.js";

export interface InitialSkillDefinition {
  readonly skill_key: string;
  readonly trigger_text: string;
  readonly description: string;
  readonly steps: readonly ReceptionSkillStep[];
}

export const INITIAL_SKILLS: readonly InitialSkillDefinition[] = [
  {
    skill_key: "trial-unit-clarification",
    trigger_text: "买家询问试用装且数量/单位不明确时，先读取商家单位规则再澄清",
    description: "试用询价澄清：读取当前事实，按注册问题确认数量与单位",
    steps: [
      { action_ref: "get_commercial_facts" },
      { action_ref: "ask_registered_question", question_id: "q_unit_mismatch_v1", guard_ref: "unit_unresolved" },
      { action_ref: "propose_reply" },
    ],
  },
  {
    skill_key: "price-objection",
    trigger_text: "买家提出目标价或认为价格偏高时，只用当前公开事实解释并转受控协商",
    description: "价格异议处理：解释可证内容，越界转人工审批，不承诺折扣",
    steps: [
      { action_ref: "get_commercial_facts" },
      { action_ref: "request_human_help" },
      { action_ref: "propose_reply" },
    ],
  },
  {
    skill_key: "public-option-comparison",
    trigger_text: "买家在同一商品有多个公开候选需要比较时，按公开价格/库存给出可验证理由",
    description: "公开方案比较：只比较公开事实，不推荐未验证或私有方案",
    steps: [
      { action_ref: "search_products" },
      { action_ref: "compare_products" },
      { action_ref: "get_commercial_facts" },
      { action_ref: "propose_reply" },
    ],
  },
];

export interface CompiledInitialSkill {
  readonly definition: InitialSkillDefinition;
  readonly compiled: CompiledArtifact;
}

/** 编译并校验三个初始技能；任何契约变化都应在发布前失败。 */
export function compileInitialSkills(): CompiledInitialSkill[] {
  return INITIAL_SKILLS.map((definition) => ({
    definition,
    compiled: compileReceptionSkillArtifact({
      skill_key: definition.skill_key,
      steps: definition.steps,
    }),
  }));
}
