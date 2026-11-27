/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../src/config/profile.js";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { MerchantWeixinChannel } from "../src/merchant/weixin-channel.js";
import { configuredWeixinOwnerAgent } from "../src/merchant/weixin-owner-agent-profile.js";
import { runMerchantModelCli } from "../src/merchant/weixin-owner-model-cli.js";
import { openOwnerModelKey, parseOwnerModelConfig, readOwnerModelConfig, writeOwnerModelConfig } from "../src/merchant/weixin-owner-model-config.js";
import { WeixinOwnerModelSettings } from "../src/merchant/weixin-owner-model-settings.js";
import { WeixinOwnerConversation } from "../src/merchant/weixin-owner-conversation.js";
import { createWorkbenchWeixinOwnerOptions } from "../src/merchant/weixin-owner-source.js";
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
  it("exposes model metadata and saves through the owner-only CSRF-protected workbench route", async () => {
    const dir = dataDir();
    const db = new DatabaseSync(":memory:");
    const sessions = new MerchantAdminSessions({ db });
    const origin = "https://merchant.example";
    const stream = createScriptedFakeStreamFn([
      fauxAssistantMessage("你好"),
      fauxAssistantMessage([fauxToolCall("handle_merchant_request", { action: "list" })], { stopReason: "toolUse" }),
    ]);
    const settings = new WeixinOwnerModelSettings(profile, dir, { ANTHROPIC_API_KEY: "ambient-fixture-secret" }, stream.streamFn);
    const conversation = createWorkbenchWeixinOwnerOptions({ flag: undefined, modelSettings: settings,
      dataDir: dir, adminDir: dir, merchantId: profile.owner_id, agentId: profile.agent_id, origin });
    Object.defineProperty(conversation, "ownerRevision", { value: (id: string) => id === "owner" ? "revision" : undefined });
    const channel = new MerchantWeixinChannel({ dataDir: dir, merchantId: profile.owner_id, modelSettings: settings, conversation });
    const handler = createMerchantManagementApiHandler({
      weixinChannel: channel,
      merchantId: profile.owner_id, generation: () => 1, runtimeVersion: "test", sessions, allowedOrigins: [origin],
      listPending: () => [], mintCandidateConfirmation: () => "unused", executeDecision: async () => {},
      operations: new MerchantManagementOperationStore({ db }), serviceState: new MutableServiceState("OPERATING"),
      drafts: new MerchantImportDraftStore({ db }), readiness: async () => ({ ready: true, checks: {} }),
    });
    const route = "/merchant/api/v1/channels/weixin/model";
    const call = (url: string, cookie?: string, body?: object, csrf?: string) => new Promise<{
      status: number; text: string; headers: Record<string, string>;
    }>((resolve) => {
      let status = 0;
      let headers: Record<string, string> = {};
      const req = new IncomingMessage(new Socket());
      req.url = url;
      req.method = body === undefined ? "GET" : "POST";
      req.headers = { cookie, origin, "x-csrf-token": csrf };
      if (body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
      req.push(null);
      handler(req, {
        writeHead(code: number, values: Record<string, string>) { status = code; headers = values; },
        end(text: string) { resolve({ status, text, headers }); },
      } as unknown as ServerResponse);
    });
    const cookie = (role: "owner" | "operator", merchantId = profile.owner_id) =>
      `${ADMIN_SESSION_COOKIE}=${sessions.createSession({ principalId: "owner", merchantId, role }).sessionId}`;
    try {
      const owner = cookie("owner");
      const csrf = JSON.parse((await call("/merchant/api/session", owner)).text).csrf_token;
      const model = { provider: "anthropic", model: "claude-fixture" };
      expect((await call(route)).status).toBe(401);
      expect((await call(route, cookie("operator"))).status).toBe(403);
      expect((await call(route, cookie("owner", "other-merchant"))).status).toBe(404);
      expect((await call(route, owner, model)).status).toBe(403);
      expect((await call(route, owner, { ...model, api_key_env: "UNRELATED_SECRET" }, csrf)).status).toBe(422);
      expect((await call(route, owner, model, csrf)).status).toBe(422);
      const saved = await call(route, owner, { ...model, credential: "merchant-fixture-secret" }, csrf);
      expect(saved.status).toBe(200);
      expect(saved.headers["cache-control"]).toBe("no-store");
      expect(saved.text).not.toContain("fixture-secret");
      expect(JSON.parse((await call(route, owner)).text)).toMatchObject({ ...model, active: true, credential_saved: true,
        providers: expect.arrayContaining([expect.objectContaining({ id: "anthropic", endpoint: "https://api.anthropic.com" })]) });
      const stored = readOwnerModelConfig(dir, profile.owner_id);
      if (stored === undefined || !("credential" in stored)) throw new Error("expected stored credential");
      expect(openOwnerModelKey(dir, profile.owner_id, stored)).toBe("merchant-fixture-secret");
      expect(() => openOwnerModelKey(dir, "other-merchant", stored)).toThrow();
      expect(statSync(path.join(dir, "owner-conversation-model-vault.key")).mode & 0o777).toBe(0o600);
    } finally {
      await channel.close();
      db.close();
    }
  });

  it("applies a workbench model only after both Pi probes and invalidates consent on a model change", async () => {
    const dir = dataDir();
    const env = { DASHSCOPE_API_KEY: "ambient-fixture-secret" };
    const qwen = { provider: "dashscope", model: "qwen-plus", apiKey: "dashscope-fixture-secret" };
    const openRouter = { provider: "openrouter", model: "minimax/minimax-m2.7", apiKey: "openrouter-fixture-secret" };
    const probeReplies = () => [
      fauxAssistantMessage("你好"),
      fauxAssistantMessage([fauxToolCall("handle_merchant_request", { action: "list" })], { stopReason: "toolUse" }),
    ];
    const stream = createScriptedFakeStreamFn([
      ...probeReplies(), fauxAssistantMessage("你好"), fauxAssistantMessage("没有工具"), ...probeReplies(), ...probeReplies(),
      ...probeReplies(), ...probeReplies(),
    ]);
    const settings = new WeixinOwnerModelSettings(profile, dir, env, stream.streamFn);
    const options = createWorkbenchWeixinOwnerOptions({ flag: undefined, modelSettings: settings,
      dataDir: dir, adminDir: dir, merchantId: profile.owner_id, agentId: profile.agent_id, origin: "https://merchant.example" });
    Object.defineProperty(options, "ownerRevision", { value: () => "current-owner-revision" });
    const conversation = new WeixinOwnerConversation(path.join(dir, "conversation.sqlite"), options, Date.now);
    const owner = "fixture-owner";
    const fingerprint = "fixture-binding";
    const onChange = () => conversation.modelChanged();
    const assertCurrent = () => {};
    try {
      expect(options.replyToOwner).toBe(false);
      await expect(settings.save(qwen, assertCurrent, onChange))
        .resolves.toMatchObject({ provider: "dashscope", model: "qwen-plus", active: true });
      expect(options.replyToOwner).toBe(true);
      const first = options.agent;
      if (first?.state !== "configured") throw new Error("model expected");
      conversation.bind(owner, fingerprint, first.consent);
      expect(conversation.status(owner, fingerprint)).toMatchObject({ authorized: true, model_authorized: true });
      await expect(settings.save(openRouter, assertCurrent, onChange))
        .rejects.toThrow("模型未能调用询价工具");
      expect(conversation.status(owner, fingerprint)).toMatchObject({ authorized: true, model_authorized: true });
      await settings.save(openRouter, assertCurrent, onChange);
      expect(conversation.status(owner, fingerprint)).toMatchObject({ authorized: true, model_authorized: false });
      expect(() => conversation.bind(owner, fingerprint, first.consent)).toThrow("模型授权已变化");
      await settings.save(qwen, assertCurrent, onChange);
      expect(() => conversation.bind(owner, fingerprint, first.consent)).toThrow("模型授权已变化");
      const revised = options.agent;
      if (revised?.state !== "configured") throw new Error("model expected");
      conversation.bind(owner, fingerprint, revised.consent);
      await settings.save({ ...qwen, apiKey: undefined }, assertCurrent, onChange);
      expect(conversation.status(owner, fingerprint).model_authorized).toBe(true);
      await settings.save({ ...qwen, apiKey: "merchant-replacement-fixture-secret" }, assertCurrent, onChange);
      expect(conversation.status(owner, fingerprint)).toMatchObject({ authorized: true, model_authorized: false });
      const restarted = new WeixinOwnerModelSettings(profile, dir, {});
      expect(restarted.agent).toMatchObject({ state: "configured", provider: "dashscope", model: "qwen-plus" });
      expect(restarted.agent).toMatchObject({ consent: settings.agent?.state === "configured" ? settings.agent.consent : "" });
      expect(new WeixinOwnerModelSettings(profile, dir, { ...env, KIWI_WEIXIN_OWNER_AGENT: "0" }).agent).toBeUndefined();
      const displayed = JSON.stringify(restarted.status()) + readFileSync(path.join(dir, "owner-conversation-model.json"), "utf8");
      expect(displayed).not.toContain("fixture-secret");
    } finally {
      conversation.close();
    }
  });

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
    ["damaged", /备份损坏的配置/],
    ["another merchant", /另一商家/],
    ["unsafe file mode", /权限/],
  ] as const)("reports %s configuration without probing or replacing it", async (kind, hint) => {
    const dir = dataDir();
    const file = path.join(dir, "owner-conversation-model.json");
    if (kind === "another merchant") writeOwnerModelConfig(dir, "other-merchant", modelConfig);
    else writeFileSync(file, '{"fixture-sensitive-detail":', { mode: kind === "damaged" ? 0o600 : 0o644 });
    const original = readFileSync(file);
    const streamFn = vi.fn(createScriptedFakeStreamFn([]).streamFn);
    const settings = new WeixinOwnerModelSettings(profile, dir, flags, streamFn);
    const { active, config_problem } = settings.status();
    expect(active).toBe(false);
    expect(config_problem).toMatch(hint);
    expect(config_problem).not.toContain("fixture-sensitive-detail");
    await expect(settings.save({ provider: "openai", model: "gpt-test", apiKey: "fixture" }, () => {}, () => {}))
      .rejects.toThrow(config_problem);
    expect(streamFn).not.toHaveBeenCalled();
    expect(readFileSync(file)).toEqual(original);
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
