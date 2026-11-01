import { describe, expect, it } from "vitest";
import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";
import { OpenInquiryVerifier } from "../src/a2a/open-inquiry-verifier.js";
import { InMemoryNonceStore } from "../src/trust/identity/nonce.js";
import type { AuthContext } from "../src/a2a/server/types.js";

describe("scoped open-inquiry verifier", () => {
  it("rejects open sessions until owner consent is enabled and after it is revoked", async () => {
    let enabled = false;
    const verifier = new OpenInquiryVerifier({ name: "fallback", verify: () => ({ authenticated: true, identity: "anonymous" }) },
      "https://merchant.example", new InMemoryNonceStore(), () => enabled);
    const signer = new OpenInquirySessionSigner();
    const make = (): AuthContext => {
      const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{}}');
      return { method: "POST", url: "/a2a", body, remoteAddress: undefined, authorizationHeader: undefined,
        headers: signer.sign({ method: "POST", url: "https://merchant.example/a2a", body, headers: {} }) };
    };
    expect((await verifier.verify(make())).authenticated).toBe(false);
    enabled = true;
    expect((await verifier.verify(make())).authenticated).toBe(true);
    enabled = false;
    expect((await verifier.verify(make())).authenticated).toBe(false);
  });
  it("accepts a self-owned inquiry session without registration and never downgrades replay or privileged methods", async () => {
    const verifier = new OpenInquiryVerifier({ name: "permissive-test", verify: () => ({ authenticated: true, identity: "anonymous" }) },
      "https://merchant.example", new InMemoryNonceStore());
    const signer = new OpenInquirySessionSigner();
    const make = (method: string): AuthContext => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }));
      return { method: "POST", url: "/a2a", body, remoteAddress: undefined, authorizationHeader: undefined,
        headers: signer.sign({ method: "POST", url: "https://merchant.example/a2a", body, headers: {} }) };
    };
    const req = make("SendMessage");
    expect(await verifier.verify(req)).toMatchObject({ authenticated: true, identity: signer.keyid, identityVerified: true, trustLevel: "T0" });
    expect(await verifier.verify(req)).toMatchObject({ authenticated: false });
    expect(await verifier.verify(make("GetExtendedAgentCard"))).toMatchObject({ authenticated: false });
    expect(await verifier.verify(make("CreateTaskPushNotificationConfig"))).toMatchObject({ authenticated: false });
    expect(await verifier.verify({ method: "GET", url: "/admin/", headers: {}, remoteAddress: undefined, authorizationHeader: undefined })).toMatchObject({ identity: "anonymous" });
  });
});
