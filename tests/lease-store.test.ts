// 文件租约（审查 BUG-07）：全临界区 ownership——并发 send 单 owner 执行、
// 崩溃残留接管、fencing 释放。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { FileLeaseStore, type FileLeaseHandle } from "../src/negotiation/lease/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const store = (nowMs?: () => number): FileLeaseStore => {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-lease-"));
  dirs.push(dir);
  return new FileLeaseStore(dir, nowMs === undefined ? {} : { nowMs });
};

function runAcquireWorker(workerData: Record<string, unknown>): Promise<unknown> {
  const worker = new Worker(new URL("./helpers/file-lease-worker.mjs", import.meta.url), {
    workerData,
  });
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`file lease worker exited with code ${code}`));
    });
  });
}

describe("FileLeaseStore（BUG-07）", () => {
  it("独占：同一 key 第二个 owner acquire 失败（单 owner 执行）", () => {
    const s = store();
    expect(s.acquire("alice:msg-1", "owner-a", 10_000)).toMatchObject({ fencingToken: 1 });
    expect(s.acquire("alice:msg-1", "owner-b", 10_000)).toBeUndefined();
    // 不同 key 不受影响
    expect(s.acquire("alice:msg-2", "owner-b", 10_000)).toMatchObject({ fencingToken: 1 });
  });

  it("release 后同一 key 可再次 acquire 且 token 单调递增", () => {
    const s = store();
    const first = s.acquire("k", "a", 10_000)!;
    expect(first.fencingToken).toBe(1);
    expect(s.release(first)).toBe(true);
    const second = s.acquire("k", "b", 10_000)!;
    expect(second.fencingToken).toBe(2);
  });

  it("崩溃残留：过期租约被接管，未过期不被接管", () => {
    let now = 0;
    const s = store(() => now);
    const oldLease = s.acquire("stale", "old-owner", 1)!;
    expect(s.acquire("stale", "new-owner", 10_000)).toBeUndefined(); // 未过期不接管
    now = 2;
    const newLease = s.acquire("stale", "new-owner", 10_000)!;
    expect(newLease.fencingToken).toBeGreaterThan(oldLease.fencingToken);
    expect(s.isCurrent(oldLease)).toBe(false);
    expect(s.renew(oldLease, 10_000)).toBeUndefined();
    expect(s.release(oldLease)).toBe(false);
    expect(s.isCurrent(newLease)).toBe(true);
  });

  it("fencing：旧 owner 的迟到 release 不删除新 owner 的租约", () => {
    const s = store();
    const oldLease = s.acquire("k", "old", 10_000)!;
    s.release(oldLease); // 正常释放
    const newLease = s.acquire("k", "new", 10_000)!;
    // 旧 owner 再次 release（迟到）：不得删除新 owner 租约
    expect(s.release(oldLease)).toBe(false);
    expect(s.acquire("k", "third", 10_000)).toBeUndefined(); // 新 owner 租约仍在
    expect(s.release(newLease)).toBe(true);
  });

  it("renew 仅 owner 可续租", () => {
    let now = 0;
    const s = store(() => now);
    const lease = s.acquire("k", "a", 100)!;
    expect(s.renew({ ...lease, owner: "b" }, 100)).toBeUndefined(); // 非 owner 拒绝
    now = 50;
    const renewed = s.renew(lease, 100)!;
    expect(renewed).toMatchObject({ fencingToken: lease.fencingToken, expiresAt: 150 });
    expect(s.isCurrent(renewed)).toBe(true);
    expect(s.release(renewed)).toBe(true);
  });

  it("两个进程同时 acquire 只有一个获得下一 token", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-lease-race-"));
    dirs.push(dir);
    const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const results = await Promise.all([
      runAcquireWorker({
        dir,
        key: "race",
        owner: "owner-a",
        ttlMs: 10_000,
        now: 0,
        barrierBuffer,
      }),
      runAcquireWorker({
        dir,
        key: "race",
        owner: "owner-b",
        ttlMs: 10_000,
        now: 0,
        barrierBuffer,
      }),
    ]);
    expect(results.filter((value) => value !== undefined)).toHaveLength(1);
    expect(results.find((value) => value !== undefined)).toMatchObject({ fencingToken: 1 });
  });

  it("SIGKILL 残留接管后旧 token 的 renew/release 均失效", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-lease-crash-"));
    dirs.push(dir);
    const handleFile = path.join(dir, "old-handle.json");
    const child = spawn(
      process.execPath,
      [
        new URL("./helpers/file-lease-worker.mjs", import.meta.url).pathname,
        "crash",
        dir,
        handleFile,
        "crash-key",
        "old-owner",
        "10",
        "0",
      ],
      { stdio: "ignore" },
    );
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    const oldLease = JSON.parse(readFileSync(handleFile, "utf8")) as FileLeaseHandle;
    const recovered = new FileLeaseStore(dir, { nowMs: () => 11 });
    const newLease = recovered.acquire("crash-key", "new-owner", 100)!;
    expect(newLease.fencingToken).toBeGreaterThan(oldLease.fencingToken);
    expect(recovered.renew(oldLease, 100)).toBeUndefined();
    expect(recovered.release(oldLease)).toBe(false);
    expect(recovered.isCurrent(newLease)).toBe(true);
  });

  it("迁移旧单文件 lease 后保持占用并从 token 2 接管", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-lease-legacy-"));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, "lease-legacy.json"),
      JSON.stringify({ owner: "legacy-owner", expires_at: 10 }),
    );
    let now = 0;
    const migrated = new FileLeaseStore(dir, { nowMs: () => now });
    expect(migrated.acquire("legacy", "new-owner", 100)).toBeUndefined();
    now = 11;
    expect(migrated.acquire("legacy", "new-owner", 100)).toMatchObject({ fencingToken: 2 });
  });
});
