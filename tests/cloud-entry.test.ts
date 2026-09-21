/**
 * 云端单端口入口（M1 薄切片）本地验证：配置强校验 / 路由分发 / 就绪检查。
 *
 * 对应验收：T013（端口必须显式、占用即失败，不换端口）、T014（缺持久存储 →
 * 拒绝进入生产 ready）、T015（外网弱认证配置 → 拒绝启动）、T016（单端口里
 * Card / 后台 / A2A 路由正确且鉴权分离）。
 *
 * 本文件只证明**进程内行为**；真实平台与真实制品的证据在
 * evidence/runs/<日期>-M1/ 下另记，不得用本文件冒充实机通过。
 */
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudConfigError,
  assertNoDemoPriceFallback,
  describeCloudConfig,
  loadCloudConfig,
} from "../src/cloud/config.js";
import { createCloudRouter } from "../src/cloud/http-router.js";
import { runReadiness } from "../src/cloud/readiness.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
});

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PORT: "8080",
    KIWI_CLOUD_PUBLIC_ORIGIN: "https://kiwi-merchant.example.app.workbuddy.host",
    KIWI_CLOUD_DATA_DIR: "/workspace/.kiwi-runtime",
    KIWI_CLOUD_PROFILE: "/workspace/.kiwi-runtime/merchant.yaml",
    KIWI_CLOUD_A2A_AUTH: "signature",
    ...overrides,
  };
}

function configError(env: Record<string, string | undefined>): CloudConfigError {
  try {
    loadCloudConfig(env, { artifactRoot: "/workspace" });
  } catch (err) {
    if (err instanceof CloudConfigError) return err;
    throw err;
  }
  throw new Error("期望抛出 CloudConfigError，但配置通过了校验");
}

describe("云端配置强校验（T013/T014/T015）", () => {
  it("缺少平台端口 → PORT_REQUIRED，且不自动挑端口", () => {
    const env = baseEnv();
    delete env.PORT;
    expect(configError(env).code).toBe("PORT_REQUIRED");
  });

  it("端口非法或越界 → PORT_INVALID", () => {
    expect(configError(baseEnv({ PORT: "abc" })).code).toBe("PORT_INVALID");
    expect(configError(baseEnv({ PORT: "0" })).code).toBe("PORT_INVALID");
    expect(configError(baseEnv({ PORT: "70000" })).code).toBe("PORT_INVALID");
  });

  it("KIWI_CLOUD_PORT 优先于 PORT", () => {
    const config = loadCloudConfig(baseEnv({ PORT: "8080", KIWI_CLOUD_PORT: "9090" }), {
      artifactRoot: "/workspace",
    });
    expect(config.port).toBe(9090);
  });

  it("缺少公网 origin / 非 https / 带路径 → 分别拒绝", () => {
    const noOrigin = baseEnv();
    delete noOrigin.KIWI_CLOUD_PUBLIC_ORIGIN;
    expect(configError(noOrigin).code).toBe("PUBLIC_ORIGIN_REQUIRED");
    expect(configError(baseEnv({ KIWI_CLOUD_PUBLIC_ORIGIN: "http://merchant.example.com" })).code).toBe(
      "PUBLIC_ORIGIN_INSECURE",
    );
    expect(
      configError(baseEnv({ KIWI_CLOUD_PUBLIC_ORIGIN: "https://merchant.example.com/app" })).code,
    ).toBe("PUBLIC_ORIGIN_HAS_PATH");
  });

  it("缺少状态目录 / 相对路径 / 临时目录 → 分别拒绝（T014）", () => {
    const noDir = baseEnv();
    delete noDir.KIWI_CLOUD_DATA_DIR;
    expect(configError(noDir).code).toBe("DATA_DIR_REQUIRED");
    expect(configError(baseEnv({ KIWI_CLOUD_DATA_DIR: "./data" })).code).toBe(
      "DATA_DIR_NOT_ABSOLUTE",
    );
    expect(configError(baseEnv({ KIWI_CLOUD_DATA_DIR: path.join(tmpdir(), "kiwi-data") })).code).toBe(
      "DATA_DIR_EPHEMERAL",
    );
  });

  it("状态目录等于制品根或落在随包目录内 → 拒绝（制品不含状态文件）", () => {
    expect(configError(baseEnv({ KIWI_CLOUD_DATA_DIR: "/workspace" })).code).toBe(
      "DATA_DIR_IS_ARTIFACT_ROOT",
    );
    expect(configError(baseEnv({ KIWI_CLOUD_DATA_DIR: "/workspace/dist/data" })).code).toBe(
      "DATA_DIR_INSIDE_SHIPPED_DIR",
    );
  });

  it("状态目录在制品根下但不在随包目录内 → 允许（deploy 只覆盖同名文件）", () => {
    const config = loadCloudConfig(baseEnv(), { artifactRoot: "/workspace" });
    expect(config.dataDir).toBe("/workspace/.kiwi-runtime");
  });

  it("弱认证（none/loopback/缺省）→ 拒绝启动（T015）", () => {
    expect(configError(baseEnv({ KIWI_CLOUD_A2A_AUTH: "none" })).code).toBe("A2A_AUTH_WEAK");
    expect(configError(baseEnv({ KIWI_CLOUD_A2A_AUTH: "loopback" })).code).toBe("A2A_AUTH_WEAK");
    const missing = baseEnv();
    delete missing.KIWI_CLOUD_A2A_AUTH;
    expect(configError(missing).code).toBe("A2A_AUTH_REQUIRED");
  });

  it("bearer 模式要求令牌环境变量存在，signature 模式直接接受", () => {
    expect(configError(baseEnv({ KIWI_CLOUD_A2A_AUTH: "bearer:KIWI_TEST_BUYER_TOKEN" })).code).toBe(
      "A2A_AUTH_TOKEN_MISSING",
    );
    const withToken = loadCloudConfig(
      baseEnv({
        KIWI_CLOUD_A2A_AUTH: "bearer:KIWI_TEST_BUYER_TOKEN",
        KIWI_TEST_BUYER_TOKEN: "t-123",
      }),
      { artifactRoot: "/workspace" },
    );
    expect(withToken.a2aAuth).toEqual({ mode: "bearer", tokenEnv: "KIWI_TEST_BUYER_TOKEN" });
    const sig = loadCloudConfig(baseEnv(), { artifactRoot: "/workspace" });
    expect(sig.a2aAuth).toEqual({ mode: "signature" });
  });

  it("启动日志摘要不含令牌（只回显承载变量名）", () => {
    const config = loadCloudConfig(
      baseEnv({
        KIWI_CLOUD_A2A_AUTH: "bearer:KIWI_TEST_BUYER_TOKEN",
        KIWI_TEST_BUYER_TOKEN: "super-secret",
      }),
      { artifactRoot: "/workspace" },
    );
    const summary = JSON.stringify(describeCloudConfig(config));
    expect(summary).not.toContain("super-secret");
    expect(summary).toContain("KIWI_TEST_BUYER_TOKEN");
  });

  it("生产禁演示价回退：打开即拒绝", () => {
    expect(() => assertNoDemoPriceFallback({ commerce: { allow_demo_price_fallback: true } })).toThrow(
      /演示价/,
    );
    expect(() => assertNoDemoPriceFallback({ commerce: {} })).not.toThrow();
    expect(() => assertNoDemoPriceFallback({})).not.toThrow();
  });
});

describe("单端口路由分发（T016）", () => {
  interface Hit {
    path: string;
    url: string | undefined;
  }

  async function startRouter(options: {
    ready?: boolean;
    challenge?: boolean;
  }): Promise<{ base: string; a2aHits: Hit[]; merchantHits: Hit[]; challengeHits: number[] }> {
    const a2aHits: Hit[] = [];
    const merchantHits: Hit[] = [];
    const challengeHits: number[] = [];
    const router = createCloudRouter({
      a2aHandler: (req, res) => {
        a2aHits.push({ path: new URL(req.url ?? "/", "http://x").pathname, url: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ surface: "a2a" }));
      },
      merchantHandler: (req, res) => {
        merchantHits.push({ path: new URL(req.url ?? "/", "http://x").pathname, url: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ surface: "merchant" }));
      },
      readiness: async () => ({
        ready: options.ready !== false,
        checked_at: "2026-09-20T00:00:00.000Z",
        checks: {
          identity: { ok: options.ready !== false },
          storage: { ok: true },
          products: { ok: true },
          policy: { ok: true },
        },
      }),
      ...(options.challenge === true
        ? {
            challengeHandler: (_req: unknown, res: import("node:http").ServerResponse) => {
              challengeHits.push(1);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ challenge: "issued" }));
            },
          }
        : {}),
      version: "0.0.0-test",
    });
    const server = createServer(router);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { base: `http://127.0.0.1:${port}`, a2aHits, merchantHits, challengeHits };
  }

  it("平台数据面路径不被业务接管", async () => {
    const { base, a2aHits, merchantHits } = await startRouter({});
    const res = await fetch(`${base}/.cloud/database/rest/items`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "reserved_path" });
    expect(a2aHits).toHaveLength(0);
    expect(merchantHits).toHaveLength(0);
  });

  it("A2A 面：/a2a 与公开 Card/发现走 A2A handler", async () => {
    const { base, a2aHits, merchantHits } = await startRouter({});
    for (const p of ["/a2a", "/.well-known/agent-card.json", "/.well-known/ucp"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ surface: "a2a" });
    }
    expect(a2aHits).toHaveLength(3);
    expect(merchantHits).toHaveLength(0);
  });

  it("商家面：/mcp、/oauth/*、/pairing/*、/admin/* 走商家 handler，A2A 不介入", async () => {
    const { base, a2aHits, merchantHits } = await startRouter({});
    for (const p of [
      "/mcp",
      "/oauth/token",
      "/.well-known/oauth-authorization-server",
      "/pairing/redeem",
      "/admin/pending",
    ]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ surface: "merchant" });
    }
    expect(merchantHits).toHaveLength(5);
    expect(a2aHits).toHaveLength(0);
  });

  it("/merchant/* 别名映射到现有 /admin/*（设计 §8.2 路由名）", async () => {
    const { base, merchantHits } = await startRouter({});
    const res = await fetch(`${base}/merchant/pending?x=1`);
    expect(res.status).toBe(200);
    expect(merchantHits).toHaveLength(1);
    expect(merchantHits[0]?.url).toBe("/admin/pending?x=1");
  });

  it("探针：/healthz 与 /livez 最小应答，/readyz 反映就绪", async () => {
    const { base } = await startRouter({ ready: true });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true, node: process.version });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as { ready: boolean; checks: Record<string, { ok: boolean }> };
    expect(body.ready).toBe(true);
    // 就绪响应不得回显敏感标识：只有布尔与原因码
    expect(Object.keys(body.checks)).toEqual(["identity", "storage", "products", "policy"]);
  });

  it("未就绪 → 503（T014：缺持久存储不进生产 ready）", async () => {
    const { base } = await startRouter({ ready: false });
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect((await res.json()) as { ready: boolean }).toMatchObject({ ready: false });
  });

  it("/control/challenge 在 M1 明确 501；提供 handler 时由其接管", async () => {
    const plain = await startRouter({});
    const res = await fetch(`${plain.base}/control/challenge`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: "not_implemented" });

    const withHandler = await startRouter({ challenge: true });
    const ok = await fetch(`${withHandler.base}/control/challenge`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(withHandler.challengeHits).toHaveLength(1);
  });

  it("未知路径最小 404，且不落到任何 handler", async () => {
    const { base, a2aHits, merchantHits } = await startRouter({});
    const res = await fetch(`${base}/whatever`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(a2aHits).toHaveLength(0);
    expect(merchantHits).toHaveLength(0);
  });
});

describe("就绪检查聚合", () => {
  const ok = { ok: true };

  it("全部通过 → ready", async () => {
    const report = await runReadiness({
      identity: () => ok,
      storage: () => ok,
      products: () => ok,
      policy: () => ok,
    });
    expect(report.ready).toBe(true);
    expect(report.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("任一项失败 → not ready，且逐项给出稳定原因码", async () => {
    const report = await runReadiness({
      identity: () => ({ ok: false, code: "IDENTITY_UNREADABLE" }),
      storage: () => ok,
      products: () => ok,
      policy: () => ok,
    });
    expect(report.ready).toBe(false);
    expect(report.checks.identity).toEqual({ ok: false, code: "IDENTITY_UNREADABLE" });
  });

  it("检查挂起 → 超时码（探针不得挂起）", async () => {
    const report = await runReadiness({
      identity: () => new Promise(() => {}),
      storage: () => ok,
      products: () => ok,
      policy: () => ok,
      timeoutMs: 20,
    });
    expect(report.checks.identity).toEqual({ ok: false, code: "IDENTITY_TIMEOUT" });
    expect(report.ready).toBe(false);
  });

  it("检查抛错 → 只回稳定码，不回显异常消息", async () => {
    const report = await runReadiness({
      identity: () => {
        throw new Error("internal detail: /workspace/state.sqlite locked by pid 42");
      },
      storage: () => ok,
      products: () => ok,
      policy: () => ok,
    });
    expect(report.checks.identity).toEqual({ ok: false, code: "IDENTITY_ERROR" });
    expect(JSON.stringify(report)).not.toContain("state.sqlite");
  });
});
