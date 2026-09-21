/**
 * 应用级 OAuth 回调端点（GET /oauth/callback）——BD 交付线 P1 自测路径第 1 步。
 *
 * 这是开放平台 → Buddy 应用的 Open API 授权链的回调落点（与连接器级 OAuth 是
 * 两条互不相通的链路）。验收点：
 *   - 两种平台回跳都如实接收（code / error，RFC 6749 §4.1.2），落地页 200；
 *   - code 是凭据：绝不回显进 HTML、绝不进日志；
 *   - error_description（平台可控自由文本）不回显，错误码只按安全形状回显；
 *   - 非平台回跳（无参数 / 空参数）→ 400；
 *   - 两个 HTTP 面（merchant http handler / gateway entry）都挂载了该端点，
 *     且 merchant http handler 在未配置连接器 OAuth 时仍可用（链路独立）。
 */
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import {
  formatAppOAuthCallbackLog,
  handleAppOAuthCallback,
} from "../src/auth/app-oauth-callback.js";
import { MerchantOAuthServer, MerchantOAuthStore } from "../src/auth/merchant-oauth.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import { createMerchantHttpHandler } from "../src/mcp/merchant-server.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";

describe("应用级回调判定（纯函数）", () => {
  it("code 回跳 → 200 授权完成；code/state 绝不回显", () => {
    const result = handleAppOAuthCallback(
      new URLSearchParams("code=SECRET-CODE-123&state=state-xyz"),
    );
    expect(result.status).toBe(200);
    expect(result.html).toContain("授权完成");
    expect(result.html).not.toContain("SECRET-CODE-123");
    expect(result.html).not.toContain("state-xyz");
    expect(result.log).toEqual({
      event: "app_oauth_callback",
      code_received: true,
      state_present: true,
    });
  });

  it("error 回跳 → 200 授权未完成；错误码按安全形状回显", () => {
    const result = handleAppOAuthCallback(
      new URLSearchParams("error=access_denied&error_description=用户拒绝&state=s1"),
    );
    expect(result.status).toBe(200);
    expect(result.html).toContain("授权未完成");
    expect(result.html).toContain("access_denied");
    // error_description 是平台可控自由文本，一律不回显。
    expect(result.html).not.toContain("用户拒绝");
    expect(result.log.error).toBe("access_denied");
  });

  it("非安全形状的 error 不回显、不入日志", () => {
    const result = handleAppOAuthCallback(
      new URLSearchParams("error=<script>alert(1)</script>"),
    );
    expect(result.status).toBe(200);
    expect(result.html).not.toContain("<script>");
    expect(result.log.error).toBeUndefined();
  });

  it("无参数 / 空参数 → 400（不是平台回跳）", () => {
    for (const query of ["", "code=&state="]) {
      const result = handleAppOAuthCallback(new URLSearchParams(query));
      expect(result.status).toBe(400);
      expect(result.html).toContain("回调参数缺失");
      expect(result.log).toEqual({
        event: "app_oauth_callback",
        code_received: false,
        state_present: false,
      });
    }
  });

  it("留痕行只有元数据字段，无凭据值", () => {
    const line = formatAppOAuthCallbackLog({
      event: "app_oauth_callback",
      code_received: true,
      state_present: false,
    });
    expect(line).toBe("app_oauth_callback code_received=true state_present=false");
    const withError = formatAppOAuthCallbackLog({
      event: "app_oauth_callback",
      code_received: false,
      state_present: true,
      error: "access_denied",
    });
    expect(withError).toBe(
      "app_oauth_callback code_received=false state_present=true error=access_denied",
    );
  });
});

describe("应用级回调端点（merchant http handler 面）", () => {
  const servers: Server[] = [];
  const dbs: DatabaseSync[] = [];
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop();
      await new Promise<void>((resolve) => s?.close(() => resolve()));
    }
    while (dbs.length > 0) dbs.pop()?.close();
    vi.restoreAllMocks();
  });

  async function startHandlerStack(options: { withOauth: boolean }): Promise<string> {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run("merchant-agent:merchant-001", T0, T0);
    const approvals = new WriteApprovalCandidateStore({
      db,
      principalId: "merchant-agent:merchant-001",
      now: () => T0,
    });
    const service = new MerchantWorkbenchService({
      profile: testProfile(),
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      approvals,
      mode: () => "supervised",
      now: () => T0,
    });
    const handle = createMerchantHttpHandler({
      service,
      ...(options.withOauth
        ? {
            oauth: new MerchantOAuthServer({
              store: new MerchantOAuthStore({ db }),
              issuer: "http://127.0.0.1:0",
              resource: "http://127.0.0.1:0/mcp",
              connectorSource: "kiwi-merchant",
              merchantName: "测试商家",
              merchantId: "merchant-001",
              now: () => T0,
            }),
          }
        : {}),
    });
    const server = createServer(handle.handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("code 回跳 → 200 授权完成；日志留痕且无 code 值", async () => {
    const base = await startHandlerStack({ withOauth: true });
    const res = await fetch(`${base}/oauth/callback?code=SECRET-CODE-42&state=st`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("授权完成");
    expect(html).not.toContain("SECRET-CODE-42");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const logged = stderrChunks.join("");
    expect(logged).toContain("app_oauth_callback code_received=true state_present=true");
    expect(logged).not.toContain("SECRET-CODE-42");
  });

  it("未配置连接器 OAuth 时端点仍然可用（链路独立）", async () => {
    const base = await startHandlerStack({ withOauth: false });
    const res = await fetch(`${base}/oauth/callback?error=access_denied`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("授权未完成");
    expect(html).toContain("access_denied");
  });

  it("无参数 → 400", async () => {
    const base = await startHandlerStack({ withOauth: true });
    const res = await fetch(`${base}/oauth/callback`);
    expect(res.status).toBe(400);
  });
});
