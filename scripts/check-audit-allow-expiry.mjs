#!/usr/bin/env node
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
 * npm audit 豁免到期提醒（审查 P2）。
 *
 * `build-inputs/shipping-audit-allow.json` 的条目全部带到期日；发布门在到期
 * 后自动失效。本脚本在 `verify` 中提前一周给出重审提醒，避免发布当天才发现
 * 豁免已过期：
 *   - 任一 entry 已过期 → exit 1（豁免不再有效，必须重审）；
 *   - 7 天内到期 → stderr 警告，exit 0（不阻塞日常开发）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WARN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const allow = JSON.parse(
  readFileSync(path.join(ROOT, "build-inputs/shipping-audit-allow.json"), "utf8"),
);
const entries = Array.isArray(allow.entries) ? allow.entries : [];
const now = Date.now();
let expired = 0;
let expiring = 0;

for (const entry of entries) {
  const expires = String(entry.expires_at ?? "");
  const at = Date.parse(expires);
  if (!Number.isFinite(at)) {
    process.stderr.write(
      `[audit-allow] ${entry.id ?? entry.package ?? "unknown"}: missing/invalid expires_at\n`,
    );
    expired += 1;
    continue;
  }
  if (at <= now) {
    process.stderr.write(
      `[audit-allow] EXPIRED ${entry.id ?? entry.package} (${expires}): re-review the advisory before releasing\n`,
    );
    expired += 1;
  } else if (at - now <= WARN_DAYS * DAY_MS) {
    process.stderr.write(
      `[audit-allow] expiring soon ${entry.id ?? entry.package} at ${expires}: schedule a re-review\n`,
    );
    expiring += 1;
  }
}

if (expired > 0) {
  process.stderr.write(
    `[audit-allow] ${expired} expired entr${expired === 1 ? "y" : "ies"}; release is blocked until re-reviewed\n`,
  );
  process.exit(1);
}
if (expiring > 0) {
  process.stderr.write(`[audit-allow] ${expiring} entr${expiring === 1 ? "y" : "ies"} expire within ${WARN_DAYS} days\n`);
}
process.stdout.write(`audit allowlist ok (${entries.length} entries)\n`);
