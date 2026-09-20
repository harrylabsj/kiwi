/**
 * T044（M2 首验）：任务归属严格——匿名/受限主体不共享任务视图。
 *
 * 历史行为：`TaskRegistry` 的任务没有归属字段，`tasks/get`、`ListTasks`、
 * `CancelTask` 都不接收调用者；且 `NoneAuthVerifier` 让所有匿名调用者共用常量
 * 身份 `"anonymous"`——任意主体可读到别人的任务（跨主体串读）。
 *
 * 修复后：
 *   - 任务落库时记录**认证身份**（内存注册表 + Ledger 事件双重留存，恢复时过滤）；
 *   - `tasks/get`/`ListTasks`/`CancelTask` 只服务本人任务，非本人一律
 *     `TASK_NOT_FOUND`（不区分"不存在"与"非本人"，不泄露存在性）；
 *   - 匿名主体按设计 §13.3 不开放私有任务 → `authentication_required`。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { A2AServer } from "../src/a2a/server/index.js";
import { echoHandler } from "../src/a2a/server/handler.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import {
  generateA2aSigningIdentity,
  resolveA2aSignatureResolver,
} from "../src/a2a/signing-key.js";
import { HttpMessageSignatureVerifier, HttpMessageSigner } from "../src/trust/identity/index.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

const AUTHORITY = "merchant.example";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

interface Stack {
  base: string;
  signers: { one: HttpMessageSigner; two: HttpMessageSigner };
  /** 1.0 方法分派与扩展协商所需的头（与平台实测一致）。 */
  protocolHeaders: Record<string, string>;
}

async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-task-owner-"));
  const merchant = generateA2aSigningIdentity(AUTHORITY);
  const buyerOne = generateA2aSigningIdentity("buyer.one");
  const buyerTwo = generateA2aSigningIdentity("buyer.two");
  const server = new A2AServer({
    card: () => ({
      name: "Ownership test merchant",
      description: "task ownership",
      providerOrganization: "Kiwi Test",
      version: "1.0.0",
      baseUrl: `https://${AUTHORITY}`,
      a2aPath: "/a2a",
    }),
    ledger: new LedgerStore({ dir: path.join(dir, "ledger"), now: () => new Date().toISOString() }),
    idempotency: new IdempotencyStore({ dir: path.join(dir, "idem"), now: () => new Date().toISOString() }),
    handler: echoHandler(),
    authVerifier: new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant, [buyerOne, buyerTwo]),
      scheme: "https",
      expectedAuthority: AUTHORITY,
      // 与云端一致：按**声明 origin** 重建目标 URI（本地 fetch 的 Host 是
      // 127.0.0.1:port；云端则是被网关改写的沙箱子域——两者都不可采信）。
      authoritySource: "declared",
      anonymousTrustLevel: "T0",
      anonymousIdentity: "anonymous",
    }),
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  cleanups.push(async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const mkSigner = (identity: { keyid: string; algorithm: "ed25519" | "es256"; privateKeyPem: string }) =>
    new HttpMessageSigner({ keyid: identity.keyid, algorithm: identity.algorithm, privateKey: identity.privateKeyPem });
  const base = `http://127.0.0.1:${port}`;
  const card = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as {
    capabilities?: { extensions?: { uri?: string }[] };
  };
  const extensionUri = card.capabilities?.extensions?.[0]?.uri;
  return {
    base,
    signers: { one: mkSigner(buyerOne), two: mkSigner(buyerTwo) },
    protocolHeaders: {
      "A2A-Version": "1.0",
      ...(extensionUri !== undefined ? { "A2A-Extensions": extensionUri } : {}),
    },
  };
}

/** 以指定签名者（或匿名）发起 JSON-RPC：@target-uri 按节点声明的 https+authority 重建。 */
async function rpc(
  stack: Stack,
  method: string,
  params: unknown,
  signer?: HttpMessageSigner,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: `req-${Math.random().toString(36).slice(2, 8)}`, method, params });
  const headers: Record<string, string> = {
    host: AUTHORITY,
    "content-type": "application/json",
    ...stack.protocolHeaders,
  };
  const signed =
    signer === undefined
      ? {}
      : signer.sign({
          method: "POST",
          url: `https://${AUTHORITY}/a2a`,
          body: Buffer.from(body, "utf8"),
          headers,
        });
  const res = await fetch(`${stack.base}/a2a`, {
    method: "POST",
    headers: { ...headers, ...signed },
    body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function envelope(messageId: string) {
  return finalizeEnvelope({ ...validEnvelopeFields(), message_id: messageId });
}

async function sendMessage(stack: Stack, messageId: string, signer?: HttpMessageSigner) {
  const env = envelope(messageId);
  return rpc(
    stack,
    "SendMessage",
    {
      message: {
        role: "ROLE_USER",
        parts: [{ data: { knp_envelope: env }, mediaType: "application/json" }],
        messageId,
      },
    },
    signer,
  );
}

function taskIdOf(body: Record<string, unknown>): string {
  const result = body["result"] as { task?: { id?: string } } | undefined;
  const id = result?.task?.id;
  expect(typeof id).toBe("string");
  return String(id);
}

/** JSON-RPC 错误码（1.0 wire 形状）。 */
function errorCode(body: Record<string, unknown>): number | undefined {
  const error = body["error"] as { code?: number } | undefined;
  return error?.code;
}

describe("T044：任务归属与匿名隔离", () => {
  it("本人可查自己的任务；异主体查同一任务 → TASK_NOT_FOUND（不泄露存在性）", async () => {
    const stack = await startStack();
    const sent = await sendMessage(stack, "msg_owner_a", stack.signers.one);
    expect(sent.status).toBe(200);
    const taskId = taskIdOf(sent.body);

    const mine = await rpc(stack, "GetTask", { id: taskId }, stack.signers.one);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).toContain(taskId);

    const theirs = await rpc(stack, "GetTask", { id: taskId }, stack.signers.two);
    // 异主体看到的是 TASK_NOT_FOUND（与"任务不存在"不可区分），且**没有 result**：
    // data 里会回显被请求的 id，但绝不返回任务本体（状态/工件）。
    expect(errorCode(theirs.body)).toBe(-32001);
    expect(theirs.body["result"]).toBeUndefined();
  });

  it("匿名主体查询任务 → authentication_required（首版不开放私有任务）", async () => {
    const stack = await startStack();
    const sent = await sendMessage(stack, "msg_owner_anon", stack.signers.one);
    const taskId = taskIdOf(sent.body);

    const anon = await rpc(stack, "GetTask", { id: taskId });
    // 1.0 wire 把错误 data 映射成 google.rpc ErrorInfo（不带 protocol_code），
    // 因此这里按 1.0 的错误形状断言：KNP 协议错误码 + 说明文本。
    expect(errorCode(anon.body)).toBe(-32050);
    expect(JSON.stringify(anon.body)).toContain("authenticated");
    expect(JSON.stringify(anon.body)).not.toContain(taskId);
  });

  it("ListTasks 只返回本人任务（异主体看不到别人的任务）", async () => {
    const stack = await startStack();
    const sent = await sendMessage(stack, "msg_owner_list", stack.signers.one);
    const taskId = taskIdOf(sent.body);

    const mine = await rpc(stack, "ListTasks", {}, stack.signers.one);
    expect(JSON.stringify(mine.body)).toContain(taskId);

    const theirs = await rpc(stack, "ListTasks", {}, stack.signers.two);
    expect(JSON.stringify(theirs.body)).not.toContain(taskId);

    const anon = await rpc(stack, "ListTasks", {});
    expect(errorCode(anon.body)).toBe(-32050);
    expect(JSON.stringify(anon.body)).toContain("authenticated");
  });

  it("异主体 CancelTask → not_found，任务状态不被改动", async () => {
    const stack = await startStack();
    const sent = await sendMessage(stack, "msg_owner_cancel", stack.signers.one);
    const taskId = taskIdOf(sent.body);

    const theirs = await rpc(stack, "CancelTask", { id: taskId }, stack.signers.two);
    expect(errorCode(theirs.body)).toBe(-32001);
    expect(theirs.body["result"]).toBeUndefined();

    // 本人查询仍是原状态（未被异主体取消）。
    const mine = await rpc(stack, "GetTask", { id: taskId }, stack.signers.one);
    expect(JSON.stringify(mine.body)).not.toContain("canceled");
  });

  it("匿名主体 CancelTask → authentication_required", async () => {
    const stack = await startStack();
    const sent = await sendMessage(stack, "msg_owner_cancel_anon", stack.signers.one);
    const taskId = taskIdOf(sent.body);
    const anon = await rpc(stack, "CancelTask", { id: taskId });
    expect(errorCode(anon.body)).toBe(-32050);
    expect(JSON.stringify(anon.body)).toContain("authenticated");
  });
});
