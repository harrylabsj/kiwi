import { describe, expect, it, vi } from "vitest";
import { createOpenInquiryTransport } from "../src/a2a/client/open-inquiry-transport.js";
import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";

describe("open inquiry directory transport", () => {
  const merchant = "https://merchant.example/a2a";
  const request = () => {
    const body = Buffer.from('{"message":"hello"}');
    const signer = new OpenInquirySessionSigner();
    const headers = { "content-type": "application/json", cookie: "private-cookie",
      authorization: "private-bearer", ...signer.sign({ method: "POST", url: merchant, body, headers: {} }) };
    return { body, headers };
  };

  it("sends signed requests only to the selected directory gateway without forwarding credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const transport = createOpenInquiryTransport({ catalogOrigin: "https://catalog.example",
      catalogAgentId: "cagt_123", merchantEndpoint: merchant, fetchImpl });
    const r = request();
    await transport(merchant, { method: "POST", body: r.body, headers: r.headers });
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls[0]?.[0]).toBe("https://catalog.example/v1/agents/cagt_123/public-inquiry");
    const options = calls[0]?.[1];
    const forwarded = new Headers(options?.headers);
    expect(forwarded.has("signature-input")).toBe(true);
    expect(forwarded.has("cookie")).toBe(false);
    expect(forwarded.has("authorization")).toBe(false);
    expect(options?.redirect).toBe("manual");
  });

  it("rejects other targets, unsigned requests and malicious gateway identifiers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const transport = createOpenInquiryTransport({ catalogOrigin: "https://catalog.example",
      catalogAgentId: "cagt_123", merchantEndpoint: merchant, fetchImpl });
    await expect(transport("https://other.example/a2a", { method: "POST", ...request() })).rejects.toThrow();
    await expect(transport(merchant, { method: "POST", body: "{}", headers: {} })).rejects.toThrow();
    expect(() => createOpenInquiryTransport({ catalogOrigin: "https://catalog.example",
      catalogAgentId: "../../other", merchantEndpoint: merchant, fetchImpl })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
