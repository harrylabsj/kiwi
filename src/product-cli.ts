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
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { EXIT } from "./exit-codes.js";
import { SHOPPING_CLI_COMPAT, compatRangeText, versionInRange } from "./product-compat.js";

/**
 * 裸 `kiwi` 默认读取的 profile 路径：`kiwi buyer init` / `kiwi merchant init`
 * 都会写到这里。之后直接 `kiwi` 即按已初始化的 buyer/merchant 运行。
 */
export const DEFAULT_PROFILE_PATH = path.join(homedir(), ".kiwi", "kiwi.yaml");

/**
 * 写默认 profile（供裸 `kiwi` 读取）；目录不存在则创建（0700/0600）。
 *
 * 目标路径优先级：显式 `profilePath` > 环境变量 `KIWI_DEFAULT_PROFILE` >
 * `DEFAULT_PROFILE_PATH`。后两者供测试/受控环境隔离真实用户默认 profile——
 * init 测试不得污染 `~/.kiwi/kiwi.yaml`（历史教训：测试跑一遍就把用户默认
 * profile 覆盖成测试 merchant）。
 */
export function writeDefaultProfile(yaml: string, profilePath?: string): void {
  const target = profilePath ?? process.env.KIWI_DEFAULT_PROFILE ?? DEFAULT_PROFILE_PATH;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, yaml, { mode: 0o600 });
}

/** 与 package.json / USAGE 同步的产品版本。 */
export const PRODUCT_VERSION = "0.7.16";

/**
 * 缺省 kiwi-catalog 地址（单一来源，cli.ts 各处解析一致）。
 *
 * 默认指向官方 catalog（harrylabsj 资产，catalog.kiwi.harrylabsj.com）；
 * 用户可覆盖：
 *   - CLI：`--catalog <url>`
 *   - 环境变量：`KIWI_CATALOG_URL`
 *   - profile：`commerce.base_url` 不参与；catalog 独立配置
 * 本地开发/自托管：`KIWI_CATALOG_URL=http://127.0.0.1:8600` 或 `--catalog http://127.0.0.1:8600`。
 */
export const DEFAULT_CATALOG_URL = "https://catalog.kiwi.harrylabsj.com";

const BUYER_HELP = `kiwi buyer — Kiwi Buyer（product-strategy rev1.1 §2.2/§19 D4）

Usage:
  kiwi buyer start [--profile <file>]      Buyer 对话入口（chat 别名；裸 kiwi 即进入）
  kiwi buyer init --agent-id <buyer 身份>  [D4] 生成 buyer profile（无需 shopping-cli；
                                          --output/--force；或 KIWI_BUYER_AGENT_ID）
  kiwi buyer search <需求描述>             [D4] Product-first 搜索（listing → Merchant
                                          Agent；--catalog/--limit/--category/--region）
  kiwi buyer tasks [--data-dir <dir>]      [D4] 查看 Buyer 任务（start 运行后）

Buyer 只需要 Kiwi；不感知 shopping-cli / kiwi-catalog。
`;

const MERCHANT_HELP = `kiwi merchant — Kiwi Merchant（product-strategy rev1.1 §2.3/§3.2/§19）

Usage:
  kiwi merchant start --profile <merchant.yaml> [--catalog <url>] [--port N] [--no-chat]
                                          Merchant A2A server + 注册 Kiwi Network
                                          （agent serve 别名）
  kiwi merchant init [--merchant-id <shopping-cli merchant_id>] [--name <商家名称>]
                                          [D1] 生成 merchant profile（只填 merchant_id
                                          即可，其余自动补全；TTY 交互提示；写默认
                                          profile，之后裸 kiwi 即按此运行）
  kiwi merchant publish --profile <merchant.yaml> --shopping-cli-db <db>
                                          [D2] 注册 Agent + 发布 Listing 编排
                                          （需 KIWI_CATALOG_OWNER_TOKEN_SECRET）
  kiwi merchant setup-public [--domain <域名>] [--port N] [--check]
                                          [D3] 公网 A2A 暴露引导：检测公网 IP、检查
                                          DNS、生成 Caddyfile、输出启动/验证命令
                                          （well-known 由节点自动生成）
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

export function detectShoppingCli(
  spawnImpl?: typeof spawnSync,
): { ok: boolean; found: boolean; version?: string; error?: string } {
  try {
    const spawn = spawnImpl ?? spawnSync;
    const result = spawn("shopping", ["--version"], {
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
 * 三组件聚合健康检查（D0 最小版 → D3 补版本兼容矩阵）：runtime self-check
 * + shopping-cli 存在性/版本（矩阵判定）+ kiwi-catalog 可达性。
 * 输出 JSON {ok, components}；矩阵单一来源 = product-compat.ts，
 * 与 `kiwi merchant publish` 共同消费（D3）。
 */
export async function cmdProductDoctor(): Promise<number> {
  const shopping = detectShoppingCli();
  const detectedVersion = shopping.version;
  const compatible =
    shopping.found &&
    detectedVersion !== undefined &&
    versionInRange(detectedVersion, SHOPPING_CLI_COMPAT);
  const shoppingStep: Record<string, unknown> = {
    ok: shopping.ok && compatible,
    found: shopping.found,
  };
  if (shopping.found) {
    shoppingStep.version = detectedVersion ?? "unknown";
    shoppingStep.compatible = compatible;
    if (detectedVersion !== undefined && !compatible) {
      shoppingStep.error =
        `shopping-cli ${detectedVersion} 超出 Kiwi 支持范围（${compatRangeText(SHOPPING_CLI_COMPAT)}）`;
    }
  } else if (shopping.error !== undefined) {
    shoppingStep.error = shopping.error;
  }

  const components = {
    kiwi: { ok: true, version: PRODUCT_VERSION },
    shopping_cli: shoppingStep,
    kiwi_catalog: await detectCatalog(),
  };
  const ok = Object.values(components).every((c) => c.ok === true);
  printJson({ ok, components });
  return ok ? EXIT.OK : EXIT.CONFIG;
}
