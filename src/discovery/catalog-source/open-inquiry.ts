/** Resolve an explicitly open merchant through the trusted Catalog, without a buyer account. */
import { createPinnedFetch } from "../../merchant-gateway/pinned-fetch.js";
import { assertSafeTargetUrl } from "../../a2a/client/url-policy.js";
import { createOpenInquiryTransport } from "../../a2a/client/open-inquiry-transport.js";
import { OpenInquirySessionSigner } from "../../a2a/open-inquiry-session.js";
import type { BindingTrustStore } from "../../trust/binding/verify.js";
import { CloudCardSource, type CloudAgentResolution } from "./cloud-card.js";
import { readJsonBody } from "../../net/safe-http.js";

export interface OpenInquiryRoute {
  endpoint: string;
  fetchImpl: typeof fetch;
  signer: OpenInquirySessionSigner;
}

export class OpenInquirySource {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveAgent: (id: string) => Promise<Pick<CloudAgentResolution, "endpoint" | "claims">>;
  private readonly signer: OpenInquirySessionSigner;
  private readonly timeoutMs: number;

  constructor(options: { catalogOrigin: string; trust: BindingTrustStore; signer: OpenInquirySessionSigner;
    fetchImpl?: typeof fetch; timeoutMs?: number;
    resolveAgent?: (id: string) => Promise<Pick<CloudAgentResolution, "endpoint" | "claims">> }) {
    const url = assertSafeTargetUrl(options.catalogOrigin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
      throw new Error("open inquiry requires a canonical HTTPS Catalog origin");
    this.origin = url.origin;
    this.fetchImpl = options.fetchImpl ?? createPinnedFetch();
    this.signer = options.signer;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    const source = new CloudCardSource({ baseUrl: this.origin, trust: options.trust,
      fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
    this.resolveAgent = options.resolveAgent ?? ((id) => source.resolveCloudAgent(id));
  }

  async get(agentId: string, expectedMerchantId: string): Promise<OpenInquiryRoute | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId) || !expectedMerchantId)
      throw new Error("invalid open inquiry merchant identity");
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(`${this.origin}/v1/agents/${agentId}/public-inquiry`, {
      method: "GET", redirect: "manual", signal,
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error("open inquiry availability unavailable");
    const capability: unknown = await readJsonBody(response, { signal, maxBytes: 4096 });
    if (typeof capability !== "object" || capability === null || Array.isArray(capability) ||
        Object.keys(capability).some((key) => key !== "available" && key !== "catalog_agent_id") ||
        (capability as Record<string, unknown>)["available"] !== true ||
        (capability as Record<string, unknown>)["catalog_agent_id"] !== agentId)
      throw new Error("invalid open inquiry availability response");
    const resolution = await this.resolveAgent(agentId);
    if (resolution.claims.merchant_id !== expectedMerchantId)
      throw new Error("open inquiry binding does not match discovered merchant");
    return { endpoint: resolution.endpoint, signer: this.signer,
      fetchImpl: createOpenInquiryTransport({ catalogOrigin: this.origin, catalogAgentId: agentId,
        merchantEndpoint: resolution.endpoint, fetchImpl: this.fetchImpl }) };
  }
}
