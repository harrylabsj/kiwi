/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { sanitizeModelText } from "../context/fencing.js";

const SENSITIVE_KEY = /authorization|bearer|token|secret|password|credential|private[_-]?key|vault/i;

/**
 * Keep presentation payloads structured while applying the same external
 * content hygiene as model context. This intentionally caps arrays/objects
 * locally so one hostile field cannot turn a card into an unbounded document.
 */
export function sanitizePresentationValue(
  value: unknown,
  options: { maxChars?: number; maxItems?: number; depth?: number } = {},
): unknown {
  const maxChars = Math.max(1, options.maxChars ?? 2_000);
  const maxItems = Math.max(1, Math.min(options.maxItems ?? 50, 100));
  const maxDepth = Math.max(1, Math.min(options.depth ?? 8, 12));
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > maxDepth) return "[nested value omitted]";
    if (typeof entry === "string") return sanitizeModelText(entry, { maxChars });
    if (Array.isArray(entry)) return entry.slice(0, maxItems).map((item) => visit(item, depth + 1));
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .slice(0, maxItems)
          .map(([key, item]) => [
            sanitizeModelText(key, { maxChars: 128 }),
            SENSITIVE_KEY.test(key) ? "[redacted]" : visit(item, depth + 1),
          ]),
      );
    }
    return entry;
  };
  return visit(value, 0);
}
