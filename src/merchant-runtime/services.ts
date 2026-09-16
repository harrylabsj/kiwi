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
 * runtime 受管服务命令构造（BUG-04 修复）。
 *
 * A2A 与 MCP 子进程显式携带 `--data-dir <merchantDataDir>`（三槽位解析结果）
 * 与确定的工作目录（cwd = merchantDataDir）——A2A Ledger、MCP 状态、
 * oauth.sqlite、stats 等全部落在同一数据根目录；manager 的健康/备份与
 * 子进程读写同一真实业务状态。
 */

import type { ManagedServiceSpec } from "./manager.js";
import type { MerchantMcpRuntimeDirs } from "../mcp/merchant-dirs.js";

export function buildRuntimeServiceSpecs(options: {
  dirs: MerchantMcpRuntimeDirs;
  cliEntry: string;
  profileArgs: string[];
}): ManagedServiceSpec[] {
  const dataDirArgs = ["--data-dir", options.dirs.merchantDataDir];
  // 确定的工作目录：数据根目录（子进程内相对路径解析一致）。
  const env = { KIWI_RUNTIME_CWD: options.dirs.merchantDataDir };
  return [
    {
      name: "a2a",
      command: [
        process.execPath,
        options.cliEntry,
        "merchant",
        "start",
        "--no-chat",
        ...options.profileArgs,
        ...dataDirArgs,
      ],
      env,
      cwd: options.dirs.merchantDataDir,
    },
    {
      name: "mcp",
      command: [
        process.execPath,
        options.cliEntry,
        "merchant",
        "mcp",
        "serve",
        ...options.profileArgs,
        ...dataDirArgs,
      ],
      env,
      cwd: options.dirs.merchantDataDir,
    },
  ];
}
