/**
 * `kiwi logs` — bounded, redacted tail of manifest-owned log files.
 *
 * Only log files referenced by this instance's manifests are read, and only
 * after path containment is proven (they must live inside the instance
 * logs/ dir). Every line is labeled with its process role. Redaction
 * removes bearer/token/API-key-like secrets and private-policy numeric
 * lines; env values and private thresholds are never printed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { manifestPathFor, readManifest } from "./manifest.js";
import { loadInstance } from "./manage.js";
import { ProfileError } from "../config/profile.js";
import { MANAGED_ROLES, type ManagedRole } from "./stack-config.js";

export const DEFAULT_LOG_LINES = 100;
export const MAX_LOG_LINES = 10_000;

/** Parse and bound the --lines option. Throws on anything invalid. */
export function parseLogLines(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LOG_LINES;
  if (!/^\d+$/.test(value)) {
    throw new ProfileError(`--lines must be a positive integer (got "${value}")`);
  }
  const n = Number(value);
  if (n < 1 || n > MAX_LOG_LINES) {
    throw new ProfileError(`--lines must be between 1 and ${MAX_LOG_LINES} (got ${n})`);
  }
  return n;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+\S+/gi, "Bearer [REDACTED]"],
  [/shopping_(merchant|buyer|agent|admin)_[A-Za-z0-9_-]+/g, "shopping_$1_[REDACTED]"],
  [/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]"],
  [/((?:token|api[-_]?key|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
];

const PRIVATE_NUMERIC_LINE =
  /(min_unit_price_private|max_total_price_private|最低可成交价|底价|最高预算|内部预算)/;

/** Redact secret-looking tokens and private-policy numeric values in a line. */
export function redactLine(line: string): string {
  let out = line;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (PRIVATE_NUMERIC_LINE.test(out)) {
    out = out.replace(/\d+(?:\.\d+)?/g, "[REDACTED]");
  }
  return out;
}

export interface LogsResult {
  instance_id: string;
  lines: string[];
  missing: ManagedRole[];
}

export function runLogs(dir: string, maxLines: number): LogsResult {
  const ctx = loadInstance(dir);
  const logsRoot = path.resolve(ctx.paths.logs);
  const collected: { role: ManagedRole; line: string }[] = [];
  const missing: ManagedRole[] = [];

  for (const role of MANAGED_ROLES) {
    const manifest = readManifest(manifestPathFor(ctx.paths.run, role));
    const logPath = manifest?.log_path ?? path.join(ctx.paths.logs, `${role}.log`);
    // Path containment: only files inside this instance's logs/ dir.
    const resolved = path.resolve(logPath);
    if (resolved !== path.join(logsRoot, `${role}.log`)) {
      missing.push(role);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(resolved, "utf-8");
    } catch {
      missing.push(role);
      continue;
    }
    for (const line of content.split("\n")) {
      if (line.length > 0) collected.push({ role, line });
    }
  }

  const tail = collected.slice(-maxLines);
  return {
    instance_id: ctx.config.instance_id,
    lines: tail.map(({ role, line }) => `[${role}] ${redactLine(line)}`),
    missing,
  };
}
