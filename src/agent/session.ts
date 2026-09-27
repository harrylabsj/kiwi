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
 * Main-conversation session persistence on top of the pi-coding-agent
 * SessionManager (design §4.2, §8).
 *
 * Invariants kept after the pi-agent-core 0.87 migration:
 * - raw model reasoning is never persisted (design §2.2): every message
 *   append goes through a thinking-stripping wrapper installed by
 *   `installNoThinkingWrapper`, regardless of model or thinking_level;
 * - the session keeps the legacy fixed path `<agent>/sessions/main.jsonl`.
 *   The pi SessionManager would otherwise name fresh sessions
 *   `<timestamp>_<id>.jsonl` and defer file creation until the first
 *   assistant message, so we pin the instance `sessionFile` and write the
 *   header eagerly (the legacy JsonlSessionStorage created the file on
 *   open as well);
 * - the session file is owner-only (0600): upstream opens files without a
 *   mode (0644 under the default umask), so every write path (`_persist`,
 *   `_rewriteFile`) is wrapped with a chmod re-assertion;
 * - a corrupted log fails closed (AgentSessionError) instead of loading a
 *   guessed session state — malformed lines are rejected before calling
 *   SessionManager.open, which would otherwise skip them.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentPaths } from "./agent-db.js";

export class AgentSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionError";
  }
}

type ThinkingStrippable = { role?: string; content?: unknown };

/** Strip thinking blocks from an assistant message (content-copied). */
function stripThinkingBlocks<T extends ThinkingStrippable>(message: T): T {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  const kept = (message.content as Array<{ type?: string }>).filter(
    (block) => block.type !== "thinking",
  );
  if (kept.length === (message.content as unknown[]).length) return message;
  return { ...message, content: kept } as T;
}

/**
 * Install the no-thinking invariant on a SessionManager instance.
 *
 * The SessionManager constructor is private and its `_persist` pipeline has
 * no hook, so we wrap `appendMessage` on the instance: assistant messages
 * get their thinking blocks stripped before the entry is appended/persisted.
 * All other entry kinds (usage, compaction, labels) carry no reasoning.
 */
function installNoThinkingWrapper(manager: SessionManager): SessionManager {
  const managerLike = manager as SessionManager & {
    appendMessage: (message: ThinkingStrippable) => string;
  };
  const original = managerLike.appendMessage.bind(manager);
  managerLike.appendMessage = (message: ThinkingStrippable) =>
    original(stripThinkingBlocks(message));
  return manager;
}

/**
 * Instance internals the fixed-layout/0600 contract has to touch. The
 * upstream class keeps these as ordinary properties/methods (no `#`
 * privacy), and its constructor is private, so instance-level wrapping is
 * the only hook available.
 */
type SessionManagerInternals = {
  sessionFile?: string;
  flushed?: boolean;
  _persist: (entry: unknown) => void;
  _rewriteFile: () => void;
};

/** Re-assert 0600 after every write path (upstream creates files 0644). */
function installOwnerOnlyWrites(manager: SessionManager): SessionManager {
  const internals = manager as unknown as SessionManagerInternals;
  const persist = internals._persist.bind(manager);
  internals._persist = (entry: unknown) => {
    persist(entry);
    enforce0600(internals.sessionFile);
  };
  const rewrite = internals._rewriteFile.bind(manager);
  internals._rewriteFile = () => {
    rewrite();
    enforce0600(internals.sessionFile);
  };
  return manager;
}

/** Directory that holds the main conversation JSONL (0700). */
function ensureSessionsDir(paths: AgentPaths): string {
  const dir = path.dirname(paths.mainSession);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/** Enforce owner-only permissions on an existing session file. */
function enforce0600(file: string | undefined | null): void {
  if (file !== undefined && file !== null && existsSync(file)) {
    chmodSync(file, 0o600);
  }
}

/** SessionManager silently skips malformed JSONL lines, so reject them first. */
export function validateSessionLog(file: string): void {
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [index, line] of lines.entries()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSONL at line ${index + 1}`);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`invalid session entry at line ${index + 1}`);
    }
  }
}

export interface MainSessionManager {
  manager: SessionManager;
  /** True when an existing session file was opened (vs. freshly created). */
  existed: boolean;
}

/**
 * Open (or create) the main conversation session with the no-thinking
 * invariant, the fixed legacy file path, and 0600 enforcement. Returns the
 * SessionManager directly — callers wire it into
 * `createAgentSession({ sessionManager })`.
 */
export function openMainSessionManager(
  paths: AgentPaths,
  cwd: string,
  sessionId = "main",
): MainSessionManager {
  const dir = ensureSessionsDir(paths);
  const existed = existsSync(paths.mainSession);
  let manager: SessionManager;
  try {
    if (existed) {
      validateSessionLog(paths.mainSession);
      manager = SessionManager.open(paths.mainSession, dir, cwd);
    } else {
      manager = SessionManager.create(cwd, dir, { id: sessionId });
    }
  } catch (e) {
    throw new AgentSessionError(
      `cannot open main session ${paths.mainSession}: ${
        e instanceof Error ? e.message : String(e)
      } (failing closed)`,
    );
  }
  installOwnerOnlyWrites(manager);
  installNoThinkingWrapper(manager);
  if (!existed) {
    // Pin the file to the legacy kiwi layout instead of the pi
    // `<timestamp>_<id>.jsonl` naming, and write the header eagerly so the
    // session file exists right after open (matches the legacy storage and
    // keeps `main.jsonl` readable even for a session with no messages).
    const internals = manager as unknown as SessionManagerInternals;
    internals.sessionFile = paths.mainSession;
    internals._rewriteFile();
    // The header is on disk; flip the flush gate so later entries append to
    // the pinned file instead of re-creating it with `openSync(..., "wx")`.
    internals.flushed = true;
  }
  enforce0600(manager.getSessionFile());
  return { manager, existed };
}
