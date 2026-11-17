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

describe("standalone merchant workbench", () => {
  it("starts a local workbench with login/admin surfaces and /livez", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiwi-workbench-"));
    dirs.push(root);
    const profilePath = join(root, "profile.yaml");
    writeFileSync(profilePath, PROFILE);
    const profile = loadProfile(profilePath);
    writeAdminCredentials(root, {
      principalId: profile.agent_id,
      merchantId: profile.owner_id,
      password: "strong-pw-123",
    });
    const handle = await startStandaloneMerchantWorkbench({
      profile,
      dataDir: root,
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });
    workbenches.push(handle);
    const page = await fetch(handle.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("商家工作台");
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
    const policy = await fetch(new URL("/merchant/api/v1/policy", handle.url), {
      headers: { cookie },
    });
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ auto_quote: true });
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
