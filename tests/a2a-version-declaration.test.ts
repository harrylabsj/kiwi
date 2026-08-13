/**
 * 声明门禁（战略 §10.4 / §11 Gate 0 Truthful Protocol，issue 01）：
 * Agent Card 声明的 protocolVersion 必须与实际 wire 行为一致。
 *
 * - 声明 1.0 → 默认 client 请求必须用 1.0 方法名（SendMessage/GetTask/…）
 *   且携带 `A2A-Version: 1.0` 头；
 * - 声明 0.3 → 用 legacy 方法名（message/send/tasks/get），无版本头。
 *
 * 当前实现：Card 声明 1.0，但默认 client 发 `message/send`、无 A2A-Version——
 * 本测试**必红**，把漂移变成可判定的红。v1 双栈（issue 06/07）落地后转绿。
 */

import { describe, expect, it } from "vitest";
import { A2AClient } from "../src/a2a/client/index.js";
import { buildAgentCard } from "../src/a2a/server/card.js";
import type { AgentCardConfig } from "../src/a2a/server/types.js";
import { LEGACY_METHODS, V1_METHODS } from "../src/a2a/v1/methods.js";

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const CARD_CONFIG: AgentCardConfig = {
  name: "Kiwi Test Merchant",
  description: "test",
  providerOrganization: "Kiwi Test",
  version: "1.0.0",
  baseUrl: "https://merchant.example",
  a2aPath: "/",
};

interface WireCapture {
  method: string;
  headers: Record<string, string>;
}

/** 用 mock fetch 捕获默认 A2AClient 实际发出的请求（方法名 + 头）。 */
async function captureDefaultClientWire(): Promise<WireCapture> {
  let wire: WireCapture | undefined;
  const fetchImpl = (async (_url: unknown, init?: FetchInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: unknown };
    wire = {
      method: String(body.method ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const client = new A2AClient({
    url: "http://127.0.0.1:9999",
    fetchImpl,
    skipDnsCheck: true,
    allowPrivateRanges: true,
  });
  try {
    await client.sendMessage({ role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: "m1" });
  } catch {
    // 响应体无效：wire 已在 mock 中捕获，足够用于门禁判定。
  }
  if (wire === undefined) throw new Error("wire not captured");
  return wire;
}

describe("声明门禁（Gate 0 Truthful Protocol）", () => {
  it("Card 声明版本与实际 wire 行为一致", async () => {
    const card = buildAgentCard(CARD_CONFIG);
    const declared = card.supportedInterfaces[0]?.protocolVersion ?? "";
    const wire = await captureDefaultClientWire();

    if (declared === "1.0") {
      // 声明 1.0 → 默认 client 必须讲 1.0。
      expect(V1_METHODS.has(wire.method)).toBe(true);
      expect(wire.headers["A2A-Version"]).toBe("1.0");
    } else if (declared === "0.3") {
      expect(LEGACY_METHODS.has(wire.method)).toBe(true);
    } else {
      throw new Error(`不支持的声明版本：${declared}`);
    }
  });
});
