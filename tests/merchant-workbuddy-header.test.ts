/**
 * WorkBuddy 实例专用头模式（显式 opt-in）：
 *   - 只认 X-Kiwi-Authorization；缺失/重复/逗号合并/异常一律拒绝；
 *   - 标准 Authorization 被完全忽略，不回退；
 *   - 通过后原 OAuth 校验器照常校验 token/owner scope/撤销；
 *   - 未启用时标准 OAuth 行为不变（由既有 OAuth 测试覆盖）。
 *
 * 该模式依据仅限隔离应用实测；真实 Linkluck/平台全局未验证。
 */
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { loadProfile } from "../src/config/profile.js";
import { MerchantOAuthStore } from "../src/auth/merchant-oauth.js";
import { MerchantOAuthVerifier } from "../src/auth/merchant-authorization.js";
import { assembleMerchantRuntime } from "../src/mcp/merchant-runtime-assembly.js";
import { createOperationsReportBuilder } from "../src/merchant/operations-report.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import { createFixedInstanceBinding } from "../src/workbuddy-adapter/binding.js";
import { FixedInstanceMcpClient } from "../src/workbuddy-adapter/mcp-client.js";
import {
  WORKBUDDY_AUTH_HEADER,
  WorkBuddyHeaderAuthVerifier,
} from "../src/mcp/merchant-auth.js";
import type {
  MerchantMcpAuthContext,
  MerchantMcpAuthResult,
  MerchantMcpAuthVerifier,
} from "../src/mcp/merchant-auth.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../src/mcp/merchant-server.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-11-07T06:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const TOKEN = "test-workbuddy-header-token-0123456789";

function context(values: string[], authorizationHeader?: string): MerchantMcpAuthContext {
  const rawHeaders: string[] = [];
  for (const value of values) rawHeaders.push(WORKBUDDY_AUTH_HEADER, value);
  return {
    ...(authorizationHeader !== undefined ? { authorizationHeader } : {}),
    rawHeaders,
  };
}

function recordingInner(result: MerchantMcpAuthResult = {
  ok: true,
  authorization: {
    principal_id: PRINCIPAL,
    merchant_id: "merchant-001",
    scopes: ["merchant:read", "merchant:owner"],
  },
}): { inner: MerchantMcpAuthVerifier; calls: MerchantMcpAuthContext[] } {
  const calls: MerchantMcpAuthContext[] = [];
  return {
    calls,
    inner: {
      name: "recording",
      verify(ctx) {
        calls.push(ctx);
        return result;
      },
    },
  };
}

describe("WorkBuddyHeaderAuthVerifier", () => {
  it("单字段 Bearer 通过，并原样保留 inner 的 authorization（owner scope 不变）", () => {
    const { inner, calls } = recordingInner();
    const verifier = new WorkBuddyHeaderAuthVerifier(inner);
    const result = verifier.verify(
      context([`Bearer ${TOKEN}`], "Bearer platform-injected-standard-token"),
    );
    expect(result).toEqual({
      ok: true,
      authorization: {
        principal_id: PRINCIPAL,
        merchant_id: "merchant-001",
        scopes: ["merchant:read", "merchant:owner"],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorizationHeader).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.authorizationHeader).not.toContain("platform-injected");
  });

  it("缺失/无 rawHeaders/重复/逗号合并/异常值全部 fail-closed，且不调用 inner", () => {
    const { inner, calls } = recordingInner();
    const verifier = new WorkBuddyHeaderAuthVerifier(inner);
    const cases: Array<MerchantMcpAuthContext> = [
      {},
      context([]),
      context([], `Bearer ${TOKEN}`),
      context([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]),
      context([`Bearer ${TOKEN}, Bearer ${TOKEN}`]),
      context(["Basic abc"]),
      context([`Bearer  ${TOKEN}`]),
      context([`Bearer ${TOKEN}\t`]),
      context([`Bearer ${TOKEN}\u0000`]),
      context([`Bearer ${"x".repeat(9000)}`]),
      context([""]),
    ];
    for (const ctx of cases) {
      expect(verifier.verify(ctx), JSON.stringify(ctx)).toMatchObject({ ok: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("包装不改变 OAuth 校验：owner scope 保留、撤销生效、跨商家拒绝", () => {
    const store = new MerchantOAuthStore({ db: new DatabaseSync(":memory:") });
    const inner = new MerchantOAuthVerifier({ store, expectedMerchantId: "merchant-001" });
    const wrapper = new WorkBuddyHeaderAuthVerifier(inner);
    const owner = store.issueTokenPair({
      client_id: "client-owner",
      principal_id: PRINCIPAL,
      merchant_id: "merchant-001",
      scope: "merchant:read merchant:owner",
    });
    const accepted = wrapper.verify(context([`Bearer ${owner.access_token}`]));
    expect(accepted.ok).toBe(true);
    expect(accepted.ok ? accepted.authorization?.scopes : []).toEqual(
      expect.arrayContaining(["merchant:read", "merchant:owner"]),
    );

    store.revokeToken(owner.access_token);
    expect(wrapper.verify(context([`Bearer ${owner.access_token}`])).ok).toBe(false);

    const other = store.issueTokenPair({
      client_id: "client-other",
      principal_id: "merchant-agent:merchant-002",
      merchant_id: "merchant-002",
      scope: "merchant:read",
    });
    expect(wrapper.verify(context([`Bearer ${other.access_token}`])).ok).toBe(false);
  });

  it("大小写变体头名可识别；inner 拒绝原因原样返回", () => {
    const rawHeaders = ["x-kiwi-authorization", `Bearer ${TOKEN}`];
    const verifier = new WorkBuddyHeaderAuthVerifier({
      name: "rejecting",
      verify: () => ({ ok: false, reason: "invalid or expired access token" }),
    });
    expect(verifier.verify({ rawHeaders })).toEqual({
      ok: false,
      reason: "invalid or expired access token",
    });
  });
});

async function startServer(
  auth: MerchantMcpAuthVerifier,
): Promise<MerchantMcpServerHandle> {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const service = new MerchantWorkbenchService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals,
    mode: () => "supervised",
    now: () => T0,
  });
  return startMerchantMcpServer({ service, host: "127.0.0.1", port: 0, auth });
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "workbuddy-header-test", version: "0.0.0" },
    },
  });
}

async function rawMcp(
  port: number,
  headers: string[],
  body = initializeBody(),
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: [
          "Host",
          `127.0.0.1:${port}`,
          "Content-Type",
          "application/json",
          "Accept",
          "application/json, text/event-stream",
          ...headers,
        ],
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("WorkBuddy 专用头 HTTP 入口", () => {
  const handles: MerchantMcpServerHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) await handles.pop()?.close();
  });

  it("有效专用头 + 平台注入的错误标准头 → 通过；只有标准头 → 401；重复专用头 → 401", async () => {
    const { inner } = recordingInner({ ok: true });
    const handle = await startServer(new WorkBuddyHeaderAuthVerifier(inner));
    handles.push(handle);

    const accepted = await rawMcp(handle.port, [
      "X-Kiwi-Authorization",
      `Bearer ${TOKEN}`,
      "Authorization",
      "Bearer platform-injected-standard-token",
    ]);
    expect(accepted.status).toBe(200);

    const standardOnly = await rawMcp(handle.port, [
      "Authorization",
      `Bearer ${TOKEN}`,
    ]);
    expect(standardOnly.status).toBe(401);

    const duplicate = await rawMcp(handle.port, [
      "X-Kiwi-Authorization",
      `Bearer ${TOKEN}`,
      "X-Kiwi-Authorization",
      `Bearer ${TOKEN}`,
    ]);
    expect(duplicate.status).toBe(401);
  });
});

describe("本机适配器直连单实例", () => {
  it("专用头 + OAuth token 经固定绑定读取运营报告（不依赖共享网关）", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-adapter-ops-"));
    try {
      const db = new DatabaseSync(":memory:");
      migrateMemorySchema(db);
      db.prepare(
        `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
         VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
      ).run(PRINCIPAL, T0, T0);
      const service = new MerchantWorkbenchService({
        profile: testProfile(),
        merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
        approvals: new WriteApprovalCandidateStore({
          db,
          principalId: PRINCIPAL,
          now: () => T0,
        }),
        mode: () => "supervised",
        now: () => T0,
        operationsReport: createOperationsReportBuilder({ dataDir }),
      });
      const oauthStore = new MerchantOAuthStore({ db: new DatabaseSync(":memory:") });
      const issued = oauthStore.issueTokenPair({
        client_id: "adapter-client",
        principal_id: PRINCIPAL,
        merchant_id: "merchant-001",
        scope: "merchant:read",
      });
      const handle = await startMerchantMcpServer({
        service,
        host: "127.0.0.1",
        port: 0,
        auth: new WorkBuddyHeaderAuthVerifier(
          new MerchantOAuthVerifier({ store: oauthStore, expectedMerchantId: "merchant-001" }),
        ),
      });
      try {
        const binding = createFixedInstanceBinding({
          instanceUrl: `http://127.0.0.1:${handle.port}/mcp`,
        });
        const client = new FixedInstanceMcpClient({
          binding,
          accessToken: issued.access_token,
          shareCode: "",
          fetchImpl: fetch,
        });
        await client.initialize();
        const tools = await client.listTools();
        expect(tools.map((tool) => tool.name)).toContain(
          "kiwi_merchant_get_operations_report",
        );
        const result = await client.callTool("kiwi_merchant_get_operations_report", {
          period: "day",
        });
        expect(result.isError).toBe(false);
        expect(result.structuredContent?.report).toMatchObject({
          period: "day",
          window: { basis: "UTC" },
        });
      } finally {
        await handle.close();
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("profile opt-in", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function profileWith(merchantMcp: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbuddy-header-"));
    dirs.push(dir);
    const file = path.join(dir, "profile.yaml");
    writeFileSync(
      file,
      `runtime_version: 0.5.0
protocol_version: shopping.negotiation/0.1
agent_id: merchant-agent:merchant-001
role: merchant
owner_id: merchant-001
commerce:
  base_url: http://127.0.0.1:8765
  token_env: SHOPPING_AGENT_TOKEN
  backend: local_marketplace
model:
  provider: fake
  model: fake-merchant-model
runtime:
  mode: once
  poll_interval_seconds: 5
  turn_timeout_seconds: 90
  max_model_steps: 4
  max_retries: 2
merchant_policy:
  min_unit_price_private: 80.00
  quote_ttl_seconds: 300
merchant_mcp:
${merchantMcp}
`,
    );
    return file;
  }

  it("显式 oauth + workbuddy_header=true 才启用", () => {
    const profile = loadProfile(
      profileWith("  enabled: true\n  auth_mode: oauth\n  workbuddy_header: true"),
    );
    expect(profile.merchant_mcp?.workbuddy_header).toBe(true);
  });

  it("token 模式、非布尔、未知字段拒绝", () => {
    expect(() =>
      loadProfile(profileWith("  enabled: true\n  auth_mode: token\n  workbuddy_header: true")),
    ).toThrow(/workbuddy_header requires auth_mode=oauth/);
    expect(() =>
      loadProfile(profileWith("  enabled: true\n  auth_mode: oauth\n  workbuddy_header: yes")),
    ).toThrow(/workbuddy_header must be a boolean/);
    expect(() =>
      loadProfile(profileWith("  enabled: true\n  auth_mode: oauth\n  workbuddy_header_extra: true")),
    ).toThrow(/workbuddy_header_extra/);
  });

  it("conversation 显式 opt-in：OAuth 允许，token 模式拒绝", () => {
    const profile = loadProfile(
      profileWith("  enabled: true\n  auth_mode: oauth\n  conversation: true"),
    );
    expect(profile.merchant_mcp?.conversation).toBe(true);
    expect(() =>
      loadProfile(profileWith("  enabled: true\n  auth_mode: token\n  conversation: true")),
    ).toThrow(/conversation requires auth_mode=oauth/);
  });

  it("装配层对 token 模式 + workbuddy_header 也 fail-closed（防绕过 profile 校验）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbuddy-header-assembly-"));
    dirs.push(dir);
    await expect(
      assembleMerchantRuntime({
        profile: testProfile({
          merchant_mcp: { auth_mode: "token", workbuddy_header: true },
        }),
        dataDir: dir,
        host: "127.0.0.1",
        port: 0,
        mcpPath: "/mcp",
        authMode: "token",
        log: () => undefined,
      }),
    ).rejects.toThrow(/workbuddy_header\/conversation 需要 auth_mode=oauth/);
  });
});
