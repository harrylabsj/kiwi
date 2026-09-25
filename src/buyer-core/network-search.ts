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
 * Kiwi Network 查询状态词表（双来源搜索设计 v1.1 §7/§10/§17）。
 *
 * 双来源搜索要求两个来源的查询状态**各自独立、真实**：无匹配 / 查询失败 /
 * 超时 / 部分完成 / 未搜索必须可区分——只判断候选数组是否为空会把"目录不可达"
 * 误报成"没有匹配"。本模块是这些状态在 Buyer Core 的**单一来源**：MerchantIndex
 * 产出组件状态，service 汇总为 `network_search`，MCP/HTTP 原样透传；宿主不得
 * 另立平行词表（对照 `src/handoff/destination.ts` 的词表单一来源约定）。
 *
 * 互联网电商一路由宿主自己的检索/取页工具完成，本模块只描述 Kiwi Network。
 */

import { CatalogSourceError } from "../discovery/catalog-source/errors.js";

/** 来源查询状态（设计 §7 用户可见状态的机器表示）。 */
export const SOURCE_QUERY_STATUSES = [
  /** 已开始，尚未完成。后端一次性结果不产生该态，宿主可用于分步展示。 */
  "searching",
  /** 本次查询完成（覆盖完整），有或无结果由 result_state 区分。 */
  "completed",
  /** 已取得部分结果，其余范围未完成（含部分来源失败/超时/能力缺失）。 */
  "partial",
  /** 查询未能在配置时限内完成。 */
  "timeout",
  /** 出现错误，无法得出搜索结论。 */
  "error",
  /** 实际未执行：后端未接线，或该来源在当前部署不存在。 */
  "not_searched",
] as const;
export type SourceQueryStatus = (typeof SOURCE_QUERY_STATUSES)[number];

/**
 * 结果判定。只有查询范围完整且没有匹配时才可为 `no_match`；
 * 返回候选不等于已满足用户全部硬性条件（设计 §17）。
 */
export const NETWORK_RESULT_STATES = ["has_candidates", "no_match", "undetermined"] as const;
export type NetworkResultState = (typeof NETWORK_RESULT_STATES)[number];

/** Kiwi Network 内部来源组件（与 catalog 端点一一对应）。 */
export const NETWORK_SEARCH_COMPONENTS = ["listings", "agents", "merchant_publications"] as const;
export type NetworkSearchComponentName = (typeof NETWORK_SEARCH_COMPONENTS)[number];

/** 单个内部来源的查询状态。组件不产生 `searching`/`partial`（那是来源级汇总态）。 */
export interface NetworkSearchComponent {
  name: NetworkSearchComponentName;
  status: Extract<SourceQueryStatus, "completed" | "timeout" | "error" | "not_searched">;
  /**
   * 机器可读原因：失败时为 `CatalogSourceError.code`（如 `request_timeout`、
   * `endpoint_unavailable`），非类型化异常为 `unknown`。成功时不设置。
   */
  reason?: string;
}

/** 本次 Network 查询的结构化诊断（设计 §17 的 `network_search`）。 */
export interface NetworkSearchDiagnostics {
  source: "kiwi_network";
  status: SourceQueryStatus;
  result_state: NetworkResultState;
  /** 本次查询发起时间（RFC3339）。未实际搜索（`not_searched`）时不设置。 */
  searched_at?: string;
  /** 组件级状态；旧版/第三方索引无法提供时为 `[]`（此时 status 为保守判定）。 */
  components: NetworkSearchComponent[];
  /** 非致命降级说明（人类可读，供宿主如实转述）。 */
  notes: string[];
}

/**
 * 把来源失败映射为组件状态。超时与"能力不存在"必须与一般失败分开：
 * 前者是 `timeout`，后者是 `not_searched`（设计 §7「未搜索 = 能力不可用」），
 * 其余按 `error` 处理并保留错误码作为 reason——不从提示词文本猜错误类型。
 */
export function classifyComponentFailure(
  name: NetworkSearchComponentName,
  error: unknown,
): NetworkSearchComponent {
  const code = error instanceof CatalogSourceError ? error.code : undefined;
  if (code === "request_timeout") return { name, status: "timeout", reason: code };
  if (code === "endpoint_unavailable") return { name, status: "not_searched", reason: code };
  return { name, status: "error", reason: code ?? "unknown" };
}

/**
 * 汇总组件状态为来源级状态与结果判定（设计 §17 约定）：
 * - 全部组件 `completed` → `completed`；此时且仅此时可 `no_match`；
 * - 有任一组件完成、其余未完成 → `partial`（已取得部分结果，覆盖不完整）；
 * - 无组件完成：全部为超时 → `timeout`，其余 → `error`；
 * - 无组件被尝试（全部 `not_searched`）→ `not_searched`。
 */
export function summarizeNetworkSearch(input: {
  components: NetworkSearchComponent[];
  /** 本次合并后的候选数量（merchants.length）。 */
  candidateCount: number;
  searchedAt: string;
  notes: string[];
}): NetworkSearchDiagnostics {
  const { components, candidateCount, searchedAt, notes } = input;
  const attempted = components.filter((component) => component.status !== "not_searched");
  const completed = components.filter((component) => component.status === "completed");
  let status: SourceQueryStatus;
  if (components.length > 0 && completed.length === components.length) {
    status = "completed";
  } else if (completed.length > 0) {
    status = "partial";
  } else if (attempted.length === 0) {
    status = "not_searched";
  } else {
    status = attempted.every((component) => component.status === "timeout") ? "timeout" : "error";
  }
  const resultState: NetworkResultState =
    candidateCount > 0
      ? "has_candidates"
      : components.length > 0 && completed.length === components.length
        ? "no_match"
        : "undetermined";
  return {
    source: "kiwi_network",
    status,
    result_state: resultState,
    ...(status === "not_searched" ? {} : { searched_at: searchedAt }),
    components,
    notes,
  };
}

/** 后端未接线（MerchantIndex 未注入）：未搜索，不是无匹配、也不是失败。 */
export function notSearchedDiagnostics(): NetworkSearchDiagnostics {
  return {
    source: "kiwi_network",
    status: "not_searched",
    result_state: "undetermined",
    components: [],
    notes: [],
  };
}

/**
 * 搜索整体失败（索引抛错 / 目录不可达）：明确为查询失败或超时，不得表述为无匹配。
 * 组件级状态不可得（索引未走到组件汇总就抛出），故 components 为空。
 */
export function failedSearchDiagnostics(input: {
  searchedAt: string;
  error: unknown;
  note: string;
}): NetworkSearchDiagnostics {
  const timedOut =
    input.error instanceof CatalogSourceError && input.error.code === "request_timeout";
  return {
    source: "kiwi_network",
    status: timedOut ? "timeout" : "error",
    result_state: "undetermined",
    searched_at: input.searchedAt,
    components: [],
    notes: [input.note],
  };
}

/**
 * 旧版/第三方 MerchantIndex 只能给出 `merchants` + `note`（实例级、可能被并发
 * 覆盖），无法区分组件级状态。保守口径（设计 §19 旧运行时兼容期）：
 * - 有候选 → `has_candidates`；带降级说明时来源标 `partial`；
 * - 空结果 → **不判 `no_match`**（无法确定是确实没匹配还是覆盖不完整），标
 *   `partial + undetermined`。
 */
export function legacySearchDiagnostics(input: {
  candidateCount: number;
  searchedAt: string;
  notes: string[];
}): NetworkSearchDiagnostics {
  const hasCandidates = input.candidateCount > 0;
  return {
    source: "kiwi_network",
    status: hasCandidates && input.notes.length === 0 ? "completed" : "partial",
    result_state: hasCandidates ? "has_candidates" : "undetermined",
    searched_at: input.searchedAt,
    components: [],
    notes: input.notes,
  };
}
