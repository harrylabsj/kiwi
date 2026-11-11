/**
 * Restart recovery for explicit buyer routes.
 *
 * The hint on disk is not a route decision: after a real buyer-process rebuild
 * (including a real HTTP Catalog read) it must re-check the public projection.
 * `direct` stays no-code, `relay` never falls back to a cached direct route,
 * and unknown/revoked/unavailable states fail closed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BuyerRouteHintStore } from "../src/buyer-core/buyer-route-hint-store.js";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { MerchantRecord } from "../src/buyer-core/service.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";

const AGENT_ID = "cagt_route_recovery";
const MERCHANT_ID = "merchant-route-recovery";
const WB_ORIGIN = "https://acme.app.workbuddy.host";
const WB_CARD = `${WB_ORIGIN}/.well-known/agent-card.json`;
const WB_ENDPOINT = `${WB_ORIGIN}/a2a`;

type Projection = "direct" | "relay" | "unknown" | "absent";

interface CatalogState {
  projection: Projection;
  runtimeAccess?: boolean;
  administrativeState?: "active" | "suspended";
  revision?: number;
}

interface CatalogRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface CatalogStub {
  url: string;
  requests: CatalogRequest[];
  setState(state: CatalogState): void;
  stop(): Promise<void>;
}

function recordFor(state: CatalogState): Record<string, unknown> {
  const buyerAccess =
    state.projection === "absent"
      ? undefined
      : {
          schema_version: 1,
          state: state.projection,
          source:
            state.projection === "unknown"
              ? "authorization_changed"
              : "merchant_setting",
          mode:
            state.projection === "direct"
              ? "no_share_code"
              : state.projection === "relay"
                ? "share_code"
                : "auto",
          revision: state.revision ?? 1,
          updated_at: "2026-11-11T00:00:00Z",
          platform_verification: "unverified",
        };
  return {
    catalog_agent_id: AGENT_ID,
    principal_type: "merchant",
    merchant_id: MERCHANT_ID,
    display_name: "Route Recovery Merchant",
    canonical_domain: "acme.app.workbuddy.host",
    agent_card_url: WB_CARD,
    hosting_mode: "direct_only",
    verification_level: "commerce_verified",
    freshness_state: "fresh",
    administrative_state: state.administrativeState ?? "active",
    created_at: "2026-11-11T00:00:00Z",
    updated_at: "2026-11-11T00:00:00Z",
    ...(state.runtimeAccess === true
      ? {
          runtime_access: {
            provider: "workbuddy",
            access_mode: "share_parameter",
            parameter_name: "sharecode",
            config_version: 1,
            adapter_version: "workbuddy-share-v1",
            auth_mode: "signature",
          },
        }
      : {}),
    ...(buyerAccess !== undefined ? { buyer_access: buyerAccess } : {}),
  };
}

async function startCatalog(initial: CatalogState): Promise<CatalogStub> {
  let state = initial;
  const requests: CatalogRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ url: req.url ?? "", headers: req.headers });
    if (url.pathname === `/v1/agents/${AGENT_ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agent: recordFor(state) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setState(next: CatalogState) {
      state = next;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "buyer-route-recovery-"));
  dirs.push(dir);
  return dir;
}

function buildService(dir: string, catalogUrl: string) {
  // Intentionally no catalogSessionToken: public route recovery must work
  // without a buyer session and must not send one.
  return buildBuyerService({
    dbPath: ":memory:",
    protocolStateDir: dir,
    principal: "buyer:route-recovery",
    buyerAgentId: "buyer-agent:route-recovery",
    sessionId: "route-recovery",
    policy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:route-recovery" },
    catalogUrl,
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 3000,
  });
}

type Access = {
  direct?: true;
  relayRequired?: true;
  sendUrlFor(url: string): string;
};

function merchant(projection: "direct" | "relay" | "unknown"): MerchantRecord {
  return {
    merchant_id: MERCHANT_ID,
    name: "Route Recovery Merchant",
    verified: true,
    capabilities: [],
    catalog_agent_id: AGENT_ID,
    agent_card_url: WB_CARD,
    buyer_access: {
      schema_version: 1,
      state: projection,
      source: projection === "unknown" ? "authorization_changed" : "merchant_setting",
      mode: projection === "direct" ? "no_share_code" : projection === "relay" ? "share_code" : "auto",
      revision: 1,
      platform_verification: "unverified",
    },
  };
}

function resolver(service: ReturnType<typeof buildBuyerService>): {
  forMerchant(merchant: MerchantRecord): Promise<Access | null>;
  forEndpoint(endpoint: string): Promise<Access | null>;
} {
  return (service as unknown as {
    quoteFetcher: {
      merchantAccess: {
        forMerchant(merchant: MerchantRecord): Promise<Access | null>;
        forEndpoint(endpoint: string): Promise<Access | null>;
      };
    };
  }).quoteFetcher.merchantAccess;
}

describe("explicit direct survives a real buyer-process restart", () => {
  it("re-fetches the public projection without a session and stays no-code", async () => {
    const catalog = await startCatalog({ projection: "direct" });
    const dir = makeDir();
    try {
      const first = buildService(dir, catalog.url);
      const initial = await resolver(first).forMerchant(merchant("direct"));
      expect(initial?.direct).toBe(true);
      expect(initial?.sendUrlFor(WB_ENDPOINT)).toBe(WB_ENDPOINT);

      // Rebuild the whole buyer service from the same protocol state: only the
      // endpoint is known on the recovery path.
      const restarted = buildService(dir, catalog.url);
      const recovered = await resolver(restarted).forEndpoint(WB_ENDPOINT);
      expect(recovered?.direct).toBe(true);
      expect(recovered?.sendUrlFor(WB_ENDPOINT)).toBe(WB_ENDPOINT);

      expect(
        catalog.requests.some((request) => request.url.includes("include=buyer_access")),
      ).toBe(true);
      expect(
        catalog.requests.every(
          (request) =>
            request.headers.authorization === undefined && request.headers.cookie === undefined,
        ),
      ).toBe(true);
      const hintFile = readFileSync(path.join(dir, "buyer-route-hints.json"), "utf8");
      expect(hintFile).not.toContain("sharecode");
      expect(hintFile).not.toContain("secret");
    } finally {
      await catalog.stop();
    }
  });

  it("switches direct -> relay after restart and never reuses the old direct cache", async () => {
    const catalog = await startCatalog({ projection: "direct" });
    const dir = makeDir();
    try {
      const first = buildService(dir, catalog.url);
      expect((await resolver(first).forMerchant(merchant("direct")))?.direct).toBe(true);

      catalog.setState({ projection: "relay" });
      // Even within the same process, the endpoint lookup re-checks the
      // projection instead of trusting the earlier direct resolution.
      const sameProcess = await resolver(first).forEndpoint(WB_ENDPOINT);
      expect(sameProcess?.relayRequired).toBe(true);
      expect(sameProcess?.direct).toBeUndefined();

      const restarted = buildService(dir, catalog.url);
      const recovered = await resolver(restarted).forEndpoint(WB_ENDPOINT);
      expect(recovered?.relayRequired).toBe(true);
      expect(recovered?.direct).toBeUndefined();
      expect(() => recovered?.sendUrlFor(WB_ENDPOINT)).toThrow();
    } finally {
      await catalog.stop();
    }
  });

  it("routes relay -> direct after restart instead of sticking to an old relay hint", async () => {
    const catalog = await startCatalog({ projection: "relay" });
    const dir = makeDir();
    try {
      const first = buildService(dir, catalog.url);
      // Non-official Catalog has no wired relay; the explicit relay is terminal,
      // but the identity hint is still written for a later switch.
      expect((await resolver(first).forMerchant(merchant("relay")))?.relayRequired).toBe(true);

      catalog.setState({ projection: "direct" });
      const restarted = buildService(dir, catalog.url);
      const recovered = await resolver(restarted).forEndpoint(WB_ENDPOINT);
      expect(recovered?.direct).toBe(true);
      expect(recovered?.sendUrlFor(WB_ENDPOINT)).toBe(WB_ENDPOINT);
    } finally {
      await catalog.stop();
    }
  });

  it("fails closed on revoked/unknown/suspended authorization even with a direct hint", async () => {
    const catalog = await startCatalog({ projection: "direct" });
    const dir = makeDir();
    try {
      const first = buildService(dir, catalog.url);
      expect((await resolver(first).forMerchant(merchant("direct")))?.direct).toBe(true);

      catalog.setState({ projection: "unknown" });
      await expect(
        resolver(buildService(dir, catalog.url)).forEndpoint(WB_ENDPOINT),
      ).rejects.toMatchObject({ code: "ACCESS_ROUTE_UNKNOWN" });

      catalog.setState({ projection: "direct", administrativeState: "suspended" });
      await expect(
        resolver(buildService(dir, catalog.url)).forEndpoint(WB_ENDPOINT),
      ).rejects.toMatchObject({ code: "ACCESS_ROUTE_UNKNOWN" });
    } finally {
      await catalog.stop();
    }
  });

  it("fails closed when the Catalog is unreachable instead of using the old direct hint", async () => {
    const catalog = await startCatalog({ projection: "direct" });
    const dir = makeDir();
    try {
      const first = buildService(dir, catalog.url);
      expect((await resolver(first).forMerchant(merchant("direct")))?.direct).toBe(true);
    } finally {
      await catalog.stop();
    }
    await expect(
      resolver(buildService(dir, catalog.url)).forEndpoint(WB_ENDPOINT),
    ).rejects.toMatchObject({ code: "ROUTE_STATE_UNAVAILABLE" });
  });
});

describe("legacy Catalog records without buyer_access", () => {
  it("keeps the old no-code semantics but refuses direct when runtime_access appears", async () => {
    const catalog = await startCatalog({ projection: "absent", runtimeAccess: false });
    const dir = makeDir();
    try {
      const store = new BuyerRouteHintStore(dir, catalog.url);
      store.remember({
        agentId: AGENT_ID,
        merchantId: MERCHANT_ID,
        origin: WB_ORIGIN,
        kind: "direct",
      });
      const recovered = await resolver(buildService(dir, catalog.url)).forEndpoint(WB_ENDPOINT);
      expect(recovered?.direct).toBe(true);

      catalog.setState({ projection: "absent", runtimeAccess: true });
      await expect(
        resolver(buildService(dir, catalog.url)).forEndpoint(WB_ENDPOINT),
      ).rejects.toMatchObject({ code: "ACCESS_ROUTE_UNKNOWN" });
    } finally {
      await catalog.stop();
    }
  });
});
