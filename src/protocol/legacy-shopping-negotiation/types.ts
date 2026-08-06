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
 * LegacyNegotiationAdapter — shopping.negotiation/0.1 ↔ KNP/1.0 转译结果类型
 * （基线 §35 Legacy Migration / 子规范 §32 Legacy shopping-cli Mapping）。
 *
 * 每条转译路径都必须返回结构化结果，禁止静默降级：
 *
 *   { translated, notes }          — 成功。notes 逐条记录所有「补默认值 /
 *                                     丢弃字段 / legacy-extension / identity」
 *                                     决策，调用方可见、可审计、绝不静默。
 *   { fail_closed: true, reason }  — 输入在目标协议中无法表达（受保护语义：
 *                                     conditions / expiry / identity /
 *                                    agreement），拒绝并说明原因。
 *   { requires_human: true, reason } — 输入超出目标协议表达能力（如 legacy
 *                                     escalate → 人工），转人工/fallback。
 *
 * 不变量 22（基线 §36）：Legacy Adapter 不得扩大权限 —— 本模块只做纯数据
 * 转译，不执行任何 side effect，也不把 legacy 消息提升为 KNP 更高权限语义
 * （如伪造 ConditionalOffer 条件、把 accept 变成订单/支付语义）。
 */

import type { TermSet } from "../../negotiation/domain/common.js";
import type { NegotiationActor } from "../../negotiation/domain/objects.js";

// ---------------------------------------------------------------------------
// 转译结果
// ---------------------------------------------------------------------------

export type TranslationNote =
  | { kind: "mapped"; path: string; detail: string }
  | { kind: "default"; path: string; detail: string }
  | { kind: "dropped"; path: string; detail: string }
  | { kind: "extension"; path: string; detail: string }
  | { kind: "identity"; path: string; detail: string };

export type TranslationResult<T> =
  | { translated: T; notes: TranslationNote[] }
  | { fail_closed: true; reason: string }
  | { requires_human: true; reason: string };

export function translated<T>(value: T, notes: TranslationNote[]): TranslationResult<T> {
  return { translated: value, notes };
}

export function failClosed(reason: string): TranslationResult<never> {
  return { fail_closed: true, reason };
}

export function requiresHuman(reason: string): TranslationResult<never> {
  return { requires_human: true, reason };
}

export function isTranslated<T>(r: TranslationResult<T>): r is { translated: T; notes: TranslationNote[] } {
  return "translated" in r;
}

// ---------------------------------------------------------------------------
// 转译上下文
// ---------------------------------------------------------------------------

/**
 * legacy → KNP 方向所需的上下文。legacy decision/message 不携带 actor、
 * capability、created_at；这些由调用方（运行时的传输/身份层）提供，缺省填
 * 默认值并记录 note。offer 引用解析是 KNP accept/counter 的 terms_digest /
 * responding_to_offer_id 的前置条件，无法解析即 fail-closed。
 */
export interface LegacyToKnpContext {
  /** KNP 能力标识（子规范 §4.4）。 */
  capability: string;
  /** legacy 传输层绑定的 actor 身份（子规范 §8.1 / §33-1）。 */
  actor: NegotiationActor;
  /** envelope.created_at（RFC 3339）；缺省用适配器时钟，记录 note。 */
  created_at?: string;
  /** 当前产品 sku（legacy ask → KNP inquiry subject 用）。 */
  current_sku?: string;
  /** 解析 legacy accept 所接受的 offer terms，用于计算 §15 terms_digest。 */
  resolveAcceptedTerms?: (conversationId: string, inReplyToMessageId: number) => TermSet | null;
}

/** legacy 消息转译上下文：消息本身不携带 negotiation_id / capability / in_reply_to。 */
export interface LegacyMessageContext extends LegacyToKnpContext {
  conversation_id: string;
  /**
   * 该消息回复的目标（KNP in_reply_to）；`msg_legacy_<int>` 形态。
   * counter/decline/accept 消息的目标/被接受 offer 引用依赖它，缺失即 fail-closed。
   */
  in_reply_to?: string;
}

/**
 * KNP → legacy 方向无需额外上下文：legacy decision 的网关派生字段
 * （retries_remaining、actor 等）不属于转译范围 —— KNP 侧的 actor 语义通过
 * note 显式交给传输层断言（identity，绝不静默丢），其余 KNP-only 字段逐条
 * 记录为 dropped note。
 */
