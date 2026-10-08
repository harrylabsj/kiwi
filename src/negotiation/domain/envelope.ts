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
 * KNP/1.0 Negotiation Envelope（子规范 §8，基线 §13）。
 *
 * digest 按 §19.2 计算：clone 后移除 `digest` 自身与 transport signature 字段，
 * RFC 8785 JCS 规范化 + SHA-256，hex 小写并加 `sha256:` 前缀。
 * protocol_version 只认 1.0，未知版本 fail-closed（§5 / §33-6）。
 * actor 仅 buyer|merchant；system/内部事件不得冒充商业角色（§8.1）。
 */

import { contentDigest } from "../jcs.js";
import {
  KNP_PROTOCOL_VERSION,
  NegotiationValidationError,
  requireDigest,
  requireEnum,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireObject,
  requireString,
  schemaError,
} from "./common.js";
import { validateIdentifier } from "./identifiers.js";
import { KNP_ACTIONS, validatePayloadForAction } from "./objects.js";
import type { NegotiationAction, NegotiationActor, NegotiationPayload } from "./objects.js";

// review 2-5：移除本地 transport-signature 字段剔除表——KNP §19.2 第 7 条
// 明文「MUST NOT invent a local signature-field stripping list inside the KNP
// envelope」：传输签名活在 envelope 之外。此前这四个名字若作为业务内容出现
// 会被静默排除在 digest 之外；合法 envelope 本就不携带它们（validateEnvelope
// 重建时丢弃未知字段），digest 不受影响，携带方现在 fail-closed 被拒。

export type EnvelopeContent = Omit<NegotiationEnvelope, "digest">;

export interface NegotiationEnvelope {
  capability: string;
  protocol_version: typeof KNP_PROTOCOL_VERSION;
  negotiation_id: string;
  exchange_id: string;
  message_id: string;
  in_reply_to?: string;
  actor: NegotiationActor;
  action: NegotiationAction;
  created_at: string;
  payload: NegotiationPayload;
  public_message?: string;
  digest: string;
}

/**
 * 计算 envelope digest（§19.2）：移除 digest 自身与 transport signature 字段，
 * 其余字段 JCS 规范化 + SHA-256。JCS 排序键且跳过 undefined，因此字段顺序
 * 无关、可选字段缺省不影响摘要。
 */
export function computeEnvelopeDigest(input: object): string {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key === "digest") continue;
    clean[key] = (input as Record<string, unknown>)[key];
  }
  return contentDigest(clean);
}

/**
 * 对未签名字段计算 digest 并返回完整 envelope。
 *
 * 命名说明（基线 §19 / §31）：本函数只做内容寻址 digest（JCS + SHA-256），
 * 不做任何密码学签名。KNP/1.0 envelope 的 digest 是完整性/防篡改校验；
 * signature 属于 transport 层且 §19.2 显式从 digest 输入中排除——digest 与
 * signature 是两种性质，故不命名为 sign*。
 */
export function finalizeEnvelope(fields: EnvelopeContent): NegotiationEnvelope {
  return { ...fields, digest: computeEnvelopeDigest(fields) };
}

/** 重算 digest 并与 wire digest 比较；false 表示被篡改或过期。 */
export function verifyEnvelopeDigest(envelope: NegotiationEnvelope): boolean {
  const { digest, ...rest } = envelope;
  // review 2-5/3-9（A316 校准）：digest 对 **raw wire 字节形状** 复核——重建
  // 会丢 schema 允许的嵌套扩展字段（如 Money/Quantity 的合法扩展），用重建
  // 对象复核会让合法扩展 envelope 被误判 digest 不符。顶层未知键已被
  // validateEnvelope 显式拒绝，raw 复核不含未契约字段。
  return computeEnvelopeDigest(rest) === digest;
}

/** Validate the received object and its digest without dropping legal extensions. */
export function validateWireEnvelope(value: unknown): NegotiationEnvelope {
  validateEnvelope(value);
  const wire = value as NegotiationEnvelope;
  if (!verifyEnvelopeDigest(wire)) {
    throw schemaError("/digest", "envelope digest does not match the received content");
  }
  return wire;
}

/**
 * Envelope schema 校验。未知 protocol_version / actor 非 buyer|merchant /
 * action-payload 类型不匹配 / digest 格式错误均 fail-closed。
 * digest 内容一致性由 verifyEnvelopeDigest 单独校验。
 */
const ENVELOPE_TOP_LEVEL_FIELDS = new Set([
  "capability",
  "protocol_version",
  "negotiation_id",
  "exchange_id",
  "message_id",
  "in_reply_to",
  "actor",
  "action",
  "created_at",
  "payload",
  "public_message",
  "digest",
]);

export function validateEnvelope(value: unknown): NegotiationEnvelope {
  const obj = requireObject(value, "/");
  // review 2-5（A316 校准）：顶层契约 additionalProperties=false **显式执行**——
  // 未知顶层键直接 schema_invalid 拒绝，不靠重建静默丢字段（否则携 signature
  // 等业务同名字段的 envelope 沿用旧无该字段 digest 仍可通过管线）。合法
  // envelope 的 digest 校验因此与原文一致；携带方不再被静默豁免。
  for (const key of Object.keys(obj)) {
    if (!ENVELOPE_TOP_LEVEL_FIELDS.has(key)) {
      throw schemaError(
        `/${key}`,
        `unknown top-level envelope field "${key}" is not allowed (KNP §19.2: transport signatures live outside the envelope)`,
      );
    }
  }
  const capability = requireNonEmptyString(obj.capability, "/capability");
  const protocolVersion = requireNonEmptyString(obj.protocol_version, "/protocol_version");
  if (protocolVersion !== KNP_PROTOCOL_VERSION) {
    throw new NegotiationValidationError(
      "protocol_version_unsupported",
      `unsupported protocol_version ${protocolVersion}; this runtime implements ${KNP_PROTOCOL_VERSION}`,
      "/protocol_version",
    );
  }
  const negotiationId = validateIdentifier(obj.negotiation_id, "/negotiation_id");
  const exchangeId = validateIdentifier(obj.exchange_id, "/exchange_id");
  const messageId = validateIdentifier(obj.message_id, "/message_id");
  const inReplyTo =
    obj.in_reply_to === undefined ? undefined : validateIdentifier(obj.in_reply_to, "/in_reply_to");
  const actor = requireEnum(obj.actor, ["buyer", "merchant"] as const, "/actor");
  const action = requireEnum(obj.action, KNP_ACTIONS, "/action");
  const createdAt = requireIsoTimestamp(obj.created_at, "/created_at");
  const payload = validatePayloadForAction(action, obj.payload, "/payload");
  const publicMessage =
    obj.public_message === undefined
      ? undefined
      : requireString(obj.public_message, "/public_message");
  const digest = requireDigest(obj.digest, "/digest");

  // §14：clarification_response 必须通过 in_reply_to 引用被回答的澄清消息。
  if (action === "clarification_response" && inReplyTo === undefined) {
    throw schemaError("/in_reply_to", "clarification_response requires in_reply_to");
  }

  return {
    capability,
    protocol_version: KNP_PROTOCOL_VERSION,
    negotiation_id: negotiationId,
    exchange_id: exchangeId,
    message_id: messageId,
    in_reply_to: inReplyTo,
    actor,
    action,
    created_at: createdAt,
    payload,
    public_message: publicMessage,
    digest,
  };
}
