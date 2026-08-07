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

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { agentDataDir, ensurePathsForDir } from "./agent/agent-db.js";
import { RUNTIME_VERSION } from "./config/profile.js";
import { PROTOCOL_VERSION } from "./negotiation/types.js";
import { detectShoppingCli } from "./product-cli.js";

export interface MerchantInitOptions {
  /** 商家名称（写进 profile 注释与 owner 可读性）。 */
  merchantName: string;
  /** shopping-cli merchant_id —— 身份锚（agent_id/owner_id 同源）。 */
  merchantId: string;
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
  const merchantId = options.merchantId.trim();
  if (merchantId === "") {
    return {
      ok: false,
      profile_path: "",
      agent_id: "",
      steps: {
        shopping_cli_detected: { ok: false, detail: "merchantId 为空" },
        shopping_cli_reachable: { ok: false, detail: "未执行（merchantId 无效）" },
        profile_written: { ok: false, detail: "未执行（merchantId 无效）" },
        data_dir_initialized: { ok: false, detail: "未执行（merchantId 无效）" },
      },
      warnings,
    };
  }

  // ── Step 1: shopping-cli 依赖检测 ────────────────────────────────────────
  const detected = detectShoppingCli(options.spawnImpl);
  if (!detected.ok) {
    warnings.push(
      `shopping-cli 未检测到（${detected.error ?? "?"}）——Kiwi Merchant 需要它；` +
        "请先安装（pip install shopping-cli）或指定 --shopping-cli-path。",
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
