/**
 * Buyer session ownership.
 *
 * `sessionId` is a display/namespace label and is NEVER sufficient to identify
 * a client. A host must allocate a per-client instance identity (`clientId`)
 * and persist it in host-owned storage, or supply a per-client token file.
 * Without a host identity this function returns an ephemeral owner: two default
 * clients cannot read each other's tasks, but they also cannot resume after a
 * restart (there is no trustworthy identity to recover).
 *
 * A token file must be non-empty and client-private; this is a local credential,
 * not remote authentication. Hosts such as DSH/Hermes/WorkBuddy/OpenClaw must
 * generate/persist clientId themselves.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SessionOwnerInput {
  dbPath?: string;
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  /** Host-generated, host-persisted identity for this client instance. */
  clientId?: string;
  sessionToken?: string;
  sessionTokenFile?: string;
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
    .update(`${input.dbPath ?? ""}\u0000${input.principal}\u0000${input.buyerAgentId}\u0000${input.clientId ?? ""}\u0000${input.sessionId}`)
    .digest("hex");
  const dir = input.tokenDir ?? path.join(homedir(), ".kiwi", "mcp", "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${key}.token`);
}

export function resolveSessionOwner(input: SessionOwnerInput): string {
  let token = input.sessionToken?.trim() ?? "";
  if (token === "" && input.sessionTokenFile !== undefined) token = readTokenFile(input.sessionTokenFile);
  const clientId = input.clientId?.trim() ?? "";
  if (token === "" && clientId === "") {
    // Fail closed on identity: do not silently share a file keyed only by a
    // caller-controlled session label.
    return `ephemeral:${randomBytes(32).toString("hex")}`;
  }
  if (token === "") {
    const file = autoTokenFile(input);
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      chmodSync(file, 0o600);
    }
    token = readTokenFile(file);
  }
  const identity = `${input.principal}\u0000${input.buyerAgentId}\u0000${clientId}\u0000${input.sessionId}`;
  return createHmac("sha256", token).update(identity).digest("hex");
}
