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
 * `kiwi merchant init`（product-strategy rev1.1 §3.2/§19 D1）。
 *
 * 首次初始化引导，产出可直接被 `kiwi merchant start` / `kiwi merchant
 * publish` 使用的 merchant profile：
 *
 *   1. shopping-cli 依赖检测（缺失 → warning + 引导提示，不阻塞生成）；
 *   2. Kiwi ↔ shopping-cli 连接可达性（/health，失败 warning 不阻塞）；
 *   3. 生成 merchant profile（agent_id = merchant_id —— D2 身份统一，
 *      publish 无需 --shopping-cli-merchant 映射）；
 *   4. 初始化数据目录（AgentKernel 的 state/sessions，0700）。
 *
 * 身份锚 = shopping-cli merchant_id（数据引擎的 merchant 身份）；profile
 * 不存任何 secret（token_env 只写环境变量名，与 loadProfile 约定一致）。
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { agentDataDir, ensurePathsForDir } from "./agent/agent-db.js";
import { RUNTIME_VERSION } from "./config/profile.js";
import { PROTOCOL_VERSION } from "./negotiation/types.js";
import { detectShoppingCli } from "./product-cli.js";

function slugifyMerchantId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug !== "") return slug;
  return `merchant-${randomBytes(3).toString("hex")}`;
}

export interface MerchantInitOptions {
  /** 商家名称（写进 profile 注释与 owner 可读性）。 */
  merchantName: string;
  /**
   * shopping-cli merchant_id —— 身份锚（agent_id/owner_id 同源）。
   * 缺省从 merchantName 派生（普通商家只需要知道自己名称）；
   * 显式指定用于对接已有 shopping-cli 商家数据。
   */
  merchantId?: string;
  /** shopping-cli API base URL（Kiwi ↔ shopping-cli 连接）。 */
  shoppingCliUrl?: string;
  /** shopping-cli SQLite 路径（连接验证与 publish 用；记录于报告）。 */
  shoppingCliDb?: string;
  /** kiwi-catalog base URL（publish/start 用）。 */
  catalogUrl?: string;
  /** 私有底价（minor 单位；merchant_policy.min_unit_price_private）。 */
  floorPriceMinor?: number;
  /** 自动磋商开关（merchant_policy.auto_negotiate，缺省 false）。 */
  autoNegotiate?: boolean;
  /** profile 输出路径（缺省 ./merchant.yaml）。 */
  outputPath?: string;
  /** 覆盖已存在的输出文件（缺省拒绝）。 */
  force?: boolean;
  /**
   * shopping-cli 缺失时自动安装（pip install shopping-cli，PyPI 包名定稿）。
   * 只检测到缺失才执行；安装失败 fail-closed（warning，不假装装好）。
   * rev1.1 §3.2：Merchant 无需知晓并单独安装数据引擎。
   */
  autoInstallShoppingCli?: boolean;
  modelProvider?: string;
  modelName?: string;
  apiKeyEnv?: string;
  /** 测试注入。 */
  spawnImpl?: typeof import("node:child_process").spawnSync;
  fetchImpl?: typeof fetch;
}

export interface MerchantInitStep {
  ok: boolean;
  detail?: string;
}

export interface MerchantInitReport {
  ok: boolean;
  profile_path: string;
  agent_id: string;
  steps: {
    shopping_cli_detected: MerchantInitStep;
    shopping_cli_reachable: MerchantInitStep;
    profile_written: MerchantInitStep;
    data_dir_initialized: MerchantInitStep;
  };
  warnings: string[];
}

/**
 * 执行 merchant init。fail-closed：profile 写盘失败 → ok:false；
 * shopping-cli 检测/可达性失败只记 warning（生成不阻塞，但报告可见）。
 */
export async function merchantInit(
  options: MerchantInitOptions,
): Promise<MerchantInitReport> {
  const warnings: string[] = [];
  // 商家号缺省从名称派生（用户只需要知道自己的商家名称；显式指定用于
  // 对接已有 shopping-cli 商家数据）。派生规则：小写 + 空白/特殊字符转
  // '-'；中文保留；空结果回退随机。
  const merchantId =
    options.merchantId !== undefined && options.merchantId.trim() !== ""
      ? options.merchantId.trim()
      : slugifyMerchantId(options.merchantName);

  // ── Step 1: shopping-cli 依赖检测（缺失时按需自动安装）──────────────────
  let detected = detectShoppingCli(options.spawnImpl);
  if (!detected.ok && options.autoInstallShoppingCli === true) {
    const spawn = options.spawnImpl ?? spawnSync;
    let install: ReturnType<typeof spawnSync>;
    try {
      install = spawn("pip", ["install", "shopping-cli"], {
        encoding: "utf-8",
        timeout: 300_000,
      });
    } catch (err) {
      install = {
        status: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      } as unknown as ReturnType<typeof spawnSync>;
    }
    if (install.status === 0) {
      // PATH 可能未刷新：重检测，失败也给明确指引
      detected = detectShoppingCli(options.spawnImpl);
      if (detected.ok) {
        warnings.push("shopping-cli 已自动安装（数据引擎就绪）。");
      } else {
        warnings.push(
          "pip install shopping-cli 完成但 `shopping` 命令仍不可用——" +
            "可能需要刷新 PATH 或重新打开终端。",
        );
      }
    } else {
      warnings.push(
        `自动安装失败（pip install shopping-cli 退出 ${install.status ?? "?"}）——` +
          `请手动安装后重试（${String(install.stderr ?? "").trim().slice(0, 200)}）。`,
      );
    }
  }
  if (!detected.ok) {
    warnings.push(
      `shopping-cli 未检测到（${detected.error ?? "?"}）——Kiwi Merchant 需要它；` +
        "安装已默认自动尝试，可用 `kiwi merchant init --no-install` 跳过自动安装、稍后手动安装。",
    );
  }

  // ── Step 2: Kiwi ↔ shopping-cli 连接可达性 ──────────────────────────────
  const shoppingCliUrl = (options.shoppingCliUrl ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
  let reachable: MerchantInitStep;
  try {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(`${shoppingCliUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    reachable = response.ok
      ? { ok: true, detail: shoppingCliUrl }
      : { ok: false, detail: `HTTP ${response.status} from ${shoppingCliUrl}` };
  } catch (err) {
    reachable = {
      ok: false,
      detail: `${shoppingCliUrl} 不可达：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!reachable.ok) {
    warnings.push(
      `shopping-cli API ${shoppingCliUrl} 不可达——` +
        "profile 仍会生成，但 `kiwi merchant start` 的磋商/数据工具会 fail-closed。",
    );
  }

  // ── Step 3: 生成 merchant profile ───────────────────────────────────────
  const agentId = merchantId; // D2 身份统一：agent_id = shopping-cli merchant_id
  const floorPriceMinor = options.floorPriceMinor ?? 0;
  const profile: Record<string, unknown> = {
    // 由 `kiwi merchant init` 生成（D1）。secret 永不入 profile：token_env
    // 只写环境变量名（与 loadProfile 约定一致）。
    runtime_version: RUNTIME_VERSION, // profile schema 版本（与产品版本独立）
    protocol_version: PROTOCOL_VERSION,
    agent_id: agentId,
    role: "merchant",
    owner_id: merchantId,
    commerce: {
      base_url: shoppingCliUrl,
      token_env: "SHOPPING_MERCHANT_TOKEN",
      backend: "local_marketplace",
    },
    model: {
      provider: options.modelProvider ?? "deepseek",
      model: options.modelName ?? "deepseek-v4-flash",
      api_key_env: options.apiKeyEnv ?? "DEEPSEEK_API_KEY",
    },
    runtime: {
      mode: "once",
      poll_interval_seconds: 5,
      turn_timeout_seconds: 90,
      max_model_steps: 4,
      max_retries: 2,
    },
    merchant_policy: {
      min_unit_price_private: floorPriceMinor / 100,
      auto_negotiate: options.autoNegotiate ?? false,
      human_review_on: ["below_floor", "exceptional_warranty", "suspicious_content"],
    },
  };

  const outputPath = options.outputPath ?? path.resolve("merchant.yaml");
  let written: MerchantInitStep;
  if (existsSync(outputPath) && !options.force) {
    written = { ok: false, detail: `已存在：${outputPath}（用 --force 覆盖）` };
  } else {
    try {
      writeFileSync(
        outputPath,
        `# Kiwi Merchant profile — generated by \`kiwi merchant init\` (${new Date().toISOString()})\n` +
          `# Merchant: ${options.merchantName}\n` +
          stringifyYaml(profile),
        { mode: 0o600 },
      );
      written = { ok: true, detail: outputPath };
    } catch (err) {
      written = {
        ok: false,
        detail: `写盘失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Step 4: 初始化数据目录（AgentKernel state/sessions，0700）───────────
  let dataDirOk = true;
  let dataDirDetail = "";
  try {
    const paths = ensurePathsForDir(agentDataDir(agentId));
    dataDirDetail = paths.dir;
  } catch (err) {
    dataDirOk = false;
    dataDirDetail = err instanceof Error ? err.message : String(err);
  }

  const ok = written.ok && dataDirOk;
  return {
    ok,
    profile_path: outputPath,
    agent_id: agentId,
    steps: {
      shopping_cli_detected: detected.ok
        ? { ok: true, detail: detected.version ?? "found" }
        : { ok: false, detail: detected.error ?? "not found" },
      shopping_cli_reachable: reachable,
      profile_written: written,
      data_dir_initialized: dataDirOk ? { ok: true, detail: dataDirDetail } : { ok: false, detail: dataDirDetail },
    },
    warnings,
  };
}
