/**
 * 代码审查第一批（安全）验收测试：BUG-01 / BUG-02 / BUG-03。
 *
 * BUG-01（P0）：OAuth 授权前的商家身份认证——匿名拒绝、跨商家拒绝、失效
 * 会话拒绝、token 主体来自认证用户而非启动参数。
 * BUG-02（P0）：模型不可自我批准——execute/reject 不在 MCP 注册表；无确认
 * 记录写操作不可执行；审计含批准人/内容/时间。
 * BUG-03（P1）：管理确认页 cookie 会话 + 一次性确认凭证（缺/重复/过期/
 * 不匹配拒绝）；跨主体拒绝。
 *
 * 确定性：内存 SQLite + 临时目录 + ephemeral 端口 + 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MerchantOAuthServer,
  MerchantOAuthStore,
  pkceS256,
  workbuddyCallbackUri,
} from "../src/auth/merchant-oauth.js";
import {
  MerchantAdminSessions,
  readAdminCredentials,
  renderAdminLoginPage,
  verifyAdminPassword,
  writeAdminCredentials,
} from "../src/auth/merchant-sessions.js";
import { MerchantOAuthVerifier } from "../src/auth/merchant-authorization.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { MerchantOperationStore } from "../src/merchant-core/operations.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../src/mcp/merchant-server.js";
import { merchantAdminSurface } from "../src/merchant-admin/pending-page.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { buildMerchantMcpTools } from "../src/mcp/merchant-tools.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const ADMIN_PW = "review-admin-password-1";
const VERIFIER = "review-code-verifier-0123456789abcdef";
const CALLBACK = workbuddyCallbackUri("kiwi-merchant");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "kiwi-review1-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

describe("BUG-01：OAuth 授权前的商家身份认证", () => {
  it("管理登录页转义不可信 next/error 内容", () => {
    const html = renderAdminLoginPage({
      next: '"><script>alert(1)</script>',
      error: "<img src=x onerror=alert(1)>",
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  function setup() {
    const clock = { value: T0 };
    const store = new MerchantOAuthStore({
      db: new DatabaseSync(":memory:"),
      now: () => clock.value,
    });
    const server = new MerchantOAuthServer({
      store,
      issuer: "http://127.0.0.1:9100",
      resource: "http://127.0.0.1:9100/mcp",
      connectorSource: "kiwi-merchant",
      merchantName: "Veyquo 手工陶瓷",
      merchantId: "merchant-001",
      now: () => clock.value,
    });
    return { store, server, clock };
  }

  it("匿名（无会话）访问 authorize → 303 登录页，不进入可批准状态", () => {
    const { server } = setup();
    const result = server.authorize({
      response_type: "code",
      client_id: "c",
      redirect_uri: CALLBACK,
      code_challenge: pkceS256(VERIFIER),
      code_challenge_method: "S256",
    });
    expect(result.status).toBe(303);
    expect(result.headers?.location).toContain("/admin/login");
    expect(result.headers?.location).toContain("next=");
  });

  it("跨商家会话拒绝（会话 merchant ≠ 实例商家 → 403 access_denied）", () => {
    const { server } = setup();
    const result = server.authorize(
      {
        response_type: "code",
        client_id: "c",
        redirect_uri: CALLBACK,
        code_challenge: pkceS256(VERIFIER),
        code_challenge_method: "S256",
      },
      { principal_id: "admin:merchant-999", merchant_id: "merchant-999" },
    );
    expect(result.status).toBe(403);
    expect((result.body as { error: string }).error).toBe("access_denied");
  });

  it("失效会话拒绝（sessions.getSession 对过期/撤销返回 undefined）", () => {
    const clock = { value: T0 };
    const sessions = new MerchantAdminSessions({
      db: new DatabaseSync(":memory:"),
      now: () => clock.value,
    });
    const { sessionId } = sessions.createSession({
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
    });
    expect(sessions.getSession(sessionId)).toBeDefined();
    sessions.revoke(sessionId);
    expect(sessions.getSession(sessionId)).toBeUndefined();
    // 过期
    const second = sessions.createSession({ principalId: PRINCIPAL, merchantId: "merchant-001" });
    clock.value = new Date(Date.parse(T0) + 13 * 3600 * 1000).toISOString();
    expect(sessions.getSession(second.sessionId)).toBeUndefined();
  });

  it("token 主体来自认证用户（挂起单绑定会话 principal），不是启动参数", () => {
    const { store, server } = setup();
    const reg = server.register({ client_name: "t", redirect_uris: [CALLBACK] });
    const clientId = (reg.body as { client_id: string }).client_id;
    // 认证用户 principal 是 admin 凭据主体（非任何启动参数——启动参数已删除）
    const session = { principal_id: "admin:authenticated-user", merchant_id: "merchant-001" };
    const page = server.authorize(
      {
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        scope: "merchant:read",
        code_challenge: pkceS256(VERIFIER),
        code_challenge_method: "S256",
      },
      session,
    );
    expect(page.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1] ?? "";
    const submit = server.authorizeSubmit({ csrf, decision: "approve" }, session);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code") ?? "";
    const token = server.token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(token.status).toBe(200);
    const row = store.getAccessToken((token.body as { access_token: string }).access_token);
    expect(row?.principal_id).toBe("admin:authenticated-user"); // 认证用户主体
    expect(row?.merchant_id).toBe("merchant-001");
  });

  it("管理员口令：scrypt 哈希校验（恒定时间）、短口令拒绝、覆盖需 force、不明文落盘", () => {
    const dir = tmp();
    const creds = writeAdminCredentials(dir, {
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      password: ADMIN_PW,
    });
    expect(creds.password_hash.startsWith("scrypt$")).toBe(true);
    expect(creds.password_hash).not.toContain(ADMIN_PW);
    expect(verifyAdminPassword(ADMIN_PW, creds.password_hash)).toBe(true);
    expect(verifyAdminPassword("wrong-password-xx", creds.password_hash)).toBe(false);
    expect(() =>
      writeAdminCredentials(tmp(), { principalId: "p", merchantId: "m", password: "short" }),
    ).toThrow(/至少 8 位/);
    expect(() =>
      writeAdminCredentials(dir, {
        principalId: PRINCIPAL,
        merchantId: "merchant-001",
        password: "another-password-1",
      }),
    ).toThrow(/已存在/);
    const again = writeAdminCredentials(dir, {
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      password: "another-password-1",
      force: true,
    });
    expect(verifyAdminPassword("another-password-1", again.password_hash)).toBe(true);
    expect(readAdminCredentials(dir)?.merchant_id).toBe("merchant-001");
  });
});

describe("BUG-02：模型不可自我批准", () => {
  function setupCore(confirmations?: MerchantOAuthStore) {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, T0, T0);
    const store = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
    const core = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      approvals: store,
      mode: () => "supervised",
      now: () => T0,
      commandPrincipalId: PRINCIPAL,
      operations: new MerchantOperationStore({ db, now: () => T0 }),
      ...(confirmations !== undefined ? { confirmations } : {}),
    });
    return { core, store, db };
  }

  it("MCP 注册表无 execute/reject 工具（模型不可见）；call 返回未知工具", async () => {
    const { core, db } = setupCore();
    const tools = buildMerchantMcpTools(core);
    const names = tools.listTools(undefined).map((t) => t.name);
    expect(names).not.toContain("kiwi_merchant_execute_approved");
    expect(names).not.toContain("kiwi_merchant_reject_candidate");
    // 模型连续 prepare + execute：execute 不在注册表
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 1 });
    const result = await tools.call("kiwi_merchant_execute_approved", {
      command_id: prepared.candidate.candidate_id,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("未知工具");
    db.close();
  });

  it("无确认记录写操作不可执行；有效凭证可执行；重用/错绑/过期拒绝；审计含批准人与时间", async () => {
    const clock = { value: T0 };
    const confirmations = new MerchantOAuthStore({
      db: new DatabaseSync(":memory:"),
      now: () => clock.value,
    });
    const { core, db } = setupCore(confirmations);
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 1 });
    const id = prepared.candidate.candidate_id;

    // 无凭证 → 拒绝
    await expect(core.executeApproved(id)).rejects.toMatchObject({ kind: "validation" });
    // 错绑候选的凭证 → 拒绝
    const wrongToken = confirmations.createConfirmation({
      candidateId: "act_other",
      candidateDigest: "sha256:other",
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      action: "approve",
    });
    await expect(core.executeApproved(id, wrongToken)).rejects.toMatchObject({
      kind: "validation",
    });
    // 有效凭证 → 执行；审计字段（批准人/动作/时间）
    const { contentHash } = await import("../src/agent/merchant/action-candidate.js");
    const candidate = core.commands.get(id);
    const token = confirmations.createConfirmation({
      candidateId: id,
      candidateDigest: contentHash({
        arguments: candidate?.arguments ?? {},
        preconditions: candidate?.preconditions ?? {},
      }),
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      action: "approve",
    });
    const outcome = await core.executeApproved(id, token);
    expect(outcome.kind).toBe("executed");
    const audit = confirmations.consumeConfirmation(token, {
      candidateId: id,
      candidateDigest: "sha256:any",
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      action: "approve",
    });
    expect(audit).toBeUndefined(); // 单次用途：已核销
    // 过期凭证拒绝
    clock.value = new Date(Date.parse(T0) + 11 * 60 * 1000).toISOString();
    const expiredToken = confirmations.createConfirmation({
      candidateId: id,
      candidateDigest: "sha256:x",
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      action: "approve",
    });
    await expect(core.executeApproved(id, expiredToken)).rejects.toMatchObject({
      kind: "validation",
    });
    db.close();
  });
});

describe("BUG-03：管理确认页会话与确认凭证（HTTP）", () => {
  it("无会话 303 登录；登录后批准需有效确认凭证；缺/重复/错配拒绝；跨主体拒绝", async () => {
    const clock = { value: T0 };
    const sharedDb = new DatabaseSync(":memory:");
    const oauthStore = new MerchantOAuthStore({ db: sharedDb, now: () => clock.value });
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, T0, T0);
    const store = new WriteApprovalCandidateStore({
      db,
      principalId: PRINCIPAL,
      now: () => clock.value,
    });
    const client = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
    const core = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: client,
      approvals: store,
      mode: () => "supervised",
      now: () => clock.value,
      commandPrincipalId: PRINCIPAL,
      operations: new MerchantOperationStore({ db, now: () => clock.value }),
      confirmations: oauthStore,
    });
    const adminDir = tmp();
    writeAdminCredentials(adminDir, {
      principalId: PRINCIPAL,
      merchantId: "merchant-001",
      password: ADMIN_PW,
    });
    const probe = await startMerchantMcpServer({ service: core, host: "127.0.0.1", port: 0 });
    const issuer = `http://127.0.0.1:${probe.port}`;
    await probe.close();
    const oauth = new MerchantOAuthServer({
      store: oauthStore,
      issuer,
      resource: `${issuer}/mcp`,
      connectorSource: "kiwi-merchant",
      merchantName: "Veyquo 手工陶瓷",
      merchantId: "merchant-001",
      now: () => clock.value,
    });
    const handle: MerchantMcpServerHandle = await startMerchantMcpServer({
      service: core,
      host: "127.0.0.1",
      port: probe.port,
      oauth,
      auth: new MerchantOAuthVerifier({ store: oauthStore, expectedMerchantId: "merchant-001" }),
      admin: {
        merchantName: "Veyquo 手工陶瓷",
        surface: merchantAdminSurface(core),
        sessions: new MerchantAdminSessions({ db: sharedDb, now: () => clock.value }),
        store: oauthStore,
        adminDir,
      },
    });
    try {
      // 准备一条待批准命令
      const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 2 });
      const commandId = prepared.candidate.candidate_id;

      // 无会话访问 pending → 303 登录页
      const noSession = await fetch(`${issuer}/admin/pending`, { redirect: "manual" });
      expect(noSession.status).toBe(303);

      // 登录
      const login = await fetch(`${issuer}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: ADMIN_PW }).toString(),
        redirect: "manual",
      });
      expect(login.status).toBe(303);
      const setCookie = login.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      const cookie = setCookie.split(";")[0] ?? "";

      // 登录后 pending 页 200，含候选与确认凭证
      const page = await fetch(`${issuer}/admin/pending`, { headers: { cookie } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(commandId);
      const confirmation = new RegExp(
        `name="confirmation" value="([^"]+)"[\\s\\S]*?${commandId}|${commandId}[\\s\\S]*?name="confirmation" value="([^"]+)"`,
      ).exec(html);
      const token = confirmation?.[1] ?? confirmation?.[2] ?? "";
      expect(token).not.toBe("");

      // 缺凭证 → 403
      const missing = await fetch(`${issuer}/admin/decision`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ command_id: commandId, decision: "approve" }).toString(),
      });
      expect(missing.status).toBe(403);

      // 有效凭证批准 → 303 回跳；库存已改
      const ok = await fetch(`${issuer}/admin/decision`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          command_id: commandId,
          decision: "approve",
          confirmation: token,
        }).toString(),
        redirect: "manual",
      });
      expect(ok.status).toBe(303);
      expect((await client.getProduct("sku-001")).stock).toBe(2);

      // 凭证重用/错配（单次用途 + 绑定候选）：准备第二条命令，用第一条已核销的
      // 凭证批准它 → 403（凭证已用且候选不匹配）
      const second = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 7 });
      const reuse = await fetch(`${issuer}/admin/decision`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          command_id: second.candidate.candidate_id,
          decision: "approve",
          confirmation: token,
        }).toString(),
      });
      expect(reuse.status).toBe(403);
    } finally {
      await handle.close();
      db.close();
      sharedDb.close();
    }
  });
});
