/**
 * Append-only operator event persistence (design §6, §14).
 *
 * The store is injectable: FileOperatorEventStore for the real TUI (JSONL,
 * directory 0700 / file 0600), InMemoryOperatorEventStore for tests.
 *
 * Two fail-closed rules:
 * - append refuses any event carrying a secret-like value (token, API key,
 *   password, Bearer string) — secrets must never enter the event log;
 * - readAll refuses a corrupted or shape-invalid log instead of guessing —
 *   a damaged private store means the operator session does not load.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OperatorEvent } from "./types.js";

export interface OperatorEventStore {
  append(event: OperatorEvent): Promise<void>;
  readAll(): Promise<OperatorEvent[]>;
}

export class OperatorStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorStoreError";
  }
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization|credential)/i;
const BEARER_VALUE = /bearer\s+\S+/i;
// Credential-shaped values, wherever they appear in a string: OpenAI-style
// sk- keys and shopping-cli token names. Fail closed like the named-key scan.
const CREDENTIAL_VALUE =
  /sk-[A-Za-z0-9_-]{6,}|shopping_(merchant|buyer|agent|admin)_[A-Za-z0-9_-]+/i;

/** Depth-first scan for secret-like content; returns the offending path. */
function scanForSecrets(value: unknown, at: string): string | undefined {
  if (typeof value === "string") {
    return BEARER_VALUE.test(value) || CREDENTIAL_VALUE.test(value) ? at : undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForSecrets(value[i], `${at}[${i}]`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      const keyPath = at === "" ? key : `${at}.${key}`;
      if (SECRET_KEY.test(key) && typeof v === "string" && v.length > 0) return keyPath;
      const hit = scanForSecrets(v, keyPath);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Refuse to persist events that look like they carry credentials. */
export function assertEventRedacted(event: OperatorEvent): void {
  const hit = scanForSecrets(event, "");
  if (hit !== undefined) {
    throw new OperatorStoreError(
      `operator event carries a secret-like value at "${hit || "(root)"}"; refusing to persist`,
    );
  }
}

function isOperatorEvent(value: unknown): value is OperatorEvent {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.event_id === "string" &&
    typeof v.occurred_at === "string" &&
    typeof v.agent_id === "string" &&
    typeof v.type === "string" &&
    typeof v.visibility === "string" &&
    typeof v.payload === "object" &&
    v.payload !== null
  );
}

/** Known event types (design §6). An unknown type fails closed on load. */
const KNOWN_EVENT_TYPES = new Set<string>([
  "operator.message",
  "strategy.patch.proposed",
  "strategy.patch.applied",
  "strategy.patch.rejected",
  "mode.changed",
  "negotiation.paused",
  "negotiation.resumed",
  "candidate.generated",
  "candidate.approved",
  "candidate.rejected",
  "candidate.revised",
  "decision.submitted",
  "turn.settled",
]);

/** JSONL file store. File 0600, directory 0700 (design §14). */
export class FileOperatorEventStore implements OperatorEventStore {
  readonly dir: string;
  private readonly file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, "operator-events.jsonl");
  }

  async append(event: OperatorEvent): Promise<void> {
    assertEventRedacted(event);
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // mkdir/open modes only apply at creation: enforce them on pre-existing
    // paths too (e.g. a dir or log left at 0755/0644 by another tool).
    await fsp.chmod(this.dir, 0o700);
    const handle = await fsp.open(this.file, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.write(`${JSON.stringify(event)}\n`);
    } finally {
      await handle.close();
    }
  }

  async readAll(): Promise<OperatorEvent[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, "utf-8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return [];
      throw err;
    }
    const events: OperatorEvent[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new OperatorStoreError(
          `operator event log corrupted at line ${i + 1}; refusing to load (fail closed)`,
        );
      }
      if (!isOperatorEvent(parsed)) {
        throw new OperatorStoreError(
          `operator event log line ${i + 1} is not a valid event; refusing to load (fail closed)`,
        );
      }
      if (!KNOWN_EVENT_TYPES.has(parsed.type)) {
        throw new OperatorStoreError(
          `operator event log line ${i + 1} has unknown type "${parsed.type}"; refusing to load (fail closed)`,
        );
      }
      events.push(parsed);
    }
    return events;
  }
}

/** In-memory store for tests and embedded use. Same redaction rules. */
export class InMemoryOperatorEventStore implements OperatorEventStore {
  private readonly events: OperatorEvent[] = [];

  async append(event: OperatorEvent): Promise<void> {
    assertEventRedacted(event);
    this.events.push(event);
  }
  readAll(): Promise<OperatorEvent[]> {
    return Promise.resolve([...this.events]);
  }
}
