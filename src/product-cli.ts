#!/usr/bin/env node
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
 * 产品层 CLI（product-strategy rev1.1 §10/§19）——buyer / merchant / network
 * 命令树与聚合 doctor。
 *
 * 工程上仍是多组件（kiwi / shopping-cli / kiwi-catalog），产品层只做统一入口：
 * - `kiwi merchant start` = `kiwi agent serve` 别名（Merchant A2A server）；
 * - `kiwi buyer start` = `kiwi chat` 别名（Buyer 对话入口）；
 * - 骨架命令（init/publish/listings/search/tasks）输出明确的"尚未实现
 *   （D-x）"提示并指向 rev1.1 §19 完成定义——不假装可用；
 * - `kiwi doctor`（无 --profile）= 三组件聚合健康检查（D0 最小版；
 *   D3 补版本兼容矩阵）。
 */

import { spawnSync } from "node:child_process";
import { EXIT } from "./exit-codes.js";

/** 与 package.json / USAGE 同步的产品版本。 */
export const PRODUCT_VERSION = "0.6.0";

/** 缺省 kiwi-catalog 地址（与 cli.ts 的 KIWI_CATALOG_URL 解析一致）。 */
const DEFAULT_CATALOG_URL = "http://127.0.0.1:8600";

const BUYER_HELP = `kiwi buyer — Kiwi Buyer（product-strategy rev1.1 §2.2/§19 D4）

Usage:
  kiwi buyer start [--profile <file>]      Buyer 对话入口（chat 别名；裸 kiwi 即进入）
  kiwi buyer init                          [D4] 初始化 Buyer Principal/Vault —— 尚未实现
  kiwi buyer search                        [D4] Product-first 搜索（listing → Merchant Agent）—— 尚未实现
  kiwi buyer tasks                         [D4] 查看 Buyer 任务 —— 尚未实现

Buyer 只需要 Kiwi；不感知 shopping-cli / kiwi-catalog。
`;

const MERCHANT_HELP = `kiwi merchant — Kiwi Merchant（product-strategy rev1.1 §2.3/§3.2/§19）

Usage:
  kiwi merchant start --profile <merchant.yaml> [--catalog <url>] [--port N] [--no-chat]
                                          Merchant A2A server + 注册 Kiwi Network
                                          （agent serve 别名）
  kiwi merchant init                      [D1] 统一初始化引导（shopping-cli 检测/
                                          Principal/数据连接/A2A 配置）—— 尚未实现
  kiwi merchant publish --profile <merchant.yaml> --shopping-cli-db <db>
                                          [D2] 注册 Agent + 发布 Listing 编排
                                          （需 KIWI_CATALOG_OWNER_TOKEN_SECRET）
  kiwi merchant listings                  [D2] 已发布 Listing 查看 —— 尚未实现
  kiwi merchant status                    [D1] Merchant 运行时状态 —— 尚未实现
  kiwi merchant doctor                    [D3] Merchant 侧组件健康 —— 尚未实现

Merchant = Kiwi Runtime + shopping-cli（Commerce Data Engine）。
`;

const NETWORK_HELP = `kiwi network — Kiwi Network（product-strategy rev1.1 §5/§19）

Usage:
  kiwi network status                     Kiwi Network（kiwi-catalog）可达性/状态 —— 规划中
  kiwi network register                   Network Operator 面 —— 规划中

Network = kiwi-catalog（公共发现/验证基础设施）。普通 Buyer/Merchant 不安装；
Operator/企业自建走 kiwi-catalog 部署物（Docker/systemd）。
`;

export function productHelp(group: string): string {
  if (group === "buyer") return BUYER_HELP;
  if (group === "merchant") return MERCHANT_HELP;
  if (group === "network") return NETWORK_HELP;
  return "";
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ── 聚合 doctor（D0 最小版；D3 补版本兼容矩阵）─────────────────────────────

function detectShoppingCli(): { ok: boolean; found: boolean; version?: string; error?: string } {
  try {
    const result = spawnSync("shopping", ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (result.status !== 0) {
      return { ok: false, found: false, error: `shopping --version exited ${result.status ?? "?"}` };
    }
    const version = String(result.stdout ?? "").trim().split("\n")[0] ?? "";
    return { ok: true, found: true, ...(version !== "" ? { version } : {}) };
  } catch (err) {
    return {
      ok: false,
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectCatalog(): Promise<{
  ok: boolean;
  reachable: boolean;
  base_url: string;
  error?: string;
}> {
  const baseUrl = process.env.KIWI_CATALOG_URL ?? DEFAULT_CATALOG_URL;
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return { ok: false, reachable: false, base_url: baseUrl, error: `HTTP ${response.status}` };
    }
    return { ok: true, reachable: true, base_url: baseUrl };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      base_url: baseUrl,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 三组件聚合健康检查（D0 最小版）：runtime self-check + shopping-cli 存在性
 * + kiwi-catalog 可达性。输出 JSON {ok, components}。
 */
export async function cmdProductDoctor(): Promise<number> {
  const components = {
    kiwi: { ok: true, version: PRODUCT_VERSION },
    shopping_cli: detectShoppingCli(),
    kiwi_catalog: await detectCatalog(),
  };
  const ok = Object.values(components).every((c) => c.ok === true);
  printJson({ ok, components });
  return ok ? EXIT.OK : EXIT.CONFIG;
}
