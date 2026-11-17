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
 * 接待技能目录（设计 v1.1 §7.1 / D-M0-04 / M2-6）。
 *
 * 运行开始时固定 `skill_bindings`；`skill_summaries` 只含 skill_key、一句
 * 触发条件与版本/hash，不含正文（最多 5 项、合计不超过 600 中文字符）。
 * `load_reception_skill` 只能加载快照中的确切产物，不重新解析 ACTIVE 指针，
 * 也不回退到 owner 目录；未绑定/已撤回/超限一律拒绝。
 */

import type { CurrentSkillBinding } from "../../merchant-core/context-governance/context-guard.js";
import type { ReceptionSkillStep, ReceptionSkillTool } from "./skill-contract.js";

export const MAX_SKILL_SUMMARIES = 5;
export const MAX_SKILL_SUMMARY_CHARS = 600;
export const MAX_LOADED_SKILLS = 2;
export const MAX_LOADED_SKILL_CHARS = 3_000;

export interface ReceptionSkillBinding {
  readonly skill_key: string;
  readonly release_id: string;
  readonly compiled_artifact_hash: string;
  readonly generation: number;
  readonly revocation_epoch: number;
  readonly trigger_text: string;
  readonly question_schema_version: number;
  readonly tool_contract_digest: string;
  readonly body_text: string;
  readonly steps: readonly ReceptionSkillStep[];
  readonly required_tools: readonly ReceptionSkillTool[];
}

export interface ReceptionSkillSummary {
  readonly skill_key: string;
  readonly trigger: string;
  readonly release_id: string;
  readonly compiled_artifact_hash: string;
  readonly generation: number;
  readonly revocation_epoch: number;
  readonly question_schema_version: number;
  readonly tool_contract_digest: string;
}

export interface SkillSummaryResult {
  readonly summaries: readonly ReceptionSkillSummary[];
  /** 因 5 项/600 字上限截断（运行记录标注原因，不静默丢）。 */
  readonly truncated: boolean;
}

export interface ReceptionSkillCatalog {
  /** 当前生效版本（按 skill_key 稳定排序）；撤回/退役后不再返回。 */
  activeBindings(merchantId: string): ReceptionSkillBinding[];
  /** 运行快照摘要（≤5 项 / ≤600 字，按 skill_key 排序）。 */
  summaries(merchantId: string): SkillSummaryResult;
  /** ContextGuard 权威值：当前 ACTIVE 绑定；undefined = 未绑定/已撤回。 */
  currentBinding(merchantId: string, skillKey: string): CurrentSkillBinding | undefined;
  /** 加载快照绑定的冻结产物；release 不再生效时返回 undefined。 */
  loadArtifact(
    merchantId: string,
    skillKey: string,
    releaseId: string,
  ): ReceptionSkillBinding | undefined;
}

function oneLine(value: string, max = 120): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function summarizeBindings(
  bindings: readonly ReceptionSkillBinding[],
): SkillSummaryResult {
  const sorted = [...bindings].sort((a, b) => a.skill_key.localeCompare(b.skill_key));
  const summaries: ReceptionSkillSummary[] = [];
  let chars = 0;
  let truncated = false;
  for (const binding of sorted) {
    if (summaries.length >= MAX_SKILL_SUMMARIES) {
      truncated = true;
      break;
    }
    const trigger = oneLine(binding.trigger_text);
    const length = binding.skill_key.length + trigger.length;
    if (chars + length > MAX_SKILL_SUMMARY_CHARS) {
      truncated = true;
      break;
    }
    chars += length;
    summaries.push({
      skill_key: binding.skill_key,
      trigger,
      release_id: binding.release_id,
      compiled_artifact_hash: binding.compiled_artifact_hash,
      generation: binding.generation,
      revocation_epoch: binding.revocation_epoch,
      question_schema_version: binding.question_schema_version,
      tool_contract_digest: binding.tool_contract_digest,
    });
  }
  return { summaries, truncated };
}

/** 模型 prompt 里的技能摘要（不含正文）。 */
/** 固定快照目录（评测/测试用）：绑定列表不可变，load 只返回对应 release。 */
export function createStaticSkillCatalog(
  bindings: readonly ReceptionSkillBinding[],
): ReceptionSkillCatalog {
  const byKey = new Map(bindings.map((binding) => [binding.skill_key, binding]));
  return {
    activeBindings: () => [...bindings],
    summaries: () => summarizeBindings(bindings),
    currentBinding: (_merchantId, skillKey) => {
      const binding = byKey.get(skillKey);
      return binding === undefined
        ? undefined
        : {
            release_id: binding.release_id,
            compiled_artifact_hash: binding.compiled_artifact_hash,
            generation: binding.generation,
            revocation_epoch: binding.revocation_epoch,
          };
    },
    loadArtifact: (_merchantId, skillKey, releaseId) => {
      const binding = byKey.get(skillKey);
      return binding !== undefined && binding.release_id === releaseId ? binding : undefined;
    },
  };
}

export function skillSummaryPrompt(result: SkillSummaryResult): string {
  if (result.summaries.length === 0) return "";
  return [
    "Published reception skills for this merchant (choose skill_key and call load_reception_skill; summaries contain no body):",
    ...result.summaries.map((summary) => `- ${summary.skill_key}: ${summary.trigger}`),
  ].join("\n");
}
