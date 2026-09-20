/**
 * T022（M2 首验）：写入途中崩溃 → 恢复一致状态，无半成功。
 *
 * 历史缺口：管线在调用 handler **之前**不留任何痕迹；而 handler 可能在管线落账/
 * 幂等提交之前就已经对外产生副作用（发出报价、推进相位）。此时崩溃 → 幂等索引
 * 无记录、Ledger 也无 message_received → **重试会再跑一遍 handler**（第二次对外
 * 报价）。恢复路径只覆盖"message_received 已落账"的窗口。
 *
 * 修复：处理开始前落 in-flight 标记，提交成功后清除。重试时若标记仍在 → 业务
 * 结果未知，明确走对账（协议词表 `reconciliation_required`），**不重跑 handler**。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { A2AServer, NoneAuthVerifier } from "../src/a2a/server/index.js";
import type { NegotiationHandler } from "../src/a2a/server/types.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function countingHandler(): { handler: NegotiationHandler; calls: () => number } {
  let calls = 0;
  return {
    handler: {
      name: "counting-echo",
      async handle() {
        calls += 1;
        return { kind: "accepted", taskState: "completed" };
      },
    },
    calls: () => calls,
  };
}

interface Stack {
  base: string;
  idempotency: IdempotencyStore;
  calls: () => number;
}

async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-crash-"));
  const { handler, calls } = countingHandler();
  const idempotency = new IdempotencyStore({ dir: path.join(dir, "idem"), now: () => new Date().toISOString() });
  const server = new A2AServer({
    card: () => ({
      name: "Crash window merchant",
      description: "t022",
      providerOrganization: "Kiwi Test",
      version: "1.0.0",
      baseUrl: "http://127.0.0.1",
      a2aPath: "/a2a",
    }),
    ledger: new LedgerStore({ dir: path.join(dir, "ledger"), now: () => new Date().toISOString() }),
    idempotency,
    handler,
    // 固定身份（NoneAuthVerifier → 常量 "anonymous"），让 in-flight 标记的
    // (sender, message_id) 与测试里写入的一致。
    authVerifier: new NoneAuthVerifier(),
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  cleanups.push(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, idempotency, calls };
}

async function send(stack: Stack, messageId: string) {
  const env = finalizeEnvelope({ ...validEnvelopeFields(), message_id: messageId });
  const res = await fetch(`${stack.base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `req-${messageId}`,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "data", data: { knp_envelope: env } }], messageId } },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const SENDER = "anonymous"; // 默认 NoneAuthVerifier 的身份
const MSG = "msg_crash_001";

describe("T022：写入途中崩溃的恢复语义", () => {
  it("正常路径：提交后 in-flight 标记被清除，重放命中幂等记录而不是对账", async () => {
    const stack = await startStack();
    const first = await send(stack, MSG);
    expect(first.status).toBe(200);
    expect(stack.calls()).toBe(1);
    expect(stack.idempotency.readInFlight(SENDER, MSG)).toBeNull();

    const replay = await send(stack, MSG);
    expect(replay.status).toBe(200);
    expect(stack.calls()).toBe(1); // 幂等重放：handler 不重复执行
  });

  it("崩溃窗口：标记仍在（handler 可能已产生副作用）→ reconciliation_required，且 handler 不重跑", async () => {
    const stack = await startStack();
    // 模拟"上一次处理在提交前进程就没了"：留下标记、清理掉其它痕迹。
    const env = finalizeEnvelope({ ...validEnvelopeFields(), message_id: MSG });
    stack.idempotency.markInFlight({
      sender_identity: SENDER,
      message_id: MSG,
      digest: env.digest,
    });

    const res = await send(stack, MSG);
    expect(res.status).toBe(200);
    const error = res.body["error"] as
      | { message?: string; data?: { protocol_code?: string; detail?: string } }
      | undefined;
    // 协议词表内的对账码（不是"再跑一次"）。
    expect(error?.data?.protocol_code ?? error?.message ?? "").toMatch(/reconcil/i);
    expect(stack.calls()).toBe(0); // **绝不重跑 handler**
  });

  it("陈旧标记（超过窗口）不再阻断，按新消息处理", async () => {
    const stack = await startStack();
    const env = finalizeEnvelope({ ...validEnvelopeFields(), message_id: MSG });
    stack.idempotency.markInFlight({ sender_identity: SENDER, message_id: MSG, digest: env.digest });
    // 陈旧窗口设为 0 → 标记立即视为陈旧（模拟很久以前的残留）。
    expect(stack.idempotency.readInFlight(SENDER, MSG, { staleAfterMs: 0 })).toBeNull();
    expect(stack.idempotency.readInFlight(SENDER, MSG)).not.toBeNull();
  });

  it("同 key 不同 digest 的 in-flight 标记 → 冲突拒绝（不静默换内容重跑）", async () => {
    const stack = await startStack();
    stack.idempotency.markInFlight({ sender_identity: SENDER, message_id: MSG, digest: "sha256:" + "a".repeat(64) });
    expect(() =>
      stack.idempotency.markInFlight({ sender_identity: SENDER, message_id: MSG, digest: "sha256:" + "b".repeat(64) }),
    ).toThrowError(/idempotency_conflict/);
  });
});
