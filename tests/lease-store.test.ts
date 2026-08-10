// 文件租约（审查 BUG-07）：全临界区 ownership——并发 send 单 owner 执行、
// 崩溃残留接管、fencing 释放。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLeaseStore } from "../src/negotiation/lease/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const store = (): FileLeaseStore => {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-lease-"));
  dirs.push(dir);
  return new FileLeaseStore(dir);
};

describe("FileLeaseStore（BUG-07）", () => {
  it("独占：同一 key 第二个 owner acquire 失败（单 owner 执行）", () => {
    const s = store();
    expect(s.acquire("alice:msg-1", "owner-a", 10_000)).toBe(true);
    expect(s.acquire("alice:msg-1", "owner-b", 10_000)).toBe(false);
    // 不同 key 不受影响
    expect(s.acquire("alice:msg-2", "owner-b", 10_000)).toBe(true);
  });

  it("release 后同一 key 可再次 acquire", () => {
    const s = store();
    expect(s.acquire("k", "a", 10_000)).toBe(true);
    s.release("k", "a");
    expect(s.acquire("k", "b", 10_000)).toBe(true);
  });

  it("崩溃残留：过期租约被接管，未过期不被接管", () => {
    const s = store();
    // 过期残留（TTL 1ms 已过）
    expect(s.acquire("stale", "old-owner", 1)).toBe(true);
    expect(s.acquire("stale", "new-owner", 10_000)).toBe(false); // 未过期不接管
    // 等过期
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(s.acquire("stale", "new-owner", 10_000)).toBe(true); // 过期接管
        resolve();
      }, 10);
    });
  });

  it("fencing：旧 owner 的迟到 release 不删除新 owner 的租约", () => {
    const s = store();
    expect(s.acquire("k", "old", 10_000)).toBe(true);
    s.release("k", "old"); // 正常释放
    expect(s.acquire("k", "new", 10_000)).toBe(true);
    // 旧 owner 再次 release（迟到）：不得删除新 owner 租约
    s.release("k", "old");
    expect(s.acquire("k", "third", 10_000)).toBe(false); // 新 owner 租约仍在
    s.release("k", "new");
  });

  it("renew 仅 owner 可续租", () => {
    const s = store();
    expect(s.acquire("k", "a", 100)).toBe(true);
    expect(s.renew("k", "b", 100)).toBe(false); // 非 owner 拒绝
    expect(s.renew("k", "a", 100)).toBe(true); // owner 续租
    s.release("k", "a");
  });
});
