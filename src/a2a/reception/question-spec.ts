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
 * QuestionSpec v1（设计 v1.1 §7.2 / A05 / A20）。
 *
 * P0 只注册 sku、quantity、unit 三个槽位。问题模板、问题 ID、适用原因和
 * 输入 schema 由产品与开发审核后在注册表中固定；模型只选择 question_id 与
 * 合法候选引用，发布器从模板确定性生成问句，不接收模型自由撰写的问句。
 *
 * 兼容策略：现有 `missing_quantity`、`unit_mismatch` 等 reason 与固定文案
 * 登记为模板初始版本；确定性引擎继续产生原 reason，发布器优先用注册表
 * 渲染，模板缺失时回退旧文案并在发布结果中标注 `renderer_fallback`。
 */

import type { ReceptionBlock } from "./types.js";

export const QUESTION_SCHEMA_VERSION = 1;
export const QUESTION_SLOTS = ["sku", "quantity", "unit"] as const;
export type QuestionSlot = (typeof QUESTION_SLOTS)[number];

export type QuestionCandidateType = "none" | "sku_candidates";

export interface QuestionSpec {
  readonly question_id: string;
  readonly schema_version: number;
  readonly slot: QuestionSlot;
  /** 与旧 ask_clarification.reason 对齐的稳定原因码。 */
  readonly reason_code: string;
  /** 模型选择用的单行触发说明（不含正文模板）。 */
  readonly description: string;
  /** 默认模板；占位符只允许 {mentioned} / {candidates} / {supported_unit}。 */
  readonly template: string;
  /** unit_mismatch 在已知商品单位时的模板（只允许 {supported_unit}）。 */
  readonly template_with_supported_unit?: string;
  readonly candidate_type: QuestionCandidateType;
}

export interface QuestionRenderParams {
  readonly candidates?: readonly string[];
  readonly supported_unit?: string;
}

export interface QuestionRenderResult {
  readonly text: string;
  /** true = 注册表无模板，使用旧渲染器兜底。 */
  readonly fallback: boolean;
  readonly question_id?: string;
}

const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
const MAX_DESCRIPTION_CHARS = 120;
const MAX_TEMPLATE_CHARS = 500;

const DEFAULT_PLACEHOLDERS = new Set(["mentioned", "candidates", "supported_unit"]);
const SUPPORTED_UNIT_PLACEHOLDERS = new Set(["supported_unit"]);

function fail(message: string): never {
  throw new Error(`invalid question spec: ${message}`);
}

function validatePlaceholders(template: string, allowed: ReadonlySet<string>): void {
  for (const match of template.matchAll(/\{([a-z_]+)\}/g)) {
    if (!allowed.has(match[1] ?? "")) fail(`template placeholder {${match[1]}} is not allowed`);
  }
}

function validateSpec(spec: QuestionSpec): void {
  if (!QUESTION_ID_PATTERN.test(spec.question_id)) {
    fail(`question_id ${spec.question_id} must be lowercase kebab/snake-case`);
  }
  if (!Number.isSafeInteger(spec.schema_version) || spec.schema_version < 1) {
    fail("schema_version must be a positive integer");
  }
  if (!(QUESTION_SLOTS as readonly string[]).includes(spec.slot)) {
    fail(`slot ${spec.slot} is not registered`);
  }
  if (typeof spec.reason_code !== "string" || spec.reason_code.trim() === "") {
    fail("reason_code must be a non-empty string");
  }
  if (
    typeof spec.description !== "string" ||
    spec.description.trim() === "" ||
    spec.description.length > MAX_DESCRIPTION_CHARS
  ) {
    fail(`description must be 1..${MAX_DESCRIPTION_CHARS} characters`);
  }
  if (
    typeof spec.template !== "string" ||
    spec.template.trim() === "" ||
    spec.template.length > MAX_TEMPLATE_CHARS
  ) {
    fail(`template must be 1..${MAX_TEMPLATE_CHARS} characters`);
  }
  validatePlaceholders(spec.template, DEFAULT_PLACEHOLDERS);
  if (spec.template_with_supported_unit !== undefined) {
    if (
      spec.slot !== "unit" ||
      spec.template_with_supported_unit.trim() === "" ||
      spec.template_with_supported_unit.length > MAX_TEMPLATE_CHARS
    ) {
      fail("template_with_supported_unit is only valid for the unit slot");
    }
    validatePlaceholders(spec.template_with_supported_unit, SUPPORTED_UNIT_PLACEHOLDERS);
  }
  if (spec.candidate_type !== "none" && spec.candidate_type !== "sku_candidates") {
    fail("candidate_type must be none or sku_candidates");
  }
}

function renderTemplate(
  template: string,
  params: QuestionRenderParams,
): string | undefined {
  const candidates = params.candidates ?? [];
  const joined = candidates.length > 0 ? candidates.join("、") : "（无）";
  const mentioned = candidates.length > 0 ? `您提到了：${joined}。` : "";
  const supported = params.supported_unit;
  if (template.includes("{supported_unit}") && supported === undefined) return undefined;
  return template
    .replaceAll("{mentioned}", mentioned)
    .replaceAll("{candidates}", joined)
    .replaceAll("{supported_unit}", supported ?? "");
}

/**
 * 固定注册表。构造时全量校验（重复 ID、未知槽位、非法占位符都拒绝），
 * 防止运行时出现"半注册"模板。
 */
export class QuestionSpecRegistry {
  private readonly byId: Map<string, QuestionSpec>;
  private readonly byReason: Map<string, QuestionSpec>;

  constructor(specs: readonly QuestionSpec[]) {
    this.byId = new Map();
    this.byReason = new Map();
    for (const spec of specs) {
      validateSpec(spec);
      if (this.byId.has(spec.question_id)) fail(`duplicate question_id ${spec.question_id}`);
      this.byId.set(spec.question_id, spec);
      if (!this.byReason.has(spec.reason_code)) {
        this.byReason.set(spec.reason_code, spec);
      }
    }
  }

  resolve(questionId: string): QuestionSpec | undefined {
    return this.byId.get(questionId);
  }

  byReasonCode(reasonCode: string): QuestionSpec | undefined {
    return this.byReason.get(reasonCode);
  }

  list(): readonly QuestionSpec[] {
    return [...this.byId.values()];
  }

  /** 模型 prompt 里的受控问题目录（不含正文模板）。 */
  catalogText(): string {
    if (this.byId.size === 0) return "";
    return [
      "Registered clarification questions (choose question_id only; never write your own question):",
      ...[...this.byId.values()].map(
        (spec) => `- ${spec.question_id} [${spec.slot}] ${spec.description}`,
      ),
    ].join("\n");
  }

  /** 按 question_id 渲染已注册问题；未知 ID 返回 undefined（不得兜底）。 */
  render(questionId: string, params: QuestionRenderParams = {}): string | undefined {
    const spec = this.byId.get(questionId);
    if (spec === undefined) return undefined;
    const template =
      spec.template_with_supported_unit !== undefined && params.supported_unit !== undefined
        ? spec.template_with_supported_unit
        : spec.template;
    return renderTemplate(template, params);
  }

  /**
   * 旧 ask_clarification 渲染：有注册模板则渲染（fallback=false），否则
   * 返回 undefined 由旧文案兜底（调用方标注 fallback）。
   */
  renderLegacy(block: Extract<ReceptionBlock, { kind: "ask_clarification" }>): QuestionRenderResult | undefined {
    const spec = this.byReason.get(block.reason);
    if (spec === undefined) return undefined;
    const text = this.render(spec.question_id, {
      ...(block.candidates !== undefined ? { candidates: block.candidates } : {}),
      ...(block.supportedUnit !== undefined ? { supported_unit: block.supportedUnit } : {}),
    });
    if (text === undefined) return undefined;
    return { text, fallback: false, question_id: spec.question_id };
  }

  /** 已注册问题块的渲染（发布器在契约校验后调用）。 */
  renderRegistered(
    questionId: string,
    params: QuestionRenderParams = {},
  ): { text: string; fallback: boolean; question_id: string } | undefined {
    const text = this.render(questionId, params);
    return text === undefined ? undefined : { text, fallback: false, question_id: questionId };
  }
}

/**
 * 初始模板：逐字复刻现有固定文案（发布器测试与真实回复不变）。
 */
export const DEFAULT_QUESTION_SPECS: readonly QuestionSpec[] = [
  {
    question_id: "q_non_chinese_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "non_chinese",
    description: "买家使用非中文时说明仅支持中文接待",
    template: "目前仅支持中文接待。请用中文说明需要的商品、数量和单位，或发送结构化 RFQ。",
    candidate_type: "none",
  },
  {
    question_id: "q_empty_message_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "empty_message",
    description: "空消息时请买家说明商品、数量和单位",
    template: "请说明需要的商品、数量和单位。",
    candidate_type: "none",
  },
  {
    question_id: "q_service_busy_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "service_busy",
    description: "查询繁忙时告知可恢复的下一步",
    template: "当前查询较忙，请稍后重试；也可以直接发送 RFQ（SKU、数量、单位）获取正式报价。",
    candidate_type: "none",
  },
  {
    question_id: "q_unknown_sku_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "unknown_sku",
    description: "商品源无法确认 SKU 时请买家核对",
    template: "暂时无法从商品源确认该 SKU，请核对后重试。",
    candidate_type: "none",
  },
  {
    question_id: "q_multiple_skus_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "multiple_skus",
    description: "买家提到多个 SKU 时请其选择一个",
    template: "一次只能咨询一个商品。{mentioned}请告诉我要先确认哪一个，其余商品可以分别咨询。",
    candidate_type: "sku_candidates",
  },
  {
    question_id: "q_missing_quantity_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "quantity",
    reason_code: "missing_quantity",
    description: "缺少购买数量时请买家补充",
    template: "请补充购买数量（例如：2 件、1 箱）。",
    candidate_type: "none",
  },
  {
    question_id: "q_quantity_overflow_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "quantity",
    reason_code: "quantity_overflow",
    description: "数量超出可安全处理范围时请买家减少",
    template: "数量超出可安全处理范围，请减少数量后重试；本次未报价。",
    candidate_type: "none",
  },
  {
    question_id: "q_facts_stale_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "facts_stale",
    description: "商品事实过期时请买家重发 RFQ 或稍后重试",
    template: "商品数据已过期，暂时无法报价；请发送 RFQ 重新确认，或稍后重试。",
    candidate_type: "none",
  },
  {
    question_id: "q_unit_mismatch_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "unit",
    reason_code: "unit_mismatch",
    description: "买家单位与商品售卖单位不一致时请其确认",
    template: "请确认商品单位（如件/盒/箱）。",
    template_with_supported_unit: "该商品按 {supported_unit} 售卖；请确认您要的单位。",
    candidate_type: "none",
  },
  {
    question_id: "q_product_candidates_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "product_candidates",
    description: "搜索到多个商品候选时请买家选择",
    template: "我在本店找到这些商品：{candidates}。请告诉我要咨询哪一个，并补充数量和单位。",
    candidate_type: "sku_candidates",
  },
  {
    question_id: "q_missing_sku_v1",
    schema_version: QUESTION_SCHEMA_VERSION,
    slot: "sku",
    reason_code: "missing_sku",
    description: "缺少商品 SKU 时请买家补充",
    template: "请提供商品 SKU；如已知数量与单位也请一并说明。",
    candidate_type: "none",
  },
];

export const DEFAULT_QUESTION_SPEC_REGISTRY = new QuestionSpecRegistry(
  DEFAULT_QUESTION_SPECS,
);

/** 旧 reason → 注册 question_id（评测/审计用）。 */
export function getQuestionIdByReason(reason: string): string | undefined {
  return DEFAULT_QUESTION_SPEC_REGISTRY.byReasonCode(reason)?.question_id;
}
