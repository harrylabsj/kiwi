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
 * 七类 merchant presentation 的 MCP Apps 资源映射（V2 阶段二）。
 *
 * V1 的 present_* 工具发内部 ui 事件（宿主不渲染等于丢失）；本模块把同一套
 * PresentationRegistry 组件映射为 MCP 资源：
 *   kiwi-merchant://presentation/<component>[?参数]
 *
 * 每个资源 read 返回两个 content：
 *   1. application/json — 结构化 payload（经 sanitizePresentationValue 既有脱敏）；
 *   2. text/plain — 等效文本摘要（宿主不支持 MCP Apps 时的降级，不丢关键字段）。
 *
 * 私密类内容（阈值/成本/底价）没有任何对应资源——私密面板走管理面接缝
 * （merchant-core readPrivateThresholds），不进工具结果与资源。
 */

import { createMerchantPresentationRegistry } from "../agent/merchant/merchant-presentations.js";
import { sanitizePresentationValue } from "../agent/presentation/sanitize.js";
import type { PresentationContext } from "../agent/presentation/types.js";

export const MERCHANT_RESOURCE_PREFIX = "kiwi-merchant://presentation/";

export interface MerchantResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: "application/json";
}

export interface MerchantResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/** 需要查询参数的资源（缺参数时 read 返回可读错误）。 */
const REQUIRED_QUERY: Record<string, { param: string; hint: string }> = {
  metrics: { param: "metric", hint: "?metric=<指标名>（如 contact_events）" },
  change_preview: { param: "candidate_id", hint: "?candidate_id=<候选 id>" },
  suggestions: { param: "items", hint: "?items=<建议1,建议2>（1–4 条，逗号分隔）" },
};

/** 等效文本摘要（降级路径；不丢关键字段：数量/金额/状态/时间）。 */
export function textSummary(component: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (component) {
    case "merchant_digest": {
      const snapshot = (p.snapshot ?? {}) as { alerts?: Record<string, number | null> };
      const alerts = snapshot.alerts ?? {};
      return [
        `${String(p.title ?? "经营摘要")}：进行中磋商 ${alerts.active_negotiations ?? "?"}，` +
          `人工待处理 ${alerts.human_reviews ?? "?"}，待审批 ${alerts.pending_actions ?? "?"}，` +
          `低库存 ${alerts.low_stock ?? "不可得"}`,
      ].join("");
    }
    case "metrics": {
      const points = Array.isArray(p.points) ? p.points.length : 0;
      return `指标 ${String(p.metric ?? "?")}：${points} 个数据点（${String(p.granularity ?? "day")} 粒度）`;
    }
    case "catalog": {
      const products = Array.isArray(p.products) ? p.products.length : 0;
      const health = (p.health ?? {}) as { total?: number; out_of_stock?: number | null };
      return `商品目录：${products} 个商品（总数 ${health.total ?? "?"}，缺货 ${health.out_of_stock ?? "不可得"}）`;
    }
    case "negotiations": {
      const rows = Array.isArray(p) ? p : [];
      return `磋商列表：${rows.length} 笔`;
    }
    case "human_review": {
      const reviews = Array.isArray(p.reviews) ? p.reviews.length : 0;
      return `人工处理队列：${reviews} 项`;
    }
    case "change_preview": {
      return `变更预览：${String(p.headline ?? "变更预览")}（candidate ${String(p.candidate_id ?? "?")}；展示不批准不执行）`;
    }
    case "suggestions": {
      const items = Array.isArray(p.suggestions) ? (p.suggestions as string[]) : [];
      return `下一步建议：${items.join("；")}`;
    }
    default:
      return JSON.stringify(payload);
  }
}

export function buildMerchantPresentationResources(deps: { context: PresentationContext }): {
  list: () => MerchantResourceDef[];
  read: (uri: string) => Promise<{ contents: MerchantResourceContent[] }>;
} {
  const registry = createMerchantPresentationRegistry();
  const defs: MerchantResourceDef[] = registry.list().map((c) => ({
    uri: `${MERCHANT_RESOURCE_PREFIX}${c.component}`,
    name: c.component,
    description: c.description,
    mimeType: "application/json",
  }));

  const read = async (uri: string): Promise<{ contents: MerchantResourceContent[] }> => {
    if (!uri.startsWith(MERCHANT_RESOURCE_PREFIX)) {
      throw new Error(`未知资源 ${uri}（前缀 ${MERCHANT_RESOURCE_PREFIX}）`);
    }
    const rest = uri.slice(MERCHANT_RESOURCE_PREFIX.length);
    const qIndex = rest.indexOf("?");
    const componentName = qIndex === -1 ? rest : rest.slice(0, qIndex);
    const query = new URLSearchParams(qIndex === -1 ? "" : rest.slice(qIndex + 1));
    const component = registry.list().find((c) => c.component === componentName);
    if (component === undefined) {
      throw new Error(`未知 presentation 资源 ${componentName}`);
    }
    // 参数化资源的必填查询参数
    const required = REQUIRED_QUERY[componentName];
    let input: Record<string, unknown> = {};
    if (required !== undefined) {
      const value = query.get(required.param);
      if (value === null || value === "") {
        throw new Error(`资源 ${componentName} 需要查询参数 ${required.hint}`);
      }
      input =
        componentName === "suggestions"
          ? {
              suggestions: value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s !== ""),
            }
          : { [required.param]: value };
    }
    // 可选通用参数（period/granularity/limit/status/headline/note）
    for (const key of ["period", "granularity", "status", "headline", "note"]) {
      const v = query.get(key);
      if (v !== null) input[key] = v;
    }
    const limit = query.get("limit");
    if (limit !== null && /^\d+$/.test(limit)) input.limit = Number(limit);

    const validated = component.validate(input);
    const payload = sanitizePresentationValue(await component.enrich(validated, deps.context));
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload),
        },
        {
          uri,
          mimeType: "text/plain",
          text: textSummary(componentName, payload),
        },
      ],
    };
  };

  return { list: () => defs, read };
}
