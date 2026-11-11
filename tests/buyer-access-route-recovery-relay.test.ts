/**
 * Relay branch of restart recovery. The Catalog record and the relay resolver
 * are mocked here (the official relay needs the pinned trust anchor), but the
 * persisted hint and the buyer-service rebuild are real. The security property
 * is the same: a direct switch must never keep using the relay hint, and a
 * relay switch must use the relay rather than an old direct path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const relaySources = vi.hoisted(() => ({
  record: { current: undefined as Record<string, unknown> | undefined },
  openGet: vi.fn(),
}));

vi.mock("../src/discovery/catalog-source/kiwi-source.js", () => ({
  KiwiCatalogSource: class {
    async getRecord() {
      if (relaySources.record.current === undefined) throw new Error("record unavailable");
      return relaySources.record.current;
    }
    async searchRecords() {
      return [];
    }
  },
}));

vi.mock("../src/discovery/catalog-source/open-inquiry.js", () => ({
  OpenInquirySource: class {
    async get(agentId: string, merchantId: string) {
      return await relaySources.openGet(agentId, merchantId);
    }
  },
}));

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { MerchantRecord } from "../src/buyer-core/service.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";

const CATALOG = "https://catalog.kiwi.harrylabsj.com";
const AGENT_ID = "cagt_relay_recovery";
const MERCHANT_ID = "merchant-relay-recovery";
const WB_ORIGIN = "https://acme.app.workbuddy.host";
const WB_CARD = `${WB_ORIGIN}/.well-known/agent-card.json`;
const WB_ENDPOINT = `${WB_ORIGIN}/a2a`;

function record(state: "direct" | "relay" | "unknown"): Record<string, unknown> {
  return {
    catalog_agent_id: AGENT_ID,
    principal_type: "merchant",
    merchant_id: MERCHANT_ID,
    display_name: "Relay Recovery Merchant",
    canonical_domain: "acme.app.workbuddy.host",
    agent_card_url: WB_CARD,
    hosting_mode: "direct_only",
    verification_level: "commerce_verified",
    freshness_state: "fresh",
    administrative_state: "active",
    created_at: "2026-11-11T00:00:00Z",
    updated_at: "2026-11-11T00:00:00Z",
    buyer_access: {
      schema_version: 1,
      state,
      source: state === "unknown" ? "authorization_changed" : "merchant_setting",
      mode: state === "direct" ? "no_share_code" : state === "relay" ? "share_code" : "auto",
      revision: 1,
      updated_at: "2026-11-11T00:00:00Z",
      platform_verification: "unverified",
    },
  };
}

function merchant(state: "direct" | "relay" | "unknown"): MerchantRecord {
  const projection = record(state)["buyer_access"] as MerchantRecord["buyer_access"];
  return {
    merchant_id: MERCHANT_ID,
    name: "Relay Recovery Merchant",
    verified: true,
    capabilities: [],
    catalog_agent_id: AGENT_ID,
    agent_card_url: WB_CARD,
    buyer_access: projection,
  };
}

type Access = {
  direct?: true;
  relayRequired?: true;
  openInquiry?: unknown;
  sendUrlFor(url: string): string;
};

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

const dirs: string[] = [];
afterEach(() => {
  relaySources.record.current = undefined;
  relaySources.openGet.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function buildService(dir: string) {
  return buildBuyerService({
    dbPath: ":memory:",
    protocolStateDir: dir,
    principal: "buyer:relay-recovery",
    buyerAgentId: "buyer-agent:relay-recovery",
    sessionId: "relay-recovery",
    policy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:relay-recovery" },
    catalogUrl: CATALOG,
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 3000,
  });
}

describe("explicit relay recovery after restart", () => {
  it("re-checking relay keeps the relay and a later direct switch stops using it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-recovery-"));
    dirs.push(dir);
    relaySources.record.current = record("relay");
    relaySources.openGet.mockResolvedValue({
      endpoint: WB_ENDPOINT,
      signer: {},
      fetchImpl: async () => Response.json({}),
    });

    const first = buildService(dir);
    const initial = await resolver(first).forMerchant(merchant("relay"));
    expect(initial?.openInquiry).toBeDefined();
    expect(initial?.direct).toBeUndefined();
    expect(relaySources.openGet).toHaveBeenCalledWith(AGENT_ID, MERCHANT_ID);

    // New process: endpoint-only recovery must consult the relay again.
    const restarted = buildService(dir);
    const recovered = await resolver(restarted).forEndpoint(WB_ENDPOINT);
    expect(recovered?.openInquiry).toBeDefined();
    expect(recovered?.direct).toBeUndefined();
    expect(relaySources.openGet).toHaveBeenCalledTimes(2);

    // Merchant switches to no-share-code: the relay hint must not win.
    relaySources.record.current = record("direct");
    const direct = await resolver(buildService(dir)).forEndpoint(WB_ENDPOINT);
    expect(direct?.direct).toBe(true);
    expect(direct?.openInquiry).toBeUndefined();
    expect(relaySources.openGet).toHaveBeenCalledTimes(2);

    // Revocation is terminal even though both old hints remain on disk.
    relaySources.record.current = record("unknown");
    await expect(
      resolver(buildService(dir)).forEndpoint(WB_ENDPOINT),
    ).rejects.toMatchObject({ code: "ACCESS_ROUTE_UNKNOWN" });
  });
});
