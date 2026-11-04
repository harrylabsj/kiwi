/**
 * Buyer session ownership.
 *
 * A session label is only a display/namespace hint. It is not an
 * authentication credential. A client must present an independently generated
 * session token (`--session-token`, `KIWI_SESSION_TOKEN`, or a private token
 * file); without one the server creates a fresh random owner for this process,
 * never a shared value derived from a reusable DB key or the session label.
 *
 * Reconnect/restart: reuse the exact token. Different clients or labels get
 * different owners even when they share a database.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export interface SessionOwnerInput {
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  sessionToken?: string;
  /** Optional path to a client-private token file; not shared with the DB. */
  sessionTokenFile?: string;
}

export function resolveSessionOwner(input: SessionOwnerInput): string {
  let token = input.sessionToken?.trim() ?? "";
  if (token === "" && input.sessionTokenFile !== undefined) {
    if (!existsSync(input.sessionTokenFile)) {
      throw new Error("session token file does not exist");
    }
    token = readFileSync(input.sessionTokenFile, "utf8").trim();
  }
  if (token === "") {
    // No credential supplied: generate an independent, non-recoverable owner
    // for this process. It cannot be reconstructed from the session label or
    // a shared database directory.
    return `ephemeral:${randomBytes(32).toString("hex")}`;
  }
  const identity = `${input.principal}\u0000${input.buyerAgentId}\u0000${input.sessionId}`;
  return createHmac("sha256", token).update(identity).digest("hex");
}
