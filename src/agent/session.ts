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
 * Main-conversation session persistence (design §4.2, §8):
 * a Pi AgentHarness `Session` over JSONL at `sessions/main.jsonl` (0600).
 *
 * Two invariants:
 * - raw model reasoning is never persisted (design §2.2): a storage-level
 *   sanitizer strips thinking blocks from assistant messages before ANY
 *   append, regardless of model or profile thinking_level;
 * - a corrupted log fails closed (AgentSessionError) instead of loading a
 *   guessed session state.
 */

import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  err,
  FileError,
  JsonlSessionStorage,
  ok,
  Session,
  type FileSystem,
  type JsonlSessionMetadata,
  type Result,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { AgentPaths } from "./agent-db.js";

export class AgentSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionError";
  }
}

type StorageFs = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

function toFileError(cause: unknown, path: string): FileError {
  const code = (cause as { code?: string }).code;
  if (code === "ENOENT") {
    return new FileError("not_found", `no such file: ${path}`, path, cause as Error);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FileError("permission_denied", `permission denied: ${path}`, path, cause as Error);
  }
  return new FileError(
    "unknown",
    `fs error at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    path,
    cause as Error,
  );
}

/** Minimal node fs shim with 0600 enforcement on every write. */
function nodeFs0600(): StorageFs {
  return {
    readTextFile(path: string): Promise<Result<string, FileError>> {
      try {
        return Promise.resolve(ok(readFileSync(path, "utf8")));
      } catch (e) {
        return Promise.resolve(err(toFileError(e, path)));
      }
    },
    readTextLines(
      path: string,
      options?: { maxLines?: number },
    ): Promise<Result<string[], FileError>> {
      try {
        let lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
        if (options?.maxLines !== undefined) lines = lines.slice(0, options.maxLines);
        return Promise.resolve(ok(lines));
      } catch (e) {
        return Promise.resolve(err(toFileError(e, path)));
      }
    },
    writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
      try {
        writeFileSync(path, content, { mode: 0o600 });
        chmodSync(path, 0o600);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(toFileError(e, path)));
      }
    },
    appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
      try {
        appendFileSync(path, content, { mode: 0o600 });
        chmodSync(path, 0o600);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(toFileError(e, path)));
      }
    },
  };
}

/** Strip thinking blocks from an assistant message (shallow, content-copied). */
function sanitizeEntry(entry: SessionTreeEntry): SessionTreeEntry {
  if (entry.type !== "message") return entry;
  const message = entry.message as {
    role?: string;
    content?: unknown;
  };
  if (message.role !== "assistant" || !Array.isArray(message.content)) return entry;
  const kept = message.content.filter(
    (block) => (block as { type?: string }).type !== "thinking",
  );
  if (kept.length === message.content.length) return entry;
  return { ...entry, message: { ...message, content: kept } } as SessionTreeEntry;
}

/**
 * SessionStorage wrapper that sanitizes every appended entry. The only
 * behavioral change is appendEntry; all reads delegate.
 */
class NoThinkingStorage implements SessionStorage<JsonlSessionMetadata> {
  private readonly inner: SessionStorage<JsonlSessionMetadata>;

  constructor(inner: SessionStorage<JsonlSessionMetadata>) {
    this.inner = inner;
  }

  getMetadata() {
    return this.inner.getMetadata();
  }
  getLeafId() {
    return this.inner.getLeafId();
  }
  setLeafId(leafId: string | null) {
    return this.inner.setLeafId(leafId);
  }
  createEntryId() {
    return this.inner.createEntryId();
  }
  appendEntry(entry: SessionTreeEntry): Promise<void> {
    return this.inner.appendEntry(sanitizeEntry(entry));
  }
  getEntry(id: string) {
    return this.inner.getEntry(id);
  }
  findEntries<TType extends SessionTreeEntry["type"]>(type: TType) {
    return this.inner.findEntries(type);
  }
  getLabel(id: string) {
    return this.inner.getLabel(id);
  }
  getSessionName() {
    return this.inner.getSessionName();
  }
  getSessionStats() {
    return this.inner.getSessionStats();
  }
  getPathToRootOrCompaction(leafId: string | null) {
    return this.inner.getPathToRootOrCompaction(leafId);
  }
  getEntries(options?: Parameters<SessionStorage<JsonlSessionMetadata>["getEntries"]>[0]) {
    return this.inner.getEntries(options);
  }
}

/** Open (or create) the main conversation session with the no-thinking invariant. */
export async function openMainSession(paths: AgentPaths, sessionId = "main"): Promise<Session> {
  const fs = nodeFs0600();
  let storage: JsonlSessionStorage;
  try {
    storage = existsSync(paths.mainSession)
      ? await JsonlSessionStorage.open(fs, paths.mainSession)
      : await JsonlSessionStorage.create(fs, paths.mainSession, {
          cwd: paths.dir,
          sessionId,
        });
  } catch (e) {
    throw new AgentSessionError(
      `cannot open main session ${paths.mainSession}: ${
        e instanceof Error ? e.message : String(e)
      } (failing closed)`,
    );
  }
  return new Session(new NoThinkingStorage(storage));
}
