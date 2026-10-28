import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentProfile } from "../config/profile.js";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { readJsonBody } from "../net/safe-http.js";
import { isLoopbackHost } from "../a2a/client/url-policy.js";
import { ProfileCredentialBroker } from "../agent/merchant/credential-broker.js";
import { catalogOwnerTokenEnv } from "../config/credentials.js";

/**
 * A2A 子进程用自己的 shopping-cli 凭据证明它已经拿到轮换后的值。
 *
 * 两条硬约束（都被审查抓到过）：
 * - 只认 **shopping-cli** 凭据：`commerce.token_env` 必须与 Kiwi Catalog 的
 *   owner token（`merchant_public.merchant_token_env`）不同，否则说明 profile
 *   还没拆分，拿 catalog token 去调 shopping-cli 只会 403，永远证明不了。
 * - 端点按 `${base_url}${path}` 拼接，保留网关可能挂载的子路径前缀。
 */
export async function proveMerchantCredentialConsumer(input: {
  profile: AgentProfile;
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ ok: true; credentialFingerprint: string; pid: number } | { ok: false }> {
  if (input.profile.commerce.token_env === catalogOwnerTokenEnv(input.profile)) return { ok: false };
  const token = new ProfileCredentialBroker(input.profile).resolve("negotiation");
  if (token === undefined || token === "") return { ok: false };
  const baseUrl = process.env.KIWI_COMMERCE_URL ?? input.profile.commerce.base_url;
  let url: URL;
  try {
    const base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash ||
        (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHost(base.hostname)))) return { ok: false };
    url = new URL(`${base.href.replace(/\/+$/, "")}/merchants/${encodeURIComponent(input.profile.agent_id)}/private-config`);
  } catch {
    return { ok: false };
  }
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
    // 有界读取：常驻子进程不能被故障网关的巨量响应拖垮。
    const payload: unknown = await readJsonBody(response, { signal: controller.signal, maxBytes: 64 * 1024 });
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
