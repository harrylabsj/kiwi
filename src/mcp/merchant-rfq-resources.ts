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
 * RFQ 展示资源（设计 v0.1.1 §12.4）：ui://kiwi-rfq/case|quote|release。
 *
 *   - 每个资源 read 返回两个 content：application/json 结构化授权投影 +
 *     text/plain 等效文本摘要——宿主不支持 MCP Apps 时的降级路径不丢
 *     关键字段（数量/金额/状态/时间），阻断项与确认状态绝不静默丢弃。
 *   - UI 只显示 Core 返回的授权投影：payload 经 sanitizePresentationValue
 *     二次脱敏；确认凭证、审批 nonce、底价/成本没有对应资源。
 *   - 读资源需要 merchant:read scope（服务端逐次校验，与 merchant 展示
 *     资源同一机制）；release 资源不含确认凭证——批准仍只在可信管理页。
 */

import { sanitizePresentationValue } from "../agent/presentation/sanitize.js";
import type { MerchantRfqService, RfqCallContext } from "../merchant-core/rfq/service.js";
import { RfqError } from "../merchant-core/rfq/types.js";

export const RFQ_RESOURCE_PREFIX = "ui://kiwi-rfq/";

export interface RfqResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: "application/json";
}

export interface RfqResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

const REQUIRED_QUERY: Record<string, { param: string; hint: string }> = {
  case: { param: "case_id", hint: "?case_id=<询盘 id>" },
  quote: { param: "quote_id", hint: "?quote_id=<报价 id>&revision=<版本>" },
  release: { param: "release_id", hint: "?release_id=<发布 id>" },
};

const DEFS: RfqResourceDef[] = [
  {
    uri: `${RFQ_RESOURCE_PREFIX}case`,
    name: "case",
    description: "询盘当前需求、阻断项与报价版本列表（只读授权投影）。",
    mimeType: "application/json",
  },
  {
    uri: `${RFQ_RESOURCE_PREFIX}quote`,
    name: "quote",
    description: "一版报价的客户投影、生命周期事件与失效原因（只读）。",
    mimeType: "application/json",
  },
  {
    uri: `${RFQ_RESOURCE_PREFIX}release`,
    name: "release",
    description: "发布/批准/导出状态与客户投影（只读；不含确认凭证——批准走可信管理页）。",
    mimeType: "application/json",
  },
];

function money(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}￥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function caseSummary(payload: Record<string, unknown>): string {
  const kase = (payload.case ?? {}) as { case_id?: string; stage?: string };
  const blockers = (payload.blockers ?? []) as Array<{ field: string; reason: string }>;
  const quotes = (payload.quotes ?? []) as Array<{ status?: string }>;
  return (
    `询盘 ${kase.case_id ?? "?"}（${kase.stage ?? "?"}）：` +
    `阻断项 ${blockers.length}（${blockers.slice(0, 3).map((b) => b.reason).join("；") || "无"}），` +
    `报价版本 ${quotes.length}`
  );
}

function quoteSummary(payload: Record<string, unknown>): string {
  const projection = (payload.projection ?? {}) as {
    totals?: { gross_minor?: number };
    valid_until?: string;
    lines?: Array<{ line_id?: string; quantity?: number }>;
  };
  const status = String(payload.status ?? "?");
  const events = (payload.events ?? []) as Array<{ event?: string }>;
  return (
    `报价 ${String(payload.quote_id ?? "?")} v${String(payload.revision ?? "?")}（${status}）：` +
    `应付 ${money(Number(projection.totals?.gross_minor ?? 0))}，` +
    `${(projection.lines ?? []).length} 行，有效期至 ${projection.valid_until ?? "?"}，` +
    `事件 ${events.length}（最新 ${events[events.length - 1]?.event ?? "无"}）` +
    (payload.invalid_reason !== undefined ? `；失效原因：${String(payload.invalid_reason)}` : "")
  );
}

function releaseSummary(payload: Record<string, unknown>): string {
  const release = (payload.release ?? {}) as { release_id?: string; status?: string; quote_id?: string };
  const quote = (payload.quote ?? {}) as { status?: string };
  return (
    `发布 ${String(release.release_id ?? "?")}（${release.status ?? "?"}）：` +
    `报价 ${release.quote_id ?? "?"} 当前 ${quote.status ?? "?"}；` +
    `批准与下载在可信管理页（/admin/rfq）——本资源不含确认凭证`
  );
}

export function buildRfqPresentationResources(deps: {
  rfq: MerchantRfqService;
  callContext: () => RfqCallContext;
}): {
  list: () => RfqResourceDef[];
  read: (uri: string) => Promise<{ contents: RfqResourceContent[] }>;
} {
  const read = async (uri: string): Promise<{ contents: RfqResourceContent[] }> => {
    if (!uri.startsWith(RFQ_RESOURCE_PREFIX)) {
      throw new RfqError("not_found", `未知资源 ${uri}（前缀 ${RFQ_RESOURCE_PREFIX}）`);
    }
    const rest = uri.slice(RFQ_RESOURCE_PREFIX.length);
    const qIndex = rest.indexOf("?");
    const name = qIndex === -1 ? rest : rest.slice(0, qIndex);
    const query = new URLSearchParams(qIndex === -1 ? "" : rest.slice(qIndex + 1));
    if (DEFS.every((d) => d.name !== name)) {
      throw new RfqError("not_found", `未知 RFQ 展示资源 ${name}`);
    }
    const required = REQUIRED_QUERY[name];
    if (required !== undefined) {
      const value = query.get(required.param);
      if (value === null || value === "") {
        throw new RfqError("validation", `资源 ${name} 需要查询参数 ${required.hint}`);
      }
    }
    const ctx = deps.callContext();
    let payload: Record<string, unknown>;
    let summary: string;
    if (name === "case") {
      payload = (await deps.rfq.getCase(ctx, query.get("case_id") ?? "")) as unknown as Record<string, unknown>;
      summary = caseSummary(payload);
    } else if (name === "quote") {
      const revisionRaw = query.get("revision");
      if (revisionRaw === null || !/^\d+$/.test(revisionRaw)) {
        throw new RfqError("validation", `资源 quote 需要查询参数 revision=<正整数>`);
      }
      payload = (await deps.rfq.getQuoteView(
        ctx,
        query.get("quote_id") ?? "",
        Number(revisionRaw),
      )) as unknown as Record<string, unknown>;
      summary = quoteSummary(payload);
    } else {
      payload = deps.rfq.adminReleaseDetail(
        ctx,
        query.get("release_id") ?? "",
      ) as unknown as Record<string, unknown>;
      summary = releaseSummary(payload);
    }
    const sanitized = sanitizePresentationValue(payload) as Record<string, unknown>;
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(sanitized) },
        { uri, mimeType: "text/plain", text: summary },
      ],
    };
  };
  return { list: () => DEFS.map((d) => ({ ...d })), read };
}
