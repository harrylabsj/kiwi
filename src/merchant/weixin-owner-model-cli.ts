/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { AtomicWriteError } from "../fs/atomic-write.js";
import { configuredWeixinOwnerAgent, createExplicitWeixinOwnerAgent, hasOwnerModelKey, ownerModelRuntimeFlags, resolveWeixinOwnerAgent } from "./weixin-owner-agent-profile.js";
import { probeWeixinOwnerAgent } from "./weixin-owner-agent.js";
import { OWNER_MODEL_PROVIDERS, parseOwnerModelConfig, readOwnerModelConfig, writeOwnerModelConfig } from "./weixin-owner-model-config.js";

interface Options {
  action: string;
  dataDir: string;
  profile: AgentProfile;
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  ask?: (label: string) => Promise<string>;
  streamFn?: StreamFn;
}

export async function runMerchantModelCli(options: Options): Promise<number> {
  const { action, dataDir, profile, env, log, ask, streamFn } = options;
  const report = (value: object) => log(JSON.stringify(value, null, 2));
  const fail = (code: string): number => { report({ ok: false, code }); return 1; };
  if (profile.role !== "merchant") return fail("merchant_profile_required");
  if (!["configure", "status", "test"].includes(action)) return fail("unknown_action");
  try {
    const current = readOwnerModelConfig(dataDir, profile.owner_id);
    const configEnv = { ...env, KIWI_WEIXIN_OWNER_AGENT: "1", KIWI_WEIXIN_OWNER_REPLIES: "1" };
    if (action === "status") {
      const selected = configuredWeixinOwnerAgent(profile, configEnv, dataDir);
      report({ source: current === undefined ? selected?.state === "configured" ? "legacy_profile" : "none" : "local_owner_config",
        state: selected?.state ?? "unavailable", enabled: ownerModelRuntimeFlags(env, current).modelEnabled,
        ...(selected?.state === "configured"
          ? { model: selected.model, provider: selected.provider, endpoint: selected.endpoint }
          : { reason: selected?.reason ?? "not_configured" }),
        connectivity: "untested", });
      return 0;
    }
    if (action === "test") {
      const selected = resolveWeixinOwnerAgent(profile, env, current, dataDir, streamFn);
      if (selected.state !== "configured") return fail(selected.reason ?? "not_configured");
      const error = await probeWeixinOwnerAgent(selected);
      if (error !== undefined) return fail(error);
      report({ ok: true, text_reply: true, tool_call: true });
      return 0;
    }
    if (ask === undefined) return fail("interactive_terminal_required");
    log("配置仅用于店主对话。请先在服务环境设置模型密钥；这里仅输入环境变量名，不输入密钥。");
    const provider = (await ask(`服务商 [${OWNER_MODEL_PROVIDERS.join(" / ")}]：`)).trim();
    const model = (await ask("模型 ID：")).trim();
    const api_key_env = (await ask("密钥环境变量名：")).trim();
    const config = parseOwnerModelConfig({ provider, model, api_key_env });
    if (!hasOwnerModelKey(env[api_key_env])) return fail("missing_credential");
    if ((await ask("发送两次合成测试请求，通过后保存此配置？[y/N] ")).trim().toLowerCase() !== "y") {
      report({ ok: true, saved: false });
      return 0;
    }
    const error = await probeWeixinOwnerAgent(createExplicitWeixinOwnerAgent(profile, config,
      { read: () => env[api_key_env], reference: api_key_env }, streamFn));
    if (error !== undefined) return fail(error);
    writeOwnerModelConfig(dataDir, profile.owner_id, config);
    report({ ok: true, saved: true, provider: config.provider, model: config.model, restart_required: true });
    log("重启运行时以应用配置；微信回信、模型开关和店主的数据授权仍需分别开启或确认。");
    return 0;
  } catch (error) {
    if (error instanceof AtomicWriteError) return fail(error.committed ? "saved_durability_unknown" : "save_failed");
    return fail("invalid_owner_model_config");
  }
}
