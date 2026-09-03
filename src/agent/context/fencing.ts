/**
 * Model-visible external data fencing.
 *
 * Protocol payloads are verified before this module is called. This module
 * only creates a sanitized copy for prompts/UI and must never mutate the
 * payload used for signatures, digests, or ledger events.
 */

import { inspect } from "node:util";

export type ExternalSource =
  | "a2a_message"
  | "catalog"
  | "merchant_api"
  | "buyer_message"
  | "human_review"
  | "ucp_profile"
  | "metric";

export const DEFAULT_FENCE_MAX_CHARS = 12_000;
export const DEFAULT_MEMORY_VALUE_MAX_CHARS = 4_000;

const TURN_MARKER = /(\r?\n\s*\r?\n\s*)(human|assistant|system|user)\s*:/gi;
const LEADING_TURN_MARKER = /^\s*(human|assistant|system|user)\s*:/i;
const SPECIAL_TOKEN = /<\s*\/?\s*(?:(?:[a-z][\w.-]{0,30}:)?(?:transcript|conversation|function_calls|function_results|invoke|tool_use|tool_result|system|human|user|assistant)|[a-z][\w.-]{0,30}:(?:parameter|result))\b[^<>]{0,160}>|<\|[^|<>\r\n]{1,64}\|>/gi;

const INVISIBLE_RANGES: readonly [number, number][] = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function removeInvisibleAndControl(input: string): string {
  return Array.from(input, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isInvisible(codePoint)) return "";
    if (
      codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return " ";
    }
    return character;
  }).join("");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Sanitize one untrusted string without changing the caller's value. */
export function sanitizeModelText(
  input: string,
  options: { maxChars?: number; marker?: string } = {},
): string {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_FENCE_MAX_CHARS);
  const marker = options.marker ?? "";
  let text = removeInvisibleAndControl(input.normalize("NFKC"));
  // Repeat because removing one token can expose another adjacent token.
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(SPECIAL_TOKEN, " ").replace(TURN_MARKER, "$1");
    const cleaned = next.replace(LEADING_TURN_MARKER, "");
    if (cleaned === text) break;
    text = cleaned;
  }
  if (marker !== "") {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<\\s*/?\\s*${escaped}(?![A-Za-z0-9_])(?:[^<>]*>)?`, "gi"), " ");
  }
  return truncate(text, maxChars);
}

function modelValue(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload) ?? "null";
  } catch {
    return inspect(payload, { depth: 5, breakLength: 120 });
  }
}

/** True when a value carries one of Kiwi's model-visible external-data fences. */
export function containsExternalFence(value: unknown): boolean {
  if (typeof value === "string") return /<\s*\/?\s*kiwi_(?:external|memory)_data(?:_|\b)/i.test(value);
  if (Array.isArray(value)) return value.some(containsExternalFence);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsExternalFence);
  }
  return false;
}

/** Sanitize every string in a JSON-like value without mutating the source. */
export function sanitizeModelValue(
  value: unknown,
  options: { maxChars?: number; depth?: number; marker?: string } = {},
): unknown {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MEMORY_VALUE_MAX_CHARS);
  const maxDepth = Math.max(1, Math.min(options.depth ?? 8, 20));
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > maxDepth) return "[nested value omitted]";
    if (typeof entry === "string") return sanitizeModelText(entry, { maxChars, marker: options.marker });
    if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, item]) => [
          sanitizeModelText(key, { maxChars: 128, marker: options.marker }),
          visit(item, depth + 1),
        ]),
      );
    }
    return entry;
  };
  const sanitized = visit(value, 0);
  const serialized = modelValue(sanitized);
  if (serialized.length <= maxChars) return sanitized;
  return sanitizeModelText(serialized, { maxChars, marker: options.marker });
}

/** Wrap sanitized data in a fixed, source-specific fence. */
export function fenceModelPayload(
  source: ExternalSource,
  payload: unknown,
  options: { maxChars?: number } = {},
): string {
  const label = `kiwi_external_data_${source}`;
  const marker = `<${label}>`;
  const body = sanitizeModelText(modelValue(payload), {
    maxChars: options.maxChars ?? DEFAULT_FENCE_MAX_CHARS,
    marker: label,
  });
  return `${marker}\n${body}\n</${label}>`;
}
