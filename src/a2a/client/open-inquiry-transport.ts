/**
 * Account-free inquiry transport contract. The directory forwards to the
 * already signed merchant endpoint without returning a WorkBuddy share code.
 * Installed only for a directory-verified merchant that has opted in.
 */
import { assertSafeTargetUrl } from "./url-policy.js";

const ALLOWED_HEADERS = new Set([
  "accept", "content-type", "content-digest", "signature", "signature-input",
  "a2a-version", "a2a-extensions",
]);

export function createOpenInquiryTransport(options: {
  catalogOrigin: string;
  catalogAgentId: string;
  merchantEndpoint: string;
  fetchImpl: typeof fetch;
}): typeof fetch {
  const catalog = assertSafeTargetUrl(options.catalogOrigin);
  const merchant = assertSafeTargetUrl(options.merchantEndpoint);
  if (catalog.protocol !== "https:" || catalog.pathname !== "/" || catalog.search || catalog.hash)
    throw new Error("catalog origin must be an HTTPS origin");
  if (merchant.protocol !== "https:" || merchant.pathname !== "/a2a" || merchant.search || merchant.hash)
    throw new Error("merchant endpoint must be a canonical HTTPS /a2a URL");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.catalogAgentId)) throw new Error("invalid catalog agent id");
  const gateway = new URL(`/v1/agents/${options.catalogAgentId}/public-inquiry`, catalog).href;

  return (async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target !== merchant.href || init?.method !== "POST" || init.body === undefined || init.body === null)
      throw new Error("open inquiry transport rejected request target or method");
    const headers = new Headers();
    new Headers(init.headers).forEach((value, name) => {
      if (ALLOWED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    for (const required of ["content-type", "content-digest", "signature", "signature-input"]) {
      if (!headers.has(required)) throw new Error("open inquiry transport requires signed requests");
    }
    return options.fetchImpl(gateway, { method: "POST", body: init.body, headers,
      redirect: "manual", ...(init.signal ? { signal: init.signal } : {}) });
  }) as typeof fetch;
}
