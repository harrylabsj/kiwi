/**
 * Merchant MCP 认证测试（WorkBuddy Buddy 应用开发计划 阶段二）：
 * - StaticBearerTokenVerifier：无 token / 非 Bearer 头 / 错误 token 被拒，
 *   正确 token 通过；恒定时间比较（timingSafeEqual；长度不等时短路不比较）；
 * - resolveMerchantMcpVerifier：token_env 解析与缺省环境变量名；
 * - assertMerchantMcpAuthPolicy fail-closed：非 loopback 无 token 拒绝启动，
 *   loopback 无 token 允许但返回警告；
 * - 真实 HTTP server（ephemeral 端口）：401 行为端到端。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// spy timingSafeEqual：恒定时间比较的使用断言（importOriginal 透传其余 node:crypto）。
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { timingSafeEqual } from "node:crypto";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import {
  assertMerchantMcpAuthPolicy,
  DEFAULT_MERCHANT_MCP_TOKEN_ENV,
  resolveMerchantMcpVerifier,
  StaticBearerTokenVerifier,
} from "../src/mcp/merchant-auth.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../src/mcp/merchant-server.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "merchant-agent:merchant-001";
const TOKEN = "test-mcp-token-0123456789abcdef";

const handles: MerchantMcpServerHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.close();
  }
});

async function startAuthedServer(
  auth?: StaticBearerTokenVerifier,
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
  const handle = await startMerchantMcpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    ...(auth !== undefined ? { auth } : {}),
  });
  handles.push(handle);
  return handle;
}

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "auth-test", version: "0.0.0" },
  },
};

describe("StaticBearerTokenVerifier", () => {
  it("无 Authorization 头 / 非 Bearer 头 / 错误 token 被拒，正确 token 通过", () => {
    const verifier = new StaticBearerTokenVerifier(TOKEN);
    expect(verifier.verify({})).toMatchObject({ ok: false });
    expect(verifier.verify({ authorizationHeader: "Basic abc" })).toMatchObject({ ok: false });
    expect(
      verifier.verify({ authorizationHeader: "Bearer wrong-token-000000000000000" }),
    ).toMatchObject({
      ok: false,
    });
    expect(verifier.verify({ authorizationHeader: `Bearer ${TOKEN}` })).toEqual({ ok: true });
    // Bearer 大小写不敏感
    expect(verifier.verify({ authorizationHeader: `bearer ${TOKEN}` })).toEqual({ ok: true });
  });

  it("空 token 构造即抛错（fail-closed）", () => {
    expect(() => new StaticBearerTokenVerifier("")).toThrow();
  });

  it("恒定时间比较：等长候选走 timingSafeEqual，长度不等短路不比较", () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    const verifier = new StaticBearerTokenVerifier(TOKEN);
    // 等长错误 token：必须走恒定时间比较
    expect(verifier.verify({ authorizationHeader: `Bearer ${"x".repeat(TOKEN.length)}` }).ok).toBe(
      false,
    );
    expect(spy).toHaveBeenCalled();
    // 长度不等：长度恒等预检短路，不调 timingSafeEqual
    spy.mockClear();
    expect(verifier.verify({ authorizationHeader: "Bearer short" }).ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("resolveMerchantMcpVerifier", () => {
  it("缺省环境变量名 + token_env 覆盖；未设置返回 undefined", () => {
    const env = { [DEFAULT_MERCHANT_MCP_TOKEN_ENV]: TOKEN, CUSTOM_MCP_TOKEN: "other-token" };
    expect(
      resolveMerchantMcpVerifier(undefined, env)?.verify({
        authorizationHeader: `Bearer ${TOKEN}`,
      }),
    ).toEqual({ ok: true });
    expect(
      resolveMerchantMcpVerifier("CUSTOM_MCP_TOKEN", env)?.verify({
        authorizationHeader: "Bearer other-token",
      }),
    ).toEqual({ ok: true });
    expect(resolveMerchantMcpVerifier(undefined, {})).toBeUndefined();
    expect(
      resolveMerchantMcpVerifier(undefined, { [DEFAULT_MERCHANT_MCP_TOKEN_ENV]: "  " }),
    ).toBeUndefined();
  });
});

describe("assertMerchantMcpAuthPolicy（fail-closed）", () => {
  it("非 loopback 监听且无 token → 抛错拒绝启动", () => {
    expect(() => assertMerchantMcpAuthPolicy("0.0.0.0", undefined)).toThrow(/fail-closed/);
    expect(() => assertMerchantMcpAuthPolicy("203.0.113.10", undefined)).toThrow();
  });

  it("loopback 监听且无 token → 允许启动但返回警告", () => {
    const warning = assertMerchantMcpAuthPolicy("127.0.0.1", undefined);
    expect(warning).toContain("未配置认证 token");
    expect(assertMerchantMcpAuthPolicy("::1", undefined)).toContain("⚠️");
  });

  it("已配置校验器 → 无警告（任意 host）", () => {
    const verifier = new StaticBearerTokenVerifier(TOKEN);
    expect(assertMerchantMcpAuthPolicy("0.0.0.0", verifier)).toBeUndefined();
  });
});

describe("HTTP 端到端", () => {
  it("配置认证后：无 token 401、错误 token 401、正确 token 通过 initialize", async () => {
    const handle = await startAuthedServer(new StaticBearerTokenVerifier(TOKEN));

    const noToken = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toBe("Bearer");

    const wrongToken = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token-00000000000000",
      },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(wrongToken.status).toBe(401);

    const rightToken = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(rightToken.status).toBe(200);
    const body = (await rightToken.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("kiwi-merchant-workbench");
  });

  it("未配置认证的 loopback server 照常服务（启动守卫在 CLI 层）", async () => {
    const handle = await startAuthedServer();
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(res.status).toBe(200);
  });

  it("未知路径 404；认证失败不回显 token 信息", async () => {
    const handle = await startAuthedServer(new StaticBearerTokenVerifier(TOKEN));
    const notFound = await fetch("http://127.0.0.1:" + String(handle.port) + "/other", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(INITIALIZE_BODY),
    });
    expect(notFound.status).toBe(404);
    const denied = await (
      await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}-x` },
        body: JSON.stringify(INITIALIZE_BODY),
      })
    ).text();
    expect(denied).not.toContain(TOKEN);
  });
});
