/**
 * X09：后台经营任务真实模型建议执行器（脚本化模型验证契约）。
 */
import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";

import {
  TOOL_PROPOSE_OPERATION_ADVICE,
  createOperationAdviceRunner,
} from "../src/merchant-core/operations-jobs/advice-runner.js";
import type { AutomationRule } from "../src/merchant-core/operations-jobs/service.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const NOW = "2026-11-18T00:00:00.000Z";
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

const rule: AutomationRule = {
  rule_id: "rule-1",
  merchant_id: "m-1",
  version: 1,
  template: "unfinished_inquiry_digest",
  trigger_spec: { kind: "daily_local", local_time: "09:00", timezone: "Asia/Shanghai" },
  timezone: "Asia/Shanghai",
  scope: { window: "previous_local_day" },
  predicate_spec: { kind: "fixed_template", template: "unfinished_inquiry_digest" },
  action_type: "internal_summary",
  budget: { max_runs_per_day: 1 },
  authorization_ref: null,
  effective_at: NOW,
  expires_at: "2027-01-01T00:00:00.000Z",
  content_hash: "sha256:rule",
  state: "ACTIVE",
  enable_epoch: 1,
  next_due_at: NOW,
  missed_count: 0,
  created_at: NOW,
  updated_at: NOW,
};

describe("经营建议执行器（X09）", () => {
  it("只接受内部建议与证据引用；拒绝收件人/额外字段", async () => {
    const { streamFn } = createScriptedFakeStreamFn([
      fauxAssistantMessage([
        fauxToolCall(TOOL_PROPOSE_OPERATION_ADVICE, {
          kind: "internal_summary",
          summary: "昨日有 2 条未完成询价，建议工作台跟进。",
          evidence_refs: ["inquiry:1", "inquiry:2"],
          next_action: "merchant_review",
        } as JsonObject),
      ]),
      fauxAssistantMessage("已提交内部建议。"),
    ]);
    const runner = createOperationAdviceRunner({
      streamFn,
      model,
      now: () => NOW,
      maxSteps: 4,
    });
    const result = await runner({
      rule,
      task: { task_id: "task-1", payload: { candidates: 2 } },
    });
    expect(result.advice).toMatchObject({
      kind: "internal_summary",
      evidence_refs: ["inquiry:1", "inquiry:2"],
      next_action: "merchant_review",
    });
    expect(result.usage.toolCalls[TOOL_PROPOSE_OPERATION_ADVICE]).toBe(1);
    expect(result.trace).toMatchObject({ rule_id: "rule-1", task_id: "task-1" });
  });
});
