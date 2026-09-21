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
 * 五步开通向导的**确定性骨架**（设计 §5.4 第一段；T007/T010/T012/T057）。
 *
 *     login-binding → platform-consent → catalog-confirm → service-check → public-profile
 *     登录绑定         原生平台授权        商品/规则确认      服务检查        公开资料确认
 *
 * 这一层只做三件事，都是为了"非技术商家 + 不可靠会话"这个组合：
 *
 * 1. **步骤 ↔ 记录状态**的映射是**数据**，不是散落在 UI 里的 if——向导每一步做没做过，
 *    只由服务端记录的 `lastSuccessfulStep` / `status` 决定（T010：中途退出后重开，
 *    读记录续办，不依赖聊天记忆）；
 * 2. **每一步的准入条件**明确写出：状态不对就不能进，且**关键步骤必须有权威证据**
 *    （平台授权那一步尤其——平台确认框回执是权威的，LLM 说"你已同意"不是）；
 * 3. **面向非技术用户的文案**里不出现域名/终端/端口/密钥（T057：不是说得好听，
 *    而是这些东西**真的不需要商家填**）。
 */

import {
  isAuthoritative,
  type Evidence,
  type OnboardingRecord,
  type OnboardingStatus,
} from "./types.js";

export const WIZARD_STEP_IDS = [
  "login-binding",
  "platform-consent",
  "catalog-confirm",
  "service-check",
  "public-profile",
] as const;

export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export interface WizardStepDefinition {
  id: WizardStepId;
  /** 面向非技术商家的标题（不出现域名/终端/端口/密钥）。 */
  title: string;
  /** 一句话说明这一步在做什么、商家要做什么。 */
  ask: string;
  /** 进入这一步时记录必须处于的状态。 */
  requiresStatus: readonly OnboardingStatus[];
  /** 这一步成功后要推进到的状态。 */
  advancesTo: OnboardingStatus;
  /** 这一步是否需要**权威证据**才能算成功（平台授权、服务检查是）。 */
  requiresAuthoritativeEvidence: boolean;
  /**
   * 失败时允许的展示方式（§5.4：依赖映射失败与配额不足要**真实展示**）。
   * `blocked` = 停下来等商家处理；`retryable` = 可重试。
   */
  onFailure: "blocked" | "retryable";
}

export const WIZARD_STEPS: readonly WizardStepDefinition[] = [
  {
    id: "login-binding",
    title: "登录与绑定",
    ask: "用你的账号登录，确认这次开通属于哪位商家。",
    requiresStatus: ["DRAFT"],
    advancesTo: "AWAITING_PLATFORM_CONSENT",
    requiresAuthoritativeEvidence: false,
    onFailure: "retryable",
  },
  {
    id: "platform-consent",
    title: "平台授权",
    ask: "在平台的确认框里确认授权——只有你在那儿按了确认，这一步才算完成。",
    requiresStatus: ["AWAITING_PLATFORM_CONSENT"],
    advancesTo: "ACTIVATED",
    // 平台确认框的回执是权威证据：代确认、粘贴一个 id、或助手说"已完成"都不算（T007/T029）。
    requiresAuthoritativeEvidence: true,
    onFailure: "blocked",
  },
  {
    id: "catalog-confirm",
    title: "商品与规则",
    ask: "确认要对外展示的商品，以及报价规则（哪些能自动答、哪些要你点头）。",
    requiresStatus: ["ACTIVATED"],
    // 确认商品/规则后**开始发布制品**（DEPLOYING）。"公网应用确实出现了"
    // （DEPLOYED_UNBOUND）不是向导的一步，而是平台回执到达后的后台对账——
    // 向导不该假装自己能让它发生。
    advancesTo: "DEPLOYING",
    requiresAuthoritativeEvidence: true,
    onFailure: "retryable",
  },
  {
    id: "service-check",
    title: "服务检查",
    ask: "系统自动检查接待能力（存储、商品、直连、隔离）。有问题会告诉你哪里不对。",
    // `DEPLOYED_UNBOUND → BOUND → VERIFYING` 是**后台对账**：授权/持钥证明与检查
    // 本身由系统完成，不是商家点出来的。商家看到的"服务检查"这一步，是检查**跑完
    // 且通过**（VERIFYING → READY_TO_PUBLISH）——所以这一步的准入状态是 VERIFYING。
    requiresStatus: ["VERIFYING"],
    advancesTo: "READY_TO_PUBLISH",
    requiresAuthoritativeEvidence: true,
    // 配额不足/依赖映射失败属"确定失败"：真实展示，不静默重试（T012）。
    onFailure: "blocked",
  },
  {
    id: "public-profile",
    title: "确认公开信息",
    ask: "确认对外公开的名片内容，然后发布。发布后买家才能在目录里找到你。",
    requiresStatus: ["READY_TO_PUBLISH"],
    advancesTo: "PUBLISHED",
    requiresAuthoritativeEvidence: true,
    onFailure: "retryable",
  },
];

export type WizardStepState =
  /** 已完成（记录里记着这一步成功过）。 */
  | "DONE"
  /** 当前该做的一步。 */
  | "CURRENT"
  /** 还没轮到（前面的步骤没完成）。 */
  | "PENDING"
  /** 记录状态不在这一步的准入集合里——说明流程走到别处了（失败/阻断/已发布）。 */
  | "UNAVAILABLE";

export interface WizardStepView extends WizardStepDefinition {
  state: WizardStepState;
}

export interface WizardPlan {
  steps: WizardStepView[];
  currentStep: WizardStepId | null;
  /** 记录当前状态（供 UI 如实展示，不由前端推断）。 */
  recordStatus: OnboardingStatus;
  /** 记录里记住的最后成功步骤（断点）。 */
  resumeFromStep: string | null;
}

/**
 * 由**服务端记录**推导向导视图（T010）。
 *
 * 纯函数：给同一条记录必然得到同一份计划——不信会话、不信前端状态。
 */
export function planWizard(record: OnboardingRecord): WizardPlan {
  const completed = new Set<string>();
  if (record.lastSuccessfulStep !== null) {
    // lastSuccessfulStep 之前的步骤都算做过（步骤是有序的）
    const index = WIZARD_STEP_IDS.indexOf(record.lastSuccessfulStep as WizardStepId);
    for (const id of WIZARD_STEP_IDS.slice(0, index + 1)) completed.add(id);
  }

  let current: WizardStepId | null = null;
  const steps: WizardStepView[] = WIZARD_STEPS.map((step) => {
    if (completed.has(step.id)) return { ...step, state: "DONE" };
    const admissible = step.requiresStatus.includes(record.status);
    if (current === null && admissible) {
      current = step.id;
      return { ...step, state: "CURRENT" };
    }
    return { ...step, state: admissible ? "PENDING" : "UNAVAILABLE" };
  });

  return {
    steps,
    currentStep: current,
    recordStatus: record.status,
    resumeFromStep: record.lastSuccessfulStep,
  };
}

export type StepVerdict =
  | { ok: true; definition: WizardStepDefinition }
  | { ok: false; code: "step_not_current" | "evidence_not_authoritative" | "record_terminal"; reason: string };

/**
 * 判断"这一步现在能不能提交成功"——**在写入之前**判定，避免半途改状态。
 *
 * 关键规则：需要权威证据的步骤，拿到非权威证据一律**拒**（含"商家说平台已经同意了"
 * 这类转述）。
 */
export function checkStepSubmission(
  record: OnboardingRecord,
  stepId: WizardStepId,
  evidence?: Evidence,
): StepVerdict {
  if (record.status === "CANCELLED") {
    return { ok: false, code: "record_terminal", reason: "开通意图已撤销，不能再提交步骤" };
  }
  const definition = WIZARD_STEPS.find((step) => step.id === stepId);
  if (definition === undefined) {
    return { ok: false, code: "step_not_current", reason: `unknown wizard step: ${stepId}` };
  }
  if (!definition.requiresStatus.includes(record.status)) {
    return {
      ok: false,
      code: "step_not_current",
      reason: `step ${stepId} is not admissible from status ${record.status}`,
    };
  }
  if (definition.requiresAuthoritativeEvidence) {
    if (evidence === undefined || !isAuthoritative(evidence)) {
      return {
        ok: false,
        code: "evidence_not_authoritative",
        reason: `step ${stepId} requires authoritative platform evidence (confirmed: ${String(evidence?.kind ?? "none")})`,
      };
    }
  }
  return { ok: true, definition };
}

/**
 * 面向非技术用户的文案自检（T057 的可执行部分）：
 * 向导文案里**不得**出现域名/终端/端口/密钥这类词——不是"说得好听"，
 * 而是这些输入**真的不该由商家提供**。
 */
const FORBIDDEN_TERMS = ["域名", "终端", "端口", "密钥", "CLI", "命令行", "SSH", "npm", "证书"];

export function auditWizardCopy(steps: readonly WizardStepDefinition[] = WIZARD_STEPS): string[] {
  const violations: string[] = [];
  for (const step of steps) {
    const text = `${step.title} ${step.ask}`;
    for (const term of FORBIDDEN_TERMS) {
      if (text.includes(term)) violations.push(`${step.id}: 文案出现「${term}」`);
    }
  }
  return violations;
}
