/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";

export const OWNER_MODEL_PROVIDERS = ["openai", "deepseek"] as const;
export type OwnerModelProvider = typeof OWNER_MODEL_PROVIDERS[number];

export interface OwnerModelConfig {
  provider: OwnerModelProvider;
  model: string;
  api_key_env: string;
}

export const OWNER_MODEL_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
} as const;

export class OwnerModelConfigError extends Error {
  constructor(readonly code: "invalid_config" | "unreadable_config") {
    super(code === "invalid_config" ? "店主模型配置无效。" : "无法读取店主模型配置。");
  }
}

/** 配置只包含非秘密字段；未知字段（包括明文密钥和任意端点）一律拒绝。 */
export function parseOwnerModelConfig(value: unknown): OwnerModelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OwnerModelConfigError("invalid_config");
  const { provider, model, api_key_env, ...unknown } = value as Record<string, unknown>;
  if (Object.keys(unknown).length !== 0 || (provider !== "openai" && provider !== "deepseek") ||
      typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) ||
      typeof api_key_env !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(api_key_env)) {
    throw new OwnerModelConfigError("invalid_config");
  }
  return { provider, model, api_key_env };
}

function configPath(dataDir: string): string {
  return path.join(dataDir, "owner-conversation-model.json");
}

/** 配置跟随持久状态，不改部署包 profile 中的交易模型。 */
export function readOwnerModelConfig(dataDir: string, merchantId: string): OwnerModelConfig | undefined {
  let fd: number;
  try {
    fd = openSync(configPath(dataDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new OwnerModelConfigError("unreadable_config");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new OwnerModelConfigError("invalid_config");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OwnerModelConfigError("invalid_config");
    const { schema_version, merchant_id, ...config } = value as Record<string, unknown>;
    if (schema_version !== 1 || merchant_id !== merchantId) throw new OwnerModelConfigError("invalid_config");
    return parseOwnerModelConfig(config);
  } catch {
    throw new OwnerModelConfigError("invalid_config");
  } finally {
    closeSync(fd);
  }
}

export function writeOwnerModelConfig(dataDir: string, merchantId: string, config: OwnerModelConfig): void {
  const validated = parseOwnerModelConfig(config);
  // 不能用一个商家覆盖另一商家的配置，或覆盖不合法的现有状态。
  readOwnerModelConfig(dataDir, merchantId);
  writeFileAtomic(configPath(dataDir), `${JSON.stringify({ schema_version: 1, merchant_id: merchantId, ...validated }, null, 2)}\n`, { mode: 0o600 });
}
