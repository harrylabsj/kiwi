/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { sanitizeModelText } from "../context/fencing.js";
import { publicCandidatePreview } from "./merchant-enrichment.js";
import { PresentationRegistry } from "../presentation/registry.js";
import type { PresentationContext, PresentationComponent } from "../presentation/types.js";

const MAX_PERIOD = /^(?:[1-9]|[1-8][0-9]|90)d$/;

function objectInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("presentation input must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxChars) throw new Error(`${field} must be a string of at most ${maxChars} characters`);
  return sanitizeModelText(value, { maxChars });
}

function requireText(value: unknown, field: string, maxChars: number): string {
  const text = optionalText(value, field, maxChars);
  if (text === undefined || text === "") throw new Error(`${field} must be a non-empty string`);
  return text;
}

function intelligence(context: PresentationContext) {
  if (context.intelligence === undefined) throw new Error("merchant intelligence is unavailable");
  return context.intelligence;
}

interface DigestInput { title?: string; period?: string }
interface MetricsInput { metric: string; period?: string; granularity?: "day" | "week" | "month" }
interface CatalogInput { limit?: number }
interface NegotiationsInput { status?: "active" | "agreement" | "all"; limit?: number }
interface HumanReviewInput { limit?: number }
interface ChangePreviewInput { candidate_id: string; headline?: string; note?: string }
interface SuggestionsInput { suggestions: string[] }

function boundedLimit(value: unknown, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("limit must be an integer between 1 and 50");
  }
  return value;
}

function parseDigest(value: unknown): DigestInput {
  const v = objectInput(value);
  const period = optionalText(v.period, "period", 20);
  if (period !== undefined && !MAX_PERIOD.test(period)) throw new Error("period must use 1d–90d syntax");
  return { ...(optionalText(v.title, "title", 80) ? { title: optionalText(v.title, "title", 80) } : {}), ...(period ? { period } : {}) };
}

function parseMetrics(value: unknown): MetricsInput {
  const v = objectInput(value);
  const metric = requireText(v.metric, "metric", 80);
  const period = optionalText(v.period, "period", 20);
  if (period !== undefined && !MAX_PERIOD.test(period)) throw new Error("period must use 1d–90d syntax");
  const granularity = v.granularity === undefined ? "day" : v.granularity;
  if (granularity !== "day" && granularity !== "week" && granularity !== "month") throw new Error("invalid granularity");
  return { metric, ...(period ? { period } : {}), granularity };
}

function parseCatalog(value: unknown): CatalogInput {
  return { limit: boundedLimit(objectInput(value).limit, 20) };
}

function parseNegotiations(value: unknown): NegotiationsInput {
  const v = objectInput(value);
  const status = v.status === undefined ? "all" : v.status;
  if (status !== "active" && status !== "agreement" && status !== "all") throw new Error("invalid negotiation status");
  return { status, limit: boundedLimit(v.limit, 20) };
}

function parseHumanReview(value: unknown): HumanReviewInput {
  return { limit: boundedLimit(objectInput(value).limit, 20) };
}

function parseChangePreview(value: unknown): ChangePreviewInput {
  const v = objectInput(value);
  return {
    candidate_id: requireText(v.candidate_id, "candidate_id", 200),
    ...(optionalText(v.headline, "headline", 120) ? { headline: optionalText(v.headline, "headline", 120) } : {}),
    ...(optionalText(v.note, "note", 200) ? { note: optionalText(v.note, "note", 200) } : {}),
  };
}

function parseSuggestions(value: unknown): SuggestionsInput {
  const raw = objectInput(value).suggestions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) throw new Error("suggestions must contain 1 to 4 items");
  return { suggestions: raw.map((item) => requireText(item, "suggestion", 80)) };
}

function component<I, O>(input: PresentationComponent<I, O>): PresentationComponent<I, O> {
  return input;
}

export function createMerchantPresentationRegistry(): PresentationRegistry {
  const registry = new PresentationRegistry();
  registry
    .register(component<DigestInput, unknown>({
      toolName: "present_merchant_digest",
      component: "merchant_digest",
      label: "展示经营摘要",
      description: "展示商家经营摘要、告警、A2A 磋商和待审批事项。真实数据由服务端读取和补全。",
      inputSchema: { type: "object", properties: { title: { type: "string", maxLength: 80 }, period: { type: "string", pattern: "^(?:[1-9]|[1-8][0-9]|90)d$" } }, additionalProperties: false },
      validate: parseDigest,
      enrich: async (input, context) => {
        const backend = intelligence(context);
        const max = context.profile.merchant_experience?.max_presentation_items ?? 12;
        const [snapshot, negotiations, pending] = await Promise.all([
          backend.getBusinessSnapshot({ merchant_id: context.principalId, ...(input.period ? { period: input.period } : {}) }),
          backend.getNegotiationDigest({ merchant_id: context.principalId, status: "active", limit: max }),
          backend.getPendingActions(),
        ]);
        return { title: input.title ?? "经营摘要", snapshot, negotiations: negotiations.slice(0, max), pending_actions: pending.slice(0, max) };
      },
    }))
    .register(component<MetricsInput, unknown>({
      toolName: "present_metrics",
      component: "metrics",
      label: "展示经营指标",
      description: "展示一项按日、周或月聚合的经营指标；数据和限制说明由服务端补全。",
      inputSchema: { type: "object", properties: { metric: { type: "string", maxLength: 80 }, period: { type: "string", pattern: "^(?:[1-9]|[1-8][0-9]|90)d$" }, granularity: { type: "string", enum: ["day", "week", "month"] } }, required: ["metric"], additionalProperties: false },
      validate: parseMetrics,
      enrich: (input, context) => intelligence(context).queryMetric({ merchant_id: context.principalId, ...input }),
    }))
    .register(component<CatalogInput, unknown>({
      toolName: "present_catalog",
      component: "catalog",
      label: "展示商品目录",
      description: "展示商家商品目录及库存健康摘要；真实商品数据由服务端读取和补全。",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
      validate: parseCatalog,
      enrich: async (input, context) => {
        const [products, health] = await Promise.all([
          context.merchantClient.listProducts(context.principalId),
          intelligence(context).getCatalogHealth({ merchant_id: context.principalId }),
        ]);
        return { health, products: products.slice(0, input.limit) };
      },
    }))
    .register(component<NegotiationsInput, unknown>({
      toolName: "present_negotiations",
      component: "negotiations",
      label: "展示磋商列表",
      description: "展示当前 A2A 磋商列表；状态、报价和时间由 Ledger 服务端补全。",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["active", "agreement", "all"] }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
      validate: parseNegotiations,
      enrich: (input, context) => intelligence(context).getNegotiationDigest({ merchant_id: context.principalId, ...input }),
    }))
    .register(component<HumanReviewInput, unknown>({
      toolName: "present_human_review",
      component: "human_review",
      label: "展示人工审核",
      description: "展示需要人工处理的事项；审核原因和实体由服务端读取和补全。",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
      validate: parseHumanReview,
      enrich: async (input, context) => ({ reviews: (await context.merchantClient.getHumanReviewQueue(context.principalId)).slice(0, input.limit) }),
    }))
    .register(component<ChangePreviewInput, unknown>({
      toolName: "present_change_preview",
      component: "change_preview",
      label: "展示变更预览",
      description: "展示一个 WriteApprovalCandidate 的前后差异。展示不会批准或执行变更。",
      inputSchema: { type: "object", properties: { candidate_id: { type: "string" }, headline: { type: "string", maxLength: 120 }, note: { type: "string", maxLength: 200 } }, required: ["candidate_id"], additionalProperties: false },
      validate: parseChangePreview,
      enrich: async (input, context) => {
        const preview = context.intelligence === undefined
          ? publicCandidatePreview(context.approvals.get(input.candidate_id))
          : await context.intelligence.getCandidatePreview({
              principal_id: context.principalId,
              candidate_id: input.candidate_id,
            });
        if (preview === undefined) throw new Error("未找到当前 principal 的候选操作");
        return { ...preview, headline: input.headline ?? "变更预览", note: input.note ?? "" };
      },
    }))
    .register(component<SuggestionsInput, unknown>({
      toolName: "present_suggestions",
      component: "suggestions",
      label: "展示下一步建议",
      description: "展示 1–4 个下一步建议。建议只影响 UI，不改变权限或业务状态。",
      inputSchema: { type: "object", properties: { suggestions: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 80 } } }, required: ["suggestions"], additionalProperties: false },
      validate: parseSuggestions,
      enrich: async (input) => ({ suggestions: input.suggestions }),
    }));
  return registry;
}
