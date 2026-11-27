/**
 * 独立部署工作台路由：/merchant/ 页面、/merchant/api/*、/admin/* 登录面、
 * /livez 健康检查各自命中，未知路径 404；页面不缓存。
 */
import { createServer, request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createContext, Script } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adminCredentialsPath, writeAdminCredentials } from "../src/auth/merchant-sessions.js";
import { BuyerFollowups } from "../src/merchant-core/support/buyer-followups.js";
import { loadProfile } from "../src/config/profile.js";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";
import {
  createWorkbenchRequestRouter,
  startStandaloneMerchantWorkbench,
  type StandaloneWorkbenchHandle,
} from "../src/merchant/workbench-server.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const workbenches: StandaloneWorkbenchHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(workbenches.splice(0).map((handle) => handle.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function mount(): Promise<string> {
  const router = createWorkbenchRequestRouter({
    page: "<!doctype html><title>工作台</title>",
    api: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"handler":"api"}');
    },
    admin: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("admin-login");
    },
    trusted: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("trusted-confirmation");
    },
    version: "0.0.0-test",
  });
  const server = createServer(router);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

const PROFILE = `
runtime_version: 0.5.0
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
  delivery_lead_days: 7
`;

async function startWorkbench(root: string, preview?: Parameters<typeof startStandaloneMerchantWorkbench>[0]["manualSupportPreview"]): Promise<StandaloneWorkbenchHandle | undefined> {
  const profilePath = join(root, "profile.yaml");
  if (!existsSync(profilePath)) writeFileSync(profilePath, PROFILE, { mode: 0o600 });
  const profile = loadProfile(profilePath);
  if (!existsSync(adminCredentialsPath(root))) {
    writeAdminCredentials(root, {
      principalId: profile.agent_id,
      merchantId: profile.owner_id,
      password: "strong-pw-123",
    });
  }
  try {
    return await startStandaloneMerchantWorkbench({
      profile,
      dataDir: root,
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
      ...(preview === undefined ? {} : { manualSupportPreview: preview }),
    });
  } catch (error) {
    if (preview !== undefined) throw error;
    return undefined;
  }
}

describe("standalone merchant workbench", () => {
  it.each([
    { label: "anonymous", role: "anonymous" },
    { label: "operator", role: "operator" },
    { label: "unbound owner", role: "owner", ownerState: "unbound" },
    { label: "unbound preview-only owner", role: "owner", ownerState: "preview" },
    { label: "owner before model consent", role: "owner", ownerState: "rules" },
    { label: "owner after model consent", role: "owner", ownerState: "model" },
  ])("opens the single-purpose Weixin page as $label without navigating the workbench", async ({ role, ownerState }) => {
    const page = renderMerchantManagementPage({ productAuthority: "exact", weixinOnly: true });
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    expect(scripts.length).toBeGreaterThan(0);
    const view = { innerHTML: "", setAttribute: () => {}, querySelectorAll: () => [] };
    const panel = { innerHTML: "" };
    const capabilities = { innerHTML: "" };
    const drafts = { hidden: true };
    const list = { textContent: "" };
    const elements = new Map<string, object>([["view", view], ["who", {}], ["page-title", {}],
      ["page-description", {}], ["weixin-panel", panel], ["weixin-begin", {}], ["weixin-disconnect", {}],
      ["weixin-mobile-capabilities", capabilities], ["weixin-mobile-drafts", drafts], ["weixin-draft-refresh", {}], ["weixin-draft-list", list]]);
    const requests: string[] = [];
    const bound = ownerState === "rules" || ownerState === "model";
    const context = createContext({
      document: { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [] },
      setTimeout: () => 0, clearTimeout: () => {},
      fetch: (url: string) => {
        requests.push(url);
        if (url === "/merchant/api/session") {
          return Promise.resolve(role === "anonymous" ? new Response(null, { status: 401 }) : Response.json({ role, merchant_id: "fixture", csrf_token: "fixture" }));
        }
        if (url === "/merchant/api/v1/channels/weixin") return Promise.resolve(Response.json({
          status: bound ? "connected" : "disconnected", configured: bound,
          conversation: { enabled: true, authorized: bound, delivery: ownerState === "preview" ? "workbench_only" : "paired_owner",
            model_authorized: ownerState === "model",
            ...(bound ? { agent: { state: "configured", provider: "fixture", model: "fixture", endpoint: "https://example.invalid" } } : {}) },
        }));
        if (url === "/merchant/api/v1/channels/weixin/reply-drafts") return Promise.resolve(Response.json({ items: [] }));
        throw new Error("unexpected request: " + url);
      },
    });
    for (const script of scripts) await new Script(script!).runInContext(context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (role === "anonymous") expect(view.innerHTML).toContain('/admin/login?next=%2Fmerchant%2Fweixin');
    if (role === "operator") expect(view.innerHTML).toContain("只有本实例的店主");
    if (role === "owner") {
      expect(view.innerHTML).toContain('id="weixin-panel"');
      expect(panel.innerHTML).toContain(bound ? "断开连接" : "生成微信二维码");
      expect(panel.innerHTML).toContain(bound ? "在微信里向机器人发送 /ping 验证收发" : "微信连接：未连接");
      expect(panel.innerHTML).toContain('id="weixin-mobile-capabilities"');
      if (ownerState === "unbound") {
        expect(panel.innerHTML).toContain("在手机微信确认绑定，即授权 Kiwi 仅回复这个店主账号的私聊");
        expect(panel.innerHTML).toContain("不会调用模型或向买家发送消息");
      } else {
        expect(panel.innerHTML).not.toContain("在手机微信确认绑定，即授权");
      }
      expect(capabilities.innerHTML).toContain(bound ? "已绑定，已授权店主回信" : "未绑定");
      expect(capabilities.innerHTML).toContain(ownerState === "model" ? "已配置并授权；未在此页验证推理连通性" :
        ownerState === "rules" ? "已配置，未授权" : ownerState === "preview" ? "<dd>未启用</dd>" : "未启用或未配置");
      expect(capabilities.innerHTML).toContain(bound ? "支持待跟进询价、清单追问和起草" : "微信内未启用");
      expect(capabilities.innerHTML).toContain("不会向买家发送");
      expect(view.innerHTML).toContain('id="weixin-mobile-drafts"');
      expect(drafts.hidden).toBe(false);
      expect(list.textContent).toContain("没有已保存的回复草稿");
    } else {
      expect(drafts.hidden).toBe(true);
    }
    expect(requests).toEqual(role === "owner" ? ["/merchant/api/session", "/merchant/api/v1/channels/weixin",
      "/merchant/api/v1/channels/weixin/reply-drafts"] : ["/merchant/api/session"]);
  });

  it("starts a local workbench with login/admin surfaces and /livez", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwi-workbench-"));
    dirs.push(root);
    process.env.KIWI_GOVERNANCE_LEARNING_ENABLED = "true";
    let handle: StandaloneWorkbenchHandle | undefined;
    try {
      handle = await startWorkbench(root);
    } finally {
      delete process.env.KIWI_GOVERNANCE_LEARNING_ENABLED;
    }
    if (handle === undefined) throw new Error("workbench failed to start");
    workbenches.push(handle);
    const page = await fetch(handle.url);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("商家工作台");
    expect(pageHtml).toContain("var WEIXIN_CHANNEL = true");
    expect(pageHtml).toContain("var MANUAL_SUPPORT = false");
    expect(handle.supportOrigin).toBeUndefined();
    const live = await fetch(new URL("/livez", handle.url));
    expect(live.status).toBe(200);
    expect((await live.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const pairingPage = await fetch(new URL("/merchant/weixin/", handle.url));
    expect(pairingPage.status).toBe(200);
    expect(pairingPage.headers.get("cache-control")).toBe("no-store");
    const pairingHtml = await pairingPage.text();
    expect(pairingHtml).toContain("var WEIXIN_ONLY = true");
    expect(pairingHtml).not.toContain('<nav id="tabs"');
    const invalidMethod = await fetch(new URL("/merchant/weixin", handle.url), { method: "POST" });
    expect(invalidMethod.status).toBe(405);
    const anonymous = await fetch(new URL("/merchant/api/v1/channels/weixin", handle.url));
    expect(anonymous.status).toBe(401);

    const login = await fetch(new URL("/admin/login", handle.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=strong-pw-123&next=%2Fmerchant%2Fweixin",
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/merchant/weixin");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("kiwi_admin=");
    const weixin = await fetch(new URL("/merchant/api/v1/channels/weixin", handle.url), { headers: { cookie } });
    expect(weixin.status).toBe(200);
    expect(await weixin.json()).toEqual({ status: "disconnected", configured: false });
    const policy = await fetch(new URL("/merchant/api/v1/policy", handle.url), {
      headers: { cookie },
    });
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ auto_quote: true });

    // TOP1-3 管理路由已接入同一 workbench 入口。
    const corrections = await fetch(
      new URL("/merchant/api/v1/learning/corrections", handle.url),
      { headers: { cookie } },
    );
    expect(corrections.status).toBe(200);
    expect(await corrections.json()).toEqual({ corrections: [] });
    const rules = await fetch(new URL("/merchant/api/v1/automation/rules", handle.url), {
      headers: { cookie },
    });
    expect(rules.status).toBe(404);
    const support = await fetch(new URL("/merchant/api/v1/support/cases", handle.url), { headers: { cookie } });
    expect(support.status).toBe(404);
  });

  it("rejects enabling manual support on a public Workbench or without a governance owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwi-support-gates-"));
    dirs.push(root);
    const preview = { tls: {}, serviceHours: "合成服务时段", contactHint: "合成人工入口" };
    await expect(startWorkbench(root, preview)).rejects.toMatchObject({ code: "unavailable" });
    const profile = loadProfile(join(root, "profile.yaml"));
    await expect(startStandaloneMerchantWorkbench({ profile, dataDir: root, host: "0.0.0.0", port: 0, manualSupportPreview: preview }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(startStandaloneMerchantWorkbench({ profile, dataDir: root, host: "127.0.0.1", port: 0,
      publicOrigin: "https://example.invalid", manualSupportPreview: preview })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("resumes a local HTTPS buyer after Workbench restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwi-support-preview-"));
    dirs.push(root);
    const key = join(root, "fixture.key"), cert = join(root, "fixture.pem"), config = join(root, "tls.cnf");
    writeFileSync(config, "[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:localhost\n");
    execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=localhost",
      "-keyout", key, "-out", cert, "-config", config, "-extensions", "v3"], { stdio: "ignore" });
    const ca = readFileSync(cert);
    async function boot() {
      const old = process.env.KIWI_GOVERNANCE_LEARNING_ENABLED;
      process.env.KIWI_GOVERNANCE_LEARNING_ENABLED = "true";
      try {
        const result = await startWorkbench(root, {
          tls: { key: readFileSync(key), cert: ca }, serviceHours: "本地测试时段", contactHint: "合成商家人工入口",
        });
        if (result?.supportOrigin === undefined) throw new Error("support preview not started");
        workbenches.push(result);
        return { ...result, supportOrigin: result.supportOrigin };
      } finally {
        if (old === undefined) delete process.env.KIWI_GOVERNANCE_LEARNING_ENABLED;
        else process.env.KIWI_GOVERNANCE_LEARNING_ENABLED = old;
      }
    }
    let handle = await boot();
    const base = "/api/customer-service/v1";
    function buyer(path: string, options: { cookie?: string; body?: unknown; origin?: string } = {}) {
      const root = new URL(handle.supportOrigin);
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolve, reject) => {
        const request = httpsRequest({ hostname: "127.0.0.1", servername: "localhost", port: root.port, ca, path,
          method: payload === undefined ? "GET" : "POST", headers: { host: root.host, ...(options.cookie ? { cookie: options.cookie } : {}),
            ...(payload === undefined ? {} : { origin: options.origin ?? root.origin, "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (data: Buffer) => chunks.push(data));
          response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
        });
        request.on("error", reject);
        request.end(payload);
      });
    }
    const begin = () => buyer(base + "/sessions", { body: {} });
    const page = await buyer("/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("提交售后");
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(page.text)?.[1];
    expect(script).toBeDefined();
    expect(() => new Script(script!)).not.toThrow();
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await buyer("/merchant/api/session")).status).toBe(404);
    expect((await buyer("/a2a")).status).toBe(404);
    expect((await buyer(base + "/sessions", { body: {}, origin: new URL(handle.url).origin })).status).toBe(403);
    expect((await buyer(base + "/sessions/current/updates")).status).toBe(401);
    const newSession = await begin();
    const cookieLine = newSession.headers["set-cookie"]?.[0] ?? "";
    expect(cookieLine).toMatch(/^__Host-kiwi_cs=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    expect(cookieLine).not.toContain("Domain=");
    const cookie = cookieLine.split(";")[0]!;
    expect(newSession.text).not.toContain(cookie.split("=")[1]);
    const otherCookie = (await begin()).headers["set-cookie"]?.[0]?.split(";")[0];
    expect(otherCookie).toBeDefined();
    const submission = { type: "confirm_case", client_message_id: randomUUID(), description: "合成买家的故障描述", sku: "SKU-001" };
    const submit = (body: unknown = submission) => buyer(base + "/sessions/current/messages", { body, cookie });
    const accepted = await submit();
    expect(accepted.status).toBe(202);
    expect(await submit().then((response) => response.text)).toBe(accepted.text);
    expect((await submit({ ...submission, description: "changed intent" })).status).toBe(409);
    expect((await submit({ ...submission, merchant_id: "not-this-merchant" })).status).toBe(400);
    const updatesPath = base + "/sessions/current/updates";
    const seen = JSON.parse((await buyer(updatesPath, { cookie })).text) as { events: [{ case_id: string; kind: string }]; next_cursor: string };
    expect(seen.events).toEqual([expect.objectContaining({ kind: "case_receipt" })]);
    const id = seen.events[0].case_id;
    const casePath = base + "/sessions/current/cases/" + id;
    expect((await buyer(casePath, { cookie: otherCookie! })).status).toBe(404);
    expect((await buyer(updatesPath + "?after=" + seen.next_cursor, { cookie: otherCookie! })).status).toBe(400);
    const staffPath = "/merchant/api/v1/support/cases/" + id;
    const staffAddress = new URL(handle.url);
    const otherHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(staffAddress, { headers: { host: `localhost:${staffAddress.port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(otherHost).toBe(403);
    const workbench = await fetch(handle.url);
    expect(await workbench.text()).toContain("var MANUAL_SUPPORT = true");
    expect((await fetch(new URL(staffPath, handle.url))).status).toBe(401);
    const login = await fetch(new URL("/admin/login?next=%2Fmerchant%2F", handle.url), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=strong-pw-123&next=%2Fmerchant%2F", redirect: "manual",
    });
    expect(login.status).toBe(303);
    const staffCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrf_token: csrf } = await (await fetch(new URL("/merchant/api/session", handle.url), { headers: { cookie: staffCookie } })).json() as { csrf_token: string };
    const act = (verb: string, body: unknown, csrfToken = csrf) => fetch(new URL(staffPath + "/" + verb, handle.url), {
      method: "POST", headers: { cookie: staffCookie, "content-type": "application/json", "x-csrf-token": csrfToken, origin: new URL(handle.url).origin },
      body: JSON.stringify(body),
    });
    expect((await act("claim", { expected_revision: 1 }, "")).status).toBe(403);
    expect((await act("reply", { expected_revision: 1, text: "未领取" })).status).toBe(409);
    expect((await act("claim", { expected_revision: 1 })).status).toBe(200);
    expect((await act("claim", { expected_revision: 1 })).status).toBe(409);
    const text = "人工回访：已登记，等待核实。<不是 HTML>";
    expect((await act("reply", { expected_revision: 2, text })).status).toBe(200);
    expect((await act("reply", { expected_revision: 2, text })).status).toBe(409);
    await handle.close();
    handle = await boot();
    const resumed = await buyer(base + "/sessions", { body: {}, cookie });
    expect(resumed.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(resumed.text)).toMatchObject({ reset: false });
    const reply = await buyer(updatesPath + "?after=" + seen.next_cursor, { cookie });
    expect(reply.status).toBe(200);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(reply.text)).toMatchObject({ events: [{ kind: "claimed" }, { kind: "human_reply", text }] });
    expect((await buyer(updatesPath, { cookie: otherCookie! })).text).not.toContain(text);
    expect((await act("revoke", { expected_revision: 3 })).status).toBe(403); // 进程重启后的旧 CSRF 无效。
    const refreshed = await (await fetch(new URL("/merchant/api/session", handle.url), { headers: { cookie: staffCookie } })).json() as { csrf_token: string };
    expect((await act("revoke", { expected_revision: 3 }, refreshed.csrf_token)).status).toBe(200);
    expect((await buyer(updatesPath + "?after=" + seen.next_cursor, { cookie })).status).toBe(401);
    expect((await submit()).status).toBe(401);
    const replacement = await buyer(base + "/sessions", { body: {}, cookie });
    expect(JSON.parse(replacement.text)).toMatchObject({ reset: true });
    const lostCookie = replacement.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(lostCookie).not.toBe(cookie);
    expect((await buyer(casePath, { cookie: lostCookie! })).status).toBe(404);
  }, 15_000);

  it("M6-3：绑定/订阅/退订管理路由", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwi-workbench-"));
    dirs.push(root);
    const handle = await startWorkbench(root);
    if (handle === undefined) throw new Error("workbench failed to start");
    workbenches.push(handle);
    const origin = new URL(handle.url).origin;
    const login = await fetch(new URL("/admin/login?next=%2Fmerchant%2F", handle.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=strong-pw-123&next=%2Fmerchant%2F",
      redirect: "manual",
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const session = await fetch(new URL("/merchant/api/session", handle.url), {
      headers: { cookie },
    });
    const csrf = ((await session.json()) as { csrf_token: string }).csrf_token;
    const post = async (path: string, body: unknown) =>
      fetch(new URL(path, handle.url), {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await post("/merchant/api/v1/delivery/bindings", {
      channel: "wechat",
      address_ref: "wxref:abc",
      proof_ref: "proof-1",
    });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(201);
    const binding = JSON.parse(createdBody) as { binding_id: string; binding_epoch: number };
    expect(binding.binding_id).toMatch(/^bind_/);
    const subscription = await post("/merchant/api/v1/delivery/subscriptions", {
      binding_id: binding.binding_id,
      purpose: "arrival_notification",
      max_per_day: 2,
      expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      consent_evidence_ref: "phrase:confirm-1",
    });
    expect(subscription.status).toBe(201);
    const sub = (await subscription.json()) as { subscription_id: string; grant_epoch: number };
    const list = await fetch(new URL("/merchant/api/v1/delivery/subscriptions", handle.url), {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
    const unsubscribed = await post(
      `/merchant/api/v1/delivery/subscriptions/${sub.subscription_id}/unsubscribe`,
      { expected_epoch: sub.grant_epoch },
    );
    expect(unsubscribed.status).toBe(200);
    expect(await unsubscribed.json()).toMatchObject({ grant_epoch: sub.grant_epoch + 1 });
  });

  it("does not mount TOP1-3 routes when governance flags are off", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwi-workbench-"));
    dirs.push(root);
    const handle = await startWorkbench(root);
    if (handle === undefined) throw new Error("workbench failed to start");
    workbenches.push(handle);
    const login = await fetch(new URL("/admin/login?next=%2Fmerchant%2F", handle.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=strong-pw-123&next=%2Fmerchant%2F",
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const policy = await fetch(new URL("/merchant/api/v1/policy", handle.url), {
      headers: { cookie },
    });
    expect(policy.status).toBe(200);
    const corrections = await fetch(
      new URL("/merchant/api/v1/learning/corrections", handle.url),
      { headers: { cookie } },
    );
    expect(corrections.status).toBe(404);
  });
});

describe("standalone merchant workbench router", () => {
  it("serves the workbench page at /merchant and /merchant/ without cache", async () => {
    const base = await mount();
    for (const path of ["/merchant", "/merchant/"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toContain("工作台");
    }
  });

  it("routes /merchant/api/* to the management API and /admin/* to login", async () => {
    const base = await mount();
    const api = await fetch(`${base}/merchant/api/v1/policy`);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ok: true, handler: "api" });
    const admin = await fetch(`${base}/admin/login`);
    expect(admin.status).toBe(200);
    expect(await admin.text()).toBe("admin-login");
    const trusted = await fetch(`${base}/merchant/trusted/confirm?ref=test`);
    expect(trusted.status).toBe(200);
    expect(await trusted.text()).toBe("trusted-confirmation");
  });

  it("exposes /livez and rejects unknown paths", async () => {
    const base = await mount();
    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true, version: "0.0.0-test" });
    const missing = await fetch(`${base}/unknown`);
    expect(missing.status).toBe(404);
  });
});

it("allows only an authenticated owner with CSRF to publish an answer to the original buyer", async () => {
  const root = mkdtempSync(join(tmpdir(), "kiwi-buyer-workbench-"));
  dirs.push(root);
  const before = process.env.KIWI_BUYER_FOLLOWUPS;
  process.env.KIWI_BUYER_FOLLOWUPS = "1";
  try {
    const handle = await startWorkbench(root);
    expect(handle).toBeDefined();
    workbenches.push(handle!);
    const queue = new BuyerFollowups(join(root, "a2a"), "merchant-001", () => new Date().toISOString());
    const created = queue.create({ buyer: "buyer:fixture", negotiation: "neg_fixture", message: "msg_fixture", index: 0,
      sku: "CUP-1", topic: "customization", quantity: 50, wireDigest: "sha256:fixture" })!;
    const url = new URL("/merchant/api/v1/buyer-followups", handle!.url);
    expect((await fetch(url)).status).toBe(401);
    const login = await fetch(new URL("/admin/login", handle!.url), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=strong-pw-123", redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrf_token: csrf } = await (await fetch(new URL("/merchant/api/session", handle!.url), { headers: { cookie } })).json() as { csrf_token: string };
    const list = await fetch(url, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ cases: [{ case_ref: created.case_ref, topic: "customization", status: "pending", version: 1 }] });
    const act = (action: string, body: unknown, token = csrf) => fetch(url.href + "/" + created.case_ref + "/" + action, {
      method: "POST", headers: { cookie, "x-csrf-token": token, origin: url.origin, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await act("claim", { version: 1 }, "bad")).status).toBe(403);
    expect((await act("claim", { version: 1 })).status).toBe(200);
    expect((await act("answer", { version: 1, answer: "stale" })).status).toBe(409);
    expect((await act("answer", { version: 2, answer: "支持单色丝印" })).status).toBe(200);
    expect(queue.readBuyer("buyer:fixture", "neg_fixture", created.case_ref)).toMatchObject({ status: "answered", answer: "支持单色丝印" });
    expect(queue.readBuyer("buyer:other", "neg_fixture", created.case_ref)).toBeUndefined();
    expect((await act("close", { version: 3 })).status).toBe(200);
    expect(queue.readBuyer("buyer:fixture", "neg_fixture", created.case_ref)).not.toHaveProperty("answer");
  } finally { if (before === undefined) delete process.env.KIWI_BUYER_FOLLOWUPS; else process.env.KIWI_BUYER_FOLLOWUPS = before; }
});
