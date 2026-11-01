import { describe, expect, it, vi } from "vitest";
import { OpenInquirySource } from "../src/discovery/catalog-source/open-inquiry.js";
import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";
import type { CloudAgentResolution } from "../src/discovery/catalog-source/cloud-card.js";
import { officialCatalogTrust } from "../src/discovery/catalog-source/official-catalog-trust.js";
import { jwkThumbprint } from "../src/trust/binding/thumbprint.js";
import type { JsonWebKey } from "../src/trust/identity/jwk.js";

const trust = { resolveIssuerKey: () => undefined };
const verified = { endpoint: "https://merchant.example/a2a", claims: { merchant_id: "merchant-1" } } as unknown as Pick<CloudAgentResolution, "endpoint" | "claims">;

describe("account-free Catalog inquiry discovery", () => {
  it("pins the official Catalog key and never transfers that trust to another origin", () => {
    const store = officialCatalogTrust("https://catalog.kiwi.harrylabsj.com");
    const key = store?.resolveIssuerKey("kiwi-catalog-issuer-20261001-01") as JsonWebKey;
    expect(jwkThumbprint(key)).toBe("sha256:4e9f50724b699fc5f76906d7b04fd1a3f909aad660f52ad89a44573617eec8c9");
    expect(store?.resolveIssuerKey("unknown-issuer")).toBeUndefined();
    expect(officialCatalogTrust("https://other.example")).toBeUndefined();
  });
  it("requires open consent and a verified binding for the discovered merchant, without buyer cookies", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ available: true, catalog_agent_id: "cagt_1" })) as unknown as typeof fetch;
    const resolveAgent = vi.fn(async () => verified);
    const source = new OpenInquirySource({ catalogOrigin: "https://catalog.example", trust,
      signer: new OpenInquirySessionSigner(), fetchImpl, resolveAgent });
    const route = await source.get("cagt_1", "merchant-1");
    expect(route?.endpoint).toBe("https://merchant.example/a2a");
    expect(resolveAgent).toHaveBeenCalledWith("cagt_1");
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.redirect).toBe("manual");
    await expect(source.get("cagt_1", "another-merchant")).rejects.toThrow("does not match");
  });

  it("does not treat absent or malformed capability responses as permission", async () => {
    const missing = new OpenInquirySource({ catalogOrigin: "https://catalog.example", trust,
      signer: new OpenInquirySessionSigner(), fetchImpl: async () => new Response("", { status: 404 }) });
    expect(await missing.get("cagt_1", "merchant-1")).toBeNull();
    const malformed = new OpenInquirySource({ catalogOrigin: "https://catalog.example", trust,
      signer: new OpenInquirySessionSigner(), fetchImpl: async () => Response.json({ available: true, catalog_agent_id: "other" }) });
    await expect(malformed.get("cagt_1", "merchant-1")).rejects.toThrow();
    await expect(malformed.get("../other", "merchant-1")).rejects.toThrow();
  });
});
