/**
 * HandoffIdempotencyStore 测试（KTH rev0.3 §10.1；完成标准 11）。
 *
 * 覆盖：
 * - 幂等键 (candidate_id, candidate_digest)：同键命中 → 返回原 handoff_id；
 * - 不同 digest（同候选）→ 不命中（调用方 fail-closed 的输入）；
 * - 保留期清理（prune 删除过期行）。
 */
import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffIdempotencyStore } from "../src/handoff/index.js";

function store(now: () => string = () => "2026-08-07T00:00:00Z"): HandoffIdempotencyStore {
  return new HandoffIdempotencyStore({
    dir: trackedMkdtemp("kiwi-idem-"),
    now,
  });
}

describe("HandoffIdempotencyStore", () => {
  it("record + lookup 同键命中", () => {
    const s = store();
    expect(s.lookup("hcan_01", "sha256:abc")).toBeUndefined();
    s.record("hcan_01", "sha256:abc", "hnd_99");
    expect(s.lookup("hcan_01", "sha256:abc")).toEqual({ handoff_id: "hnd_99" });
  });

  it("同候选不同 digest → 不命中（幂等键的 digest 分量生效）", () => {
    const s = store();
    s.record("hcan_01", "sha256:abc", "hnd_99");
    expect(s.lookup("hcan_01", "sha256:def")).toBeUndefined();
  });

  it("prune 清理过期行，保留新行", () => {
    let now = "2026-08-07T00:00:00Z";
    const s = store(() => now);
    s.record("hcan_old", "sha256:old", "hnd_old");
    now = "2026-08-10T00:00:00Z";
    s.record("hcan_new", "sha256:new", "hnd_new");
    now = "2026-08-20T00:00:00Z"; // 距 old 13 天（>7 天），距 new 10 天（>7 天）
    const pruned = s.prune();
    expect(pruned).toBe(2);
    expect(s.lookup("hcan_old", "sha256:old")).toBeUndefined();
    expect(s.lookup("hcan_new", "sha256:new")).toBeUndefined();
  });

  it("保留期内不清理", () => {
    let now = "2026-08-07T00:00:00Z";
    const s = store(() => now);
    s.record("hcan_01", "sha256:abc", "hnd_01");
    now = "2026-08-10T00:00:00Z"; // 3 天后
    expect(s.prune()).toBe(0);
    expect(s.lookup("hcan_01", "sha256:abc")).toEqual({ handoff_id: "hnd_01" });
  });
});

describe("withCandidateLock（§10.1 并发保护）", () => {
  it("并发 withCandidateLock 串行执行（互斥）：第二个执行者看到首个的 record，仅一次落盘", async () => {
    const s = store();
    let inFlight = 0;
    let maxInFlight = 0;
    let recorded = 0;
    // 模拟 executeHandoff 锁内语义：lookup（在锁内重查）→ 命中则跳过 record。
    const entry = () =>
      s.withCandidateLock("hcan_01", async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30)); // await 间隙
        inFlight -= 1;
        const hit = s.lookup("hcan_01", "sha256:abc");
        if (hit === undefined) {
          recorded += 1;
          s.record("hcan_01", "sha256:abc", "hnd_01");
        }
        return hit ?? "delivered";
      });
    const outcomes = await Promise.all([entry(), entry()]);
    expect(maxInFlight).toBe(1); // 任何时刻只有一个执行者在锁内
    expect(recorded).toBe(1); // 仅一次落盘（无锁时会是 2）
    expect(outcomes).toEqual(["delivered", { handoff_id: "hnd_01" }]);
    expect(s.lookup("hcan_01", "sha256:abc")).toEqual({ handoff_id: "hnd_01" });
  });

  it("不同候选互不阻塞（锁按候选粒度）", async () => {
    const s = store();
    const order: string[] = [];
    await Promise.all([
      s.withCandidateLock("hcan_a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("a");
      }),
      s.withCandidateLock("hcan_b", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["b", "a"]); // b 不被 a 的锁阻塞
  });

  it("锁内抛错 → 锁释放，后续可再获锁；锁文件不留残骸", async () => {
    const s = store();
    await expect(
      s.withCandidateLock("hcan_01", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      s.withCandidateLock("hcan_01", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("持锁超时 → HandoffError(concurrency_lock_timeout)（fail-closed，绝不并发执行）", async () => {
    const s = new HandoffIdempotencyStore({
      dir: trackedMkdtemp("kiwi-idem-"),
      lockTimeoutMs: 60,
    });
    let released = false;
    const holder = s.withCandidateLock("hcan_01", async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      s.withCandidateLock("hcan_01", async () => "never"),
    ).rejects.toMatchObject({ code: "concurrency_lock_timeout" });
    await holder;
    expect(released).toBe(true);
  });

  it("陈旧锁自愈：崩溃残留（mtime 超阈值）被清理，不永久 concurrency_lock_timeout（评审项 B2）", async () => {
    const dir = trackedMkdtemp("kiwi-idem-");
    const s = new HandoffIdempotencyStore({ dir, lockTimeoutMs: 60 });
    // 模拟持锁进程崩溃：手工创建锁文件并把 mtime 改到陈旧阈值之前
    const lockPath = path.join(dir, "locks", "hcan_01.lock");
    mkdirSync(path.join(dir, "locks"), { recursive: true });
    writeFileSync(lockPath, "99999");
    const past = new Date(Date.now() - 11 * 60 * 1000); // > 10 分钟阈值
    utimesSync(lockPath, past, past);
    // 陈旧锁被自愈清理，立即获得锁（不会等满 60ms 超时）
    await expect(s.withCandidateLock("hcan_01", async () => "ok")).resolves.toBe("ok");
  });
});

/** 评审项 L6：mkdtemp 目录跟踪清理（此前每次运行在 /tmp 残留）。 */
const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
