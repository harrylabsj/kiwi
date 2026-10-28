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

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";

export interface ManagedServiceSpec {
  /** 服务名（a2a / mcp 等，作为文件名须安全）。 */
  name: string;
  /** 完整 argv（如 [process.execPath, "dist/cli.js", "merchant", "start", "--no-chat"]）。 */
  command: string[];
  env?: Record<string, string>;
  /** 确定的工作目录（BUG-04：缺省 = 数据根目录语义由调用方保证）。 */
  cwd?: string;
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
    readonly code: "unknown_service" | "already_running" | "not_running" | "spawn_failed" | "stop_unconfirmed",
  ) {
    super(message);
    this.name = "MerchantRuntimeError";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. Permission/observation failure cannot prove a stopped service.
    return (error as { code?: string }).code !== "ESRCH";
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
  stopToken?: string;
}

interface PidRecord {
  pid: number;
  command: string[];
  cwd?: string;
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

  private stoppedFile(name: string): string { return path.join(this.runDir, `${name}.stopped`); }
  private stopIntent(name: string): { stopped: boolean; token?: string } {
    const file = this.stoppedFile(name);
    if (!existsSync(file)) return { stopped: false };
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof value === "object" && value !== null && "stopped" in value && "token" in value
        && typeof value.stopped === "boolean" && typeof value.token === "string" && value.token !== "")
        return { stopped: value.stopped, token: value.token };
    } catch { /* Unknown intent remains stopped; it cannot trigger an automatic launch. */ }
    return { stopped: true, token: "unknown-stop-intent" };
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
      const record = JSON.parse(readFileSync(this.pidFile(name), "utf8")) as PidRecord;
      if (!Number.isInteger(record.pid) || record.pid <= 0 || !pidAlive(record.pid)) return undefined;
      const matched = this.matchesProcess(record.pid, this.spec(name));
      if (matched === false) return undefined;
      // matched === true | "unknown"：unknown（ps 不可用/超时）时 pid 存活 +
      // pidfile 记录即证据——按存活认领，绝不 fail-open 双 spawn（审查 P2）。
      return record.pid;
    } catch {
      return undefined;
    }
  }

  /**
   * PID 存活不等于仍是 Kiwi 子进程；校验命令行，避免 PID 复用误杀。
   * 返回 "unknown" = 查询手段失败（ps 缺失/超时）——不能证明进程不存在，
   * 调用方按保守（存活）处理，绝不据此重拉新实例（审查 P2 fail-open 修复）。
   */
  private matchesProcess(pid: number, spec: ManagedServiceSpec): boolean | "unknown" {
    // Windows does not provide a portable command-line query through the
    // standard Node APIs; keep the live-pid behavior there and rely on the
    // service manager's per-instance directory isolation.
    if (process.platform === "win32") return true;
    try {
      const commandLine = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim();
      return spec.command.every((arg) => arg === "" || commandLine.includes(arg));
    } catch {
      return "unknown";
    }
  }

  private scheduleRestart(name: string, previous: RunningChild): void {
    const delay = backoffMs(previous.restarts);
    setTimeout(() => {
      if (!this.supervising || previous.stopped || this.stopIntent(name).stopped || this.stopIntent(name).token !== previous.stopToken) return;
      void this.launch(name, false, { token: previous.stopToken })
        .then(() => {
          const next = this.children.get(name);
          if (next !== undefined) next.restarts = previous.restarts;
        })
        .catch(() => {
          // 配置/权限/工作目录错误也按退避持续重试，保持 7×24 manager 存活。
          if (this.supervising && !previous.stopped && !this.stopIntent(name).stopped && this.stopIntent(name).token === previous.stopToken) {
            previous.restarts = Math.min(previous.restarts + 1, 32);
            this.scheduleRestart(name, previous);
          }
        });
    }, delay).unref();
  }

  /** 启动服务（已在运行 → already_running 拒绝重复启动）。 */
  async start(name: string): Promise<ManagedServiceState> { return this.launch(name, true); }

  private async launch(name: string, explicit: boolean, expectedIntent?: { token?: string }): Promise<ManagedServiceState> {
    const spec = this.spec(name);
    const observedIntent = this.stopIntent(name);
    if (!explicit && (observedIntent.stopped || (expectedIntent !== undefined && observedIntent.token !== expectedIntent.token))) return this.stateOf(name);
    const existing = this.livePid(name);
    if (existing !== undefined) {
      throw new MerchantRuntimeError(`服务 ${name} 已在运行（pid ${existing}）`, "already_running");
    }
    const intent = this.stopIntent(name);
    if (explicit && intent.stopped) writeFileAtomic(this.stoppedFile(name), JSON.stringify({ stopped: false, token: intent.token ?? randomUUID() }) + "\n", { mode: 0o600 });
    const child = this.spawnImpl(spec.command[0] ?? "", spec.command.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...spec.env },
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    });
    // An invalid executable emits `error` asynchronously; attach a listener
    // before checking pid so a failed spawn cannot crash the runtime manager.
    child.once("error", () => undefined);
    child.unref();
    if (child.pid === undefined) {
      throw new MerchantRuntimeError(`服务 ${name} 启动失败（无 pid）`, "spawn_failed");
    }
    const state: RunningChild = { pid: child.pid, restarts: 0, stopped: false, stopToken: this.stopIntent(name).token };
    this.children.set(name, state);
    try {
      writeFileSync(
        this.pidFile(name),
        `${JSON.stringify({ pid: child.pid, command: spec.command, ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}) })}\n`,
        { mode: 0o600 },
      );
    } catch (err) {
      // 审查 P2：pidfile 写失败时子进程已在跑——不回滚就会出现「无 pidfile
      // 的活子进程」，异常路径重试会双 spawn（双 a2a 抢账本/端口）。
      this.children.delete(name);
      try {
        child.kill("SIGTERM");
      } catch {
        // 已退出
      }
      throw new MerchantRuntimeError(
        `服务 ${name} pidfile 写入失败，已终止刚启动的子进程：` +
          `${err instanceof Error ? err.message : String(err)}`,
        "spawn_failed",
      );
    }
    rmSync(this.exitFile(name), { force: true });
    let finalized = false;
    const finalize = (code: number | null): void => {
      if (finalized) return;
      finalized = true;
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
        this.scheduleRestart(name, current);
      }
    };
    // spawn 的 error 事件若无监听会成为未处理 EventEmitter 错误，直接退出 manager。
    child.once("error", () => finalize(null));
    child.once("exit", (code) => finalize(code));
    return this.stateOf(name);
  }

  /** 停止服务（SIGTERM；显式停止后不自动重启）。 */
  async stop(name: string): Promise<ManagedServiceState> {
    return await this.terminate(name, { persistIntent: true });
  }

  /**
   * 停止服务本体。`persistIntent=false` 用于**优雅关闭**（supervisor 收到
   * SIGTERM 后停全部子进程）：此时不写 `<name>.stopped`，否则下一次
   * `runtime start` 的 supervise() 会把它们当成操作员显式停止而不拉起——
   * systemd `Restart=always` 重启一次就把 A2A/MCP 永久停掉（生产事故：
   * 2026-10-28 重启 kiwi-merchant-v2 后 A2A 502）。
   */
  private async terminate(
    name: string,
    options: { persistIntent: boolean },
  ): Promise<ManagedServiceState> {
    this.spec(name);
    if (options.persistIntent) {
      writeFileAtomic(this.stoppedFile(name), JSON.stringify({ stopped: true, token: randomUUID() }) + "\n", { mode: 0o600 });
    }
    const current = this.children.get(name);
    if (current !== undefined) current.stopped = true;
    let pid = current?.pid ?? this.livePid(name);
    if (pid === undefined) {
      // 审查 P2：spec（argv）变更后旧进程与新 spec 命令行不符，livePid 认领
      // 不到——按 pidfile 原始记录的 command 校验并停掉，否则旧进程永远停
      // 不掉且 start 会双跑（旧实例以旧策略继续对外报价）。
      try {
        const record = JSON.parse(readFileSync(this.pidFile(name), "utf8")) as PidRecord;
        if (
          Number.isInteger(record.pid) &&
          record.pid > 0 &&
          pidAlive(record.pid) &&
          this.matchesProcess(record.pid, {
            name,
            command: record.command,
            ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
          }) !== false
        ) {
          pid = record.pid;
        }
      } catch {
        // 无 pidfile / 解析失败：按无进程处理
      }
    }
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
    if (pidAlive(pid)) {
      // The stop intent blocks future supervisor launches; liveness is still unconfirmed, keep its pid evidence.
      throw new MerchantRuntimeError(`服务 ${name} 停止意图已记录，但 pid ${pid} 仍未确认退出`, "stop_unconfirmed");
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
      stopped: this.stopIntent(name).stopped || (current?.stopped ?? pid === undefined),
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
      if (pid === undefined && !this.stopIntent(name).stopped) await this.launch(name, false);
    }
  }

  /**
   * 停止监控并停掉全部服务（优雅关闭）。**不写显式停止意图**：进程退出后
   * 由 systemd 重新拉起本进程，supervise() 必须能把子服务重新启动；显式
   * `runtime stop` 的意图仍由 stop() 保留（见 terminate 注释）。
   */
  async shutdown(): Promise<void> {
    this.supervising = false;
    for (const name of [...this.services.keys()].reverse()) {
      await this.terminate(name, { persistIntent: false });
    }
  }
}
