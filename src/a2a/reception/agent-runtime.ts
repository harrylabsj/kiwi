/**
 * 接待 Pi 运行时（M2）：受控工具循环。
 *
 * 模型只通过四个工具工作：
 *   search_products        → 本店公开候选
 *   get_commercial_facts   → 服务端事实快照引用（价格/库存/交期）
 *   propose_need_patch     → 本轮需求增量（待服务端合并）
 *   propose_reply          → 类型化回复计划（终态）
 *
 * 红线：
 *  - 模型拿不到价格/交期字面值以外的写能力；所有金额经 fact ref 由发布器渲染；
 *  - 工具参数与模型输出都按不可信处理；schema 之外直接拒绝；
 *  - propose_reply 之后不再接受工具调用；超时/异常返回 undefined，调用方回退
 *    确定性接待路径。
 */

import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentToolResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, TSchema } from "@earendil-works/pi-ai";

import type { MerchantPolicy } from "../../config/profile.js";
import type { AttemptBudgetHooks } from "../server/inquiry-interpreter.js";
import {
  canonicalUnitToken,
  multiplyQuantitySafe,
  resolveUnitConversion,
  unitConversionPolicy,
} from "../unit-alias.js";
import type { ReceptionProductSource } from "./engine.js";
import { factRevision, type InMemoryFactRegistry } from "./publish.js";
import type {
  ReceptionBlock,
  ReceptionNeed,
  ReceptionResponsePlan,
} from "./types.js";

export const TOOL_SEARCH_PRODUCTS = "search_products";
export const TOOL_COMPARE_PRODUCTS = "compare_products";
export const TOOL_GET_COMMERCIAL_FACTS = "get_commercial_facts";
export const TOOL_PROPOSE_NEED_PATCH = "propose_need_patch";
export const TOOL_PROPOSE_REPLY = "propose_reply";

const RECEPTION_TOOL_ALLOWLIST: readonly string[] = [
  TOOL_SEARCH_PRODUCTS,
  TOOL_COMPARE_PRODUCTS,
  TOOL_GET_COMMERCIAL_FACTS,
  TOOL_PROPOSE_NEED_PATCH,
  TOOL_PROPOSE_REPLY,
];

const BLOCK_KINDS = new Set([
  "acknowledge_need",
  "ask_clarification",
  "show_commercial_terms",
  "recommend_option",
  "request_human_help",
  "next_step",
]);

export interface ReceptionAgentInput {
  merchantId: string;
  identity: string;
  contextId: string;
  text: string;
  previousNeed?: ReceptionNeed;
  registry: InMemoryFactRegistry;
  now: string;
}

export interface ReceptionAgentMetrics {
  steps: number;
  toolCalls: Record<string, number>;
  usage: { input: number; output: number; total: number };
  quotaRejected?: boolean;
}

export interface ReceptionAgentResult {
  plan: ReceptionResponsePlan;
  need?: Partial<
    Pick<
      ReceptionNeed,
      "sku" | "quantity" | "unit" | "pendingSkus" | "inputQuantity" | "inputUnit"
    >
  >;
  metrics: ReceptionAgentMetrics;
}

export interface ReceptionAgentRuntime {
  run(input: ReceptionAgentInput): Promise<ReceptionAgentResult | undefined>;
}

export interface PiReceptionRuntimeOptions {
  streamFn: StreamFn;
  model: Model<Api>;
  productSource?: ReceptionProductSource;
  policy?: () => MerchantPolicy | undefined;
  unitAliases?: Record<string, string>;
  unitPackageFactors?: Record<string, number>;
  /**
   * 商家的默认售卖单位；倍率只对以此为目标单位的商品源生效。
   * 旧调用形式不传时保留历史 factor 换算；新调用方应显式传入。
   */
  unitDefaultUnit?: string;
  maxSteps?: number;
  maxToolAttempts?: number;
  timeoutMs?: number;
  /** API key resolver for the real provider. */
  getApiKey?: () => string | undefined;
  systemPrompt?: string;
  /** 每次模型回合的预算 lease（§18）；拒绝时本轮降级确定性路径。 */
  budget?: AttemptBudgetHooks;
  /** 工具级指标出口（node 写入本地 metrics 文件）。 */
  onMetrics?: (metrics: ReceptionAgentMetrics) => void;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a Kiwi merchant reception agent serving one buyer at a time.",
  "Reply in Simplified Chinese (zh-CN) only. One product per conversation.",
  "Use search_products when the buyer has not named a SKU.",
  "Call get_commercial_facts for the chosen SKU and quantity. Never invent a price,",
  "stock count, delivery date or any commercial fact; only the facts tool is authoritative.",
  "When the request is ambiguous or a required field is missing, ask one short",
  "clarification question. When ready, call propose_reply with typed blocks:",
  "acknowledge_need, ask_clarification, show_commercial_terms (using the fact ref),",
  "request_human_help or next_step. You may use recommend_option with a fact ref and",
  "compared refs from compare_products; reasonCode must be lowest_public_price or in_stock.",
  "Never write free-form commercial text.",
].join(" ");

function toolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把模型提交的 blocks 限缩到白名单结构；引用仍由发布器校验。 */
export function sanitizeReceptionBlocks(value: unknown): ReceptionBlock[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) return undefined;
  const blocks: ReceptionBlock[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.kind !== "string" || !BLOCK_KINDS.has(item.kind)) {
      return undefined;
    }
    switch (item.kind) {
      case "acknowledge_need": {
        const sku = typeof item.sku === "string" && item.sku.trim() !== "" ? item.sku.trim() : undefined;
        const quantity =
          typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity > 0
            ? item.quantity
            : undefined;
        const unit = typeof item.unit === "string" && item.unit.trim() !== "" ? item.unit.trim() : undefined;
        blocks.push({
          kind: "acknowledge_need",
          ...(sku !== undefined ? { sku } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit !== undefined ? { unit } : {}),
        });
        break;
      }
      case "ask_clarification": {
        const reason = item.reason;
        if (
          reason !== "missing_sku" &&
          reason !== "unknown_sku" &&
          reason !== "non_chinese" &&
          reason !== "empty_message" &&
          reason !== "service_busy" &&
          reason !== "multiple_skus" &&
          reason !== "product_candidates"
        ) {
          return undefined;
        }
        const candidates = Array.isArray(item.candidates)
          ? item.candidates.filter((candidate): candidate is string => typeof candidate === "string").slice(0, 8)
          : undefined;
        blocks.push({
          kind: "ask_clarification",
          missing: ["sku"],
          reason,
          ...(candidates !== undefined ? { candidates } : {}),
        });
        break;
      }
      case "show_commercial_terms": {
        const ref = item.ref;
        if (
          !isObject(ref) ||
          typeof ref.sku !== "string" ||
          typeof ref.revision !== "string"
        ) {
          return undefined;
        }
        const topics = Array.isArray(item.topics)
          ? item.topics.filter(
              (topic): topic is "price" | "stock" | "delivery" =>
                topic === "price" || topic === "stock" || topic === "delivery",
            )
          : undefined;
        blocks.push({
          kind: "show_commercial_terms",
          ref: { sku: ref.sku, revision: ref.revision },
          ...(topics !== undefined && topics.length > 0 ? { topics } : {}),
        });
        break;
      }
      case "recommend_option": {
        const ref = item.ref;
        if (!isObject(ref) || typeof ref.sku !== "string" || typeof ref.revision !== "string") {
          return undefined;
        }
        const comparedRefs = Array.isArray(item.comparedRefs)
          ? item.comparedRefs
              .filter(
                (candidate): candidate is { sku: string; revision: string } =>
                  isObject(candidate) &&
                  typeof candidate.sku === "string" &&
                  typeof candidate.revision === "string",
              )
              .slice(0, 3)
          : undefined;
        const reasonCode = item.reasonCode;
        if (reasonCode !== "lowest_public_price" && reasonCode !== "in_stock") {
          return undefined;
        }
        blocks.push({
          kind: "recommend_option",
          ref: { sku: ref.sku, revision: ref.revision },
          ...(comparedRefs !== undefined && comparedRefs.length > 0 ? { comparedRefs } : {}),
          reasonCode,
        });
        break;
      }
      case "request_human_help": {
        if (item.topic !== "price_below_public_bound") return undefined;
        const buyerTargetPrice =
          typeof item.buyerTargetPrice === "number" && Number.isFinite(item.buyerTargetPrice)
            ? item.buyerTargetPrice
            : undefined;
        const currency = typeof item.currency === "string" ? item.currency : undefined;
        blocks.push({
          kind: "request_human_help",
          topic: "price_below_public_bound",
          ...(buyerTargetPrice !== undefined ? { buyerTargetPrice } : {}),
          ...(currency !== undefined ? { currency } : {}),
        });
        break;
      }
      case "next_step": {
        if (item.action !== "send_rfq") return undefined;
        blocks.push({ kind: "next_step", action: "send_rfq" });
        break;
      }
    }
  }
  return blocks;
}

function policyFloorMinor(
  policy: MerchantPolicy | undefined,
  sku: string,
): number | undefined {
  const floor = policy?.price_floors?.[sku] ?? policy?.min_unit_price_private;
  if (typeof floor !== "number" || !Number.isFinite(floor)) return undefined;
  return Math.round(floor * 100);
}

function deliveryBefore(policy: MerchantPolicy | undefined, now: string): string | undefined {
  const days = policy?.delivery_lead_days;
  if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
  const base = Date.parse(now);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + days * 86_400_000).toISOString();
}

export function createPiReceptionRuntime(
  options: PiReceptionRuntimeOptions,
): ReceptionAgentRuntime {
  const unitPolicy = unitConversionPolicy({
    aliases: options.unitAliases,
    packageFactors: options.unitPackageFactors,
    ...(options.unitDefaultUnit !== undefined ? { defaultUnit: options.unitDefaultUnit } : {}),
  });
  return {
    async run(input) {
      const policy = options.policy?.();
      let plan: ReceptionResponsePlan | undefined;
      let needPatch: Partial<
        Pick<
          ReceptionNeed,
          "sku" | "quantity" | "unit" | "pendingSkus" | "inputQuantity" | "inputUnit"
        >
      > = {};
      interface FactUnitState {
        inputQuantity?: number;
        inputUnit?: string;
        quantity?: number;
        unit?: string;
        factor?: number;
      }
      const factUnits = new Map<string, FactUnitState>();
      const rejectedFactUnits = new Map<string, { inputQuantity?: number; inputUnit?: string }>();
      let steps = 0;
      let toolAttempts = 0;
      let timedOut = false;

      const guard = async (
        context: BeforeToolCallContext,
      ): Promise<BeforeToolCallResult | undefined> => {
        if (!RECEPTION_TOOL_ALLOWLIST.includes(context.toolCall.name)) {
          return { block: true, reason: "tool_not_allowed" };
        }
        if (plan !== undefined) {
          return { block: true, reason: "reply_already_proposed" };
        }
        toolAttempts += 1;
        if (toolAttempts > (options.maxToolAttempts ?? 12)) {
          return { block: true, reason: "tool_budget_exhausted" };
        }
        const serialized = JSON.stringify(context.toolCall.arguments ?? {});
        if (serialized.length > 8_000) {
          return { block: true, reason: "arguments_too_large" };
        }
        return undefined;
      };

      const tools: AgentTool<TSchema, unknown>[] = [
        {
          name: TOOL_SEARCH_PRODUCTS,
          label: "Search products",
          description: "Search this merchant's public products by the buyer's words.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            const query = isObject(args) && typeof args.query === "string" ? args.query : "";
            if (options.productSource?.searchProducts === undefined) {
              return toolResult(JSON.stringify({ candidates: [], note: "search_not_configured" }));
            }
            const candidates = await options.productSource.searchProducts(query).catch(() => []);
            return toolResult(
              JSON.stringify({
                candidates: candidates.slice(0, 5).map((candidate) => ({
                  sku: candidate.sku,
                  ...(candidate.title !== undefined ? { title: candidate.title } : {}),
                  price: candidate.price,
                  currency: candidate.currency,
                  ...(candidate.stock !== undefined ? { stock: candidate.stock } : {}),
                })),
              }),
            );
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_COMPARE_PRODUCTS,
          label: "Compare products",
          description:
            "Read public price, stock and delivery facts for up to three SKUs so you can compare them.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              skus: { type: "array" },
            },
            required: ["skus"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            const rawSkus =
              isObject(args) && Array.isArray(args.skus) ? args.skus : [];
            const skus = rawSkus
              .filter((sku): sku is string => typeof sku === "string")
              .map((sku) => sku.trim())
              .filter((sku) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sku))
              .slice(0, 3);
            if (skus.length === 0 || options.productSource === undefined) {
              return toolResult(JSON.stringify({ products: [] }));
            }
            const products = [];
            for (const sku of skus) {
              try {
                const product = await options.productSource.getProduct(sku);
                if (product.valid_until !== undefined) {
                  const until = Date.parse(product.valid_until);
                  if (!Number.isFinite(until) || until <= Date.parse(input.now)) {
                    products.push({ sku, error: "facts_stale" });
                    continue;
                  }
                }
                const floorMinor = policyFloorMinor(policy, sku);
                const listPrice =
                  floorMinor !== undefined && Math.round(product.price * 100) < floorMinor
                    ? undefined
                    : product.price;
                const delivery = deliveryBefore(policy, input.now);
                const facts = {
                  ...(listPrice !== undefined
                    ? { listPrice, currency: product.currency }
                    : {}),
                  ...(product.stock !== undefined
                    ? { stockAvailable: product.stock > 0 }
                    : {}),
                  ...(delivery !== undefined ? { deliveryBefore: delivery } : {}),
                  ...(product.tax_included !== undefined
                    ? { taxIncluded: product.tax_included }
                    : {}),
                  ...(product.shipping_included !== undefined
                    ? { shippingIncluded: product.shipping_included }
                    : {}),
                };
                const base = {
                  merchantId: input.merchantId,
                  sku,
                  visibility: "public" as const,
                  issuedAt: input.now,
                  ...(product.valid_until !== undefined ? { expiresAt: product.valid_until } : {}),
                  facts,
                };
                const ref = input.registry.register({
                  ...base,
                  revision: factRevision(base),
                });
                products.push({
                  sku,
                  ref,
                  ...(listPrice !== undefined
                    ? { listPrice, currency: product.currency }
                    : {}),
                  ...(product.stock !== undefined ? { stock: product.stock } : {}),
                  ...(product.unit !== undefined ? { unit: product.unit } : {}),
                });
              } catch {
                products.push({ sku, error: "unknown_sku" });
              }
            }
            return toolResult(JSON.stringify({ products }));
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_GET_COMMERCIAL_FACTS,
          label: "Get commercial facts",
          description:
            "Read the authoritative price, stock and delivery facts for one SKU and quantity.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              sku: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              unit: { type: "string" },
            },
            required: ["sku"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            const sku = isObject(args) && typeof args.sku === "string" ? args.sku.trim() : "";
            const quantity =
              isObject(args) &&
              typeof args.quantity === "number" &&
              Number.isSafeInteger(args.quantity) &&
              args.quantity > 0
                ? args.quantity
                : undefined;
            const requestedUnit =
              isObject(args) && typeof args.unit === "string" && args.unit.trim() !== ""
                ? args.unit.trim()
                : undefined;
            if (sku === "" || options.productSource === undefined) {
              return toolResult(JSON.stringify({ error: "unknown_sku" }));
            }
            let product;
            try {
              product = await options.productSource.getProduct(sku);
            } catch {
              return toolResult(JSON.stringify({ error: "unknown_sku" }));
            }
            // AC13：过期事实不得进入回复或审批。
            if (product.valid_until !== undefined) {
              const until = Date.parse(product.valid_until);
              if (!Number.isFinite(until) || until <= Date.parse(input.now)) {
                return toolResult(JSON.stringify({ error: "facts_stale" }));
              }
            }
            // AC06：商品源单位与请求同义时始终 1:1；包装倍率只对 default_unit
            // 目标生效，其他情况或别名冲突一律安全拒绝，不猜倍率。
            let unit = requestedUnit;
            let effectiveQuantity = quantity;
            let factFactor: number | undefined;
            if (product.unit !== undefined && requestedUnit !== undefined) {
              const resolution = resolveUnitConversion(unitPolicy, product.unit, requestedUnit);
              if (resolution.kind === "factor") {
                if (quantity === undefined) {
                  rejectedFactUnits.set(sku, { inputUnit: requestedUnit });
                  return toolResult(JSON.stringify({ error: "missing_quantity" }));
                }
                const convertedQuantity = multiplyQuantitySafe(quantity, resolution.factor);
                if (convertedQuantity === undefined) {
                  rejectedFactUnits.set(sku, { inputQuantity: quantity, inputUnit: requestedUnit });
                  return toolResult(JSON.stringify({ error: "quantity_overflow" }));
                }
                effectiveQuantity = convertedQuantity;
                unit = product.unit;
                factFactor = resolution.factor;
              } else if (resolution.kind === "identity" || resolution.kind === "alias") {
                unit = product.unit;
              } else {
                rejectedFactUnits.set(sku, { inputQuantity: quantity, inputUnit: requestedUnit });
                return toolResult(
                  JSON.stringify({
                    error: "unit_mismatch",
                    supported_unit: product.unit,
                  }),
                );
              }
            }
            if (factFactor !== undefined && effectiveQuantity !== undefined && unit !== undefined &&
                quantity !== undefined && requestedUnit !== undefined) {
              factUnits.set(sku, {
                inputQuantity: quantity,
                inputUnit: requestedUnit,
                quantity: effectiveQuantity,
                unit,
                factor: factFactor,
              });
              rejectedFactUnits.delete(sku);
            } else if (effectiveQuantity !== undefined || unit !== undefined) {
              factUnits.set(sku, {
                ...(effectiveQuantity !== undefined ? { quantity: effectiveQuantity } : {}),
                ...(unit !== undefined ? { unit } : {}),
              });
              rejectedFactUnits.delete(sku);
            }
            const floorMinor = policyFloorMinor(policy, sku);
            const listPrice =
              floorMinor !== undefined && Math.round(product.price * 100) < floorMinor
                ? undefined
                : product.price;
            const stockAvailable =
              product.stock === undefined
                ? undefined
                : effectiveQuantity !== undefined
                  ? product.stock >= effectiveQuantity
                  : product.stock > 0;
            const delivery = deliveryBefore(policy, input.now);
            const facts = {
              ...(listPrice !== undefined
                ? { listPrice, currency: product.currency }
                : {}),
              ...(stockAvailable !== undefined ? { stockAvailable } : {}),
              ...(delivery !== undefined ? { deliveryBefore: delivery } : {}),
              ...(product.tax_included !== undefined
                ? { taxIncluded: product.tax_included }
                : {}),
              ...(product.shipping_included !== undefined
                ? { shippingIncluded: product.shipping_included }
                : {}),
            };
            const base = {
              merchantId: input.merchantId,
              sku,
              visibility: "public" as const,
              issuedAt: input.now,
              facts,
            };
            const ref = input.registry.register({
              ...base,
              revision: factRevision(base),
            });
            return toolResult(
              JSON.stringify({
                ref,
                facts,
                ...(unit !== undefined ? { unit } : product.unit !== undefined ? { unit: product.unit } : {}),
                ...(effectiveQuantity !== undefined ? { quantity: effectiveQuantity } : {}),
                note: "Only these facts may appear in show_commercial_terms.",
              }),
            );
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_PROPOSE_NEED_PATCH,
          label: "Propose need patch",
          description: "Record the product, quantity and unit the buyer has confirmed so far.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              sku: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              unit: { type: "string" },
            },
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            if (!isObject(args)) return toolResult(JSON.stringify({ error: "invalid_patch" }));
            const sku = typeof args.sku === "string" && args.sku.trim() !== "" ? args.sku.trim() : undefined;
            const quantity =
              typeof args.quantity === "number" &&
              Number.isSafeInteger(args.quantity) &&
              args.quantity > 0
                ? args.quantity
                : undefined;
            const unit = typeof args.unit === "string" && args.unit.trim() !== "" ? args.unit.trim() : undefined;
            const effectiveSku = sku ?? needPatch.sku;
            const rejected = effectiveSku !== undefined ? rejectedFactUnits.get(effectiveSku) : undefined;
            if (rejected !== undefined) {
              return toolResult(JSON.stringify({ error: "need_patch_conflict" }));
            }
            const conversion = effectiveSku !== undefined ? factUnits.get(effectiveSku) : undefined;
            if (conversion?.factor !== undefined) {
              const inputMatches =
                quantity === conversion.inputQuantity &&
                unit !== undefined &&
                conversion.inputUnit !== undefined &&
                canonicalUnitToken(unit) === canonicalUnitToken(conversion.inputUnit);
              const effectiveMatches =
                quantity === conversion.quantity &&
                unit !== undefined &&
                conversion.unit !== undefined &&
                canonicalUnitToken(unit) === canonicalUnitToken(conversion.unit);
              const omitted = quantity === undefined && unit === undefined;
              if (!omitted && !inputMatches && !effectiveMatches) {
                return toolResult(JSON.stringify({ error: "need_patch_conflict" }));
              }
              if (
                conversion.quantity === undefined ||
                conversion.unit === undefined ||
                conversion.inputQuantity === undefined ||
                conversion.inputUnit === undefined
              ) {
                return toolResult(JSON.stringify({ error: "need_patch_conflict" }));
              }
              needPatch = {
                ...needPatch,
                sku: effectiveSku,
                quantity: conversion.quantity,
                unit: conversion.unit,
                inputQuantity: conversion.inputQuantity,
                inputUnit: conversion.inputUnit,
              };
              return toolResult(JSON.stringify({ accepted: true }));
            }
            needPatch = {
              ...needPatch,
              ...(effectiveSku !== undefined ? { sku: effectiveSku } : {}),
              ...(quantity !== undefined ? { quantity } : {}),
              ...(unit !== undefined ? { unit } : {}),
            };
            return toolResult(JSON.stringify({ accepted: true }));
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_PROPOSE_REPLY,
          label: "Propose reply",
          description: "Submit the final typed response plan. Ends the turn.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              blocks: { type: "array" },
            },
            required: ["blocks"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            if (!isObject(args)) return toolResult(JSON.stringify({ accepted: false, error: "invalid_plan" }));
            const blocks = sanitizeReceptionBlocks(args.blocks);
            if (blocks === undefined) {
              return toolResult(JSON.stringify({ accepted: false, error: "invalid_blocks" }));
            }
            const normalizedBlocks = blocks.map((block) => {
              if (
                block.kind !== "acknowledge_need" ||
                needPatch.sku === undefined ||
                (block.sku !== undefined && block.sku !== needPatch.sku)
              ) {
                return block;
              }
              const conversion = factUnits.get(needPatch.sku);
              return {
                ...block,
                sku: needPatch.sku,
                ...(needPatch.quantity !== undefined ? { quantity: needPatch.quantity } : {}),
                ...(needPatch.unit !== undefined ? { unit: needPatch.unit } : {}),
                ...(conversion?.factor !== undefined &&
                needPatch.inputQuantity !== undefined &&
                needPatch.inputUnit !== undefined
                  ? {
                      convertedFrom: {
                        quantity: needPatch.inputQuantity,
                        unit: needPatch.inputUnit,
                        factor: conversion.factor,
                      },
                    }
                  : {}),
              };
            });
            plan = { locale: "zh-CN", blocks: normalizedBlocks };
            return toolResult(JSON.stringify({ accepted: true }));
          },
        } as AgentTool<TSchema, unknown>,
      ];

      const agent = new Agent({
        streamFn: options.streamFn,
        initialState: {
          systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
          model: options.model,
          tools,
        },
        convertToLlm: (messages) => messages as Message[],
        toolExecution: "sequential",
        beforeToolCall: guard,
        ...(options.getApiKey !== undefined ? { getApiKey: options.getApiKey } : {}),
      });

      const maxSteps = options.maxSteps ?? 6;
      const metrics: ReceptionAgentMetrics = {
        steps: 0,
        toolCalls: {},
        usage: { input: 0, output: 0, total: 0 },
      };
      let activeLease: string | undefined;
      let lastSettledOutput = 0;
      let quotaRejected = false;

      agent.subscribe((event: AgentEvent) => {
        if (event.type === "turn_start") {
          if (options.budget !== undefined) {
            const begin = options.budget.begin();
            if ("rejected" in begin) {
              quotaRejected = true;
              options.budget.onRejected(begin.rejected);
              agent.abort();
              return undefined;
            }
            activeLease = begin.leaseId;
          }
          return undefined;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = event.message.usage;
          metrics.usage.input += usage.input;
          metrics.usage.output += usage.output;
          metrics.usage.total += usage.totalTokens;
          return undefined;
        }
        if (event.type === "tool_execution_start") {
          metrics.toolCalls[event.toolName] = (metrics.toolCalls[event.toolName] ?? 0) + 1;
          return undefined;
        }
        if (event.type === "turn_end") {
          steps += 1;
          metrics.steps = steps;
          if (activeLease !== undefined && options.budget !== undefined) {
            const delta = Math.max(0, metrics.usage.output - lastSettledOutput);
            options.budget.settle(activeLease, delta);
            lastSettledOutput = metrics.usage.output;
            activeLease = undefined;
          }
          if (steps >= maxSteps) {
            timedOut = true;
            agent.abort();
          }
        }
        return undefined;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, options.timeoutMs ?? 30_000);
      try {
        await agent.prompt(JSON.stringify({
          buyer_message: input.text,
          previous_need: input.previousNeed ?? {},
          locale: "zh-CN",
        }));
        await agent.waitForIdle();
      } catch {
        // 回退确定性路径；未结算的预算 lease 在 finally 按未知用量保留。
      } finally {
        clearTimeout(timer);
        if (activeLease !== undefined && options.budget !== undefined) {
          options.budget.settle(activeLease, undefined);
          activeLease = undefined;
        }
      }

      if (quotaRejected) metrics.quotaRejected = true;
      options.onMetrics?.(metrics);
      if (plan === undefined || timedOut || quotaRejected) return undefined;
      return {
        plan,
        ...(Object.keys(needPatch).length > 0 ? { need: needPatch } : {}),
        metrics,
      };
    },
  };
}
