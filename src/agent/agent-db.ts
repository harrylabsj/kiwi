/**
 * Per-agent data layout and database opening (design §8):
 *
 *   .kiwi/agents/<agent_id>/state.sqlite        (0600; dir 0700)
 *   .kiwi/agents/<agent_id>/sessions/main.jsonl (0600)
 *
 * Buyer and Merchant agents get physically separate directories, databases,
 * session files and keys (design §17) — path components derived from the
 * agent_id are sanitized so a profile can never escape its own directory.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateMemorySchema, MigrationError } from "./memory/schema.js";
import { MemoryError } from "./memory/types.js";

export const DEFAULT_AGENTS_ROOT = path.resolve(".kiwi", "agents");

/** Sanitize an agent_id for filesystem use; refuses traversal outright. */
export function agentDirName(agentId: string): string {
  if (agentId.includes("..") || agentId.includes("/") || agentId.includes("\\")) {
    throw new MemoryError("validation", `agent_id ${agentId} is not safe for a data directory`);
  }
  const safe = agentId.replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (safe.length === 0) {
    throw new MemoryError("validation", "agent_id produces an empty data directory name");
  }
  return safe;
}

export function agentDataDir(agentId: string, root: string = DEFAULT_AGENTS_ROOT): string {
  return path.join(root, agentDirName(agentId));
}

export interface AgentPaths {
  dir: string;
  db: string;
  sessionsDir: string;
  mainSession: string;
}

/** Create (0700) and describe one concrete agent data directory. */
export function ensurePathsForDir(dir: string): AgentPaths {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // recursive mkdir only applies the mode to new components
  const sessionsDir = path.join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionsDir, 0o700);
  return {
    dir,
    db: path.join(dir, "state.sqlite"),
    sessionsDir,
    mainSession: path.join(sessionsDir, "main.jsonl"),
  };
}

export function ensureAgentPaths(agentId: string, root: string = DEFAULT_AGENTS_ROOT): AgentPaths {
  return ensurePathsForDir(agentDataDir(agentId, root));
}

/** Open (and migrate) the agent's memory database; file mode 0600, fail closed on corruption. */
export function openAgentDatabase(dbPath: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    throw new MemoryError(
      "store_corrupted",
      `cannot open memory database ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    migrateMemorySchema(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // already broken; preserve the original error
    }
    if (err instanceof MigrationError) throw err;
    throw new MemoryError(
      "store_corrupted",
      `cannot migrate memory database ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return db;
}
