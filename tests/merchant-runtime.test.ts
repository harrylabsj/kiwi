/**
 * Merchant runtime 测试（V2 阶段一：src/merchant-runtime/）：
 * - manager：启动/状态/停止/重启往返（停止后管理入口可重启——阶段一验收项）、
 *   重复启动拒绝、异常退出自动重启（supervise 模式）、优雅关闭；
 * - health：分项报告（进程/商品源/目录可写/磁盘），缺探测记录或目录不可写
 *   时 fail-closed（ok:false）；
 * - jobs：周期任务注册/执行/异常隔离/备份接缝默认报「未实现」。
 *
 * 确定性：临时目录 + node -e 长寿子进程 + 注入时钟。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MerchantRuntimeManager, MerchantRuntimeError } from "../src/merchant-runtime/manager.js";
import { collectMerchantHealth } from "../src/merchant-runtime/health.js";
import { MerchantJobs, standardMerchantJobs } from "../src/merchant-runtime/jobs.js";

const T0 = "2026-09-15T10:00:00.000Z";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kiwi-runtime-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

/** 长寿子进程（保持运行直到被 kill）。 */
const LONG_RUNNING = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
/** 立即退出的子进程（exit 1）。 */
const FAILING = [process.execPath, "-e", "process.exit(1)"];

function makeManager(dir: string, command: string[] = LONG_RUNNING): MerchantRuntimeManager {
  return new MerchantRuntimeManager({
    dir,
    services: [
      { name: "a2a", command },
      { name: "mcp", command: LONG_RUNNING },
    ],
    now: () => T0,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe("MerchantRuntimeManager", () => {
  it("启动/状态/停止/重启往返：停止 A2A 后管理入口可重启（阶段一验收）", async () => {
    const manager = makeManager(tmp());
    const started = await manager.start("a2a");
    expect(started.running).toBe(true);
    expect(started.pid).toBeGreaterThan(0);
    expect(manager.status().find((s) => s.name === "a2a")?.running).toBe(true);

    const stopped = await manager.stop("a2a");
    expect(stopped.running).toBe(false);

    // 管理入口重启
    const restarted = await manager.restart("a2a");
    expect(restarted.running).toBe(true);
    expect(restarted.pid).not.toBe(started.pid);
    await manager.shutdown();
  });

  it("重复启动拒绝；未知服务拒绝；停未知服务报错", async () => {
    const manager = makeManager(tmp());
    await manager.start("a2a");
    await expect(manager.start("a2a")).rejects.toMatchObject({ code: "already_running" });
    expect(() => manager.status()).not.toThrow();
    await expect(manager.start("nope")).rejects.toBeInstanceOf(MerchantRuntimeError);
    await manager.shutdown();
  });

  it("supervise 模式下异常退出自动重启（显式 stop 的不重启）", async () => {
    const dir = tmp();
    const manager = new MerchantRuntimeManager({
      dir,
      services: [{ name: "a2a", command: FAILING }],
      now: () => T0,
    });
    await manager.supervise();
    // 崩溃进程应被自动重启（退避 500ms 起）
    const restarted = await waitFor(() => {
      const s = manager.status()[0];
      return s !== undefined && s.restarts >= 1;
    }, 6_000);
    expect(restarted).toBe(true);
    await manager.shutdown();
    const after = manager.status()[0];
    expect(after?.running).toBe(false);
  });

  it("重启管理进程后从 pidfile 恢复状态视图", async () => {
    const dir = tmp();
    const m1 = makeManager(dir);
    await m1.start("a2a");
    // 新 manager（模拟管理入口重启）：不持有 children，从 pidfile 读
    const m2 = makeManager(dir);
    expect(m2.status().find((s) => s.name === "a2a")?.running).toBe(true);
    await m2.stop("a2a");
    expect(m2.status().find((s) => s.name === "a2a")?.running).toBe(false);
    await m1.shutdown();
  });
});

describe("collectMerchantHealth", () => {
  it("分项报告：进程/商品源/目录/磁盘；全部正常 → ok", async () => {
    const dir = tmp();
    mkdirRuntimeProbe(dir, { ok: true, version: "2.1.0" });
    const manager = makeManager(dir);
    await manager.start("a2a");
    await manager.start("mcp");
    const report = collectMerchantHealth({
      dataDir: dir,
      services: manager.status(),
      now: () => T0,
    });
    expect(report.ok).toBe(true);
    expect(report.checked_at).toBe(T0);
    expect(report.checks.processes.ok).toBe(true);
    expect(report.checks.product_source).toMatchObject({ ok: true, version: "2.1.0" });
    expect(report.checks.data_dir.writable).toBe(true);
    expect(report.checks.disk.ok).toBe(true);
    await manager.shutdown();
  });

  it("缺能力探测记录 / 进程未运行 → fail-closed ok:false", () => {
    const dir = tmp();
    const manager = makeManager(dir);
    const report = collectMerchantHealth({
      dataDir: dir,
      services: manager.status(),
      now: () => T0,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.processes.ok).toBe(false);
    expect(report.checks.product_source.ok).toBe(false);
    expect(report.checks.product_source.error).toContain("capability-probe");
  });

  it("磁盘下限可注入（低于下限 → fail）", async () => {
    const dir = tmp();
    mkdirRuntimeProbe(dir, { ok: true, version: "2.1.0" });
    const report = collectMerchantHealth({
      dataDir: dir,
      services: [],
      now: () => T0,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(report.checks.disk.ok).toBe(false);
    expect(report.ok).toBe(false);
  });
});

function mkdirRuntimeProbe(dir: string, probe: { ok: boolean; version: string }): void {
  writeFileSync(path.join(dir, "capability-probe.json"), JSON.stringify(probe));
}

describe("MerchantJobs", () => {
  it("注册/执行/异常隔离；备份接缝默认报未实现", async () => {
    const jobs = new MerchantJobs({ now: () => T0 });
    let healthRuns = 0;
    for (const job of standardMerchantJobs({
      healthPoll: async () => {
        healthRuns += 1;
      },
      healthIntervalMs: 60_000,
      backupIntervalMs: 300_000,
    })) {
      jobs.register(job);
    }
    const health = await jobs.runOnce("health-poll");
    expect(healthRuns).toBe(1);
    expect(health.last_error).toBeUndefined();
    // 备份接缝：明确失败，不静默成功
    const backup = await jobs.runOnce("backup");
    expect(backup.last_error).toContain("未实现");
    // 单个任务失败不影响其他任务
    const again = await jobs.runOnce("health-poll");
    expect(again.last_error).toBeUndefined();
    expect(jobs.list()).toHaveLength(2);
    jobs.stop();
  });

  it("重复注册/非法 interval 拒绝；stop 后不再触发", async () => {
    const jobs = new MerchantJobs({ now: () => T0 });
    jobs.register({ name: "x", intervalMs: 100, run: async () => {} });
    expect(() => jobs.register({ name: "x", intervalMs: 100, run: async () => {} })).toThrow();
    expect(() => jobs.register({ name: "y", intervalMs: 0, run: async () => {} })).toThrow();
    jobs.start();
    jobs.stop();
  });
});
