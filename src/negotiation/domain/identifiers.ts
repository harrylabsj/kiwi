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
 * KNP/1.0 Identifier 模型（子规范 §6，基线 §9）。
 *
 * 所有 identifier 对对手方 opaque（§6）。生成器产出 `<前缀>_<uuidv7>`：
 * 前缀便于人读日志（neg_/ex_/msg_/off_/agr_），uuidv7 保证跨重启稳定、
 * 碰撞抵抗且按创建时间可排序（§6 SHOULD）。
 *
 * 校验器只做 opaque 字符串检查——协议不强制前缀，但 MUST 非空、无前后
 * 空白、无控制字符、长度受限。A2A `contextId` / `taskId` 同样是 opaque
 * 字符串（§6.6/§6.7），复用同一规则。
 */

import { randomBytes } from "node:crypto";
import {
  NegotiationValidationError,
  requireNonEmptyString,
  requireObject,
  schemaError,
} from "./common.js";

export const IDENTIFIER_PREFIX = {
  negotiation: "neg",
  exchange: "ex",
  message: "msg",
  offer: "off",
  agreement: "agr",
  // v0.7.0 KTH（KTH rev0.3 §5/§6）
  handoff_candidate: "hcan",
  handoff: "hnd",
} as const;
export type IdentifierKind = keyof typeof IDENTIFIER_PREFIX;

const MAX_IDENTIFIER_LENGTH = 256;

let lastMs = -1;
let seq = 0;

/**
 * UUIDv7：48 位毫秒时间戳 + version(7)/variant(10) 位 + 随机尾（§6 建议可排序）。
 * rand_a 作 12 位每毫秒计数器，保证同毫秒内也单调不减（时钟回拨时锚定 lastMs）。
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) ms = lastMs + 1;
  } else {
    seq = 0;
  }
  lastMs = ms;
  bytes[0] = Math.floor(ms / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ms / 0x100000000) & 0xff;
  bytes[2] = Math.floor(ms / 0x1000000) & 0xff;
  bytes[3] = Math.floor(ms / 0x10000) & 0xff;
  bytes[4] = Math.floor(ms / 0x100) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((seq >> 8) & 0x0f) | 0x70;
  bytes[7] = seq & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 生成带前缀的 identifier（`neg_<uuidv7>` 等）。 */
export function generateId(kind: IdentifierKind): string {
  return `${IDENTIFIER_PREFIX[kind]}_${uuidv7()}`;
}

export const newNegotiationId = (): string => generateId("negotiation");
export const newExchangeId = (): string => generateId("exchange");
export const newMessageId = (): string => generateId("message");
export const newOfferId = (): string => generateId("offer");
export const newAgreementId = (): string => generateId("agreement");

/** opaque identifier 校验：非空、无前后空白、无控制字符、长度受限。 */
export function validateIdentifier(value: unknown, path: string): string {
  const s = requireNonEmptyString(value, path);
  if (s.length > MAX_IDENTIFIER_LENGTH) {
    throw schemaError(path, `${path} exceeds ${MAX_IDENTIFIER_LENGTH} characters`);
  }
  if (s !== s.trim()) {
    throw schemaError(path, `${path} must not have surrounding whitespace`);
  }
  const hasControl = Array.from(s).some(
    (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
  );
  if (hasControl) {
    throw schemaError(path, `${path} must not contain control characters`);
  }
  return s;
}

/** A2A `contextId`：对 Kiwi opaque（§6.6）。 */
export function validateContextId(value: unknown, path: string): string {
  return validateIdentifier(value, path);
}

/** A2A `taskId`：transport/session 状态，不得替代 negotiation_id（§6.7）。 */
export function validateTaskId(value: unknown, path: string): string {
  return validateIdentifier(value, path);
}

// ---------------------------------------------------------------------------
// TargetRef（基线 §9.7 / 子规范 §17.1）
// ---------------------------------------------------------------------------

/**
 * 扁平 target 引用：target_message_id 是通用引用；target_offer_id 仅用于
 * Offer-like 目标。两者同时存在时 MUST 解析到同一 Ledger 对象，否则
 * state_conflict。
 */
export interface TargetRef {
  target_message_id: string;
  target_offer_id?: string;
}

export function validateTargetRef(value: unknown, path: string): TargetRef {
  const obj = requireObject(value, path);
  const ref: TargetRef = {
    target_message_id: validateIdentifier(obj.target_message_id, `${path}/target_message_id`),
  };
  if (obj.target_offer_id !== undefined) {
    ref.target_offer_id = validateIdentifier(obj.target_offer_id, `${path}/target_offer_id`);
  }
  return ref;
}

export interface TargetRefResolver {
  /** 消息 id → 其承载的 offer_id；未知返回 null。 */
  resolveMessageOffer(messageId: string): string | null;
  /** offer id → 承载它的 message_id；未知返回 null。 */
  resolveOfferMessage(offerId: string): string | null;
}

/**
 * 用 Ledger 视图核对 TargetRef 的一致性。只有双方都能解析且发生矛盾时才抛
 * state_conflict（§9.7）；单侧未知不属于这里可判定的矛盾，留给引擎按
 * offer_unknown 等状态错误处理。
 */
export function checkTargetRefAgreement(target: TargetRef, resolver: TargetRefResolver): void {
  if (target.target_offer_id === undefined) return;
  const messageOffer = resolver.resolveMessageOffer(target.target_message_id);
  if (messageOffer !== null && messageOffer !== target.target_offer_id) {
    throw new NegotiationValidationError(
      "state_conflict",
      `target_message_id ${target.target_message_id} resolves to offer ${messageOffer}, not ${target.target_offer_id}`,
      "target_message_id",
    );
  }
  const offerMessage = resolver.resolveOfferMessage(target.target_offer_id);
  if (offerMessage !== null && offerMessage !== target.target_message_id) {
    throw new NegotiationValidationError(
      "state_conflict",
      `target_offer_id ${target.target_offer_id} resolves to message ${offerMessage}, not ${target.target_message_id}`,
      "target_offer_id",
    );
  }
}
