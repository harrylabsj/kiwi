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
 * 两轨磋商适配器（V2 §5.2；阶段二）。
 *
 * Kiwi Merchant 同时存在两条磋商轨：
 *   - a2a：A2A/KNP 轨（Ledger 权威，相位机状态名 OPEN/OFFER_OPEN/…）；
 *   - shopping：shopping-cli 会话轨（conversation 状态名 waiting_merchant/…）。
 *
 * 统一列表：每条携带 source_protocol 与 source_id；详情保留各自协议的
 * 状态名（不抹平）。人工处理入口按来源路由——A2A 人审走 A2A 侧机制，
 * 绝不调 shopping-cli resolve-review；shopping 轨才走上游接口。
 */

import type { IncomingConsultation } from "../agent/merchant/types.js";
import type { A2aNegotiationRow } from "../merchant/workbench-service.js";

/** 磋商来源协议（两轨）。 */
export type NegotiationSourceProtocol = "a2a" | "shopping";

/** 统一磋商列表行（状态名保留各自协议口径，不抹平）。 */
export interface UnifiedNegotiationRow {
  source_protocol: NegotiationSourceProtocol;
  /** 轨道内 id：a2a = negotiation_id；shopping = conversation_id。 */
  source_id: string;
  /** 协议原生状态名（a2a 相位 / shopping 会话 status）。 */
  status: string;
  sku?: string;
  buyer?: string;
  updated_at: string;
  needs_human_review: boolean;
}

/** A2A 轨行 → 统一行。needsHumanReview 由调用方按轨道语义计算传入
 *  （A2A 侧权威口径在 intelligence 的 extractNegotiation：AWAITING_CLARIFICATION
 *  或「非终态且最后一条为买家入站等待商家回应」）。 */
export function fromA2aRow(
  row: A2aNegotiationRow,
  needsHumanReview: boolean,
): UnifiedNegotiationRow {
  return {
    source_protocol: "a2a",
    source_id: row.negotiation_id,
    status: row.phase,
    ...(row.sku !== "" ? { sku: row.sku } : {}),
    updated_at: row.recorded_at,
    needs_human_review: needsHumanReview,
  };
}

/** shopping 会话轨行 → 统一行。 */
export function fromShoppingConsultation(c: IncomingConsultation): UnifiedNegotiationRow {
  return {
    source_protocol: "shopping",
    source_id: c.conversation_id,
    status: c.status,
    ...(c.sku !== undefined ? { sku: c.sku } : {}),
    ...(c.buyer_id !== undefined ? { buyer: c.buyer_id } : {}),
    updated_at: c.last_message_at,
    needs_human_review: c.status === "human_required",
  };
}

/** 人工处理路由（V2 §5.2）：按来源返回处理通道，跨轨调用直接拒绝。 */
export function routeHumanReview(row: UnifiedNegotiationRow): "a2a" | "shopping" {
  return row.source_protocol;
}

/**
 * 路由守卫：对 A2A 来源的磋商调用 shopping 轨处理接口（resolve-review）是
 * 协议错误——fail-closed 抛错，绝不跨轨执行。
 */
export function assertReviewRoute(
  sourceProtocol: NegotiationSourceProtocol,
  channel: "a2a" | "shopping",
): void {
  if (sourceProtocol !== channel) {
    throw new Error(
      `人工处理路由错误：${sourceProtocol} 轨磋商不能走 ${channel} 通道` +
        "（A2A 人审走 A2A 侧机制，shopping 轨才走 shopping-cli resolve-review）",
    );
  }
}
