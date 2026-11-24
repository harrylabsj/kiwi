/**
 * 独立部署工作台路由：/merchant/ 页面、/merchant/api/*、/admin/* 登录面、
 * /livez 健康检查各自命中，未知路径 404；页面不缓存。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAdminCredentials } from "../src/auth/merchant-sessions.js";
import { loadProfile } from "../src/config/profile.js";
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

async function startWorkbench(root: string): Promise<StandaloneWorkbenchHandle | undefined> {
  const profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, PROFILE);
  const profile = loadProfile(profilePath);
  writeAdminCredentials(root, {
    principalId: profile.agent_id,
    merchantId: profile.owner_id,
    password: "strong-pw-123",
  });
  try {
    return await startStandaloneMerchantWorkbench({
      profile,
      dataDir: root,
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });
  } catch {
    return undefined;
  }
}

describe("standalone merchant workbench", () => {
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
    const live = await fetch(new URL("/livez", handle.url));
    expect(live.status).toBe(200);
    expect((await live.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const login = await fetch(new URL("/admin/login?next=%2Fmerchant%2F", handle.url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=strong-pw-123&next=%2Fmerchant%2F",
      redirect: "manual",
    });
    expect(login.status).toBe(303);
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
  });

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
      expires_at: "2026-11-25T00:00:00.000Z",
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
