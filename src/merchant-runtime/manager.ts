/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Merchant 实例运行时管理（V2 阶段一：src/merchant-runtime/manager.ts）。
 *
 * 独立管理进程语义：A2A 接待服务与 MCP 管理服务作为受管子进程管理，
 * 互不影响——停止 A2A 后管理入口（本 manager）仍可重启它（阶段一验收项）。
 * WorkBuddy / MCP 会话退出不影响受管服务（detached + unref）。
 *
 * 进程状态落 `<dir>/runtime/`：`<name>.pid` / `<name>.log` / `<name>.exit.json`。
 * 自动重启：supervise() 监控子进程异常退出并按退避重启；显式 stop 的不重启。
 * 阶段一为单活形态；主备 fencing 留阶段四（V2 §5.3）。
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ManagedServiceSpec {
  /** 服务名（a2a / mcp 等，作为文件名须安全）。 */
  name: string;
  /** 完整 argv（如 [process.execPath, "dist/cli.js", "merchant", "start", "--no-chat"]）。 */
  command: string[];
  env?: Record<string, string>;
}

export interface ManagedServiceState {
  name: string;
  running: boolean;
  pid?: number;
  restarts: number;
  /** 显式停止（stop）后不再自动重启，直到再次 start。 */
  stopped: boolean;
  last_exit?: { exit_code: number | null; at: string };
}

export class MerchantRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_service" | "already_running" | "not_running" | "spawn_failed",
  ) {
    super(message);
    this.name = "MerchantRuntimeError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 异常退出后的重启退避（毫秒；指数，封顶 30s）。 */
function backoffMs(restarts: number): number {
  return Math.min(30_000, 500 * 2 ** Math.min(restarts, 6));
}

interface RunningChild {
  pid: number;
  restarts: number;
  stopped: boolean;
}

export class MerchantRuntimeManager {
  private readonly dir: string;
  private readonly runDir: string;
  private readonly services = new Map<string, ManagedServiceSpec>();
  private readonly children = new Map<string, RunningChild>();
  private readonly now: () => string;
  private readonly spawnImpl: typeof spawn;

  constructor(options: {
    dir: string;
    services: ManagedServiceSpec[];
    now?: () => string;
    /** 测试注入。 */
    spawnImpl?: typeof spawn;
  }) {
    this.dir = options.dir;
    this.runDir = path.join(options.dir, "runtime");
    this.now = options.now ?? (() => new Date().toISOString());
    this.spawnImpl = options.spawnImpl ?? spawn;
    for (const spec of options.services) {
      if (!/^[a-z0-9-]+$/.test(spec.name)) {
        throw new MerchantRuntimeError(`非法服务名 ${spec.name}`, "unknown_service");
      }
      this.services.set(spec.name, spec);
    }
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
  }

  private pidFile(name: string): string {
    return path.join(this.runDir, `${name}.pid`);
  }

  private logFile(name: string): string {
    return path.join(this.runDir, `${name}.log`);
  }

  private exitFile(name: string): string {
    return path.join(this.runDir, `${name}.exit.json`);
  }

  private spec(name: string): ManagedServiceSpec {
    const spec = this.services.get(name);
    if (spec === undefined) {
      throw new MerchantRuntimeError(
        `未知服务 ${name}（已知：${[...this.services.keys()].join(", ")}）`,
        "unknown_service",
      );
    }
    return spec;
  }

  /** 读取 pidfile 里的存活状态（管理入口重启后据此恢复视图）。 */
  private livePid(name: string): number | undefined {
    try {
      const pid = Number(readFileSync(this.pidFile(name), "utf8").trim());
      return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** 启动服务（已在运行 → already_running 拒绝重复启动）。 */
  async start(name: string): Promise<ManagedServiceState> {
    const spec = this.spec(name);
    const existing = this.livePid(name);
    if (existing !== undefined) {
      throw new MerchantRuntimeError(`服务 ${name} 已在运行（pid ${existing}）`, "already_running");
    }
    const child = this.spawnImpl(spec.command[0] ?? "", spec.command.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...spec.env },
    });
    child.unref();
    if (child.pid === undefined) {
      throw new MerchantRuntimeError(`服务 ${name} 启动失败（无 pid）`, "spawn_failed");
    }
    const state: RunningChild = { pid: child.pid, restarts: 0, stopped: false };
    this.children.set(name, state);
    writeFileSync(this.pidFile(name), `${child.pid}\n`, { mode: 0o600 });
    rmSync(this.exitFile(name), { force: true });
    child.on("exit", (code) => {
      writeFileSync(
        this.exitFile(name),
        `${JSON.stringify({ exit_code: code, at: this.now() })}\n`,
        { mode: 0o600 },
      );
      const current = this.children.get(name);
      this.children.delete(name);
      rmSync(this.pidFile(name), { force: true });
      // 异常退出自动重启（显式 stop 的不重启）；退避防崩溃风暴。
      if (current !== undefined && !current.stopped && this.supervising) {
        current.restarts += 1;
        const delay = backoffMs(current.restarts);
        setTimeout(() => {
          if (this.supervising && !current.stopped) {
            void this.start(name).then((s) => {
              const next = this.children.get(name);
              if (next !== undefined) next.restarts = current.restarts;
              void s;
            });
          }
        }, delay).unref();
      }
    });
    return this.stateOf(name);
  }

  /** 停止服务（SIGTERM；显式停止后不自动重启）。 */
  async stop(name: string): Promise<ManagedServiceState> {
    this.spec(name);
    const current = this.children.get(name);
    if (current !== undefined) current.stopped = true;
    const pid = current?.pid ?? this.livePid(name);
    if (pid === undefined) {
      rmSync(this.pidFile(name), { force: true });
      return this.stateOf(name);
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && pidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
    this.children.delete(name);
    rmSync(this.pidFile(name), { force: true });
    return this.stateOf(name);
  }

  /** 重启（停止 → 启动）；停止 A2A 后管理入口可重启它（阶段一验收项）。 */
  async restart(name: string): Promise<ManagedServiceState> {
    await this.stop(name);
    return await this.start(name);
  }

  private stateOf(name: string): ManagedServiceState {
    const current = this.children.get(name);
    const pid = current?.pid ?? this.livePid(name);
    let lastExit: ManagedServiceState["last_exit"];
    try {
      lastExit = JSON.parse(
        readFileSync(this.exitFile(name), "utf8"),
      ) as ManagedServiceState["last_exit"];
    } catch {
      lastExit = undefined;
    }
    return {
      name,
      running: pid !== undefined,
      ...(pid !== undefined ? { pid } : {}),
      restarts: current?.restarts ?? 0,
      stopped: current?.stopped ?? pid === undefined,
      ...(lastExit !== undefined && lastExit !== null ? { last_exit: lastExit } : {}),
    };
  }

  /** 全部服务状态。 */
  status(): ManagedServiceState[] {
    return [...this.services.keys()].map((name) => this.stateOf(name));
  }

  /** 监控模式（runtime start 前台运行）：启动全部服务并保持，异常退出自动重启。 */
  private supervising = false;

  async supervise(): Promise<void> {
    this.supervising = true;
    for (const name of this.services.keys()) {
      const pid = this.livePid(name);
      if (pid === undefined) await this.start(name);
    }
  }

  /** 停止监控并停掉全部服务（优雅关闭）。 */
  async shutdown(): Promise<void> {
    this.supervising = false;
    for (const name of [...this.services.keys()].reverse()) {
      await this.stop(name);
    }
  }
}
