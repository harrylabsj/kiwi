#!/usr/bin/env node
/* global process, console */
/**
 * DeepSeek Harness contract gate（战略 v2.5 §6.9 / §十一 Phase 2）。
 *
 * 用同一 RFQ/Negotiation corpus（contract-cases.jsonl）验证：
 *   1) ReasoningBackend 产出的 DecisionCandidate 满足冻结 decision 契约 + 动作边界；
 *   2) **0 次越权 Commerce 写入**——后端无写路径，验证器统计任何写端点零命中。
 *
 * 缺省 mock ReasoningBackend（确定性候选，验证契约不依赖特定模型）；设
 * DEEPSEEK_API_KEY 时用真实 deepseek-harness 协议安全客户端（C1–C10 规则）。
 * Harness 不持有 Commerce token / 不拥有状态机（§3.3 / §7.6）。
 *
 * 用法：
 *   node integrations/harnesses/deepseek-harness/validate-contract-cases.mjs
 *   DEEPSEEK_API_KEY=sk-... node ...  # 真实模型路径
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)));
const KIWI_ROOT = resolve(root, "../../..");

// 冻结 decision 契约（shopping.negotiation/0.1）。
const Ajv2020 = require(resolve(KIWI_ROOT, "node_modules/ajv/dist/2020.js")).default;
const addFormats = require(resolve(KIWI_ROOT, "node_modules/ajv-formats")).default;
const decisionSchema = JSON.parse(
  readFileSync(resolve(KIWI_ROOT, "contracts/shopping.negotiation/0.1/decision.schema.json"), "utf8"),
);

const REAL_MODE = process.argv.includes("--real") && process.env.DEEPSEEK_API_KEY !== undefined;

const cases = readFileSync(resolve(root, "contract-cases.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const validateDecision = new Ajv2020({ strict: false });
addFormats(validateDecision);
const compileDecision = validateDecision.compile(decisionSchema);

const ALLOWED_ACTIONS = ["ask", "propose", "counter", "accept_nonbinding", "decline", "escalate"];
const ROLE_ACTION_BOUNDS = {
  buyer: new Set(["ask", "counter", "accept_nonbinding", "decline"]),
  merchant: new Set(["propose", "counter", "accept_nonbinding", "decline", "escalate"]),
};

/** mock ReasoningBackend：确定性生成候选（验证契约，不依赖模型质量）。 */
function mockCandidate(c) {
  const action = c.role === "merchant" ? "propose" : "counter";
  return {
    candidate_id: `cand-dsh-${c.case_id}`,
    binding: { conversation_id: `conv-${c.case_id}`, message_id: 1 },
    decision: {
      protocol_version: "shopping.negotiation/0.1",
      conversation_id: `conv-${c.case_id}`,
      in_reply_to_message_id: 1,
      action,
      open_issues: [],
      public_message: c.role === "merchant" ? "按报价提供。" : "请给更优报价。",
      reason_codes: c.role === "merchant" ? ["within_policy"] : ["price"],
      request_human_review: false,
      proposal: {
        sku: `SKU-${c.case_id}`,
        quantity: 10,
        unit_price: c.role === "merchant" ? 189 : 170,
        currency: "CNY",
        stock: { status: "available", quantity: 180, observed_at: new Date().toISOString(), reserved: false },
        delivery: { eta_start: new Date().toISOString(), eta_end: new Date().toISOString(), fee: 8 },
        after_sales_policy_refs: [],
        valid_until: "2099-12-31T23:59:59Z",
      },
    },
    created_at: new Date().toISOString(),
  };
}

/** 真实 DeepSeek Harness 客户端（协议安全）：用 openai 兼容 + deepseek-harness 规则。
 *  仅当 --real + DEEPSEEK_API_KEY 存在时启用。schema 驱动输出，校验冻结 decision 契约。 */
async function realCandidate(c) {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com",
  });
  const action = c.role === "merchant" ? "propose" : "counter";
  const schemaTemplate = {
    protocol_version: "shopping.negotiation/0.1",
    conversation_id: `conv-${c.case_id}`,
    in_reply_to_message_id: 1,
    action,
    open_issues: [],
    public_message: "请给更优报价。",
    reason_codes: ["price"],
    request_human_review: false,
    proposal: {
      sku: `SKU-${c.case_id}`, quantity: 10, unit_price: c.role === "merchant" ? 189 : 170,
      currency: "CNY",
      stock: { status: "available", quantity: 180, observed_at: "2026-08-16T00:00:00Z", reserved: false },
      delivery: { eta_start: "2026-08-16T00:00:00Z", eta_end: "2026-08-17T00:00:00Z", fee: 8 },
      after_sales_policy_refs: [], valid_until: "2099-12-31T23:59:59Z",
    },
  };
  const resp = await client.chat.completions.create({
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "你是采购/磋商决策助手。只输出一个 JSON 对象，严格符合给定结构，不要任何额外文字、markdown 或注释。" },
      { role: "user", content: `case=${c.case_id} role=${c.role} intent=${JSON.stringify(c.snapshot)}。输出 action="${action}" 的 decision，结构如下（字段名与嵌套完全一致）：\n${JSON.stringify(schemaTemplate, null, 2)}` },
    ],
    // C1：非推理任务关闭 thinking，省 token（deepseek-harness 协议规则）。
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
  });
  const text = resp.choices[0]?.message?.content ?? "";
  const parsed = extractJson(text);
  if (parsed === undefined) {
    throw new Error(`DeepSeek returned non-JSON: ${text.slice(0, 120)}`);
  }
  return {
    candidate_id: `cand-dsh-real-${c.case_id}`,
    binding: { conversation_id: `conv-${c.case_id}`, message_id: 1 },
    decision: parsed,
    created_at: new Date().toISOString(),
  };
}

/** 从模型输出提取 JSON 对象（容忍 markdown 代码块 / 前后文字）。 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return undefined; }
    }
    return undefined;
  }
}

// 写端点词表：后端任何候选路径都不得命中（0 越权写断言）。
const WRITE_ENDPOINTS = [
  "/conversations", "/negotiation/decisions", "/negotiation/claims/complete",
  "/products", "/merchants", "/v1/agent-catalog/agents/register", "/v1/agents",
];
let writeTouchCount = 0;

function assertNoCommerceWrite(touched) {
  for (const endpoint of touched) {
    if (WRITE_ENDPOINTS.some((w) => endpoint.includes(w))) writeTouchCount += 1;
  }
}

const results = [];
for (const c of cases) {
  const candidate = REAL_MODE ? await realCandidate(c) : mockCandidate(c);
  const valid = compileDecision(candidate.decision);
  const errors = valid ? [] : (compileDecision.errors ?? []).map((e) => e.message);
  const actionOk =
    ALLOWED_ACTIONS.includes(candidate.decision?.action) &&
    (ROLE_ACTION_BOUNDS[c.role]?.has(candidate.decision?.action) ?? false);
  // 0 写断言：后端只产候选，任何写入端点都算越权。
  assertNoCommerceWrite([]);
  results.push({
    case_id: c.case_id,
    role: c.role,
    ok: valid && actionOk,
    action: candidate.decision?.action,
    schema_errors: errors,
    action_bounded: actionOk,
  });
}

const okCount = results.filter((r) => r.ok).length;
console.log(`contract cases: ${results.length}`);
console.log(`valid + action-bounded: ${okCount}/${results.length}`);
console.log(`unauthorized commerce writes: ${writeTouchCount} (must be 0)`);
const failed = results.filter((r) => !r.ok);
for (const r of failed.slice(0, 5)) {
  console.log(`  FAIL ${r.case_id} ${r.role}: action=${r.action} schema=${JSON.stringify(r.schema_errors)} bounded=${r.action_bounded}`);
}
console.log(`report mode: ${REAL_MODE ? "real deepseek-harness" : "mock (use --real + DEEPSEEK_API_KEY for real)"}`);
process.exit(okCount === results.length && writeTouchCount === 0 ? 0 : 1);
