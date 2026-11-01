/**
 * Buyer-owned, account-free session key. This is an identity for isolating a
 * conversation, not a verified real-world identity or a trust elevation.
 * Merchant acceptance is separately controlled by the merchant's consent.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpMessageSigner, verifyHttpMessageSignature } from "../trust/identity/message-signature.js";
import type { SigningKey } from "../trust/identity/keys.js";
import type { NonceStore } from "../trust/identity/nonce.js";
import type { A2AOutboundRequest, A2AOutboundSigner } from "./client/types.js";
import { OPEN_INQUIRY_IDENTITY_PREFIX as PREFIX } from "./open-inquiry-identity.js";

export class OpenInquirySessionSigner implements A2AOutboundSigner {
  readonly keyid: string;
  readonly #privateKey: string;

  constructor(existingPrivateKeyPem?: string) {
    const privateKey = existingPrivateKeyPem === undefined
      ? generateKeyPairSync("ed25519").privateKey
      : createPrivateKey(existingPrivateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("open inquiry requires an Ed25519 key");
    const publicKey = createPublicKey(privateKey);
    const der = publicKey.export({ type: "spki", format: "der" });
    this.keyid = PREFIX + der.subarray(-32).toString("base64url");
    this.#privateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  sign(input: A2AOutboundRequest): Record<string, string> {
    return new HttpMessageSigner({ keyid: this.keyid, algorithm: "ed25519",
      privateKey: this.#privateKey, nonce: randomUUID() }).sign(input);
  }
}

/** Accept only the canonical self-certifying public key encoding, at T0. */
export function resolveOpenInquirySessionKey(keyid: string): SigningKey | undefined {
  if (!keyid.startsWith(PREFIX)) return undefined;
  const encoded = keyid.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== encoded) return undefined;
  return { keyid, algorithm: "ed25519", publicKeyRaw: raw,
    profile: { identity: keyid, role: "buyer", trustLevel: "T0" } };
}

/** Only inquiry/task methods, with signature and per-request replay protection. */
export function verifyOpenInquiryRequest(input: {
  targetUri: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  nonceStore: NonceStore;
}): { ok: true; sessionIdentity: string } | { ok: false } {
  if (input.body.length === 0 || input.body.length > 64 * 1024) return { ok: false };
  let url: URL;
  let message: unknown;
  try {
    url = new URL(input.targetUri);
    message = JSON.parse(input.body.toString("utf8"));
  } catch { return { ok: false }; }
  if (url.protocol !== "https:" || url.pathname !== "/a2a" || url.search || url.hash || url.username || url.password)
    return { ok: false };
  if (typeof message !== "object" || message === null || Array.isArray(message)) return { ok: false };
  const rpc = message as Record<string, unknown>;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" ||
      !new Set(["SendMessage", "GetTask", "ListTasks", "CancelTask", "message/send", "tasks/get"]).has(rpc.method))
    return { ok: false };
  const verified = verifyHttpMessageSignature({ method: "POST", targetUri: url.href, authority: url.host,
    headers: input.headers, body: input.body, resolver: resolveOpenInquirySessionKey, nonceStore: input.nonceStore });
  if (!verified.ok || !verified.params.nonce) return { ok: false };
  return { ok: true, sessionIdentity: verified.keyid };
}
