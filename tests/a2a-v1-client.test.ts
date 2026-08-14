/**
 * A2A client 双栈测试（issue 06）：
 * - 1.0 路径发 A2A-Version + A2A-Extensions + 1.0 方法名 + 1.0 Part 编码；
 * - 0.3 路径走 legacy 帧（回归）；
 * - 1.0 模式缺 knpExtensionUri → fail-closed；
 * - 响应解析接受 1.0 大写 TaskState。
 */
import { describe, expect, it } from "vitest";
import { A2AClient } from "../src/a2a/client/index.js";
import { KNP_EXTENSION_PATH } from "../src/a2a/v1/headers.js";

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const KNP_URI = `https://merchant.example${KNP_EXTENSION_PATH}`;

interface CapturedWire {
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function mockClient(options: { version?: "1.0" | "0.3"; state?: string }) {
  let wire: CapturedWire | undefined;
  const fetchImpl = (async (_url: unknown, init?: FetchInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    wire = {
      method: String((body.method as unknown) ?? ""),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id, // 回显请求 id（parseJsonRpcResponse 校验 id 一致）
        result: { task: { id: "t1", status: { state: options.state ?? "completed" } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const client = new A2AClient({
    url: "http://127.0.0.1:9999",
    fetchImpl,
    skipDnsCheck: true,
    allowPrivateRanges: true,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.version === "1.0" ? { knpExtensionUri: KNP_URI } : {}),
  });
  return { client, getWire: () => wire };
}

describe("A2A client 双栈（issue 06）", () => {
  it("1.0 路径：A2A-Version + A2A-Extensions + SendMessage + 1.0 Part 编码", async () => {
    const { client, getWire } = mockClient({ version: "1.0", state: "COMPLETED" });
    const task = await client.sendMessage(
      { role: "agent", parts: [{ kind: "text", text: "hi" }, { kind: "data", data: { knp_envelope: {} } }], messageId: "m1" },
    );
    expect(task.status.state).toBe("completed"); // 1.0 大写状态归一化到 0.3
    const wire = getWire();
    expect(wire?.method).toBe("SendMessage");
    expect(wire?.headers["A2A-Version"]).toBe("1.0");
    expect(wire?.headers["A2A-Extensions"]).toBe(KNP_URI);
    // Part 已编码为 1.0 统一 Part（无 kind 字段，有 data/text 字段）
    const params = wire?.body.params as { message?: { parts?: unknown[] } };
    const parts = params?.message?.parts ?? [];
    expect(parts[0]).toEqual({ text: "hi" });
    expect(parts[1]).toEqual({ data: { knp_envelope: {} }, mediaType: "application/json" });
  });

  it("1.0 getTask 方法名 GetTask", async () => {
    const { client, getWire } = mockClient({ version: "1.0" });
    await client.getTask("t1");
    expect(getWire()?.method).toBe("GetTask");
  });

  it("1.0 response parser accepts unified Parts and ROLE_AGENT", async () => {
    const fetchImpl = (async (_url: unknown, init?: FetchInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            task: {
              id: "t-v1",
              status: {
                state: "TASK_STATE_COMPLETED",
                message: { role: "ROLE_AGENT", parts: [{ text: "done" }], messageId: "m-v1" },
              },
              artifacts: [{ parts: [{ data: { agreement: { agreement_id: "agr-v1" } }, mediaType: "application/json" }] }],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new A2AClient({
      url: "http://127.0.0.1:9999",
      fetchImpl,
      skipDnsCheck: true,
      allowPrivateRanges: true,
      version: "1.0",
      knpExtensionUri: KNP_URI,
    });
    const task = await client.getTask("t-v1");
    expect(task.status.state).toBe("completed");
    expect(task.status.message?.parts[0]).toEqual({ kind: "text", text: "done" });
    expect(task.artifacts?.[0]?.parts[0]).toEqual({ kind: "data", data: { agreement: { agreement_id: "agr-v1" } } });
  });

  it("0.3 路径走 legacy 帧（回归）", async () => {
    const { client, getWire } = mockClient({ version: "0.3" });
    await client.sendMessage({ role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: "m1" });
    const wire = getWire();
    expect(wire?.method).toBe("message/send");
    expect(wire?.headers["A2A-Version"]).toBeUndefined();
    // 0.3 Part 原样（带 kind）
    const params = wire?.body.params as { message?: { parts?: unknown[] } };
    const parts = params?.message?.parts ?? [];
    expect(parts[0]).toEqual({ kind: "text", text: "hi" });
  });

  it("1.0 模式缺 knpExtensionUri → 缺省从端点 origin 派生", async () => {
    let wire: CapturedWire | undefined;
    const fetchImpl = (async (_url: unknown, init: FetchInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      wire = {
        method: String(body.method ?? ""),
        body,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task: { id: "t1", status: { state: "COMPLETED" } } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new A2AClient({
      url: "http://127.0.0.1:9999",
      fetchImpl,
      skipDnsCheck: true,
      allowPrivateRanges: true,
      version: "1.0",
    });
    await client.sendMessage({ role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: "m1" });
    // 缺省派生：A2A-Extensions = http://127.0.0.1:9999 + KNP_EXTENSION_PATH
    expect(wire?.headers["A2A-Extensions"]).toBe(`http://127.0.0.1:9999${KNP_EXTENSION_PATH}`);
  });
});
