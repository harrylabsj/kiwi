/**
 * stdio 适配器 CLI 的 fail-closed/状态面（不启动 WorkBuddy，不访问网络）：
 *   - 未绑定 serve 退出 2，不回退共享网关；
 *   - status 只输出绑定状态，不含 token/sharecode；
 *   - logout 无绑定时安全返回。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkbuddyAdapterCli, startSetupServer, parseListNegotiationArgs } from "../src/workbuddy-adapter/cli.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbuddy-cli-"));
  dirs.push(dir);
  return dir;
}

describe("workbuddy adapter cli", () => {
  it("未绑定 serve 失败退出，不回退任意地址", async () => {
    const dir = tempDir();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runWorkbuddyAdapterCli(["serve", "--data-dir", dir]);
    expect(code).toBe(2);
    expect(String(stderr.mock.calls.flat().join(""))).toContain("未绑定实例");
  });

  it("status 只输出脱敏绑定状态；logout 无绑定安全返回", async () => {
    const dir = tempDir();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runWorkbuddyAdapterCli(["status", "--data-dir", dir]);
    expect(code).toBe(1);
    const text = String(stdout.mock.calls.flat().join(""));
    expect(JSON.parse(text.trim())).toEqual({ bound: false });
    expect(text.toLowerCase()).not.toContain("token");
    expect(text.toLowerCase()).not.toContain("share");

    stdout.mockClear();
    const loggedOut = await runWorkbuddyAdapterCli(["logout", "--data-dir", dir]);
    expect(loggedOut).toBe(0);
  });

  it("列表参数严格校验 cursor/status/limit，拒绝额外字段", () => {
    expect(parseListNegotiationArgs({})).toEqual({});
    expect(
      parseListNegotiationArgs({ cursor: "20", status: "agreement", limit: 50 }),
    ).toEqual({ cursor: "20", status: "agreement", limit: 50 });
    for (const invalid of [
      { cursor: "-1" },
      { cursor: "1.5" },
      { status: "closed" },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { extra: true },
    ]) {
      expect(parseListNegotiationArgs(invalid), JSON.stringify(invalid)).toBeUndefined();
    }
  });

  it("setup 本机页面：展示绑定表单；错误 Host/Origin/CSRF 被拒且不发远端请求", async () => {
    const dir = tempDir();
    const handle = await startSetupServer(dir);
    try {
      const page = await fetch(`${handle.origin}/`);
      expect(page.status).toBe(200);
      const text = await page.text();
      expect(text).toContain("绑定唯一商家实例");
      expect(text).toContain("type=\"password\"");
      const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? "";
      expect(csrf).not.toBe("");

      const wrongOrigin = await fetch(`${handle.origin}/bind`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, instance: "https://shop.example/mcp", share: "x" }),
      });
      expect(wrongOrigin.status).toBe(403);

      const wrongHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: Number(new URL(handle.origin).port),
            path: "/",
            method: "GET",
            headers: { host: "evil.example" },
          },
          (response) => resolve(response.statusCode ?? 0),
        );
        request.on("error", reject);
        request.end();
      });
      expect(wrongHost).toBe(421);
    } finally {
      await handle.close();
    }
  });
});
