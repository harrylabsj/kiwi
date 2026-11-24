/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import type { AgentProfile } from "../config/profile.js";
import { buildModel, realStreamFn } from "../runtime/model.js";
import { createWeixinOwnerDecider, type WeixinOwnerAgent } from "./weixin-owner-agent.js";

/** Explicit server-side switch and trusted HTTPS destination, in addition to fresh owner consent. */
export function configuredWeixinOwnerAgent(profile: AgentProfile, env: Readonly<Record<string, string | undefined>>): WeixinOwnerAgent | undefined {
  if (env.KIWI_WEIXIN_OWNER_AGENT !== "1" || env.KIWI_WEIXIN_OWNER_REPLIES !== "1") return undefined;
  const unavailable = { state: "unavailable" } as const;
  if (profile.role !== "merchant") return unavailable;
  const { model: name, api_key_env: keyRef, provider } = profile.model;
  if (!/^[\w.-]{1,128}$/.test(name) || keyRef === undefined || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(keyRef)) return unavailable;
  if (provider !== "openai" && provider !== "deepseek") return unavailable;
  const endpoint = provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com/v1";
  const model = buildModel(profile);
  if (model.baseUrl !== endpoint || (model.api !== "openai-completions" && !(provider === "openai" && model.api === "openai-responses"))) {
    return unavailable;
  }
  const consent = createHash("sha256").update(JSON.stringify(["weixin-owner-agent-v1", provider, model.api, name, endpoint, keyRef])).digest("hex");
  return { state: "configured", consent, provider, model: name, endpoint,
    decide: createWeixinOwnerDecider({ model, streamFn: realStreamFn(), getApiKey: () => env[keyRef] }) };
}
