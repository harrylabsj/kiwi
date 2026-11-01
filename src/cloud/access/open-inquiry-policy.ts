/** Local, fail-closed mirror of the owner's separate public-inquiry consent. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../fs/atomic-write.js";
import { readEnrollmentStore } from "../binding/enrollment-challenge.js";

export interface InquiryBindingRef {
  agentId: string;
  bindingId: string;
  merchantId: string;
  keyThumbprint: string;
}

type PolicyState = InquiryBindingRef & {
  version: 1;
  origin: string;
  desired: "grant" | "revoke";
  confirmed: boolean;
};

export class OpenInquiryLocalPolicy {
  private readonly file: string;
  constructor(private readonly dataDir: string, private readonly origin: string) {
    this.file = path.join(dataDir, "open-inquiry-policy.json");
  }

  set(binding: InquiryBindingRef, granted: boolean, confirmed: boolean): void {
    if (!binding.agentId || !binding.bindingId || !binding.merchantId || !binding.keyThumbprint)
      throw new Error("open inquiry requires a verified binding");
    const state: PolicyState = { version: 1, origin: this.origin, ...binding,
      desired: granted ? "grant" : "revoke", confirmed };
    writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600 });
  }

  intent(binding: InquiryBindingRef): "grant" | "revoke" | undefined {
    try {
      const state = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PolicyState>;
      if (state.version !== 1 || state.origin !== this.origin || state.agentId !== binding.agentId ||
          state.bindingId !== binding.bindingId || state.merchantId !== binding.merchantId ||
          state.keyThumbprint !== binding.keyThumbprint) return undefined;
      return state.desired === "grant" || state.desired === "revoke" ? state.desired : undefined;
    } catch { return undefined; }
  }

  /** Never enables another instance or an unconfirmed/revoked policy. */
  isEnabled(): boolean {
    try {
      if (!existsSync(this.file)) return false;
      const state = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PolicyState>;
      if (state.version !== 1 || state.origin !== this.origin || state.desired !== "grant" || state.confirmed !== true ||
          !state.agentId || !state.bindingId || !state.merchantId || !state.keyThumbprint) return false;
      return readEnrollmentStore(this.dataDir).sessions.some((item) => {
        const session = item as typeof item & { catalog_agent_id?: string; binding_id?: string; merchant_id?: string };
        return session.status === "published" && session.runtime_origin === this.origin &&
          session.catalog_agent_id === state.agentId && session.binding_id === state.bindingId &&
          session.merchant_id === state.merchantId && session.key_thumbprint === state.keyThumbprint;
      });
    } catch {
      return false;
    }
  }
}
