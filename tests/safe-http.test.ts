/**
 * src/net/safe-http.ts 出站 HTTP 安全原语测试：
 *  - readJsonBody：JSON 解析 / Content-Length 预检 / 流式超限中断 /
 *    signal abort 中断挂起读取 / 非 JSON 拒绝；
 *  - isRedirectResponse：3xx / opaqueredirect / 正常状态判定。
 */
import { describe, expect, it } from "vitest";
import { isRedirectResponse, readJsonBody } from "../src/net/safe-http.js";

describe("safe-http readJsonBody", () => {
  it("parses a small JSON body", async () => {
    const res = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonBody(res)).resolves.toEqual({ ok: true });
  });

  it("rejects an oversized content-length before reading the body", async () => {
    const res = new Response("{}", { headers: { "content-length": "99999999" } });
    await expect(readJsonBody(res)).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("aborts streaming when the body exceeds the byte limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const res = new Response(body);
    await expect(readJsonBody(res, { maxBytes: 1024 })).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("interrupts a hanging stream read when the signal aborts", async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        // 永不 push 也不 close：读挂起，模拟对端停滞 body。
      },
    });
    const res = new Response(body);
    const controller = new AbortController();
    const settled = readJsonBody(res, { signal: controller.signal }).then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.name : String(err)),
    );
    setTimeout(() => controller.abort(), 20);
    const result = await settled;
    expect(result).not.toBe("resolved");
  });

  it("rejects a non-JSON body", async () => {
    const res = new Response("<html>not json</html>");
    await expect(readJsonBody(res)).rejects.toMatchObject({ code: "invalid_json" });
  });
});

describe("safe-http isRedirectResponse", () => {
  it("detects 3xx responses", () => {
    expect(isRedirectResponse(new Response(null, { status: 302 }))).toBe(true);
    expect(isRedirectResponse(new Response(null, { status: 301 }))).toBe(true);
    expect(isRedirectResponse(new Response(null, { status: 200 }))).toBe(false);
    expect(isRedirectResponse(new Response(null, { status: 404 }))).toBe(false);
    expect(isRedirectResponse(new Response(null, { status: 500 }))).toBe(false);
  });
});
