/**
 * M1 收尾：真实双进程冷/热启动集成验证（D-M0-08 / X12）。
 * 两个子进程同时启动（新库：迁移 + 账本 + acquire 竞争）→ 有界重试后恰一
 * active；失败者 fail-closed（active=false）且不写；热启动验证释放后可复用。
 * 子进程由 esbuild 打包产品源码（不依赖运行时 TS 转换）。
 */
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("真实双进程冷/热启动（governance 所有权）", () => {
  it("同时启动恰一 active、失败者不写、进程/目录可靠清理", async () => {
    // 真实 OS 进程（esbuild 打包产品源码）：两个子进程同时启动（新库：迁移
    // + 账本 + acquire 竞争）→ 有界重试后恰一 active；失败者 fail-closed
    // （active=false）且不写；随后热启动验证释放后可复用。
    const dir = mkdtempSync(join(tmpdir(), "kiwi-m1-dualproc-"));
    const dbPath = join(dir, "state.sqlite");
    const resultDir = join(dir, "results");
    const releaseMarker = join(dir, "release.marker");
    const entryMjs = join(dir, "child-entry.mjs");
    const childMjs = join(dir, "child.mjs");
    const CHILD_ENTRY = [
      'import { DatabaseSync } from "node:sqlite";',
      'import { existsSync, mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { initializeGovernanceRuntime } from "<SRC>/merchant-core/ownership/runtime.js";',
      'import { parseGovernanceFeatureFlags } from "<SRC>/merchant-core/context-governance/feature-flags.js";',
      '',
      'const [dbPath, resultDir, releaseMarker, ownerId, goMarker, hotMode] = process.argv.slice(2);',
      'const db = new DatabaseSync(dbPath);',
      'const flags = parseGovernanceFeatureFlags({ memory_enabled: true });',
      'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
      '// 屏障：等父进程的 go marker（保证两子进程都已 spawn 后才竞争锁）。',
      'const goDeadline = Date.now() + 15000;',
      'while (goMarker && !existsSync(goMarker) && Date.now() < goDeadline) sleep(10);',
      '// 热启动模式：先等所有权被释放（RELEASED/行消失）再启动 runtime。',
      'const hot = hotMode === "hot";',
      'if (hot) {',
      '  const hotDeadline = Date.now() + 45000;',
      '  while (Date.now() < hotDeadline) {',
      '    try {',
      '      const row = db.prepare("SELECT state FROM instance_ownership WHERE state = ?").get("RELEASED");',
      '      if (row !== undefined) break;',
      '    } catch { /* 表可能尚未建——继续等 */ }',
      '    sleep(20);',
      '  }',
      '}',
      'const runtime = initializeGovernanceRuntime({',
      '  db, merchantId: "m-1", flags, ownerId, leaseMs: 60000,',
      '});',
      'const active = runtime.active;',
      'mkdirSync(resultDir, { recursive: true });',
      'writeFileSync(join(resultDir, "child-" + ownerId + ".json"), JSON.stringify({ ownerId, active }));',
      'if (active) {',
      '  const deadline = Date.now() + 45000;',
      '  while (!existsSync(releaseMarker) && Date.now() < deadline) {',
      '    sleep(20);',
      '  }',
      '  runtime.stop();',
      '}',
      'db.close();',
    ].join("\n");
    writeFileSync(entryMjs, CHILD_ENTRY.replaceAll("<SRC>", resolve("src")));
    await build({
      entryPoints: [entryMjs],
      outfile: childMjs,
      bundle: true, format: "esm", platform: "node", target: "node22",
      sourcemap: false, logLevel: "silent",
    });
    const childStderrs: string[] = [];
    const spawnChild = (ownerId: string, goMarker?: string, hot = false): ChildProcess => {
      const c = spawn(process.execPath, [
        childMjs, dbPath, resultDir, releaseMarker, ownerId,
        ...(goMarker !== undefined ? [goMarker] : []),
        ...(hot ? ["hot"] : []),
      ]);
      c.stderr?.on("data", (chunk: Buffer) => {
        childStderrs.push(`[${ownerId}] ${chunk.toString("utf8").slice(0, 400)}`);
      });
      return c;
    };
    const goMarker = join(dir, "go.marker");
    let childA: ChildProcess | undefined;
    let childB: ChildProcess | undefined;
    let hotChild: ChildProcess | undefined;
    try {
      // 冷启动：两进程先 spawn（在 go 屏障前各自等待），父写 go 后才同时
      // 竞争锁——排除"一方先完成启动"的时序噪声，这是真正的同刻竞争。
      childA = spawnChild("proc-A", goMarker);
      childB = spawnChild("proc-B", goMarker);
      writeFileSync(goMarker, "go");
      // 等待两个结果文件：异步定时轮询（setTimeout，事件循环不被阻塞——
      // exit/stderr 事件可正常送达）。
      const waitResults = async (ms: number): Promise<Array<{ ownerId: string; active: boolean }>> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (existsSync(resultDir)) {
            const files = readdirSync(resultDir).filter((f: string) => f.endsWith(".json"));
            if (files.length >= 2) {
              return files.map((f) =>
                JSON.parse(readFileSync(join(resultDir, f), "utf8")) as {
                  ownerId: string; active: boolean;
                },
              );
            }
          }
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        return [];
      };
      const results = await waitResults(10000);
      expect(results).toHaveLength(2);
      expect(results.every((item) => typeof item.active === "boolean")).toBe(true);
      // 恰一 active（迁移 + acquire 竞争由有界重试收敛）。
      expect(results.filter((item) => item.active)).toHaveLength(1);
      const winner = results.find((item) => item.active)!;
      const loser = results.find((item) => !item.active)!;
      // 失败者 fail-closed：active=false（ownership_held 事件化）；
      // 胜负由 CAS 竞争决定（A/B 皆可能胜出），断言基于动态结果。
      expect(loser.ownerId === "proc-A" || loser.ownerId === "proc-B").toBe(true);
      // 所有权表恰 1 行（失败者无行——不得写入）。
      const probe = new DatabaseSync(dbPath);
      const rows = probe.prepare("SELECT owner_id, state FROM instance_ownership").all() as Array<{
        owner_id: string;
        state: string;
      }>;
      probe.close();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_id: winner.ownerId, state: "HELD" });
      // 放行 winner 退出（runtime.stop 释放所有权）——结果齐即放行，避免
      // winner 空等到父断言结束。
      writeFileSync(releaseMarker, "release");
      // 事件驱动等待两个子进程 exit（事件循环不被阻塞——exit/error 事件
      // 可正常送达）；期限 10s < 测试 timeout（30s）。
      const waitForBothExit = async (ms: number): Promise<boolean> => {
        const both = (): boolean =>
          childA!.exitCode !== null && childB!.exitCode !== null;
        if (both()) return true;
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          const onExit = (): void => {
            if (both()) { clearTimeout(timer); resolve(true); }
          };
          childA!.once("exit", onExit);
          childB!.once("exit", onExit);
        });
      };
      const exitedInTime = await waitForBothExit(10000);
      // 热启动子进程在下方段中 spawn 与等待退出（waitForBothExit 不含它）。
      if (!exitedInTime) {
        // 超时未退出：附上捕获的 stderr 帮助定位（不吞错误）。
        throw new Error(
          `kiwi-fixture: 子进程超时未退出（A exit=${childA!.exitCode}, B exit=${childB!.exitCode}）; ` +
            `stderr: ${childStderrs.join(" || ") || "(empty)"}`,
        );
      }
      expect(childA!.exitCode).toBe(0);
      expect(childB!.exitCode).toBe(0);
      // 热启动（真实进程）：所有权 RELEASED 后 spawn 第三个进程获取。
      const probe2 = new DatabaseSync(dbPath);
      expect(
        (probe2.prepare("SELECT state FROM instance_ownership").get() as { state: string }).state,
      ).toBe("RELEASED");
      probe2.close();
      // go 屏障传 release.marker（已存在）——热启动无需等待冷启动屏障。
      hotChild = spawnChild("proc-HOT", releaseMarker, true);
      const hotDeadline = Date.now() + 10000;
      let hotActive = false;
      let hotResultFile: string | undefined;
      while (Date.now() < hotDeadline) {
        const f = join(resultDir, "child-proc-HOT.json");
        if (existsSync(f)) {
          hotResultFile = f;
          hotActive = (JSON.parse(readFileSync(f, "utf8")) as { active: boolean }).active;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      // 诊断：结果文件内容 + stderr 帮助定位热启动失败原因。
      if (!hotActive) {
        throw new Error(
          `kiwi-fixture: 热启动未取得所有权（file=${hotResultFile ?? "missing"}）; ` +
            `stderr: ${childStderrs.filter((item) => item.includes("proc-HOT")).join(" || ") || "(empty)"}`,
        );
      }
      expect(hotActive).toBe(true);
    } finally {
      // 可靠清理（事件驱动）：放行信号 → 对确认仍存活的本次 child SIGTERM →
      // 限时（2s）事件驱动等退 → 仍存活才 SIGKILL → 删唯一目录。各步骤独立
      // 保护，互不跳过。
      try { writeFileSync(releaseMarker, "release"); } catch { /* 目录可能已不可用 */ }
      for (const c of [childA, childB, hotChild]) {
        if (c !== undefined && c.exitCode === null && c.signalCode === null && c.pid !== undefined) {
          c.kill("SIGTERM");
        }
      }
      const allGone = async (ms: number): Promise<boolean> => {
        const alive = (): boolean =>
          [childA, childB, hotChild].some(
            (c) => c !== undefined && c.exitCode === null && c.signalCode === null,
          );
        if (!alive()) return true;
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          const onExit = (): void => {
            if (!alive()) { clearTimeout(timer); resolve(true); }
          };
          childA?.once("exit", onExit);
          childB?.once("exit", onExit);
          hotChild?.once("exit", onExit);
        });
      };
      const graceful = await allGone(2000);
      if (!graceful) {
        // SIGKILL 兜底同样覆盖 hotChild；存活判定含 signalCode（信号退出时
        // exitCode 保持 null）。
        for (const c of [childA, childB, hotChild]) {
          if (c !== undefined && c.exitCode === null && c.signalCode === null && c.pid !== undefined) {
            c.kill("SIGKILL");
          }
        }
        await allGone(3000);
      }
      rmSync(dir, { recursive: true, force: true });
    }
    // 结束断言：两个子进程均已退出、唯一目录不存在。
    expect(childA!.exitCode).toBe(0);
    expect(childB!.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  }, 20000);
});
