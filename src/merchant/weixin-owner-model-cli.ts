/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { AtomicWriteError } from "../fs/atomic-write.js";
import { configuredWeixinOwnerAgent, createExplicitWeixinOwnerAgent, hasOwnerModelKey } from "./weixin-owner-agent-profile.js";
import type { WeixinOwnerAgent } from "./weixin-owner-agent.js";
import { parseOwnerModelConfig, readOwnerModelConfig, writeOwnerModelConfig } from "./weixin-owner-model-config.js";

interface Options {
  action: string;
  dataDir: string;
  profile: AgentProfile;
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  ask?: (label: string) => Promise<string>;
  streamFn?: StreamFn;
}

/** 两次有界合成探测；不读账本、不读微信、不执行返回的工具。 */
async function probe(agent: Extract<WeixinOwnerAgent, { state: "configured" }>): Promise<string | undefined> {
  const signal = AbortSignal.timeout(55_000);
  try {
    const text = await agent.decide({ text: "这是合成测试。只用文本回一句你好。", history: [] }, signal);
    if (text.kind !== "reply") return "text_reply_missing";
    const tool = await agent.decide({ text: "这是合成测试。请查询当前待跟进的询价清单。", history: [] }, signal);
    return tool.kind === "list" ? undefined : "tool_call_missing";
  } catch (error) {
    // 不向终端反射上游返回的内容、认证头或未脱敏错误。
    const code = (error as { code?: string } | null)?.code;
    if (code === "deadline" || signal.aborted) return "timeout";
    if (code === "unavailable") return "missing_credential";
    if (code === "invalid_response" || code === "quota_exhausted" || code === "rate_limited" || code === "outcome_unknown") return code;
    return "provider_error";
  }
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
        state: selected?.state ?? "unavailable", enabled: env.KIWI_WEIXIN_OWNER_AGENT === "1" && env.KIWI_WEIXIN_OWNER_REPLIES === "1",
        ...(selected?.state === "configured"
          ? { model: selected.model, provider: selected.provider, endpoint: selected.endpoint }
          : { reason: selected?.reason ?? "not_configured" }),
        connectivity: "untested", });
      return 0;
    }
    if (action === "test") {
      const selected = current === undefined ? configuredWeixinOwnerAgent(profile, configEnv, dataDir) :
        hasOwnerModelKey(env[current.api_key_env]) ? createExplicitWeixinOwnerAgent(profile, current, env, streamFn) : undefined;
      if (selected?.state !== "configured") return fail(selected?.reason ?? (current === undefined ? "not_configured" : "missing_credential"));
      const error = await probe(selected);
      if (error !== undefined) return fail(error);
      report({ ok: true, text_reply: true, tool_call: true });
      return 0;
    }
    if (ask === undefined) return fail("interactive_terminal_required");
    log("配置仅用于店主对话。请先在服务环境设置模型密钥；这里仅输入环境变量名，不输入密钥。");
    const provider = (await ask("服务商 [openai / deepseek]：")).trim();
    const model = (await ask("模型 ID：")).trim();
    const api_key_env = (await ask("密钥环境变量名：")).trim();
    const config = parseOwnerModelConfig({ provider, model, api_key_env });
    if (!hasOwnerModelKey(env[config.api_key_env])) return fail("missing_credential");
    if ((await ask("发送两次合成测试请求，通过后保存此配置？[y/N] ")).trim().toLowerCase() !== "y") {
      report({ ok: true, saved: false });
      return 0;
    }
    const error = await probe(createExplicitWeixinOwnerAgent(profile, config, env, streamFn));
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
