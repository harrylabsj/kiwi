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
 * 后台经营任务的模型建议执行器（设计 §15.2 / X09）。
 *
 * 模型只返回内部建议（internal_summary/internal_draft/data_issue/no_action）
 * 与证据引用；不包含收件人、可执行代码或外发动作。本模块不写数据库，
 * 调用方在事务外运行模型，再用 commitInternalResult 原子提交。
 */

import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

import type { AutomationRule } from "./service.js";

export const TOOL_PROPOSE_OPERATION_ADVICE = "propose_operation_advice";

export const OPERATION_ADVICE_KINDS = [
  "internal_summary",
  "internal_draft",
  "data_issue",
  "no_action",
] as const;
export type OperationAdviceKind = (typeof OPERATION_ADVICE_KINDS)[number];

export interface OperationAdvice {
  readonly kind: OperationAdviceKind;
  readonly summary: string;
  readonly evidence_refs: readonly string[];
  readonly reason_code?: string;
  readonly question_id?: string;
  readonly next_action: "merchant_review" | "none";
}

export interface OperationAdviceUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly steps: number;
  readonly toolCalls: Readonly<Record<string, number>>;
}

export interface OperationAdviceRun {
  readonly advice: OperationAdvice;
  readonly usage: OperationAdviceUsage;
  readonly trace: Readonly<Record<string, unknown>>;
}

export interface OperationAdviceRunnerOptions {
  readonly streamFn: StreamFn;
  readonly model: Model<Api>;
  readonly getApiKey?: () => string | undefined;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly now: () => string;
}

const SYSTEM_PROMPT = [
  "You are a Kiwi merchant operations assistant. Reply in Simplified Chinese.",
  "You may only propose an internal operation advice: internal_summary, internal_draft,",
  "data_issue, or no_action. Never address a customer, never choose a recipient,",
  "never execute an order/payment/discount, and never output code.",
  "Only cite evidence_refs that appear in the task payload. If facts are missing,",
  "use data_issue with the missing range; do not invent prices, stock or orders.",
  "Finish by calling propose_operation_advice exactly once.",
].join(" ");

function toolResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAdvice(value: unknown): OperationAdvice | undefined {
  if (!isObject(value)) return undefined;
  const allowed = new Set([
    "kind",
    "summary",
    "evidence_refs",
    "reason_code",
    "question_id",
    "next_action",
  ]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return undefined;
  const kind = value.kind;
  if (typeof kind !== "string" || !(OPERATION_ADVICE_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (summary === "" || summary.length > 2000) return undefined;
  const evidence = Array.isArray(value.evidence_refs)
    ? value.evidence_refs.filter((ref): ref is string => typeof ref === "string").slice(0, 10)
    : [];
  if (!Array.isArray(value.evidence_refs) || evidence.length !== value.evidence_refs.length) {
    return undefined;
  }
  const nextAction = value.next_action;
  if (nextAction !== "merchant_review" && nextAction !== "none") return undefined;
  const reasonCode =
    typeof value.reason_code === "string" && value.reason_code.trim() !== ""
      ? value.reason_code.trim()
      : undefined;
  const questionId =
    typeof value.question_id === "string" && value.question_id.trim() !== ""
      ? value.question_id.trim()
      : undefined;
  return {
    kind: kind as OperationAdviceKind,
    summary,
    evidence_refs: evidence,
    next_action: nextAction,
    ...(reasonCode !== undefined ? { reason_code: reasonCode } : {}),
    ...(questionId !== undefined ? { question_id: questionId } : {}),
  };
}

/** 把任务快照投影成模型输入；不包含客户原文以外的隐式数据。 */
function taskPrompt(rule: AutomationRule, task: { task_id: string; payload: Record<string, unknown> }): string {
  return JSON.stringify({
    rule: {
      rule_id: rule.rule_id,
      template: rule.template,
      action_type: rule.action_type,
      scope: rule.scope,
      predicate: rule.predicate_spec,
      version: rule.version,
    },
    task: { task_id: task.task_id, payload: task.payload },
    locale: "zh-CN",
  });
}

export function createOperationAdviceRunner(
  options: OperationAdviceRunnerOptions,
): (input: {
  rule: AutomationRule;
  task: { task_id: string; payload: Record<string, unknown> };
}) => Promise<OperationAdviceRun> {
  return async (input) => {
    let advice: OperationAdvice | undefined;
    const metrics = { input: 0, output: 0, total: 0, steps: 0 };
    const toolCalls: Record<string, number> = {};
    let timedOut = false;
    const tool: AgentTool<TSchema, unknown> = {
      name: TOOL_PROPOSE_OPERATION_ADVICE,
      label: "Propose operation advice",
      description: "Submit the internal operation advice. Ends the turn.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...OPERATION_ADVICE_KINDS] },
          summary: { type: "string" },
          evidence_refs: { type: "array", items: { type: "string" } },
          reason_code: { type: "string" },
          question_id: { type: "string" },
          next_action: { type: "string", enum: ["merchant_review", "none"] },
        },
        required: ["kind", "summary", "evidence_refs", "next_action"],
      },
      execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
        const sanitized = sanitizeAdvice(params);
        if (sanitized === undefined) {
          return toolResult(JSON.stringify({ accepted: false, error: "invalid_advice" }));
        }
        advice = sanitized;
        return toolResult(JSON.stringify({ accepted: true }));
      },
    } as AgentTool<TSchema, unknown>;

    const agent = new Agent({
      streamFn: options.streamFn,
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: options.model,
        tools: [tool],
      },
      convertToLlm: (messages) => messages as Message[],
      toolExecution: "sequential",
      ...(options.getApiKey !== undefined ? { getApiKey: options.getApiKey } : {}),
    });
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const usage = event.message.usage;
        metrics.input += usage.input;
        metrics.output += usage.output;
        metrics.total += usage.totalTokens;
      }
      if (event.type === "tool_execution_start") {
        toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
      }
      if (event.type === "turn_end") {
        metrics.steps += 1;
        if (metrics.steps >= (options.maxSteps ?? 4)) {
          timedOut = true;
          agent.abort();
        }
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, options.timeoutMs ?? 60_000);
    try {
      await agent.prompt(taskPrompt(input.rule, input.task));
      await agent.waitForIdle();
      if (advice === undefined && !timedOut) {
        // 模型偶尔只回文本；再明确要求提交一次结构化建议，仍失败则交由
        // 调用方按 data_issue 降级，不伪造成功。
        await agent.prompt(
          "请立即调用 propose_operation_advice 提交内部建议；不要输出其它文本。",
        );
        await agent.waitForIdle();
      }
    } finally {
      clearTimeout(timer);
    }
    if (advice === undefined || timedOut) {
      throw new Error("operation_advice_unavailable");
    }
    return {
      advice,
      usage: { ...metrics, toolCalls },
      trace: {
        rule_id: input.rule.rule_id,
        task_id: input.task.task_id,
        model_steps: metrics.steps,
        tool_calls: toolCalls,
        at: options.now(),
      },
    };
  };
}
