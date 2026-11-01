import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OpenInquiryLocalPolicy } from "../src/cloud/access/open-inquiry-policy.js";

describe("local open-inquiry consent mirror", () => {
  it("enables only confirmed owner consent for the exact published binding and fails closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-open-policy-"));
    const origin = "https://shop.example";
    const ref = { agentId: "agent", bindingId: "binding", merchantId: "merchant", keyThumbprint: "thumb" };
    const policy = new OpenInquiryLocalPolicy(dir, origin);
    const store = (status: string, binding = "binding") => writeFileSync(path.join(dir, "merchant-enrollments.json"), JSON.stringify({
      version: 1, consumed: [], sessions: [{ enrollment_id: "e", runtime_origin: origin, key_thumbprint: "thumb",
        expires_at: "2099-01-01T00:00:00Z", status, catalog_agent_id: "agent", binding_id: binding, merchant_id: "merchant" }],
    }));
    try {
      expect(policy.isEnabled()).toBe(false);
      policy.set(ref, true, false);
      store("published");
      expect(policy.isEnabled()).toBe(false);
      policy.set(ref, true, true);
      expect(policy.isEnabled()).toBe(true);
      store("published", "different-binding");
      expect(policy.isEnabled()).toBe(false);
      store("paused");
      expect(policy.isEnabled()).toBe(false);
      store("published");
      policy.set(ref, false, false);
      expect(policy.isEnabled()).toBe(false);
      writeFileSync(path.join(dir, "open-inquiry-policy.json"), "corrupt");
      expect(policy.isEnabled()).toBe(false);
      expect(new OpenInquiryLocalPolicy(dir, "https://other.example").isEnabled()).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
