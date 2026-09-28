import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/config/profile.js";
import { loadOrCreateMerchantIdentity, merchantIdentityPath } from "../src/cloud/merchant-identity.js";

const dirs: string[] = [];

function profile(agentId: string, ownerId: string): AgentProfile {
  return {
    runtime_version: "0.6.0", protocol_version: "shopping.negotiation/0.1",
    agent_id: agentId, owner_id: ownerId, name: "商家", role: "merchant",
    commerce: { base_url: "http://127.0.0.1:1", token_env: "KIWI_TOKEN", backend: "local_marketplace", allow_demo_price_fallback: false },
    model: { provider: "fake", model: "fake-merchant-model" },
    runtime: { mode: "once", poll_interval_seconds: 5, turn_timeout_seconds: 90, max_model_steps: 4, max_retries: 2 },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persisted cloud merchant identity", () => {
  it("creates once, keeps identity on redeploy, and stores state as 0600", () => {
    const root = path.join(homedir(), ".kiwi-cloud-test");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, `identity-${process.pid}-`));
    dirs.push(dir);
    const first = loadOrCreateMerchantIdentity(dir, profile("merchant-agent:first", "merchant-first"));
    const pathToState = merchantIdentityPath(dir);
    const stat = statSync(pathToState);
    expect(stat.mode & 0o777).toBe(0o600);
    const second = loadOrCreateMerchantIdentity(dir, profile("merchant-agent:upgrade", "merchant-upgrade"));
    expect(second.agent_id).toBe(first.agent_id);
    expect(second.owner_id).toBe(first.owner_id);
    expect(JSON.parse(readFileSync(pathToState, "utf8"))).toMatchObject({ agent_id: first.agent_id, owner_id: first.owner_id });
  });

  it("migrates the prior WP23 identity from persistent admin credentials", () => {
    const root = path.join(homedir(), ".kiwi-cloud-test");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, `identity-migration-${process.pid}-`));
    dirs.push(dir);
    writeFileSync(path.join(dir, "admin-credentials.json"), JSON.stringify({
      principal_id: "merchant-agent:old-deployment",
      merchant_id: "merchant-old-deployment",
      password_hash: "scrypt$16384$salt$hash",
      created_at: new Date().toISOString(),
    }));
    const resolved = loadOrCreateMerchantIdentity(dir, profile("merchant-agent:new", "merchant-new"));
    expect(resolved.agent_id).toBe("merchant-agent:old-deployment");
    expect(resolved.owner_id).toBe("merchant-old-deployment");
  });
});
