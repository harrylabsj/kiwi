import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, closeHttpServer, createCleanup, CleanupError } from "../src/lifecycle/close.js";
import { MerchantStatsStore, openMerchantStatsStore } from "../src/merchant/stats-store.js";
import { createA2aNodeCore } from "../src/a2a/node.js";
import { assembleMerchantRuntime } from "../src/mcp/merchant-runtime-assembly.js";
import { testProfile } from "./helpers.js";

const dirs: string[] = [];
const dir = () => { const value = mkdtempSync(path.join(tmpdir(), "kiwi-close-regression-")); dirs.push(value); return value; };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe("native statistics close state", () => {
  it("closes once, and recognizes an externally closed native connection", () => {
    const db = new DatabaseSync(":memory:"), store = new MerchantStatsStore(db), close = vi.spyOn(db, "close");
    store.close(); store.close(); expect(close).toHaveBeenCalledTimes(1); expect(store.isClosed()).toBe(true); expect(store.lastCloseError).toBeNull();
    const external = new DatabaseSync(":memory:"), other = new MerchantStatsStore(external);
    external.close(); expect(() => other.close()).not.toThrow(); expect(other.isClosed()).toBe(true);
  });
  it("keeps a first failure retryable without exposing the original error", () => {
    const db = new DatabaseSync(":memory:"), store = new MerchantStatsStore(db), original = db.close.bind(db);
    const close = vi.spyOn(db, "close").mockImplementationOnce(() => { throw new Error("SECRET credential=fixture-only"); }).mockImplementation(original);
    expect(() => store.close()).toThrow("STATS_STORE_CLOSE_RETRYABLE"); expect(db.isOpen).toBe(true); expect(store.isClosed()).toBe(false);
    expect(store.lastCloseError?.message).not.toContain("credential"); store.close(); store.close(); expect(close).toHaveBeenCalledTimes(2); expect(store.isClosed()).toBe(true); expect(store.lastCloseError).toBeNull();
  });
  it("does not infer closed from an arbitrary probe error or unknown state getter", () => {
    const notClosed = { isOpen: true, close: () => { throw Object.assign(new Error("closed-looking text"), { code: "ERR_INVALID_STATE" }); } };
    expect(() => closeDatabase(notClosed)).toThrow(CleanupError);
    expect(() => closeDatabase({ isOpen: true, close: () => undefined })).toThrow(CleanupError);
    const unknown = { get isOpen(): boolean { throw new Error("probe failure"); }, close: () => { throw new Error("fixture failure"); } };
    expect(() => closeDatabase(unknown)).toThrow("RESOURCE_CLOSE_FAILED");
  });
  it("preserves the current UTC SQL grouping for offset timestamps", () => {
    const store = openMerchantStatsStore({ dbPath: ":memory:" });
    try {
      store.recordBuyerContact({ message_id: "utc-close", buyer_identity: "buyer", negotiation_id: "neg", exchange_id: "ex", action: "rfq", skus: ["sku"], occurred_at: "2026-10-13T00:30:00+08:00" });
      expect(store.dailySince("2026-10-12")).toEqual([{ day: "2026-10-12", contact_events: 1, distinct_buyers: 1, negotiations: 1 }]);
      expect(store.totalsSince("2026-10-13").contact_events).toBe(0);
    } finally { store.close(); }
  });
});

describe("cleanup aggregation and lifetime", () => {
  it("continues independent cleanup, holds ownership, and retries only failed resources", async () => {
    let fail = true; const first = vi.fn(() => { if (fail) { fail = false; throw new Error("fixture secret"); } });
    const second = vi.fn(), ownership = vi.fn();
    const close = createCleanup([{ id: "first", run: first }, { id: "second", run: second }, { id: "ownership", after: ["first", "second"], run: ownership }]);
    await expect(close()).rejects.toMatchObject({ message: "RESOURCE_CLOSE_FAILED", failedSteps: ["first", "ownership"] }); expect(second).toHaveBeenCalledTimes(1); expect(ownership).not.toHaveBeenCalled();
    await close(); await close(); expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(1); expect(ownership).toHaveBeenCalledTimes(1);
  });
  it("shares concurrent close and never repeats an active timed-out callback", async () => {
    vi.useFakeTimers(); let finish!: () => void; const work = new Promise<void>((resolve) => { finish = resolve; }); const pending = vi.fn(() => work), later = vi.fn(), ownership = vi.fn();
    const close = createCleanup([{ id: "pending", run: pending }, { id: "later", run: later }, { id: "ownership", after: ["pending", "later"], run: ownership }], 10);
    const first = close(); expect(close()).toBe(first); const observed = first.catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(11);
    expect(await observed).toBeInstanceOf(CleanupError); expect(later).toHaveBeenCalledTimes(1); expect(ownership).not.toHaveBeenCalled();
    const retry = close(); finish(); await retry; expect(pending).toHaveBeenCalledTimes(1); expect(ownership).toHaveBeenCalledTimes(1);
  });
  it("does not hide closeAllConnections failure behind a synchronous successful callback", async () => {
    const server = { listening: false, close: (callback: (error?: Error) => void) => { callback(); }, closeAllConnections: () => { throw new Error("secret fixture"); } };
    await expect(closeHttpServer(server as unknown as Parameters<typeof closeHttpServer>[0])).rejects.toThrow("RESOURCE_CLOSE_FAILED");
  });
});

describe("real core ownership and assembly close", () => {
  it("keeps persistent owner lock on statistics failure and releases it only after retry", () => {
    const dataDir = dir(), core = createA2aNodeCore({ profile: testProfile(), dataDir, advertisedBase: "http://127.0.0.1:9000" });
    const lock = path.join(dataDir, "a2a/owner.lock"), saved = readFileSync(lock, "utf8"), original = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => { throw new Error("fixture stats failure"); }).mockImplementation(original);
    expect(() => core.close()).toThrow("RESOURCE_CLOSE_FAILED"); expect(readFileSync(lock, "utf8")).toBe(saved); expect(existsSync(core.dir)).toBe(true);
    core.close(); core.close(); expect(existsSync(lock)).toBe(false); expect(existsSync(core.dir)).toBe(true);
  });
  it("defers ownership for a host and refuses an inode replacement", () => {
    const dataDir = dir(), core = createA2aNodeCore({ profile: testProfile({ role: "buyer" }), dataDir, advertisedBase: "http://127.0.0.1:9000" });
    const lock = path.join(dataDir, "a2a/owner.lock"), backup = lock + ".owned";
    core.close({ preserveOwnership: true }); expect(existsSync(lock)).toBe(true); renameSync(lock, backup); writeFileSync(lock, String(process.pid));
    expect(() => core.releaseOwnership()).toThrow("RESOURCE_CLOSE_FAILED"); expect(existsSync(lock)).toBe(true);
    unlinkSync(lock); renameSync(backup, lock); core.releaseOwnership(); expect(existsSync(lock)).toBe(false);
  });
  it("does not reclaim an owner lock when the PID probe is unknown", () => {
    const dataDir = dir(), state = path.join(dataDir, "a2a"); mkdirSync(state); const lock = path.join(state, "owner.lock"); writeFileSync(lock, "123456");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("fixture permission"), { code: "EPERM" }); });
    expect(() => createA2aNodeCore({ profile: testProfile({ role: "buyer" }), dataDir, advertisedBase: "http://127.0.0.1:9000" })).toThrow("OWNER_LOCK_STATE_UNKNOWN_HOLD");
    expect(readFileSync(lock, "utf8")).toBe("123456");
  });
  it("keeps ephemeral data while statistics remain active", () => {
    const core = createA2aNodeCore({ profile: testProfile(), advertisedBase: "http://127.0.0.1:9000" }), original = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => { throw new Error("fixture failure"); }).mockImplementation(original);
    expect(() => core.close()).toThrow("RESOURCE_CLOSE_FAILED"); expect(existsSync(core.dir)).toBe(true); core.close(); expect(existsSync(core.dir)).toBe(false);
  });
  it.each([1, 2])("closes both actual assembly databases despite failure at step %s and retries only the open one", async (failureStep) => {
    const assembly = await assembleMerchantRuntime({ profile: testProfile(), dataDir: dir(), host: "127.0.0.1", port: 9000, mcpPath: "/mcp", authMode: "oauth", log: () => undefined });
    const original = DatabaseSync.prototype.close; let calls = 0;
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      calls++; if (calls === failureStep) throw new Error("SECRET fixture-db"); original.call(this);
    });
    await expect(assembly.close()).rejects.toThrow("RESOURCE_CLOSE_FAILED"); expect(close).toHaveBeenCalledTimes(2);
    await assembly.close(); await assembly.close(); expect(close).toHaveBeenCalledTimes(3);
  });
});
