import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BuyerRouteHintStore } from "../src/buyer-core/buyer-route-hint-store.js";

const CATALOG = "https://catalog.kiwi.harrylabsj.com";
const HINT = {
  agentId: "cagt_route_hint",
  merchantId: "merchant-route-hint",
  origin: "https://acme.app.workbuddy.host",
  kind: "direct" as const,
};

describe("buyer route recovery hints", () => {
  it("persists identity only across restart and never stores a share code", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "buyer-route-hint-"));
    try {
      const store = new BuyerRouteHintStore(dir, CATALOG);
      store.remember(HINT);
      store.remember({ ...HINT, kind: "relay" });
      expect(new BuyerRouteHintStore(dir, CATALOG).getByOrigin(HINT.origin)).toEqual({
        ...HINT,
        kind: "relay",
      });
      // A different Catalog must not consume another Catalog's hints.
      expect(new BuyerRouteHintStore(dir, "https://other.example").getByOrigin(HINT.origin)).toBeUndefined();
      const file = path.join(dir, "buyer-route-hints.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("sharecode");
      expect(text).not.toContain("secret");
      expect(text).toContain(HINT.agentId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous shared origins instead of picking one merchant", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "buyer-route-hint-"));
    try {
      const store = new BuyerRouteHintStore(dir, CATALOG);
      store.remember(HINT);
      store.remember({ ...HINT, agentId: "cagt_other", merchantId: "merchant-other" });
      expect(store.getByOrigin(HINT.origin)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt, unsafe and cross-Catalog files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "buyer-route-hint-"));
    try {
      const store = new BuyerRouteHintStore(dir, CATALOG);
      expect(() => store.remember({ ...HINT, origin: "https://acme.app.workbuddy.host/a2a" })).toThrow();
      expect(() => store.remember({ ...HINT, origin: "https://acme.app.workbuddy.host?sharecode=x" })).toThrow();
      const file = path.join(dir, "buyer-route-hints.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          catalogBase: CATALOG,
          routes: [HINT, { ...HINT, agentId: "cagt_other", merchantId: "merchant-other" }],
        }),
      );
      expect(store.getByOrigin(HINT.origin)).toBeUndefined();
      writeFileSync(file, "{not json");
      expect(store.getByOrigin(HINT.origin)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
