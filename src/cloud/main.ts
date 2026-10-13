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

import { withCloseDeadline } from "../lifecycle/close.js";

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

export async function runCloudMain(): Promise<number> {
  if (isNodeBelowSupportLine(process.versions.node)) {
    process.stderr.write("[kiwi-cloud] 启动失败（NODE_UNSUPPORTED）：需要Node.js >=22.19.0。\n");
    return 1;
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
