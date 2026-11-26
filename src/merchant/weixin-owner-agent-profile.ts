/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { buildModel, realStreamFn } from "../runtime/model.js";
import { createWeixinOwnerDecider, type WeixinOwnerAgent } from "./weixin-owner-agent.js";
import { openOwnerModelKey, OWNER_MODEL_SERVICES, readOwnerModelConfig, type OwnerModelConfig, type OwnerModelSelection } from "./weixin-owner-model-config.js";

type Env = Readonly<Record<string, string | undefined>>;
type ReadyAgent = Extract<WeixinOwnerAgent, { state: "configured" }>;

function makeAgent(profile: AgentProfile, getApiKey: () => string | undefined, streamFn: StreamFn, revision?: string): ReadyAgent {
  const model = buildModel(profile);
  if (model.api === "openai-completions" && ["moonshot-cn", "zai-cn", "dashscope"].includes(model.provider)) {
    Object.assign(model, { compat: { maxTokensField: "max_tokens", supportsStore: false, supportsStrictMode: false } });
  }
  const { provider, id: name, baseUrl: endpoint, api } = model;
  const keyRef = profile.model.api_key_env!;
  const identity = ["weixin-owner-agent-v1", provider, api, name, endpoint, keyRef];
  if (revision !== undefined) identity.push(revision);
  const consent = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { state: "configured", consent, provider, model: name, endpoint,
    decide: createWeixinOwnerDecider({ model, streamFn, getApiKey }) };
}

export function hasOwnerModelKey(key: unknown): key is string {
  return typeof key === "string" && /^[\x21-\x7e]+$/.test(key);
}

export function ownerModelRuntimeFlags(env: Env, config?: OwnerModelConfig) {
  const savedInWorkbench = config !== undefined && "workbench_revision" in config;
  const replyToOwner = env.KIWI_WEIXIN_OWNER_REPLIES === "1" ||
    (savedInWorkbench && env.KIWI_WEIXIN_OWNER_REPLIES !== "0");
  const modelEnabled = replyToOwner && (env.KIWI_WEIXIN_OWNER_AGENT === "1" ||
    (savedInWorkbench && env.KIWI_WEIXIN_OWNER_AGENT !== "0"));
  return { replyToOwner, modelEnabled };
}

/** 仅替换店主对话模型，保持供应商与推理端点的固定映射。 */
export function createExplicitWeixinOwnerAgent(profile: AgentProfile, config: OwnerModelSelection,
  credential: { read: () => string | undefined; reference: string; revision?: string }, streamFn = realStreamFn()): ReadyAgent {
  const { api, endpoint } = OWNER_MODEL_SERVICES[config.provider];
  return makeAgent({ ...profile, model: { provider: config.provider, model: config.model, api_key_env: credential.reference,
    api, base_url: endpoint } }, credential.read, streamFn, credential.revision);
}

function legacyOwnerAgent(profile: AgentProfile, env: Env): ReadyAgent | undefined {
  const { model: name, api_key_env: keyRef, provider } = profile.model;
  if (!/^[\w.-]{1,128}$/.test(name) || keyRef === undefined || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(keyRef)) return undefined;
  if (provider !== "openai" && provider !== "deepseek") return undefined;
  const model = buildModel(profile);
  if (model.baseUrl !== OWNER_MODEL_SERVICES[provider].endpoint ||
      (model.api !== "openai-completions" && !(provider === "openai" && model.api === "openai-responses"))) return undefined;
  return makeAgent(profile, () => env[keyRef], realStreamFn());
}

/** 启动时读取本地配置，不探测网络，不关闭原有回信或数据授权门。 */
export function resolveWeixinOwnerAgent(profile: AgentProfile, env: Env, config?: OwnerModelConfig, dataDir?: string,
  streamFn?: StreamFn): WeixinOwnerAgent {
  if (profile.role !== "merchant") return { state: "unavailable", reason: "invalid_config" };
  if (config === undefined) return legacyOwnerAgent(profile, env) ?? { state: "unavailable", reason: "not_configured" };
  if ("api_key_env" in config) {
    const reference = config.api_key_env;
    if (!hasOwnerModelKey(env[reference])) return { state: "unavailable", reason: "missing_credential" };
    return createExplicitWeixinOwnerAgent(profile, config, { read: () => env[reference], reference }, streamFn);
  }
  if (dataDir === undefined) return { state: "unavailable", reason: "missing_credential" };
  try {
    const key = openOwnerModelKey(dataDir, profile.owner_id, config);
    if (!hasOwnerModelKey(key)) return { state: "unavailable", reason: "missing_credential" };
    return createExplicitWeixinOwnerAgent(profile, config,
      { read: () => key, reference: "workbench-vault", revision: config.workbench_revision }, streamFn);
  } catch {
    return { state: "unavailable", reason: "missing_credential" };
  }
}

export function configuredWeixinOwnerAgent(profile: AgentProfile, env: Env, dataDir?: string): WeixinOwnerAgent | undefined {
  try {
    const config = dataDir === undefined ? undefined : readOwnerModelConfig(dataDir, profile.owner_id);
    return ownerModelRuntimeFlags(env, config).modelEnabled ? resolveWeixinOwnerAgent(profile, env, config, dataDir) : undefined;
  } catch {
    return ownerModelRuntimeFlags(env).modelEnabled ? { state: "unavailable", reason: "invalid_config" } : undefined;
  }
}
