/** Persistent buyer session ownership, scoped and safe across concurrent starts. */
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { A2A_SIGNING_KEY_FILE, generateA2aSigningIdentity, loadA2aSigningIdentityFromFile } from "../a2a/signing-key.js";
import { OpenInquirySessionSigner } from "../a2a/open-inquiry-session.js";

export function loadOpenInquirySigner(dataDir: string, principal: string, buyerAgentId: string): OpenInquirySessionSigner {
  const scope = createHash("sha256").update(JSON.stringify([principal, buyerAgentId])).digest("hex");
  const dir = path.join(dataDir, "open-inquiry-sessions", scope);
  const file = path.join(dir, A2A_SIGNING_KEY_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return new OpenInquirySessionSigner(loadA2aSigningIdentityFromFile(file).privateKeyPem);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const identity = generateA2aSigningIdentity("open-inquiry-session");
  const temp = path.join(dir, `.signing-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ ...identity, publicKeyRaw: identity.publicKeyRaw.toString("base64") }),
      { mode: 0o600, flag: "wx" });
    try {
      // Publish complete bytes atomically without replacing another process's key.
      linkSync(temp, file);
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    return new OpenInquirySessionSigner(loadA2aSigningIdentityFromFile(file).privateKeyPem);
  } finally {
    try { unlinkSync(temp); } catch { /* Already removed or never created. */ }
  }
}
