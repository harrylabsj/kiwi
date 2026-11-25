/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../src/config/profile.js";
import { configuredWeixinOwnerAgent } from "../src/merchant/weixin-owner-agent-profile.js";
import { runMerchantModelCli } from "../src/merchant/weixin-owner-model-cli.js";
import { parseOwnerModelConfig, readOwnerModelConfig, writeOwnerModelConfig } from "../src/merchant/weixin-owner-model-config.js";
import { createScriptedFakeStreamFn } from "../src/runtime/fake-model.js";

const profile: AgentProfile = {
  role: "merchant", owner_id: "test-merchant", agent_id: "merchant-agent:test",
  runtime_version: "0.6.0", protocol_version: "shopping.negotiation/0.1",
  commerce: { base_url: "http://127.0.0.1:1", token_env: "TEST_COMMERCE", backend: "local_marketplace", allow_demo_price_fallback: false },
  model: { provider: "fake", model: "fake-merchant-model" },
  runtime: { mode: "once", poll_interval_seconds: 5, turn_timeout_seconds: 90, max_model_steps: 4, max_retries: 2 },
};
const modelConfig = { provider: "openai", model: "gpt-test", api_key_env: "TEST_KEY" } as const;
const flags = { KIWI_WEIXIN_OWNER_AGENT: "1", KIWI_WEIXIN_OWNER_REPLIES: "1" };
const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-owner-model-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("owner conversation model configuration", () => {
  it("pins official endpoints, rejects key bodies, and binds the 0600 file to this merchant", () => {
    const dir = dataDir();
    for (const input of [{ ...modelConfig, api_key: "fixture" }, { ...modelConfig, base_url: "https://somewhere.invalid/v1" }, { ...modelConfig, provider: "fake" }]) {
      expect(() => parseOwnerModelConfig(input)).toThrow();
    }
    expect(readOwnerModelConfig(dir, profile.owner_id)).toBeUndefined();
    writeOwnerModelConfig(dir, profile.owner_id, modelConfig);
    expect(readOwnerModelConfig(dir, profile.owner_id)).toEqual(modelConfig);
    expect(statSync(path.join(dir, "owner-conversation-model.json")).mode & 0o777).toBe(0o600);
    expect(() => writeOwnerModelConfig(dir, "second-merchant", modelConfig)).toThrow();
    expect(configuredWeixinOwnerAgent(profile, flags, dir)).toEqual({ state: "unavailable", reason: "missing_credential" });
    expect(configuredWeixinOwnerAgent(profile, { ...flags, TEST_KEY: "fixture" }, dir)).toMatchObject({ state: "configured", model: "gpt-test", endpoint: "https://api.openai.com/v1" });
    expect(configuredWeixinOwnerAgent(profile, { TEST_KEY: "fixture" }, dir)).toBeUndefined();
    expect(profile.model.provider).toBe("fake");
  });

  it.each([
    ["error", '429 {"code":"insufficient_quota"}', "quota_exhausted"],
    ["error", "429 too many requests", "rate_limited"],
    ["error", "upstream failed", "provider_error"],
    ["aborted", "upstream aborted", "outcome_unknown"],
  ] as const)("reports %s probe failures without returning raw provider text (%s)", async (stopReason, message, code) => {
    const dir = dataDir();
    writeOwnerModelConfig(dir, profile.owner_id, modelConfig);
    const output: string[] = [];
    const stream = createScriptedFakeStreamFn([fauxAssistantMessage("", { stopReason, errorMessage: `${message} fixture-sensitive-error` })]);
    expect(await runMerchantModelCli({ action: "test", dataDir: dir, profile, env: { TEST_KEY: "fixture" },
      log: (line) => output.push(line), streamFn: stream.streamFn })).toBe(1);
    expect(JSON.parse(output[0]!)).toEqual({ ok: false, code });
    expect(output.join("\n")).not.toContain("fixture-sensitive-error");
  });

  it("saves only after synthetic text and tool probes pass; failure preserves the previous config", async () => {
    const dir = dataDir();
    const output: string[] = [];
    const log = (line: string) => output.push(line);
    const answer = (model: string) => {
      const prompt = ["openai", model, "TEST_KEY", "y"];
      return async () => prompt.shift() ?? "";
    };
    const valid = createScriptedFakeStreamFn([
      fauxAssistantMessage("你好"),
      fauxAssistantMessage([fauxToolCall("handle_merchant_request", { action: "list" })], { stopReason: "toolUse" }),
    ]);
    const common = { action: "configure", dataDir: dir, profile, env: { TEST_KEY: "fixture-secret-value" }, log };
    expect(await runMerchantModelCli({ ...common, ask: answer("gpt-test"), streamFn: valid.streamFn })).toBe(0);
    const document = path.join(dir, "owner-conversation-model.json");
    const raw = readFileSync(document, "utf8");
    const rejectsTool = createScriptedFakeStreamFn([fauxAssistantMessage("你好"), fauxAssistantMessage("没有工具")]);
    expect(await runMerchantModelCli({ ...common, ask: answer("different-model"), streamFn: rejectsTool.streamFn })).toBe(1);
    expect(readFileSync(document, "utf8")).toBe(raw);
    expect(raw + output.join("\n")).not.toContain("fixture-secret-value");
  });
});
