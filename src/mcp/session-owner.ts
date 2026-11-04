/**
 * Buyer session ownership.
 *
 * The session label is only a namespace hint. Each client gets a private,
 * automatically persisted token file (0600) under the user's home directory;
 * the server stores only an HMAC-derived owner hash, never the token. Supplying
 * the same token file/session again reconnects; different files/labels do not
 * share tasks. This is a local-client credential, not remote authentication:
 * another process with the same OS user and access to the file can read it.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SessionOwnerInput {
  /** Used only to give each local database its own auto-token namespace. */
  dbPath?: string;
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  sessionToken?: string;
  /** Optional client-owned token file; must be non-empty. */
  sessionTokenFile?: string;
  /** Test/embedding override for the auto-token directory. */
  tokenDir?: string;
}

function readTokenFile(file: string): string {
  if (!existsSync(file)) throw new Error("session token file does not exist");
  const token = readFileSync(file, "utf8").trim();
  if (token === "") throw new Error("session token file is empty");
  return token;
}

function autoTokenFile(input: SessionOwnerInput): string {
  const key = createHash("sha256")
    .update(`${input.dbPath ?? ""}\u0000${input.principal}\u0000${input.buyerAgentId}\u0000${input.sessionId}`)
    .digest("hex");
  const dir = input.tokenDir ?? path.join(homedir(), ".kiwi", "mcp", "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${key}.token`);
}

export function resolveSessionOwner(input: SessionOwnerInput): string {
  let token = input.sessionToken?.trim() ?? "";
  if (token === "" && input.sessionTokenFile !== undefined) {
    token = readTokenFile(input.sessionTokenFile);
  }
  if (token === "") {
    const file = autoTokenFile(input);
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      chmodSync(file, 0o600);
    }
    token = readTokenFile(file);
  }
  const identity = `${input.principal}\u0000${input.buyerAgentId}\u0000${input.sessionId}`;
  return createHmac("sha256", token).update(identity).digest("hex");
}
