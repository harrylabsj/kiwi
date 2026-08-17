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
 * MerchantDecisionBackend —— 受限 ReasoningBackend 的可复用实现（DeepSeek Harness
 * contract-gate 验证面，战略 v2.5 §6.9 / §十一 Phase 2）。
 *
 * **设计边界（2026-08-17 修正）**：kiwi merchant 的定价是**确定性**的，不依赖 LLM；
 * 生产 merchant handler（`src/a2a/server/merchant-handler.ts`）**不咨询**本模块——
 * 买家还价在 `[floor, list]` 内确定性响应，促销（批量门槛/折扣）来自可配置的
 * `merchant_policy`。本模块保留为受限推理后端（产不可信 `NegotiationDecision`、
 * 0 写 by construction）的验证/复用面，不作为 merchant 的定价权威。
 *
 * 与 integrations/harnesses/deepseek-harness/validate-contract-cases.mjs 共享同一
 * schema 驱动 prompt 与 extractJson —— 两处 prompt 须保持同步。
 */

import { validateAgainst } from "../contracts/schemas.js";
import { PROTOCOL_VERSION, type NegotiationDecision } from "../negotiation/types.js";
import { toMinorUnits as losslessToMinorUnits } from "../protocol/legacy-shopping-negotiation/money.js";
import type { MerchantPolicy } from "../config/profile.js";

/** merchant role bounds：只产 propose / counter（决策 action 枚举的子集）。 */
export type MerchantDecisionAction = "propose" | "counter";

export interface MerchantDecisionSuggestionInput {
  action: MerchantDecisionAction;
  sku: string;
  quantity: number;
  /** list 价（resolveProduct 输出的 minor units）+ 真实商品事实（供 prompt）。 */
  product: {
    priceMinor: number;
    currency: string;
    stock?: number;
    title?: string;
  };
  /** merchant policy（floor / max discount 等）。safe subset 进 prompt，floor 不进。 */
  policy?: MerchantPolicy;
  conversationId: string;
  /** 决策 schema 要求整数 ≥1；KNP 用字符串消息 id，此处传合成值（harness 约定）。 */
  inReplyToMessageId?: number;
  snapshot?: Record<string, unknown>;
}

/** 受限推理后端：返回不可信、schema 合法候选；任何失败 → null。永不写。 */
export interface MerchantDecisionBackend {
  suggest(input: MerchantDecisionSuggestionInput): Promise<NegotiationDecision | null>;
}

// ---------------------------------------------------------------------------
// JSON 提取 + 白名单消毒（schema additionalProperties:false 需先剥未知键）
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

const DECISION_KEYS = [
  "protocol_version",
  "conversation_id",
  "in_reply_to_message_id",
  "action",
  "proposal",
  "open_issues",
  "public_message",
  "confidence",
  "reason_codes",
  "request_human_review",
] as const;
const PROPOSAL_KEYS = [
  "sku",
  "quantity",
  "unit_price",
  "currency",
  "stock",
  "delivery",
  "after_sales_policy_refs",
  "valid_until",
] as const;
const STOCK_KEYS = ["status", "quantity", "observed_at", "reserved"] as const;
const DELIVERY_KEYS = ["eta_start", "eta_end", "fee"] as const;

/**
 * 从模型输出提取 JSON 对象（容忍 ```json 围栏 / 前后缀文本）。复制自 harness。
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced !== null && fenced[1] !== undefined ? fenced[1] : text;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * 白名单消毒 + 冻结契约校验。未知键先剥（模型可能加 thinking/注释）；再
 * validateAgainst("decision")（复用生产校验器，src/contracts/schemas.ts）。
 * merchant role bound：action ∈ {propose, counter} 且 proposal 存在才接受。
 */
export function sanitizeDecision(raw: unknown): NegotiationDecision | null {
  if (!isObject(raw)) return null;
  const decision = pick(raw, DECISION_KEYS);
  if (isObject(decision.proposal)) {
    const proposal = pick(decision.proposal, PROPOSAL_KEYS);
    if (isObject(proposal.stock)) proposal.stock = pick(proposal.stock, STOCK_KEYS);
    if (isObject(proposal.delivery)) proposal.delivery = pick(proposal.delivery, DELIVERY_KEYS);
    decision.proposal = proposal;
  }
  const errors = validateAgainst("decision", decision);
  if (errors.length > 0) return null;
  const candidate = decision as unknown as NegotiationDecision;
  if ((candidate.action !== "propose" && candidate.action !== "counter") || candidate.proposal === undefined) {
    return null;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 真实 DeepSeek 后端（raw fetch，零新运行时依赖）
// ---------------------------------------------------------------------------

export interface DeepSeekDecisionBackendOptions {
  /** resolver 惰性读 env（resolveSecret），请求时才解析。 */
  apiKey: string | (() => string);
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TEMPERATURE = 0.2;

/** 构建 schema 驱动 prompt 模板（镜像 harness realCandidate；不含 floor）。 */
function decisionTemplate(input: MerchantDecisionSuggestionInput): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  const stock = input.product.stock ?? 180;
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: input.conversationId,
    in_reply_to_message_id: input.inReplyToMessageId ?? 1,
    action: input.action,
    open_issues: [],
    public_message: "按报价提供。",
    reason_codes: ["within_policy"],
    request_human_review: false,
    confidence: 0.8,
    proposal: {
      sku: input.sku,
      quantity: input.quantity,
      unit_price: input.product.priceMinor / 100, // major 元
      currency: input.product.currency,
      stock: { status: stock > 0 ? "available" : "out_of_stock", quantity: stock, observed_at: nowIso, reserved: false },
      delivery: { eta_start: nowIso, eta_end: nowIso, fee: 8 },
      after_sales_policy_refs: [],
      valid_until: "2099-12-31T23:59:59Z",
    },
  };
}

export class DeepSeekDecisionBackend implements MerchantDecisionBackend {
  private readonly opts: DeepSeekDecisionBackendOptions;

  constructor(opts: DeepSeekDecisionBackendOptions) {
    this.opts = opts;
  }

  async suggest(input: MerchantDecisionSuggestionInput): Promise<NegotiationDecision | null> {
    let apiKey: string;
    try {
      apiKey = typeof this.opts.apiKey === "function" ? this.opts.apiKey() : this.opts.apiKey;
    } catch {
      return null; // resolveSecret 失败 → fail-safe 回落
    }
    if (apiKey === "") return null;

    const template = decisionTemplate(input);
    const system = "你是商家磋商决策助手。只输出一个 JSON 对象，严格符合给定结构，不要任何额外文字、markdown 或注释。";
    const user =
      `action=${input.action} sku=${input.sku} quantity=${input.quantity} 商品=${JSON.stringify(input.product)}。` +
      `输出 action="${input.action}" 的 decision，结构如下（字段名与嵌套完全一致，不得增加字段）：\n` +
      JSON.stringify(template, null, 2);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const resp = await (this.opts.fetchImpl ?? globalThis.fetch)(
        `${this.opts.baseUrl ?? DEFAULT_BASE_URL}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: this.opts.model ?? DEFAULT_MODEL,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            thinking: { type: "disabled" }, // harness C1 规则：非推理任务
            response_format: { type: "json_object" },
            temperature: this.opts.temperature ?? DEFAULT_TEMPERATURE,
          }),
          signal: controller.signal,
        },
      );
      if (!resp.ok) return null;
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return sanitizeDecision(extractJson(data.choices?.[0]?.message?.content ?? ""));
    } catch {
      return null; // 网络/超时/解析失败 → fail-safe
    } finally {
      clearTimeout(timer); // 测试无悬挂 timer
    }
  }
}

// ---------------------------------------------------------------------------
// Mock 后端（确定性，镜像 harness mockCandidate；测试 + 离线冒烟）
// ---------------------------------------------------------------------------

export class MockDecisionBackend implements MerchantDecisionBackend {
  async suggest(input: MerchantDecisionSuggestionInput): Promise<NegotiationDecision | null> {
    const qty = input.product.stock ?? 180;
    const nowIso = new Date().toISOString();
    return {
      protocol_version: PROTOCOL_VERSION,
      conversation_id: input.conversationId,
      in_reply_to_message_id: input.inReplyToMessageId ?? 1,
      action: input.action,
      open_issues: [],
      public_message: "按报价提供。",
      reason_codes: ["within_policy"],
      request_human_review: false,
      confidence: 0.8,
      proposal: {
        sku: input.sku,
        quantity: input.quantity,
        unit_price: input.product.priceMinor / 100, // major 元
        currency: input.product.currency,
        stock: { status: qty > 0 ? "available" : "out_of_stock", quantity: qty, observed_at: nowIso, reserved: false },
        delivery: { eta_start: nowIso, eta_end: nowIso, fee: 8 },
        after_sales_policy_refs: [],
        valid_until: "2099-12-31T23:59:59Z",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 桥接助手（handler 用）
// ---------------------------------------------------------------------------

/**
 * 候选 → {minor 单价, 可选公开说明} | null。backend 不可信：任何失败/缺失/
 * 有损转换 → null（调用方回落确定性基线）。**backed 从不写。**
 */
export async function consultDecisionBackend(
  backend: MerchantDecisionBackend | undefined,
  input: MerchantDecisionSuggestionInput,
): Promise<{ unitPriceMinor: number; note?: string } | null> {
  if (backend === undefined) return null;
  let decision: NegotiationDecision | null = null;
  try {
    decision = await backend.suggest(input);
  } catch {
    return null;
  }
  if (decision === null) return null;
  const proposal = decision.proposal;
  if (proposal === undefined || typeof proposal.unit_price !== "number") return null;
  const converted = losslessToMinorUnits(proposal.unit_price, 2);
  if (!converted.lossless) return null; // money.ts：有损 → fail-closed
  return {
    unitPriceMinor: converted.amount_minor,
    ...(decision.public_message !== undefined && decision.public_message !== ""
      ? { note: decision.public_message }
      : {}),
  };
}

/**
 * 从外发公开消息中剔除私有 floor token（镜像 negotiation-chat.redactPrivateFloor
 * 的纯函数语义；复制避免 a2a→agent 跨树 import）。floor 是私有值，绝不出现在
 * 商家对外公开回复里。
 */
export function redactPublicMessage(text: string, floor: number | undefined): string {
  if (floor === undefined || floor <= 0) return text;
  return text.split(String(floor)).join("[private-floor]");
}
