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
 * Model construction for Pi.
 *
 * Real models: a pi-ai Model object is built from the profile and streamed
 * through pi-ai's api-dispatch streamSimple. API keys come from the env var
 * named by model.api_key_env — never from the profile.
 *
 * Fake model: provider "fake" yields a deterministic scripted StreamFn used
 * by tests and offline smoke runs. It needs no network and no key.
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";

const PROVIDER_API: Record<string, string> = {
  openai: "openai-completions",
  anthropic: "anthropic-messages",
  google: "google-generative-ai",
  "google-vertex": "google-vertex",
  openrouter: "openai-completions",
  deepseek: "openai-completions",
  xai: "openai-completions",
  groq: "openai-completions",
  together: "openai-completions",
  mistral: "mistral-conversations",
  "amazon-bedrock": "bedrock-converse-stream",
};

const PROVIDER_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai",
  // google-vertex and amazon-bedrock are intentionally absent: pi-ai
  // resolves their endpoints through the provider SDKs (region-based) and
  // never reads model.baseUrl, so the "" fallback below is harmless for
  // exactly those two. Every other provider needs a default or an explicit
  // model.base_url in the profile.
};

export function isFakeProvider(profile: AgentProfile): boolean {
  return profile.model.provider === "fake";
}

/**
 * Map profile model.thinking_level onto Pi's ThinkingLevel (agent-core 0.83:
 * "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; the Agent default
 * is "off"). Kiwi profiles only allow off/minimal/low/medium/high; "off" and
 * undefined leave initialState untouched so Pi keeps its default. Anything
 * else fails closed — a silently dropped level would be a config lie.
 */
export function resolveThinkingLevel(profile: AgentProfile): ThinkingLevel | undefined {
  const level = profile.model.thinking_level;
  if (level === undefined || level === "off") return undefined;
  if (level === "minimal" || level === "low" || level === "medium" || level === "high") {
    return level;
  }
  throw new Error(`Unsupported model.thinking_level: ${String(level)}`);
}

export function buildModel(profile: AgentProfile): Model<Api> {
  const provider = profile.model.provider;
  const api = (profile.model.api ?? PROVIDER_API[provider] ?? "openai-completions") as Api;
  const baseUrl = profile.model.base_url ?? PROVIDER_BASE_URL[provider] ?? "";
  return {
    id: profile.model.model,
    name: profile.model.model,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

/** StreamFn for real providers, dispatching through pi-ai's api registry. */
export function realStreamFn(): StreamFn {
  return (model, context, options) => streamSimple(model, context, options);
}
