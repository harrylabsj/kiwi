/**
 * 接待五层探针（P0a 前三层）：
 *  - 配置/凭据缺失不发起网络请求；
 *  - provider 非 200 / 异常 → connected failed；
 *  - 200 但正文为空（reasoning token 吃满预算）→ non_empty_output failed；
 *  - 成功时不泄露密钥或正文。
 */
import { describe, expect, it } from "vitest";

import { probeReceptionModel } from "../src/a2a/reception/probe.js";

const NOW = "2026-11-03T04:00:00.000Z";

const options = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  model: "deepseek-v4-flash",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  lookupEnv: (name: string) => (name === "DEEPSEEK_API_KEY" ? "sk-test" : undefined),
  now: () => NOW,
  ...overrides,
});

describe("reception probe", () => {
  it("未启用时不发起请求", async () => {
    let called = false;
    const result = await probeReceptionModel(
      options({
        enabled: false,
        fetchImpl: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      }) as never,
    );
    expect(called).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(result.layers.configured).toBe("failed");
  });

  it("缺少凭据时不发起请求", async () => {
    let called = false;
    const result = await probeReceptionModel(
      options({
        lookupEnv: () => undefined,
        fetchImpl: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        },
      }) as never,
    );
    expect(called).toBe(false);
    expect(result.reason).toBe("missing_credential");
  });

  it("provider 非 200 → connected failed", async () => {
    const result = await probeReceptionModel(
      options({ fetchImpl: async () => new Response("denied", { status: 403 }) }) as never,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.layers.configured).toBe("ok");
    expect(result.layers.connected).toBe("failed");
  });

  it("200 但正文为空 → non_empty_output failed（reasoning 预算坑）", async () => {
    const result = await probeReceptionModel(
      options({
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "" } }] }),
            { status: 200 },
          ),
      }) as never,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty_output");
    expect(result.layers.connected).toBe("ok");
    expect(result.layers.non_empty_output).toBe("failed");
  });

  it("正文非空 → 前三层通过；工具层保持 unknown", async () => {
    let body: Record<string, unknown> | undefined;
    const result = await probeReceptionModel(
      options({
        channelEnabled: true,
        fetchImpl: async (_url: string, init?: { body?: unknown }) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "已就绪。" } }] }),
            { status: 200 },
          );
        },
      }) as never,
    );
    expect(result.ok).toBe(true);
    expect(result.layers).toMatchObject({
      configured: "ok",
      connected: "ok",
      non_empty_output: "ok",
      tools: "unknown",
      channel: "ok",
    });
    expect(body?.max_tokens).toBeGreaterThanOrEqual(1_000);
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(JSON.stringify(result)).not.toContain("已就绪");
  });
});
