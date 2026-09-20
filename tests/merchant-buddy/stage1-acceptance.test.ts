/**
 * V2 阶段一验收测试（计划「四、阶段一」三条验收）：
 * 1. 首次绑定到正确商家：OAuth 全流程签发的 token 绑定 merchant_id = 实例
 *    owner_id；跨商家访问拒绝（端到端 HTTP 路径，越权用第二个实例校验）。
 * 2. 关 WorkBuddy 后 A2A 持续服务：不起 MCP 服务时，A2A 报价链路
 *    （rfq→offer）独立可用——两个入口生命周期解耦。
 * 3. 停止 A2A 后管理入口可重启：MerchantRuntimeManager 启停往返。
 *
 * 确定性：临时目录 + ephemeral 端口 + 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MerchantOAuthServer,
  MerchantOAuthStore,
  workbuddyCallbackUri,
  pkceS256,
} from "../../src/auth/merchant-oauth.js";
import { MerchantOAuthVerifier } from "../../src/auth/merchant-authorization.js";
import { MerchantAdminSessions, writeAdminCredentials } from "../../src/auth/merchant-sessions.js";
import { MerchantWorkbenchService } from "../../src/merchant/workbench-service.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../../src/mcp/merchant-server.js";
import { MerchantRuntimeManager } from "../../src/merchant-runtime/manager.js";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../../src/agent/merchant/fake-merchant-client.js";
import { negotiateWithAgent } from "../../src/a2a/negotiate.js";
import { startTestA2aStack, testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const CALLBACK = workbuddyCallbackUri("kiwi-merchant");
const VERIFIER = "stage1-code-verifier-0123456789abcdef";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

describe("阶段一验收 1：首次绑定到正确商家", () => {
  it("OAuth 全流程签发的 token 绑定实例 owner_id；越权租户拒绝", async () => {
    const clock = { value: T0 };
    const oauthDb = new DatabaseSync(":memory:");
    const oauthStore = new MerchantOAuthStore({
      db: oauthDb,
      now: () => clock.value,
    });
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run("merchant-agent:merchant-001", T0, T0);
    const profile = testProfile();
    const service = new MerchantWorkbenchService({
      profile,
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      approvals: new WriteApprovalCandidateStore({
        db,
        principalId: "merchant-agent:merchant-001",
        now: () => clock.value,
      }),
      mode: () => "supervised",
      now: () => clock.value,
    });
    let handle: MerchantMcpServerHandle | undefined;
    try {
      const probe = await startMerchantMcpServer({ service, host: "127.0.0.1", port: 0 });
      const issuer = `http://127.0.0.1:${probe.port}`;
      await probe.close();
      const oauth = new MerchantOAuthServer({
        store: oauthStore,
        issuer,
        resource: `${issuer}/mcp`,
        connectorSource: "kiwi-merchant",
        merchantName: "Veyquo 手工陶瓷",
        merchantId: profile.owner_id,
        now: () => clock.value,
      });
      // BUG-01：授权前先管理员登录（会话 cookie）；管理面挂载
      const adminDir = mkdtempSync(path.join(tmpdir(), "kiwi-stage1-admin-"));
      dirs.push(adminDir);
      writeAdminCredentials(adminDir, {
        principalId: "merchant-agent:merchant-001",
        merchantId: profile.owner_id,
        password: "stage1-admin-pw",
      });
      handle = await startMerchantMcpServer({
        service,
        host: "127.0.0.1",
        port: probe.port,
        oauth,
        auth: new MerchantOAuthVerifier({
          store: oauthStore,
          expectedMerchantId: profile.owner_id,
        }),
        admin: {
          merchantName: "Veyquo 手工陶瓷",
          surface: {
            listPending: () => [],
            executeApproved: async () => ({}),
            rejectCandidate: async () => ({}),
          },
          sessions: new MerchantAdminSessions({ db: oauthDb, now: () => clock.value }),
          store: oauthStore,
          adminDir,
        },
      });
      const login = await fetch(`${issuer}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "stage1-admin-pw" }).toString(),
        redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      // 首次绑定全流程（register → authorize 同意 → token）
      const registered = await fetch(`${issuer}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [CALLBACK] }),
      });
      const clientId = ((await registered.json()) as { client_id: string }).client_id;
      const page = await fetch(
        `${issuer}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: CALLBACK,
          scope: "merchant:read",
          state: "s1",
          code_challenge: pkceS256(VERIFIER),
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie } },
      );
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      const submit = await fetch(`${issuer}/oauth/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
        redirect: "manual",
      });
      const code = new URL(submit.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const tokenRes = await fetch(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: CALLBACK,
          code_verifier: VERIFIER,
        }),
      });
      const { access_token: token } = (await tokenRes.json()) as { access_token: string };

      // token 绑定 merchant-001（= profile.owner_id）：本实例放行
      const ok = await fetch(`${issuer}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      });
      expect(ok.status).toBe(200);

      // 越权：同 store 但期望另一商家的校验器拒绝（跨商家切换须重新授权）
      const otherInstance = new MerchantOAuthVerifier({
        store: oauthStore,
        expectedMerchantId: "merchant-999",
      });
      expect(otherInstance.verify({ authorizationHeader: `Bearer ${token}` }).ok).toBe(false);
    } finally {
      await handle?.close();
      db.close();
    }
  });
});

describe("阶段一验收 2：关 WorkBuddy（无 MCP）后 A2A 持续服务", () => {
  it("不起 MCP 服务时 A2A 报价链路独立可用（rfq→offer→agreement）", async () => {
    // 只起 A2A 测试栈，不起任何 MCP 服务——模拟 WorkBuddy/Buddy 不在场。
    // 商家公布 5% 自动折扣边界：还价在边界内即被确定性接受（T045 修复后，自动
    // 折扣必须来自**公开策略**，不再依据私有底价自动让价——未公布折扣时报价停在 list）。
    const stack = await startTestA2aStack({ merchantPolicy: { max_auto_discount_percent: 5 } });
    try {
      const result = await negotiateWithAgent({
        catalog: stack.catalogUrl,
        allowLoopback: true, // 本地 127.0.0.1 测试栈
      });
      expect(result.ok).toBe(true);
      expect(result.agreement).toBeDefined();
    } finally {
      await stack.stop();
    }
  });
});

describe("阶段一验收 3：停止 A2A 后管理入口可重启", () => {
  it("runtime manager：a2a 停止 → restart 恢复运行", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-stage1-runtime-"));
    dirs.push(dir);
    const manager = new MerchantRuntimeManager({
      dir,
      services: [
        { name: "a2a", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
        { name: "mcp", command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] },
      ],
      now: () => T0,
    });
    await manager.start("a2a");
    await manager.start("mcp");
    // 停止 A2A：mcp 管理面仍在运行
    await manager.stop("a2a");
    expect(manager.status().find((s) => s.name === "a2a")?.running).toBe(false);
    expect(manager.status().find((s) => s.name === "mcp")?.running).toBe(true);
    // 管理入口重启 A2A
    const restarted = await manager.restart("a2a");
    expect(restarted.running).toBe(true);
    await manager.shutdown();
    expect(manager.status().every((s) => !s.running)).toBe(true);
  });
});
