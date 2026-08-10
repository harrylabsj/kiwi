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
 * RFC 8785 JCS (JSON Canonicalization Scheme) — minimal deterministic
 * serialization used for content addressing (docs §17 "Digest 与幂等").
 *
 * Pure and deterministic: no eval/exec, no random or time-dependent output.
 * Equal inputs always serialize to the same byte string; object key order in
 * the input is irrelevant (keys are sorted by UTF-16 code unit), which is
 * what makes the digest stable across retries and restarts.
 *
 * The repo previously used a hand-rolled `stableStringify` (sorted keys, JSON
 * values) for idempotency hashes. JCS is stricter about number serialization
 * (`-0`, exponent normalization) and rejects non-finite numbers instead of
 * silently hashing them. New content-addressed values (candidate_digest) MUST
 * go through this module; the legacy helper is left untouched for v0.3 stores.
 */

import { createHash } from "node:crypto";

/**
 * RFC 8785 §3.2.2.2 number serialization: shortest round-trip form with a
 * normalized exponent (lowercase 'e', no leading '+' or exponent zeros), `-0`
 * preserved, NaN/Infinity rejected.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`JCS: cannot canonicalize non-finite number ${value}`);
  }
  if (Object.is(value, -0)) return "-0";
  // Number#toString produces the shortest round-trip representation, which
  // RFC 8785 requires. Only the exponent needs normalization.
  let serialized = String(value);
  const exponent = /^(.+?)[eE]([+-]?)(\d+)$/.exec(serialized);
  if (exponent !== null) {
    const mantissa = exponent[1] ?? serialized;
    const sign = exponent[2] === "-" ? "-" : "";
    const digits = (exponent[3] ?? "").replace(/^0+/, "");
    serialized = `${mantissa}e${sign}${digits === "" ? "0" : digits}`;
  }
  return serialized;
}

/**
 * RFC 8785 §3.2.2.1 字符串序列化：只转义 quotation mark（0x0022）/
 * reverse solidus（0x005C）/ 控制字符（U+0000–U+001F）——`JSON.stringify`
 * 已处理全部。
 *
 * **U+2028/U+2029 不转义**（审查修正，2026-08-10）：它们是 U+2000 段的非
 * 控制字符，RFC 8785 明确 "All Unicode characters may be placed within the
 * quotation marks except … control characters (U+0000 through U+001F)"，
 * ECMAScript JSON 序列化同样字面保留。此前实现把它们转义成 `\u2028/\u2029`
 * ——与符合规范的实现产生不同 digest，跨实现互操作断裂（错误不是字面输出，
 * 而是转义本身）。
 */
function canonicalString(value: string): string {
  return JSON.stringify(value);
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return canonicalString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((element) => {
            if (element === undefined) {
              throw new TypeError("JCS: array elements must not be undefined");
            }
            return canonicalValue(element);
          })
          .join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      // Undefined-valued keys are optional fields and are skipped, matching
      // the rest of the codebase; every other non-JSON value fails closed.
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((key) => `${canonicalString(key)}:${canonicalValue(record[key])}`).join(",")}}`;
    }
    default:
      // functions, symbols, bigint: not part of the JSON data model — fail
      // closed rather than producing a digest that hides the shape.
      throw new TypeError(`JCS: cannot canonicalize ${typeof value}`);
  }
}

/** RFC 8785 JCS canonical serialization of a JSON-compatible value. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value);
}

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Content-addressed digest of a structured value, `sha256:` prefixed. */
export function contentDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}
