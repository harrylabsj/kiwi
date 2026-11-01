import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { OpenInquirySessionSigner, resolveOpenInquirySessionKey, verifyOpenInquiryRequest } from "../src/a2a/open-inquiry-session.js";
import { HttpMessageSigner, InMemoryNonceStore, verifyHttpMessageSignature } from "../src/trust/identity/index.js";

describe("account-free inquiry session identity", () => {
  it("isolates sessions, verifies ownership and rejects replay and body tampering", () => {
    const first = new OpenInquirySessionSigner();
    const second = new OpenInquirySessionSigner();
    expect(first.keyid).not.toBe(second.keyid);
    expect(JSON.stringify(first)).not.toContain("PRIVATE KEY");
    const url = "https://merchant.example/a2a";
    const body = Buffer.from('{"question":"price?"}');
    const headers = { host: "merchant.example", "content-type": "application/json" };
    const signature = first.sign({ method: "POST", url, body, headers });
    const nonceStore = new InMemoryNonceStore();
    const verify = (payload: Buffer, signed: Record<string, string>) => verifyHttpMessageSignature({
      method: "POST", targetUri: url, authority: "merchant.example", headers: { ...headers, ...signed },
      body: payload, resolver: resolveOpenInquirySessionKey, nonceStore,
    });
    expect(verify(body, signature).ok).toBe(true);
    expect(verify(body, signature).ok).toBe(false);
    expect(verify(Buffer.from('{"question":"changed"}'), first.sign({ method: "POST", url, body, headers })).ok).toBe(false);
    expect(verify(body, second.sign({ method: "POST", url, body, headers })).ok).toBe(true);
  });

  it("rejects malformed or noncanonical public keys and does not elevate trust", () => {
    const signer = new OpenInquirySessionSigner();
    expect(resolveOpenInquirySessionKey(signer.keyid)?.profile?.trustLevel).toBe("T0");
    expect(resolveOpenInquirySessionKey(signer.keyid + "=")).toBeUndefined();
    expect(resolveOpenInquirySessionKey("kiwi-inquiry-session-v1:short")).toBeUndefined();
    expect(resolveOpenInquirySessionKey("arbitrary-trusted-key")).toBeUndefined();
  });

  it("can restore a locally owned session key without a buyer account", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const first = new OpenInquirySessionSigner(pem);
    const restored = new OpenInquirySessionSigner(pem);
    expect(restored.keyid).toBe(first.keyid);
    expect(JSON.stringify(restored)).not.toContain(pem);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(() => new OpenInquirySessionSigner(other.export({ type: "pkcs8", format: "pem" }).toString())).toThrow();
  });

  it("permits only inquiry methods with a nonce and denies replay and privileged methods", () => {
    const signer = new OpenInquirySessionSigner();
    const targetUri = "https://merchant.example/a2a";
    const nonceStore = new InMemoryNonceStore();
    const input = (method: string) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, id: 1, params: {} }));
      return { targetUri, body, nonceStore, headers: signer.sign({ method: "POST", url: targetUri, body, headers: {} }) };
    };
    const good = input("SendMessage");
    expect(verifyOpenInquiryRequest(good)).toEqual({ ok: true, sessionIdentity: signer.keyid });
    expect(verifyOpenInquiryRequest(good)).toEqual({ ok: false });
    expect(verifyOpenInquiryRequest(input("GetExtendedAgentCard"))).toEqual({ ok: false });
    expect(verifyOpenInquiryRequest(input("CreateTaskPushNotificationConfig"))).toEqual({ ok: false });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const noNonce = new HttpMessageSigner({ keyid: "kiwi-inquiry-session-v1:" + raw.toString("base64url"),
      algorithm: "ed25519", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const body = Buffer.from('{"jsonrpc":"2.0","method":"SendMessage","id":1}');
    const headers = noNonce.sign({ method: "POST", url: targetUri, body, headers: {} });
    expect(verifyOpenInquiryRequest({ targetUri, body, headers, nonceStore })).toEqual({ ok: false });
  });
});
