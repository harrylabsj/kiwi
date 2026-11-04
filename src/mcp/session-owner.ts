/**
 * Per-session ownership key for the local buyer store.
 *
 * The `--session` string is a label, not a credential: two callers may use the
 * same label. A local 0600 key file supplies the secret used to derive an
 * unguessable task-owner hash; the key is created once per database and is
 * never stored in the database or sent to a merchant. Explicit
 * KIWI_SESSION_TOKEN/--session-token is supported for managed hosts.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SessionOwnerInput {
  dbPath: string;
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  sessionToken?: string;
}

export function resolveSessionOwner(input: SessionOwnerInput): string {
  const identity = `${input.principal}\u0000${input.buyerAgentId}\u0000${input.sessionId}`;
  let secret = input.sessionToken?.trim() ?? "";
  if (secret === "") {
    if (input.dbPath === ":memory:") {
      // Tests/embedding without a DB file: deterministic per-process identity.
      secret = `${process.pid}:${randomBytes(32).toString("hex")}`;
    } else {
      const keyPath = path.join(path.dirname(input.dbPath), ".kiwi-session-key");
      mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      if (!existsSync(keyPath)) {
        writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
        chmodSync(keyPath, 0o600);
      }
      secret = readFileSync(keyPath, "utf8").trim();
    }
  }
  return createHmac("sha256", secret).update(identity).digest("hex");
}

export function fallbackSessionOwner(principal: string, buyerAgentId: string, sessionId: string): string {
  // Embedders that construct KiwiBuyerService directly still get a stable
  // session-scoped namespace; MCP/HTTP entry points should use resolve.
  return createHash("sha256").update(`${principal}\u0000${buyerAgentId}\u0000${sessionId}`).digest("hex");
}
