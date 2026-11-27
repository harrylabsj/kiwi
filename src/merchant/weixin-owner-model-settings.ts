/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { AtomicWriteError } from "../fs/atomic-write.js";
import { createExplicitWeixinOwnerAgent, hasOwnerModelKey, ownerModelRuntimeFlags, resolveWeixinOwnerAgent } from "./weixin-owner-agent-profile.js";
import { probeWeixinOwnerAgent, type WeixinOwnerAgent } from "./weixin-owner-agent.js";
import { OwnerConversationError } from "./weixin-owner-conversation.js";
import {
  isOwnerModelProvider, OWNER_MODEL_PROVIDERS, OWNER_MODEL_SERVICES,
  OwnerModelConfigError, openOwnerModelKey, parseOwnerModelSelection, readOwnerModelConfig, sealOwnerModelKey, writeOwnerModelConfig,
  type OwnerModelConfig, type OwnerModelSelection, type StoredOwnerModelConfig,
} from "./weixin-owner-model-config.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Workbench credentials belong to this merchant's instance and never fall back to process credentials. */
export class WeixinOwnerModelSettings {
  private config: OwnerModelConfig | undefined;
  private selected: WeixinOwnerAgent;
  private saving = false;
  private configProblem: string | undefined;

  constructor(
    private readonly profile: AgentProfile,
    private readonly dataDir: string,
    private readonly env: Env,
    private readonly streamFn?: StreamFn,
  ) {
    try {
      this.config = readOwnerModelConfig(dataDir, profile.owner_id);
      this.selected = resolveWeixinOwnerAgent(profile, env, this.config, dataDir);
    } catch (error) {
      this.configProblem = error instanceof OwnerModelConfigError ? error.message : "无法读取当前实例的模型配置。";
      this.selected = { state: "unavailable", reason: "invalid_config" };
    }
  }

  private get editable(): boolean {
    return this.profile.role === "merchant" && this.env.KIWI_WEIXIN_OWNER_REPLIES !== "0" &&
      this.env.KIWI_WEIXIN_OWNER_AGENT !== "0";
  }

  get replyToOwner(): boolean {
    return ownerModelRuntimeFlags(this.env, this.config).replyToOwner;
  }

  get agent(): WeixinOwnerAgent | undefined {
    return ownerModelRuntimeFlags(this.env, this.config).modelEnabled ? this.selected : undefined;
  }

  status() {
    const current = this.config ?? (this.selected.state === "configured" ? this.selected : undefined);
    return {
      editable: this.editable,
      active: this.agent?.state === "configured",
      ...(this.configProblem === undefined ? {} : { config_problem: this.configProblem }),
      credential_saved: this.config !== undefined && "credential" in this.config && this.selected.state === "configured",
      ...(current === undefined ? {} : { provider: current.provider, model: current.model }),
      providers: OWNER_MODEL_PROVIDERS.map((id) => ({
        id, label: OWNER_MODEL_SERVICES[id].label, endpoint: OWNER_MODEL_SERVICES[id].endpoint,
      })),
    };
  }

  async save(input: { provider: unknown; model: unknown; apiKey: unknown }, assertCurrent: () => void, changed: () => void) {
    if (!this.editable) throw new OwnerConversationError("forbidden", "此实例的部署设置已停用微信模型配置。");
    if (this.configProblem !== undefined) throw new OwnerConversationError("unavailable", this.configProblem);
    if (this.saving) throw new OwnerConversationError("conflict", "模型测试正在进行，请稍后重试。");
    if (!isOwnerModelProvider(input.provider)) throw new OwnerConversationError("invalid_input", "请选择支持的模型服务商。");
    let selection: OwnerModelSelection;
    try {
      selection = parseOwnerModelSelection(input.provider, input.model);
    } catch {
      throw new OwnerConversationError("invalid_input", "请输入有效的模型 ID。");
    }
    const config = this.config;
    let key = input.apiKey;
    if (key === undefined && config !== undefined && "credential" in config && config.provider === selection.provider) {
      try {
        key = openOwnerModelKey(this.dataDir, this.profile.owner_id, config);
      } catch {
        throw new OwnerConversationError("invalid_input", "无法读取已保存的密钥，请重新输入。");
      }
    }
    if (!hasOwnerModelKey(key) || key.length > 2048) {
      throw new OwnerConversationError("invalid_input", "请填写该服务商为本商家签发的有效 API Key。");
    }
    const apiKey = key;
    const revision = randomUUID().replaceAll("-", "");
    this.saving = true;
    try {
      const agent = createExplicitWeixinOwnerAgent(this.profile, selection,
        { read: () => apiKey, reference: "workbench-vault", revision }, this.streamFn);
      const problem = await probeWeixinOwnerAgent(agent);
      assertCurrent();
      if (problem !== undefined) {
        const reason = problem === "tool_call_missing" ? "模型未能调用询价工具。" :
          problem === "timeout" ? "连接模型服务超时。" :
          problem === "rate_limited" || problem === "quota_exhausted" ? "模型服务限流或额度不足。" :
          "模型服务未返回有效回复，请核对密钥和模型 ID。";
        throw new OwnerConversationError("unavailable", `${reason} 请检查后重试。`);
      }
      let current: OwnerModelConfig | undefined;
      try {
        current = readOwnerModelConfig(this.dataDir, this.profile.owner_id);
      } catch (error) {
        throw new OwnerConversationError("unavailable", error instanceof OwnerModelConfigError ? error.message : "无法读取当前实例的模型配置。");
      }
      if (JSON.stringify(current) !== JSON.stringify(this.config)) {
        throw new OwnerConversationError("conflict", "模型配置已在运行时外更新，请重启实例后重试。");
      }
      if (input.apiKey === undefined && current !== undefined && "credential" in current &&
          current.provider === selection.provider && current.model === selection.model) return this.status();
      let candidate: StoredOwnerModelConfig;
      try {
        candidate = sealOwnerModelKey(this.dataDir, this.profile.owner_id, { ...selection, workbench_revision: revision }, apiKey);
      } catch {
        throw new OwnerConversationError("unavailable", "无法加密本商家的模型密钥。");
      }
      let durabilityUnknown = false;
      try {
        writeOwnerModelConfig(this.dataDir, this.profile.owner_id, candidate);
      } catch (error) {
        if (!(error instanceof AtomicWriteError) || !error.committed) {
          throw new OwnerConversationError("unavailable", "无法保存当前实例的模型配置。");
        }
        durabilityUnknown = true;
      }
      try {
        changed();
      } finally {
        this.config = candidate;
        this.selected = agent;
      }
      if (durabilityUnknown) {
        throw new OwnerConversationError("unavailable", "已切换模型，但保存的持久性未能确认，请刷新后检查。");
      }
      return this.status();
    } finally {
      this.saving = false;
    }
  }
}
