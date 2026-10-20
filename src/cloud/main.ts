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
 * 云端 Runtime 进程入口（平台以单端口 HTTP 服务方式启动）。
 *
 *   node cloud/main.js            # 云端制品内的入口
 *
 * 失败即非零退出：配置缺失、状态目录不安全、装配失败、端口占用都不会被
 * 降级处理（没有"换端口重试"路径）。信号处理只做优雅关闭。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { OwnedRuntimeHandle } from "./owned-runtime.js";
import type { OwnedStopResult } from "./owned-runtime.js";

import { withCloseDeadline } from "../lifecycle/close.js";
import type { CloudRuntimeConfig } from "./config.js";

/** Current package engines floor; evaluated before importing the sqlite/bootstrap chain. */
export function isNodeBelowSupportLine(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return true;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  return !Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch) || major < 22 || (major === 22 && minor < 19);
}

export function createCloudShutdown(
  close: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  write: (text: string) => void = (text) => { process.stderr.write(text); },
  timeoutMs = 60_000,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return () => {
    if (!inFlight) inFlight = (async () => {
      let code = 0;
      try { await withCloseDeadline(Promise.resolve().then(close), timeoutMs); }
      catch {
        code = 1;
        try { write("[kiwi-cloud] 关闭失败（RESOURCE_CLOSE_FAILED），资源释放未确认。\n"); } catch { /* Still exit nonzero if the log sink failed. */ }
      }
      exit(code);
    })();
    return inFlight;
  };
}

/** Why a bounded cloud lifetime ended. Ordinary pre-deadline shutdown is deliberately separate. */
export type OwnedCloudDeadlineEndReason =
  | "WALL_DEADLINE"
  | "MONOTONIC_BUDGET_EXHAUSTED"
  | "CLOCK_INVALID_OR_REGRESSED";

/** Context for the owner-fenced caller that must persist its own durable terminal state. */
export interface OwnedCloudDeadlineEndContext {
  reason: OwnedCloudDeadlineEndReason;
  deadlineMs: number;
  initialWallMs: number;
  initialMonotonicMs: number;
  observedWallMs: number;
  observedMonotonicMs: number;
  signal: AbortSignal;
}

/**
 * 唯一可信的同进程 host 控制面。它只暴露无参永久停止，不是 HTTP/MCP/CLI/IPC 接口；
 * runCloudMain 不持有或导出该对象，SIGTERM 仍只走可恢复 close。
 */
export interface OwnedCloudHost {
  stopPermanently(): Promise<OwnedStopResult>;
}

export function createOwnedCloudHost<T>(handle: OwnedRuntimeHandle<T>): OwnedCloudHost {
  return Object.freeze({ stopPermanently: () => handle.stopPermanently() });
}

export interface OwnedCloudLifetimeInstance {
  server: Pick<Server, "close" | "closeAllConnections">;
  close: () => Promise<void>;
}

export interface OwnedCloudLifetimeDeps {
  now?: () => number;
  monotonicNow?: () => number;
  initialNowMs?: number;
  initialMonotonicMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** Resolve only after the consumer has durably terminalized and verified its own state. */
  onDeadlineEnd?: (context: OwnedCloudDeadlineEndContext) => void | Promise<void>;
  /** Small bound for owner-fenced persistence; values above five seconds are rejected. */
  deadlineEndTimeoutMs?: number;
  exit?: (code: number) => void;
  write?: (text: string) => void;
  timeoutMs?: number;
}

/**
 * Bound one already-owned SDK instance to both wall and monotonic time.
 * The consumer owns durable terminal state; ordinary pre-deadline shutdown stays resumable.
 */
export function createOwnedCloudLifetime(
  instance: OwnedCloudLifetimeInstance,
  deadlineMs: number,
  deps: OwnedCloudLifetimeDeps = {},
): { shutdown: () => Promise<void>; deadlineMs: number; isStopping: () => boolean } {
  const now = deps.now ?? Date.now;
  const monotonicNow = deps.monotonicNow ?? (() => performance.now());
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const callbackTimeoutMs = deps.deadlineEndTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(deadlineMs) || !instance?.server || typeof instance.server.close !== "function" ||
      typeof instance.server.closeAllConnections !== "function" || typeof instance.close !== "function" ||
      !Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 1 || callbackTimeoutMs > 5_000) {
    throw new Error("OWNED_INSTANCE_LIFECYCLE_REQUIRED");
  }

  let initialWallMs = Number.NaN;
  let initialMonotonicMs = Number.NaN;
  let initialSampleFailed = false;
  try { initialWallMs = deps.initialNowMs ?? now(); }
  catch { initialSampleFailed = true; }
  try { initialMonotonicMs = deps.initialMonotonicMs ?? monotonicNow(); }
  catch { initialSampleFailed = true; }
  if (!Number.isSafeInteger(initialWallMs) || !Number.isFinite(initialMonotonicMs)) initialSampleFailed = true;
  const initialBudgetMs = deadlineMs - initialWallMs;
  let lastWallMs = initialWallMs;
  let lastMonotonicMs = initialMonotonicMs;
  let timer: unknown;
  let stopping = false;
  let ingressError: unknown;
  let deadlineEndPromise: Promise<void> | undefined;
  let ordinaryShutdownPromise: Promise<void> | undefined;

  const finish = createCloudShutdown(async () => {
    await instance.close();
    if (ingressError !== undefined) throw ingressError;
  }, deps.exit, deps.write, deps.timeoutMs);

  const stopIngress = (): void => {
    if (stopping) return;
    stopping = true;
    if (timer !== undefined) clearTimer(timer);
    try { instance.server.close(); }
    catch (error) { ingressError ??= error; }
  };

  const closeRemainingAndFinish = async (): Promise<void> => {
    try { instance.server.closeAllConnections(); }
    catch (error) { ingressError ??= error; }
    await finish();
  };

  const deadlineReason = (observedWallMs: number, observedMonotonicMs: number): OwnedCloudDeadlineEndReason | undefined => {
    if (!Number.isSafeInteger(observedWallMs) || !Number.isSafeInteger(lastWallMs) || observedWallMs < lastWallMs ||
        !Number.isFinite(observedMonotonicMs) || !Number.isFinite(lastMonotonicMs) || observedMonotonicMs < lastMonotonicMs) {
      return "CLOCK_INVALID_OR_REGRESSED";
    }
    if (observedWallMs >= deadlineMs) return "WALL_DEADLINE";
    const monotonicRemainingMs = initialBudgetMs - (observedMonotonicMs - initialMonotonicMs);
    if (!Number.isFinite(monotonicRemainingMs)) return "CLOCK_INVALID_OR_REGRESSED";
    if (monotonicRemainingMs <= 0) return "MONOTONIC_BUDGET_EXHAUSTED";
    lastWallMs = observedWallMs;
    lastMonotonicMs = observedMonotonicMs;
    return undefined;
  };

  const endForDeadline = (
    reason: OwnedCloudDeadlineEndReason,
    observedWallMs: number,
    observedMonotonicMs: number,
  ): Promise<void> => {
    if (deadlineEndPromise) return deadlineEndPromise;
    stopIngress();
    const controller = new AbortController();
    deadlineEndPromise = Promise.resolve().then(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const callback = Promise.resolve().then(() => {
        if (!deps.onDeadlineEnd) throw new Error("OWNED_DEADLINE_CALLBACK_REQUIRED");
        return deps.onDeadlineEnd({ reason, deadlineMs, initialWallMs, initialMonotonicMs,
          observedWallMs, observedMonotonicMs, signal: controller.signal });
      });
      const bounded = new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("OWNED_DEADLINE_CALLBACK_TIMEOUT"));
          controller.abort();
        }, callbackTimeoutMs);
      });
      try { await Promise.race([callback, bounded]); }
      catch (error) {
        ingressError ??= error;
        try { (deps.write ?? ((text) => { process.stderr.write(text); }))(
          "[kiwi-cloud] 截止回调失败（OWNED_DEADLINE_END_FAILED），SDK仍将关闭。\n"); }
        catch { /* Shutdown must not depend on the log sink. */ }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      await closeRemainingAndFinish();
    });
    return deadlineEndPromise;
  };

  const shutdown = (): Promise<void> => {
    if (deadlineEndPromise) return deadlineEndPromise;
    if (ordinaryShutdownPromise) return ordinaryShutdownPromise;
    let observedWallMs: number, observedMonotonicMs: number;
    try { observedWallMs = now(); observedMonotonicMs = monotonicNow(); }
    catch { return endForDeadline("CLOCK_INVALID_OR_REGRESSED", Number.NaN, Number.NaN); }
    const reason = deadlineReason(observedWallMs, observedMonotonicMs);
    if (reason) return endForDeadline(reason, observedWallMs, observedMonotonicMs);
    stopIngress();
    ordinaryShutdownPromise = closeRemainingAndFinish();
    return ordinaryShutdownPromise;
  };

  const tick = (): void => {
    if (stopping) return;
    let observedWallMs: number, observedMonotonicMs: number;
    try { observedWallMs = now(); observedMonotonicMs = monotonicNow(); }
    catch {
      void endForDeadline("CLOCK_INVALID_OR_REGRESSED", Number.NaN, Number.NaN);
      return;
    }
    const reason = deadlineReason(observedWallMs, observedMonotonicMs);
    if (reason) { void endForDeadline(reason, observedWallMs, observedMonotonicMs); return; }
    const monotonicRemainingMs = initialBudgetMs - (observedMonotonicMs - initialMonotonicMs);
    const remainingMs = Math.min(deadlineMs - observedWallMs, monotonicRemainingMs);
    timer = setTimer(tick, Math.min(remainingMs, 2_147_483_647));
  };

  if (initialSampleFailed) {
    let observedWallMs = Number.NaN, observedMonotonicMs = Number.NaN;
    try { observedWallMs = now(); } catch { /* Preserve UNKNOWN in the fixed callback context. */ }
    try { observedMonotonicMs = monotonicNow(); } catch { /* Preserve UNKNOWN in the fixed callback context. */ }
    void endForDeadline("CLOCK_INVALID_OR_REGRESSED", observedWallMs, observedMonotonicMs);
  } else {
    tick();
  }
  return { shutdown, deadlineMs, isStopping: () => stopping };
}

/**
 * owned 模式启动（MANAGER-APPROVAL-SCOPE-v2 §B）：配置策略 → 能力探针 → owner →
 * 计数/期限 → 才 bootstrap（Core/listener）。关闭由返回句柄负责，进程退出由宿主决定。
 */
export async function startOwnedCloudRuntime(
  env: Record<string, string | undefined> = process.env,
  options: { artifactRoot?: string; configFile?: string; config?: CloudRuntimeConfig } = {},
): Promise<{ handle: OwnedRuntimeHandle<{ close: () => Promise<void> | void }>; config: CloudRuntimeConfig; host: OwnedCloudHost }> {
  // 动态导入：main.js 单独可加载（入口层测试与 Node 版本门不预拉 sqlite/config 链）。
  const [{ loadCloudConfig }, { startOwnedRuntime }] = await Promise.all([
    import("./config.js"),
    import("./owned-runtime.js"),
  ]);
  // 唯一不可变配置：已传入则绝不再读盘（TOCTOU）。
  const config = options.config ?? loadCloudConfig(env, options);
  if (config.ownedRuntime !== "require" || config.ownedPolicy === undefined) {
    throw new Error("OWNED_RUNTIME_NOT_REQUIRED");
  }
  process.env.KIWI_CLOUD_CONFIG = config.configFile;
  // 请求预留回调需要在 bootstrap 期间可用；handle 尚未返回时一律 fail-closed。
  const runtimeRef: { current?: OwnedRuntimeHandle<{ close: () => Promise<void> | void }> } = {};
  const requireRuntime = (): OwnedRuntimeHandle<{ close: () => Promise<void> | void }> => {
    if (runtimeRef.current === undefined) {
      throw Object.assign(new Error("owned runtime 尚未就绪"), { code: "OWNED_RUNTIME_NOT_READY" });
    }
    return runtimeRef.current;
  };
  const handle = await startOwnedRuntime<{ close: () => Promise<void> | void }>({
    dataDir: config.dataDir,
    policy: config.ownedPolicy,
    // 探针父目录（探针只在其下自建独占随机子目录，不删既有内容）。
    probeDir: config.dataDir,
    bootstrap: async () => {
      const { bootstrapCloudRuntime } = await import("./bootstrap.js");
      // 同一份已校验配置传给 bootstrap：全入口只读一次盘。
      // 真实路由预留：A2A 业务转发与 MCP 调用进入路由前先持久预留（失败不退款）。
      return (await bootstrapCloudRuntime({
        config,
        reserve: {
          business: () => requireRuntime().reserveBusiness(),
          mcp: () => requireRuntime().reserveMcp(),
        },
      })) as { close: () => Promise<void> | void };
    },
    closeInstance: async (instance) => {
      await instance.close();
    },
  });
  runtimeRef.current = handle;
  return { handle, config, host: createOwnedCloudHost(handle) };
}

/** off 模式：若磁盘上已有 owned 状态，禁止以 off 绕过计数/期限/终态。 */
export function assertNoOwnedStateForOff(config: Pick<CloudRuntimeConfig, "ownedRuntime" | "dataDir">): void {
  if (config.ownedRuntime !== "off") return;
  if (existsSync(path.join(config.dataDir, "owned"))) {
    throw new Error("OWNED_RUNTIME_STATE_PRESENT_WITH_OFF");
  }
}

export async function runCloudMain(): Promise<number> {
  if (isNodeBelowSupportLine(process.versions.node)) {
    process.stderr.write("[kiwi-cloud] 启动失败（NODE_UNSUPPORTED）：需要Node.js >=22.19.0。\n");
    return 1;
  }
  let config: CloudRuntimeConfig | undefined;
  try {
    const { loadCloudConfig } = await import("./config.js");
    try {
      config = loadCloudConfig(process.env, { artifactRoot: process.env.KIWI_CLOUD_ARTIFACT_ROOT });
    } catch (error) {
      // 配置模块可用但内容非法：硬失败（不降到 legacy，避免绕过 owned 策略）。
      process.stderr.write(`[kiwi-cloud] 启动失败（${(error as { code?: string }).code ?? "CONFIG_INVALID"}）。\n`);
      return 1;
    }
  } catch {
    // 配置链不可用（例如精简入口层）：退回既有 legacy 路径，由 bootstrap 决定。
    config = undefined;
  }

  if (config?.ownedRuntime === "require") {
    let owned;
    try {
      owned = await startOwnedCloudRuntime(process.env, {
        artifactRoot: config.artifactRoot,
        configFile: config.configFile,
        config,
      });
    } catch (error) {
      process.stderr.write(`[kiwi-cloud] 启动失败（${(error as { code?: string }).code ?? "OWNED_RUNTIME_FAILED"}）。\n`);
      return 1;
    }
    // SIGTERM/SIGINT：可恢复关闭（不写终态）；由宿主在 close 返回后决定退出。
    const graceful = (): void => {
      void owned.handle.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", graceful);
    process.on("SIGTERM", graceful);
    await new Promise<never>(() => {});
    return 0;
  }

  if (config !== undefined) {
    try {
      assertNoOwnedStateForOff(config);
    } catch (error) {
      process.stderr.write(`[kiwi-cloud] 启动失败（${(error as Error).message}）。\n`);
      return 1;
    }
  }

  let instance;
  try {
    const { bootstrapCloudRuntime, renderStartupFailure } = await import("./bootstrap.js");
    try { instance = await bootstrapCloudRuntime(); }
    catch (err) { process.stderr.write(renderStartupFailure(err)); return 1; }
  } catch {
    process.stderr.write("[kiwi-cloud] 启动失败（BOOTSTRAP_LOAD_FAILED）。\n");
    return 1;
  }
  const shutdown = createCloudShutdown(instance.close);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {});
  return 0;
}

/** 直接执行（非 import）时才启动：避免测试 import 拉起进程。 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  void runCloudMain()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch(() => {
      process.stderr.write("[kiwi-cloud] 启动失败（RUNTIME_STARTUP_FAILED）。\n");
      process.exit(1);
    });
}
