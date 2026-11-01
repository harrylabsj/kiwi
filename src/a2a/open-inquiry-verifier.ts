/** Scoped verifier for opt-in anonymous buyer sessions. Not enabled by default. */
import type { AuthContext, AuthResult, AuthVerifier } from "./server/types.js";
import type { NonceStore } from "../trust/identity/nonce.js";
import { verifyOpenInquiryRequest } from "./open-inquiry-session.js";
import { OPEN_INQUIRY_IDENTITY_PREFIX } from "./open-inquiry-identity.js";

export class OpenInquiryVerifier implements AuthVerifier {
  readonly name = "open-inquiry-scoped";
  private readonly origin: string;
  constructor(private readonly delegate: AuthVerifier, origin: string, private readonly nonceStore: NonceStore,
    private readonly enabled: () => boolean = () => true) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
      throw new Error("open inquiry requires a canonical HTTPS merchant origin");
    this.origin = parsed.origin;
  }

  async verify(ctx: AuthContext): Promise<AuthResult> {
    if (ctx.method === "POST" && ctx.url === "/a2a") {
      const signatureInput = Object.entries(ctx.headers ?? {}).find(([name]) => name.toLowerCase() === "signature-input")?.[1];
      const claimsOpenSession = (Array.isArray(signatureInput) ? signatureInput.join(",") : signatureInput ?? "")
        .includes(OPEN_INQUIRY_IDENTITY_PREFIX);
      if (!claimsOpenSession) return await this.delegate.verify(ctx);
      if (!this.enabled()) return { authenticated: false, protocolCode: "authorization_failed" };
      const result = verifyOpenInquiryRequest({ targetUri: `${this.origin}/a2a`,
        headers: ctx.headers ?? {}, body: ctx.body ?? Buffer.alloc(0), nonceStore: this.nonceStore });
      if (result.ok) return { authenticated: true, identity: result.sessionIdentity,
        identityVerified: true, trustLevel: "T0" };
      // Never downgrade a bad or replayed open-session signature to anonymous.
      return { authenticated: false, protocolCode: "authorization_failed" };
    }
    return await this.delegate.verify(ctx);
  }
}
