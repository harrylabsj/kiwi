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

import { bootstrapCloudRuntime, renderStartupFailure } from "./bootstrap.js";

export async function runCloudMain(): Promise<number> {
  let instance;
  try {
    instance = await bootstrapCloudRuntime();
  } catch (err) {
    process.stderr.write(renderStartupFailure(err));
    return 1;
  }
  const shutdown = async (): Promise<void> => {
    await instance.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // 常驻：请求由 http server 驱动，这里只保持事件循环。
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
    .catch((err: unknown) => {
      process.stderr.write(renderStartupFailure(err));
      process.exit(1);
    });
}
