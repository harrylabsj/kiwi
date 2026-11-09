/**
 * 本机 setup 全流程（临时实例 + 模拟 OAuth 网关，无外网）：
 *   setup 页面 → 表单绑定 → discovery/register → 303 authorize → loopback callback
 *   → token exchange → 加密落盘 → status 显示已授权。
 * 同时证明分享码走 X-Share-Code 服务端请求，而不是模型/URL。
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkbuddyAdapterCli, startSetupServer } from "../src/workbuddy-adapter/cli.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbuddy-setup-"));
  dirs.push(dir);
  return dir;
}

function postForm(
  target: string,
  headers: Record<string, string>,
  body: URLSearchParams,
): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body.toString()),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body.toString());
  });
}

async function mockInstance(options: { owner?: boolean } = {}): Promise<{
  origin: string;
  seenShare: string[];
}> {
  const seenShare: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seenShare.push(String(request.headers["x-share-code"] ?? ""));
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        scopes_supported: options.owner
          ? ["merchant:read", "merchant:owner"]
          : ["merchant:read"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth/register") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        redirect_uris: string[];
      };
      json({ client_id: "client-setup", redirect_uris: body.redirect_uris });
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      json({
        access_token: "setup-access-token-0123456789",
        refresh_token: "setup-refresh-token-0123456789",
        token_type: "Bearer",
        scope: options.owner ? "merchant:read merchant:owner" : "merchant:read",
        expires_in: 3600,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth/revoke") {
      json({});
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, seenShare };
}

describe("workbuddy adapter setup", () => {
  it("本机受控绑定 → OAuth PKCE → callback → 加密保存 → status", async () => {
    const dir = tempDir();
    const mock = await mockInstance();
    const setup = await startSetupServer(dir);
    try {
      const page = await fetch(`${setup.origin}/`);
      const pageText = await page.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(pageText)?.[1] ?? "";
      expect(csrf).not.toBe("");

      const bind = await postForm(
        `${setup.origin}/bind`,
        { origin: setup.origin },
        new URLSearchParams({
          csrf,
          instance: `${mock.origin}/mcp`,
          share: "setup-share-secret",
        }),
      );
      expect(bind.status).toBe(200);
      expect(bind.body).not.toContain('name="owner_scope"');
      const draft = /name="draft" value="([^"]+)"/.exec(bind.body)?.[1] ?? "";
      expect(draft).not.toBe("");
      const deniedOwner = await postForm(
        `${setup.origin}/authorize`,
        { origin: setup.origin },
        new URLSearchParams({ csrf, draft, owner_scope: "1" }),
      );
      expect(deniedOwner.status).toBe(400);
      const authorize = await postForm(
        `${setup.origin}/authorize`,
        { origin: setup.origin },
        new URLSearchParams({ csrf, draft }),
      );
      expect(authorize.status).toBe(303);
      const authorizeUrl = new URL(authorize.location ?? "");
      expect(authorizeUrl.searchParams.get("scope")).toBe("merchant:read");
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("sharecode")).toBe("setup-share-secret");
      const state = authorizeUrl.searchParams.get("state") ?? "";
      expect(state).not.toBe("");

      const callback = await fetch(
        `${setup.origin}/callback?state=${encodeURIComponent(state)}&code=setup-code`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/done");

      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const status = await runWorkbuddyAdapterCli(["status", "--data-dir", dir]);
      expect(status).toBe(0);
      const statusText = String(stdout.mock.calls.flat().join(""));
      const parsed = JSON.parse(statusText.trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        bound: true,
        authorized: true,
        instance: mock.origin,
        scope: ["merchant:read"],
      });
      expect(statusText).not.toContain("setup-share-secret");
      expect(statusText).not.toContain("setup-access-token");
      expect(mock.seenShare.every((value) => value === "setup-share-secret")).toBe(true);
    } finally {
      await setup.close();
    }
  });

  it("实例声明 merchant:owner 时商家可选；不选仍只读，选了才请求 owner", async () => {
    const dir = tempDir();
    const mock = await mockInstance({ owner: true });
    const setup = await startSetupServer(dir);
    try {
      const page = await fetch(`${setup.origin}/`);
      const pageText = await page.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(pageText)?.[1] ?? "";
      const bind = await postForm(
        `${setup.origin}/bind`,
        { origin: setup.origin },
        new URLSearchParams({
          csrf,
          instance: `${mock.origin}/mcp`,
          share: "setup-share-secret",
        }),
      );
      expect(bind.status).toBe(200);
      expect(bind.body).toContain('name="owner_scope"');
      const draft = /name="draft" value="([^"]+)"/.exec(bind.body)?.[1] ?? "";

      const authorize = await postForm(
        `${setup.origin}/authorize`,
        { origin: setup.origin },
        new URLSearchParams({ csrf, draft, owner_scope: "1" }),
      );
      expect(authorize.status).toBe(303);
      const authorizeUrl = new URL(authorize.location ?? "");
      expect(authorizeUrl.searchParams.get("scope")).toBe("merchant:read merchant:owner");
      const state = authorizeUrl.searchParams.get("state") ?? "";
      const callback = await fetch(
        `${setup.origin}/callback?state=${encodeURIComponent(state)}&code=setup-code`,
        { redirect: "manual" },
      );
      expect(callback.status).toBe(303);

      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const status = await runWorkbuddyAdapterCli(["status", "--data-dir", dir]);
      expect(status).toBe(0);
      const parsed = JSON.parse(String(stdout.mock.calls.flat().join("")).trim()) as {
        scope?: string[];
      };
      expect(parsed.scope).toEqual(["merchant:read", "merchant:owner"]);
    } finally {
      await setup.close();
    }
  });

  it("新绑定会使旧 draft/旧 callback 失效，不能交叉实例覆盖", async () => {
    const dir = tempDir();
    const mock = await mockInstance();
    const setup = await startSetupServer(dir);
    try {
      const page = await fetch(`${setup.origin}/`);
      const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
      const firstBind = await postForm(
        `${setup.origin}/bind`,
        { origin: setup.origin },
        new URLSearchParams({
          csrf,
          instance: `${mock.origin}/mcp`,
          share: "share-a",
        }),
      );
      const firstDraft = /name="draft" value="([^"]+)"/.exec(firstBind.body)?.[1] ?? "";

      const secondBind = await postForm(
        `${setup.origin}/bind`,
        { origin: setup.origin },
        new URLSearchParams({
          csrf,
          instance: `${mock.origin}/mcp`,
          share: "share-b",
        }),
      );
      expect(secondBind.status).toBe(200);
      const oldAuthorize = await postForm(
        `${setup.origin}/authorize`,
        { origin: setup.origin },
        new URLSearchParams({ csrf, draft: firstDraft }),
      );
      expect(oldAuthorize.status).toBe(400);
    } finally {
      await setup.close();
    }
  });
});
