/**
 * 出站钉住（SSRF / DNS 重绑定加固）测试。
 *
 * 两类攻击各一组：
 * - 解析后落到内网/保留段（含"公网域名解析到 loopback"）→ 一律拒绝；
 * - 解析失败 / 空结果 → fail-closed。
 * 另测 HTTP 适配层：按给定地址建连时 Host 头仍是主机名、不跟随重定向、
 * 响应体可读、AbortSignal 生效。
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPinnedFetch,
  PinnedFetchError,
  requestViaAddress,
  resolvePinnedAddress,
} from "../src/merchant-gateway/pinned-fetch.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn !== undefined) await fn();
  }
});

describe("解析钉住与网段校验", () => {
  it("公网解析结果可用（返回用于建连的那个地址）", async () => {
    await expect(
      resolvePinnedAddress("merchant.example", async () => ["93.184.216.34"]),
    ).resolves.toBe("93.184.216.34");
  });

  it("解析到私网/保留段一律拒绝（fail-closed）", async () => {
    for (const [hostname, ip] of [
      ["merchant.example", "10.0.0.7"],
      ["merchant.example", "192.168.1.9"],
      ["merchant.example", "169.254.169.254"],
      ["merchant.example", "172.16.5.5"],
      ["merchant.example", "fe80::1"],
    ] as const) {
      await expect(resolvePinnedAddress(hostname, async () => [ip])).rejects.toThrowError(
        PinnedFetchError,
      );
    }
  });

  it("公网域名解析到 loopback（典型 DNS 重绑定）拒绝", async () => {
    await expect(
      resolvePinnedAddress("merchant.example", async () => ["127.0.0.1"]),
    ).rejects.toThrow(/loopback/);
  });

  it("多地址中混入私网也拒绝（不做“挑一个能用的”）", async () => {
    await expect(
      resolvePinnedAddress("merchant.example", async () => ["93.184.216.34", "10.0.0.7"]),
    ).rejects.toThrowError(PinnedFetchError);
  });

  it("解析失败或空结果拒绝", async () => {
    await expect(
      resolvePinnedAddress("merchant.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrowError(/无法解析/);
    await expect(resolvePinnedAddress("merchant.example", async () => [])).rejects.toThrowError(
      /未解析出任何地址/,
    );
  });
});

describe("钉住式 fetch", () => {
  it("loopback 与字面 IP 不做解析（直接走原生 fetch）", async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const fetchImpl = createPinnedFetch({
      resolveIp: async () => {
        throw new Error("不应被调用：loopback 无需解析");
      },
    });
    const response = await fetchImpl(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("域名解析后按钉住地址建连（Host 头仍是主机名）", async () => {
    const seen: Array<{ host?: string; path?: string; body: string }> = [];
    const server: Server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        seen.push({
          host: req.headers.host,
          path: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    // 直接测适配层：把 URL 指向任意主机名，但实际连到本地服务。
    const response = await requestViaAddress(
      new URL(`http://merchant.example:${port}/pairing/redeem`),
      "127.0.0.1",
      { method: "POST", headers: { "content-type": "application/json" }, body: '{"code":"x"}' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen[0]?.host).toBe(`merchant.example:${port}`);
    expect(seen[0]?.path).toBe("/pairing/redeem");
    expect(seen[0]?.body).toBe('{"code":"x"}');
  });

  it("不跟随重定向（3xx 原样返回，供上层 fail-closed）", async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(302, { location: "https://evil.example/mcp" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await requestViaAddress(new URL(`http://127.0.0.1:${port}/mcp`), "127.0.0.1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://evil.example/mcp");
  });

  it("AbortSignal 生效（超时/取消可中断）", async () => {
    const server: Server = createServer(() => {
      // 故意不响应
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const controller = new AbortController();
    const pending = requestViaAddress(new URL(`http://127.0.0.1:${port}/mcp`), "127.0.0.1", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrowError();
  });
});
