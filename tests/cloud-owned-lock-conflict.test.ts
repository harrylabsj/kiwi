import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ownedLayout, startOwnedRuntime, type OwnedPolicy } from "../src/cloud/owned-runtime.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(path.join(homedir(), ".kiwi-owned-lock-test-"));
  dirs.push(dir);
  return dir;
}

function policy(): OwnedPolicy {
  const now = Date.now();
  return {
    version: "1",
    policy_id: "lock-test",
    window_id: "lock-window",
    window_start_utc: new Date(now - 60_000).toISOString(),
    window_end_utc: new Date(now + 3_600_000).toISOString(),
    caps: { business_requests: 3, mcp_calls: 3, core_starts: 3 },
  };
}

describe("owned SQLite owner contention", () => {
  it("maps a real journal write lock to BUSY, then resumes without resetting counts", async () => {
    const dir = scratch();
    const p = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    await first.close();
    const journalPath = ownedLayout(dir).journal;
    const blocker = new DatabaseSync(journalPath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      await expect(startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) })).rejects.toThrow(
        /OWNED_RUNTIME_OWNER_BUSY/,
      );
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    const resumed = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    expect(resumed.status().process_boots).toBe(2);
    expect(resumed.status().counts.core_starts).toBe(2);
    await resumed.close();
  });

  it("does not misclassify a corrupt journal as owner contention", async () => {
    const dir = scratch();
    const p = policy();
    const first = await startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) });
    await first.close();
    writeFileSync(ownedLayout(dir).journal, Buffer.from("not a sqlite database\n"));
    await expect(startOwnedRuntime({ dataDir: dir, policy: p, bootstrap: async () => ({}) })).rejects.toThrow(
      /not a database|SQLITE_NOTADB|file is encrypted/i,
    );
    expect(readFileSync(ownedLayout(dir).journal, "utf8")).toContain("not a sqlite database");
  });
});
