/**
 * KTH 目的地 URL 安全测试（rev0.3 §11.2；完成定义 #15）。
 *
 * 覆盖：
 * - unsafe scheme（file:/javascript:/data:）拒绝；
 * - http 非 loopback 拒绝（HTTPS 默认）；
 * - userinfo 拒绝；
 * - host 必须命中 expectedHost / allowlist（anti-phishing）；
 * - 重定向链每跳重验：跳转到 unsafe scheme / 异 host → 拒绝；
 * - 返回最终 URL（供用户展示，#17）；超过 maxRedirects → fail-closed。
 */
import { describe, expect, it } from "vitest";
import { validateExternalDestinationUrl } from "../src/handoff/index.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function redirectFetch(locations: Record<string, string>): typeof fetch {
  return (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    const target = locations[href];
    if (target !== undefined) {
      return new Response(null, { status: 302, headers: { location: target } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
}

describe("validateExternalDestinationUrl", () => {
  it("https + expectedHost 命中 → 通过并返回最终 URL", async () => {
    const result = await validateExternalDestinationUrl("https://acme.example/checkout/abc", {
      expectedHost: "acme.example",
      fetchImpl: redirectFetch({}),
      skipDnsCheck: true,
    });
    expect(result.finalUrl).toBe("https://acme.example/checkout/abc");
  });

  it("unsafe scheme 拒绝（file:/javascript:/data:）", async () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
      await expect(
        validateExternalDestinationUrl(bad, { expectedHost: "acme.example" }),
      ).rejects.toThrow(/must use http or https/);
    }
  });

  it("http 非 loopback 拒绝（HTTPS 默认）", async () => {
    await expect(
      validateExternalDestinationUrl("http://acme.example/checkout", { expectedHost: "acme.example" }),
    ).rejects.toThrow(/HTTPS|http/i);
  });

  it("userinfo 拒绝（防钓鱼伪装 authority）", async () => {
    await expect(
      validateExternalDestinationUrl("https://evil.example@acme.example/checkout", {
        expectedHost: "acme.example",
      }),
    ).rejects.toThrow(/userinfo|credentials/);
  });

  it("host 不在 expectedHost → 拒绝（anti-phishing）", async () => {
    await expect(
      validateExternalDestinationUrl("https://evil.example/checkout", { expectedHost: "acme.example" }),
    ).rejects.toThrow(/not allowed/);
  });

  it("allowlist 命中可通过", async () => {
    const result = await validateExternalDestinationUrl("https://pay.example/checkout", {
      allowlist: ["pay.example"],
      fetchImpl: redirectFetch({}),
      skipDnsCheck: true,
    });
    expect(result.finalUrl).toBe("https://pay.example/checkout");
  });

  it("重定向链每跳重验：跳转到异 host → 拒绝", async () => {
    await expect(
      validateExternalDestinationUrl("https://acme.example/checkout", {
        expectedHost: "acme.example",
        fetchImpl: redirectFetch({
          "https://acme.example/checkout": "https://evil.example/steal",
        }),
      skipDnsCheck: true,
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it("重定向链每跳重验：跳转到 unsafe scheme → 拒绝", async () => {
    await expect(
      validateExternalDestinationUrl("https://acme.example/checkout", {
        expectedHost: "acme.example",
        fetchImpl: redirectFetch({
          "https://acme.example/checkout": "javascript:alert(1)",
        }),
        skipDnsCheck: true,
      }),
    ).rejects.toThrow(/must use http or https/);
  });

  it("合法重定向链返回最终 URL（供用户展示）", async () => {
    const result = await validateExternalDestinationUrl("https://acme.example/go", {
      expectedHost: "acme.example",
      fetchImpl: redirectFetch({
        "https://acme.example/go": "https://acme.example/checkout/final",
      }),
      skipDnsCheck: true,
    });
    expect(result.finalUrl).toBe("https://acme.example/checkout/final");
    expect(result.redirects).toEqual(["https://acme.example/go"]);
  });

  it("超过 maxRedirects → fail-closed", async () => {
    const loop: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      loop[`https://acme.example/hop${i}`] = `https://acme.example/hop${i + 1}`;
    }
    await expect(
      validateExternalDestinationUrl("https://acme.example/hop0", {
        expectedHost: "acme.example",
        maxRedirects: 3,
        fetchImpl: redirectFetch(loop),
        skipDnsCheck: true,
      }),
    ).rejects.toThrow(/redirects/);
  });

  it("DNS 复查：expectedHost 命中但解析到保留网段 → 拒绝（不发出探测）", async () => {
    let probed = false;
    const fetchImpl = (async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
      probed = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await expect(
      validateExternalDestinationUrl("https://acme.example/checkout", {
        expectedHost: "acme.example",
        fetchImpl,
        resolveIp: async () => ["169.254.169.254"], // 云元数据端点
      }),
    ).rejects.toThrow(/reserved network/);
    expect(probed).toBe(false); // 防护在探测之前
  });

  it("死链拒绝：非 2xx 且无重定向 → 不当作已验证目的地", async () => {
    const fetchImpl = (async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    await expect(
      validateExternalDestinationUrl("https://acme.example/checkout", {
        expectedHost: "acme.example",
        fetchImpl,
        skipDnsCheck: true,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("3xx 无 Location → fail-closed（重定向响应必须有目标）", async () => {
    const fetchImpl = (async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
      return new Response(null, { status: 302 });
    }) as typeof fetch;
    await expect(
      validateExternalDestinationUrl("https://acme.example/checkout", {
        expectedHost: "acme.example",
        fetchImpl,
        skipDnsCheck: true,
      }),
    ).rejects.toThrow(/HTTP 302/);
  });

  it("非 3xx 带 Location → fail-closed（重定向头只在 3xx 有效）", async () => {
    const fetchImpl = (async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
      return new Response(null, {
        status: 200,
        headers: { location: "https://evil.example/steal" },
      });
    }) as typeof fetch;
    await expect(
      validateExternalDestinationUrl("https://acme.example/checkout", {
        expectedHost: "acme.example",
        fetchImpl,
        skipDnsCheck: true,
      }),
    ).rejects.toThrow(/non-3xx/);
  });
});
