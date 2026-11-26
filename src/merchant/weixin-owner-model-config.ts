/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrivateVault, VAULT_KEY_VERSION } from "../agent/memory/vault.js";
import { writeFileAtomic } from "../fs/atomic-write.js";

export const OWNER_MODEL_SERVICES = {
  deepseek: { label: "DeepSeek", endpoint: "https://api.deepseek.com/v1", api: "openai-completions" },
  openai: { label: "OpenAI", endpoint: "https://api.openai.com/v1", api: "openai-completions" },
  anthropic: { label: "Anthropic Claude", endpoint: "https://api.anthropic.com", api: "anthropic-messages" },
  google: { label: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com", api: "google-generative-ai" },
  "moonshot-cn": { label: "Kimi（月之暗面）", endpoint: "https://api.moonshot.cn/v1", api: "openai-completions" },
  "zai-cn": { label: "GLM（智谱）", endpoint: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions" },
  dashscope: { label: "通义千问（百炼北京）", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  minimax: { label: "MiniMax（中国）", endpoint: "https://api.minimaxi.com/anthropic", api: "anthropic-messages" },
  openrouter: { label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", api: "openai-completions" },
} as const;
export type OwnerModelProvider = keyof typeof OWNER_MODEL_SERVICES;
export const OWNER_MODEL_PROVIDERS = Object.keys(OWNER_MODEL_SERVICES) as OwnerModelProvider[];

export function isOwnerModelProvider(value: unknown): value is OwnerModelProvider {
  return typeof value === "string" && Object.hasOwn(OWNER_MODEL_SERVICES, value);
}

export interface OwnerModelSelection {
  provider: OwnerModelProvider;
  model: string;
}
export type StoredOwnerModelConfig = OwnerModelSelection & {
  workbench_revision: string;
  credential: { nonce: string; ciphertext: string };
};
export type OwnerModelConfig = (OwnerModelSelection & { api_key_env: string }) | StoredOwnerModelConfig;

export class OwnerModelConfigError extends Error {
  constructor(readonly code: "invalid_config" | "unreadable_config") {
    super(code === "invalid_config" ? "店主模型配置无效。" : "无法读取店主模型配置。");
  }
}

export function parseOwnerModelSelection(provider: unknown, model: unknown): OwnerModelSelection {
  const modelPattern = provider === "openrouter"
    ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!isOwnerModelProvider(provider) || typeof model !== "string" || !modelPattern.test(model)) {
    throw new OwnerModelConfigError("invalid_config");
  }
  return { provider, model };
}

/** 支持旧版服务环境引用和工作台密文，拒绝明文密钥与任意端点。 */
export function parseOwnerModelConfig(value: unknown): OwnerModelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OwnerModelConfigError("invalid_config");
  const { provider, model, api_key_env, workbench_revision, credential, ...unknown } = value as Record<string, unknown>;
  if (Object.keys(unknown).length !== 0) throw new OwnerModelConfigError("invalid_config");
  const selection = parseOwnerModelSelection(provider, model);
  if (typeof api_key_env === "string" && /^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(api_key_env) &&
      workbench_revision === undefined && credential === undefined) return { ...selection, api_key_env };
  if (api_key_env !== undefined || typeof workbench_revision !== "string" || !/^[a-f0-9]{32}$/.test(workbench_revision) ||
      typeof credential !== "object" || credential === null || Array.isArray(credential)) {
    throw new OwnerModelConfigError("invalid_config");
  }
  const { nonce, ciphertext, ...extra } = credential as Record<string, unknown>;
  if (Object.keys(extra).length !== 0 || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(nonce) ||
      typeof ciphertext !== "string" || !/^[A-Za-z0-9_-]{22,3000}$/.test(ciphertext)) {
    throw new OwnerModelConfigError("invalid_config");
  }
  return { ...selection, workbench_revision, credential: { nonce, ciphertext } };
}

function configPath(dataDir: string): string {
  return path.join(dataDir, "owner-conversation-model.json");
}

/** 配置跟随持久状态，不改部署包 profile 中的交易模型。 */
function readPrivateFile(file: string, maxBytes: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new OwnerModelConfigError("unreadable_config");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw new OwnerModelConfigError("invalid_config");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** 配置跟随持久状态，不改部署包 profile 中的交易模型。 */
export function readOwnerModelConfig(dataDir: string, merchantId: string): OwnerModelConfig | undefined {
  const source = readPrivateFile(configPath(dataDir), 4096);
  if (source === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OwnerModelConfigError("invalid_config");
    const { schema_version, merchant_id, ...config } = value as Record<string, unknown>;
    if (schema_version !== 1 || merchant_id !== merchantId) throw new OwnerModelConfigError("invalid_config");
    return parseOwnerModelConfig(config);
  } catch {
    throw new OwnerModelConfigError("invalid_config");
  }
}

export function writeOwnerModelConfig(dataDir: string, merchantId: string, config: OwnerModelConfig): void {
  const validated = parseOwnerModelConfig(config);
  // 不能用一个商家覆盖另一商家的配置，或覆盖不合法的现有状态。
  readOwnerModelConfig(dataDir, merchantId);
  writeFileAtomic(configPath(dataDir), `${JSON.stringify({ schema_version: 1, merchant_id: merchantId, ...validated }, null, 2)}\n`, { mode: 0o600 });
}

function credentialVault(dataDir: string, merchantId: string, config: OwnerModelSelection & { workbench_revision: string }, create: boolean): PrivateVault {
  const file = path.join(dataDir, "owner-conversation-model-vault.key");
  let master = readPrivateFile(file, 65)?.trim();
  // Creation is serialized by the workbench channel lease.
  if (master === undefined && create) {
    master = randomBytes(32).toString("hex");
    writeFileAtomic(file, `${master}\n`, { mode: 0o600 });
  }
  if (master === undefined || !/^[a-f0-9]{64}$/.test(master)) throw new OwnerModelConfigError("unreadable_config");
  const key = createHmac("sha256", Buffer.from(master, "hex"))
    .update(JSON.stringify(["kiwi-owner-model-v1", merchantId, config.provider, config.model, config.workbench_revision]))
    .digest();
  return new PrivateVault({ getKey: (version) => version === VAULT_KEY_VERSION ? key : undefined });
}

export function sealOwnerModelKey(dataDir: string, merchantId: string, config: OwnerModelSelection & { workbench_revision: string }, apiKey: string): StoredOwnerModelConfig {
  const sealed = credentialVault(dataDir, merchantId, config, true).seal("owner-model-key", apiKey);
  return { ...config, credential: { nonce: sealed.nonce.toString("base64url"), ciphertext: sealed.ciphertext.toString("base64url") } };
}

export function openOwnerModelKey(dataDir: string, merchantId: string, config: StoredOwnerModelConfig): string {
  const { nonce, ciphertext } = config.credential;
  return credentialVault(dataDir, merchantId, config, false).open(VAULT_KEY_VERSION,
    Buffer.from(nonce, "base64url"), Buffer.from(ciphertext, "base64url"));
}
