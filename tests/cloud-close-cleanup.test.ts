import { describe, expect, it, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { stringify } from "yaml";
import { bootstrapCloudRuntime } from "../src/cloud/bootstrap.js";
import { MerchantStatsStore } from "../src/merchant/stats-store.js";
import { writeAdminCredentials } from "../src/auth/merchant-sessions.js";
import { testProfile } from "./helpers.js";
import * as merchantHttp from "../src/mcp/merchant-server.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true }); });
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
function localState() {
  // Normal persistent-data guard rejects OS temporary directories; these are owned test-only directories.
  const base = path.join(homedir(), ".kiwi-cloud-test");
  mkdirSync(base, { recursive: true }); const dataDir = mkdtempSync(path.join(base, `kiwi-a645-close-${process.pid}-`)); dirs.push(dataDir);
  const profile = testProfile({ commerce: { ...testProfile().commerce, allow_demo_price_fallback: false } });
  const profilePath = path.join(dataDir, "merchant.yaml"); writeFileSync(profilePath, stringify(profile), { mode: 0o600 });
  writeAdminCredentials(dataDir, { principalId: profile.agent_id, merchantId: profile.owner_id, password: "fixture-close-password" });
  return { dataDir, profilePath };
}

describe("actual cloud cleanup pipeline", () => {
  it("a timed-out active merchant handler keeps dependent DBs and ownership until the same work finishes", async () => {
    const { dataDir, profilePath } = localState(), port = await freePort();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const normalCreate = merchantHttp.createMerchantHttpHandler;
    const handlerClose = vi.fn();
    vi.spyOn(merchantHttp, "createMerchantHttpHandler").mockImplementation((options) => {
      const normal = normalCreate(options);
      return { ...normal, close: async () => { handlerClose(); await blocked; await normal.close(); } };
    });
    const instance = await bootstrapCloudRuntime({ artifactRoot: path.resolve("."), catalogFetchImpl: async () => { throw new Error("UNEXPECTED_EXTERNAL_FIXTURE_CALL"); }, env: {
      KIWI_CATALOG_URL: "https://catalog.test", PORT: String(port), KIWI_CLOUD_BIND_HOST: "127.0.0.1", KIWI_CLOUD_PUBLIC_ORIGIN: "https://fixture-close.example",
      KIWI_CLOUD_DATA_DIR: dataDir, KIWI_CLOUD_PROFILE: profilePath, KIWI_CLOUD_A2A_AUTH: "bearer:FIXTURE_CLOSE_TOKEN", FIXTURE_CLOSE_TOKEN: "fixture-only-token",
    }, log: () => undefined });
    const stats = vi.spyOn(MerchantStatsStore.prototype, "close"), dbClose = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      await expect(instance.close()).rejects.toMatchObject({ failedSteps: ["merchant_handler", "statistics", "assembly", "management_database", "ownership"] });
      expect(instance.server.listening).toBe(false); expect(stats).not.toHaveBeenCalled(); expect(dbClose).not.toHaveBeenCalled();
      expect(existsSync(path.join(dataDir, "a2a/owner.lock"))).toBe(true); expect(existsSync(path.join(dataDir, "state.sqlite"))).toBe(true);
      const retry = instance.close(); finish(); await retry;
      expect(handlerClose).toHaveBeenCalledTimes(1); expect(stats).toHaveBeenCalledTimes(1); expect(dbClose).toHaveBeenCalledTimes(4);
      expect(existsSync(path.join(dataDir, "a2a/owner.lock"))).toBe(false);
    } finally { finish(); await instance.close(); }
  });
  it("stats failure does not prevent assembly/management DB cleanup and preserves ownership until retry", async () => {
    const { dataDir, profilePath } = localState(), port = await freePort();
    const instance = await bootstrapCloudRuntime({ artifactRoot: path.resolve("."), catalogFetchImpl: async () => { throw new Error("UNEXPECTED_EXTERNAL_FIXTURE_CALL"); }, env: {
      KIWI_CATALOG_URL: "https://catalog.test",
      PORT: String(port), KIWI_CLOUD_BIND_HOST: "127.0.0.1", KIWI_CLOUD_PUBLIC_ORIGIN: "https://fixture-close.example",
      KIWI_CLOUD_DATA_DIR: dataDir, KIWI_CLOUD_PROFILE: profilePath, KIWI_CLOUD_A2A_AUTH: "bearer:FIXTURE_CLOSE_TOKEN", FIXTURE_CLOSE_TOKEN: "fixture-only-token",
    }, log: () => undefined });
    const originalStats = MerchantStatsStore.prototype.close, originalDb = DatabaseSync.prototype.close;
    const closed: DatabaseSync[] = [];
    const dbClose = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) { originalDb.call(this); closed.push(this); });
    const stats = vi.spyOn(MerchantStatsStore.prototype, "close").mockImplementationOnce(() => { throw new Error("SECRET fixture-stats-close"); }).mockImplementation(originalStats);
    try {
      await expect(instance.close()).rejects.toMatchObject({ message: "RESOURCE_CLOSE_FAILED", failedSteps: ["statistics", "ownership"] });
      expect(instance.server.listening).toBe(false); expect(closed.length).toBe(3); expect(closed.every((db) => db.isOpen === false)).toBe(true);
      expect(existsSync(path.join(dataDir, "a2a/owner.lock"))).toBe(true); expect(existsSync(path.join(dataDir, "state.sqlite"))).toBe(true);
      await instance.close(); await instance.close(); expect(stats).toHaveBeenCalledTimes(2); expect(dbClose).toHaveBeenCalledTimes(4);
      expect(existsSync(path.join(dataDir, "a2a/owner.lock"))).toBe(false); expect(existsSync(path.join(dataDir, "state.sqlite"))).toBe(true);
    } finally { vi.restoreAllMocks(); await instance.close(); }
  });
});
