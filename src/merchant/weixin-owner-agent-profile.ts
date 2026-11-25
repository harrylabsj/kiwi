/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { buildModel, realStreamFn } from "../runtime/model.js";
import { createWeixinOwnerDecider, type WeixinOwnerAgent } from "./weixin-owner-agent.js";
import { OWNER_MODEL_ENDPOINTS, parseOwnerModelConfig, readOwnerModelConfig, type OwnerModelConfig } from "./weixin-owner-model-config.js";

type Env = Readonly<Record<string, string | undefined>>;
type ReadyAgent = Extract<WeixinOwnerAgent, { state: "configured" }>;

function makeAgent(profile: AgentProfile, env: Env, streamFn: StreamFn): ReadyAgent {
  const model = buildModel(profile);
  const { provider, id: name, baseUrl: endpoint, api } = model;
  const keyRef = profile.model.api_key_env!;
  const consent = createHash("sha256").update(JSON.stringify(["weixin-owner-agent-v1", provider, api, name, endpoint, keyRef])).digest("hex");
  return { state: "configured", consent, provider, model: name, endpoint,
    decide: createWeixinOwnerDecider({ model, streamFn, getApiKey: () => env[keyRef] }) };
}

export function hasOwnerModelKey(key: string | undefined): boolean {
  return key !== undefined && /^[\x21-\x7e]+$/.test(key);
}

/** 仅替换店主对话模型；推理端点仍固定为既有的两个官方服务。 */
export function createExplicitWeixinOwnerAgent(profile: AgentProfile, input: OwnerModelConfig, env: Env, streamFn = realStreamFn()): ReadyAgent {
  const config = parseOwnerModelConfig(input);
  return makeAgent({ ...profile, model: { ...config, api: "openai-completions", base_url: OWNER_MODEL_ENDPOINTS[config.provider] } }, env, streamFn);
}

function legacyOwnerAgent(profile: AgentProfile, env: Env): ReadyAgent | undefined {
  const { model: name, api_key_env: keyRef, provider } = profile.model;
  if (!/^[\w.-]{1,128}$/.test(name) || keyRef === undefined || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(keyRef)) return undefined;
  if (provider !== "openai" && provider !== "deepseek") return undefined;
  const model = buildModel(profile);
  if (model.baseUrl !== OWNER_MODEL_ENDPOINTS[provider] ||
      (model.api !== "openai-completions" && !(provider === "openai" && model.api === "openai-responses"))) return undefined;
  return makeAgent(profile, env, realStreamFn());
}

/** 启动时读取本地配置，不探测网络，不关闭原有回信或数据授权门。 */
export function configuredWeixinOwnerAgent(profile: AgentProfile, env: Env, dataDir?: string): WeixinOwnerAgent | undefined {
  if (env.KIWI_WEIXIN_OWNER_AGENT !== "1" || env.KIWI_WEIXIN_OWNER_REPLIES !== "1") return undefined;
  if (profile.role !== "merchant") return { state: "unavailable", reason: "invalid_config" };
  try {
    const config = dataDir === undefined ? undefined : readOwnerModelConfig(dataDir, profile.owner_id);
    if (config === undefined) return legacyOwnerAgent(profile, env) ?? { state: "unavailable", reason: "not_configured" };
    if (!hasOwnerModelKey(env[config.api_key_env])) return { state: "unavailable", reason: "missing_credential" };
    return createExplicitWeixinOwnerAgent(profile, config, env);
  } catch {
    return { state: "unavailable", reason: "invalid_config" };
  }
}
