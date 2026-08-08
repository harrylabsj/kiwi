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
 * `kiwi catalog serve` —— 启动独立 kiwi-catalog 服务（CURRENT-DOCS v0.7.0）。
 *
 * kiwi-catalog 是独立部署仓（<WORKSPACE>/kiwi-catalog），console script 入口
 * `kiwi-catalog-api`（pyproject [project.scripts]）。本命令以前台方式
 * 转发启动该服务（stdio inherit），便于本地一体化开发；依赖检测：
 * 未安装（ENOENT）→ fail-closed 提示 pip install。
 *
 * 缺省：--db ./kiwi-catalog.sqlite --host 127.0.0.1 --port 8600
 * （与 kiwi-catalog 的缺省端口一致）。
 */

import { spawnSync } from "node:child_process";

export interface CatalogServeOptions {
  /** catalog SQLite 文件路径（缺省 ./kiwi-catalog.sqlite）。 */
  db?: string;
  host?: string;
  port?: number;
  /** 测试注入。 */
  spawnImpl?: typeof spawnSync;
}

export interface CatalogServeResult {
  ok: boolean;
  /** spawn 前即失败的原因（如 kiwi-catalog 未安装）。 */
  error?: string;
  /** 服务是否已实际启动（Ctrl+C 停止视为正常，spawned=true）。 */
  spawned?: boolean;
}

export function catalogServe(options: CatalogServeOptions = {}): CatalogServeResult {
  const spawn = options.spawnImpl ?? spawnSync;
  const args = [
    "--db",
    options.db ?? "./kiwi-catalog.sqlite",
    "--host",
    options.host ?? "127.0.0.1",
    "--port",
    String(options.port ?? 8600),
  ];
  // spawnSync 对 ENOENT 不抛异常——返回 { error: ENOENT, status: null }；
  // Ctrl+C 停止则 status 为 null 且无 error（视为正常）。
  const result = spawn("kiwi-catalog-api", args, { stdio: "inherit" });
  if (result.error !== undefined) {
    const code = (result.error as { code?: string }).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        error:
          "kiwi-catalog-api 未安装——kiwi-catalog 是独立部署仓（<WORKSPACE>/kiwi-catalog），" +
          "请先 `pip install -e <WORKSPACE>/kiwi-catalog` 再运行本命令",
      };
    }
    return {
      ok: false,
      error: `kiwi-catalog-api 启动失败：${result.error.message}`,
    };
  }
  if (result.status !== null && result.status !== 0) {
    return { ok: false, error: `kiwi-catalog-api 退出码 ${result.status}（服务日志见上方输出）` };
  }
  return { ok: true, spawned: true };
}
