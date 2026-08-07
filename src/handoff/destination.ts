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
 * KTH/0.1 —— destination_type 词表（单一来源，KTH rev0.3 §7）。
 *
 * ⚠️ 禁止平行词表：kiwi-catalog 搜索词表、shopping-cli Handoff 元数据、Agent
 * 公开发现元数据一律从本模块 import（架构 rev1.4.1 §35A 一致性原则：
 * "destination vocabulary = KTH destination_type vocabulary"）。任何地方不得
 * 再发明 supports_* 之类的第二套命名。
 *
 * URL 类目的地的安全策略（HTTPS / redirect / anti-phishing）在 url-safety.ts
 * （WP-C2）实施；本模块只做结构校验（类型 + ref 形状 + payload 最小化约束）。
 */

import { requireNonEmptyString, requireObject, schemaError } from "../negotiation/domain/common.js";

/** KTH/0.1 目的地类型（rev0.3 §7；顺序即文档枚举顺序）。 */
export const DESTINATION_TYPES = [
  "ucp_checkout",
  "ucp_order",
  "external_checkout_url",
  "merchant_checkout_session",
  "platform_deep_link",
  "buyer_erp_request",
  "procurement_request",
  "purchase_order_draft",
  "quote_document",
  "merchant_contact",
  "sales_handoff",
] as const;

export type DestinationType = (typeof DESTINATION_TYPES)[number];

/** URL 承载类目的地：ref 必须是 http(s) URL（scheme 白名单在 url-safety.ts）。 */
const URL_DESTINATION_TYPES: ReadonlySet<DestinationType> = new Set<DestinationType>([
  "external_checkout_url",
  "platform_deep_link",
]);

/** 会话/引用类目的地：ref 是 opaque 会话或引用 id。 */
const SESSION_DESTINATION_TYPES: ReadonlySet<DestinationType> = new Set<DestinationType>([
  "ucp_checkout",
  "ucp_order",
  "merchant_checkout_session",
]);

/** 文档/联系人类目的地：ref 是 opaque 引用（PO/quote 草稿、联系方式）。 */
const DOCUMENT_DESTINATION_TYPES: ReadonlySet<DestinationType> = new Set<DestinationType>([
  "buyer_erp_request",
  "procurement_request",
  "purchase_order_draft",
  "quote_document",
  "merchant_contact",
  "sales_handoff",
]);

/**
 * 归一化后的目的地（不可变）。`payload` 必须是最小化、schema-validated、
 * 非秘密数据（KTH rev0.3 §5/§11.3）。
 */
export interface Destination {
  readonly type: DestinationType;
  /** 目的地引用：URL 类为 http(s) URL，会话/文档类为 opaque ref。 */
  readonly ref: string;
  /** 最小化目的地载荷（可选）。 */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** 校验是否为目标类型已知值。 */
export function isDestinationType(value: unknown): value is DestinationType {
  return typeof value === "string" && (DESTINATION_TYPES as readonly string[]).includes(value);
}

/**
 * 结构校验一个目的地。URL 类要求 http(s)；其余要求非空 opaque ref。
 * 安全策略（scheme 白名单 / redirect / phishing）在 url-safety.ts 执行。
 * 校验失败抛 schemaError（fail-closed）。
 */
export function validateDestination(input: unknown, path = "destination"): Destination {
  const obj = requireObject(input, path);
  const typeRaw = obj.type;
  if (!isDestinationType(typeRaw)) {
    throw schemaError(
      `${path}/type`,
      `unknown destination type (must be one of: ${DESTINATION_TYPES.join(", ")})`,
    );
  }
  const type = typeRaw;
  const ref = requireNonEmptyString(obj.ref, `${path}/ref`);
  if (URL_DESTINATION_TYPES.has(type) && !/^https?:\/\/\S+$/.test(ref)) {
    throw schemaError(`${path}/ref`, `destination type "${type}" requires an http(s) URL ref`);
  }
  if (SESSION_DESTINATION_TYPES.has(type) || DOCUMENT_DESTINATION_TYPES.has(type)) {
    if (/^https?:\/\//.test(ref) && !URL_DESTINATION_TYPES.has(type)) {
      // 会话/文档类目的地不禁止 URL（如 buyer_erp_request 的 ERP 端点引用），
      // 但不会被当作可点击链接处理——ref 语义由 destination type 决定。
    }
  }
  let payload: Readonly<Record<string, unknown>> | undefined;
  if (obj.payload !== undefined) {
    const payloadObj = requireObject(obj.payload, `${path}/payload`);
    payload = Object.freeze({ ...payloadObj });
  }
  return Object.freeze({ type, ref, ...(payload !== undefined ? { payload } : {}) }) as Destination;
}
