import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentProfile } from "../config/profile.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { ProfileCredentialBroker } from "../agent/merchant/credential-broker.js";

/** The A2A child proves its own profile token against shopping-cli before attesting readiness. */
export async function proveMerchantCredentialConsumer(input: {
  profile: AgentProfile;
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ ok: true; credentialFingerprint: string; pid: number } | { ok: false }> {
  const token = new ProfileCredentialBroker(input.profile).resolve("negotiation");
  if (token === undefined || token === "") return { ok: false };
  const baseUrl = process.env.KIWI_COMMERCE_URL ?? input.profile.commerce.base_url;
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)))) return { ok: false };
  url.pathname = `/merchants/${encodeURIComponent(input.profile.agent_id)}/private-config`;
  url.search = "";
  url.hash = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel();
      return { ok: false };
    }
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
        (payload as Record<string, unknown>).merchant_id !== input.profile.agent_id) return { ok: false };
    const credentialFingerprint = createHash("sha256").update(token).digest("hex");
    const observedAt = (input.now ?? (() => new Date()))().toISOString();
    mkdirSync(path.join(input.dataDir, "runtime"), { recursive: true, mode: 0o700 });
    writeFileAtomic(path.join(input.dataDir, "runtime", "merchant-credential-consumer.json"), `${JSON.stringify({
      merchant_id: input.profile.agent_id,
      token_env: input.profile.commerce.token_env,
      credential_fingerprint: credentialFingerprint,
      pid: process.pid,
      checked_at: observedAt,
    })}\n`, { mode: 0o600 });
    return { ok: true, credentialFingerprint, pid: process.pid };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
