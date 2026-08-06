/**
 * 入站 A2A Message 严格解析 + KNP envelope 提取（子规范 §24.3）。
 *
 * 所有入站内容视为 untrusted（基线 §4.5 / §36-12）：对象形状、字段类型、Part
 * kind、Data Part 结构全部 fail-closed。解析失败抛 schema_invalid
 * （ServerProtocolError，errors.ts），绝不静默容错。
 *
 * KNP 约定（§24.3）：结构化 Data Part 的 `knp_envelope` 键携带 Negotiation
 * Envelope；文本 Part 可省略。存在多个 Data Part 时取第一个含 `knp_envelope`
 * 的 Part；同值重复允许，冲突（多个不同 envelope）fail-closed。
 */

import type { A2AMessage, A2APart } from "../client/index.js";
import { schemaInvalid } from "./errors.js";

/** Data Part 中携带 KNP envelope 的键名（§24.3 约定）。 */
export const KNP_ENVELOPE_DATA_KEY = "knp_envelope";

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaInvalid(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw schemaInvalid(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireObject(value, path);
}

function parsePart(value: unknown, path: string): A2APart {
  const obj = requireObject(value, path);
  const kind = requireNonEmptyString(obj.kind, `${path}/kind`);
  if (kind === "text") {
    if (typeof obj.text !== "string") throw schemaInvalid(`${path}/text must be a string`);
    return { kind: "text", text: obj.text };
  }
  if (kind === "data") {
    return { kind: "data", data: requireObject(obj.data, `${path}/data`) };
  }
  throw schemaInvalid(`${path}/kind is unsupported: ${kind}`);
}

/** 严格解析入站 A2A Message（untrusted）。失败抛 schema_invalid。 */
export function parseInboundMessage(value: unknown): A2AMessage {
  const obj = requireObject(value, "params/message");
  const role = obj.role;
  if (role !== "agent" && role !== "user") {
    throw schemaInvalid("params/message/role must be agent or user");
  }
  if (!Array.isArray(obj.parts) || obj.parts.length === 0) {
    throw schemaInvalid("params/message/parts must be a non-empty array");
  }
  const message: A2AMessage = {
    role,
    parts: obj.parts.map((part, index) => parsePart(part, `params/message/parts/${index}`)),
    messageId: requireNonEmptyString(obj.messageId, "params/message/messageId"),
  };
  if (obj.taskId !== undefined) {
    message.taskId = requireNonEmptyString(obj.taskId, "params/message/taskId");
  }
  if (obj.contextId !== undefined) {
    message.contextId = requireNonEmptyString(obj.contextId, "params/message/contextId");
  }
  const metadata = optionalRecord(obj.metadata, "params/message/metadata");
  if (metadata !== undefined) message.metadata = metadata;
  return message;
}

/**
 * 从 A2A Message 的 Data Part 提取 KNP envelope（raw，未校验）。
 * 无 Data Part 携带 `knp_envelope` 或值非对象 → schema_invalid（§24.3）。
 * 多个不同 envelope → schema_invalid（冲突 fail-closed）。
 */
export function extractKnpEnvelope(message: A2AMessage): Record<string, unknown> {
  const envelopes: Record<string, unknown>[] = [];
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const data = part.data;
    if (!(KNP_ENVELOPE_DATA_KEY in data)) continue;
    const value = data[KNP_ENVELOPE_DATA_KEY];
    const envelope = requireObject(value, `data.${KNP_ENVELOPE_DATA_KEY}`);
    envelopes.push(envelope);
  }
  if (envelopes.length === 0) {
    throw schemaInvalid(
      `message has no data part carrying "${KNP_ENVELOPE_DATA_KEY}" (KNP envelope, §24.3)`,
    );
  }
  const first = envelopes[0];
  if (first === undefined) {
    throw schemaInvalid("KNP envelope data part is empty");
  }
  for (const other of envelopes.slice(1)) {
    if (JSON.stringify(other) !== JSON.stringify(first)) {
      throw schemaInvalid("multiple conflicting KNP envelopes in message data parts");
    }
  }
  return first;
}
