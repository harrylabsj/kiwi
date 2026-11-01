import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenInquiryRouteStore } from "../src/buyer-core/open-inquiry-route-store.js";

describe("account-free route recovery hints", () => {
  it("survives restart without storing access credentials and rejects ambiguous or unsafe routes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-inquiry-route-"));
    const catalog = "https://catalog.example";
    const hint = { agentId: "cagt_1", merchantId: "merchant-1", endpoint: "https://merchant.example/a2a" };
    try {
      const store = new OpenInquiryRouteStore(dir, catalog);
      store.remember(hint);
      expect(new OpenInquiryRouteStore(dir, catalog).get(hint.endpoint)).toEqual(hint);
      expect(new OpenInquiryRouteStore(dir, "https://other.example").get(hint.endpoint)).toBeUndefined();
      expect(() => store.remember({ ...hint, merchantId: "another" })).toThrow("ambiguous");
      expect(() => store.remember({ ...hint, endpoint: `${hint.endpoint}?sharecode=secret` })).toThrow();
      const file = path.join(dir, "open-inquiry-routes.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).not.toContain("sharecode");
      writeFileSync(file, JSON.stringify({ version: 1, catalogOrigin: catalog,
        routes: [hint, { ...hint, merchantId: "other" }] }));
      expect(store.get(hint.endpoint)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
