/**
 * A2ADirectChannel 端到端测试（基线 §24 Direct Reliability）——本地 mock A2A server。
 *
 * 覆盖：
 *   - send 走 message/send，KNP envelope 入 Data Part；出站落 Ledger（message_sent）+ 幂等 commit；
 *   - 协议幂等（§20）：同 message_id + 同 digest → 重放返回原结果，不重复落账；
 *     同 message_id + 异 digest → idempotency_conflict（fail-closed）；
 *   - getState 走 tasks/get，返回 task 状态 + message_ids；
 *   - subscribe 用轮询实现（A2ATaskPoller），状态变化发 RemoteEvent；
 *   - close 后 send fail-closed（channel_closed）；
 *   - 出站校验 fail-closed：坏 envelope → invalid_envelope；
 *   - 远端不可达 → send_failed（不自动降级到其他通道，不变量 21）。
 */
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { A2AServer, echoHandler } from "../src/a2a/server/index.js";
import type { A2AServerOptions } from "../src/a2a/server/index.js";
import { A2ADirectChannel } from "../src/counterparty/index.js";
import type { RemoteEvent } from "../src/counterparty/index.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

const NOW = "2026-08-06T10:00:00.000Z";
const OPEN_INPUT = {
  negotiation_id: NEGOTIATION_ID,
  sender_identity: "kiwi-buyer",
  identity: "merchant-remote",
  remote: { context_id: "ctx_1" },
};

interface Started {
  url: string;
  a2aUrl: string;
  httpServer: http.Server;
  serverDir: string;
}

const servers: Started[] = [];

async function startServer(handler: NonNullable<A2AServerOptions["handler"]>): Promise<Started> {
  const serverDir = mkdtempSync(path.join(tmpdir(), "kiwi-direct-srv-"));
  const ledger = new LedgerStore({ dir: serverDir });
  const idempotency = new IdempotencyStore({ dir: serverDir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: "Test Merchant",
      description: "direct e2e merchant",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
    }),
    ledger,
    idempotency,
    handler,
    now: () => NOW,
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  holder.baseUrl = `http://127.0.0.1:${addr.port}`;
  const started: Started = { url: holder.baseUrl, a2aUrl: `${holder.baseUrl}/`, httpServer, serverDir };
  servers.push(started);
  return started;
}

function clientFor(url: string): { channel: A2ADirectChannel; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-direct-client-"));
  return {
    channel: new A2ADirectChannel({
      url,
      ledger: new LedgerStore({ dir, now: () => NOW }),
      idempotency: new IdempotencyStore({ dir, now: () => NOW }),
      now: () => NOW,
    }),
    dir,
  };
}

describe("A2ADirectChannel: send/getState 端到端", () => {
  it("send 写入 ledger（message_sent）并幂等 commit，getState 返回远端 task", async () => {
    const srv = await startServer(echoHandler());
    const { channel, dir } = clientFor(srv.url);
    try {
      const handle = await channel.open(OPEN_INPUT);
      const envelope = finalizeEnvelope(validEnvelopeFields());
      const result = await handle.send({ envelope });

      expect(result.channel).toBe("a2a-direct");
      expect(result.task).toBeDefined();
      expect(result.task?.status.state).toBe("completed");
      expect(result.ref.task_id).toBe(result.task?.id);
      expect(result.ref.context_id).toBeDefined();

      // 出站落账：message_sent 事件含 wire_digest + wire_payload。
      const events = new LedgerStore({ dir, now: () => NOW }).events(NEGOTIATION_ID);
      const sent = events.filter((e) => e.event_kind === "message_sent");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.message_id).toBe(envelope.message_id);
      expect(sent[0]?.wire_digest).toBe(envelope.digest);

      // getState 走 tasks/get。
      const state = await handle.getState(result.ref);
      expect(state.state).toBe("completed");
      expect(state.task?.id).toBe(result.task?.id);
      expect(state.message_ids.length).toBeGreaterThan(0);

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等：同 message_id + 同 digest 重放返回原结果，不重复落账", async () => {
    const srv = await startServer(echoHandler());
    const { channel, dir } = clientFor(srv.url);
    try {
      const handle = await channel.open(OPEN_INPUT);
      const envelope = finalizeEnvelope(validEnvelopeFields());

      const first = await handle.send({ envelope });
      const second = await handle.send({ envelope });

      expect(second.replayed).toBe(true);
      expect(second.task?.id).toBe(first.task?.id);

      // 只落账一条 message_sent。
      const sent = new LedgerStore({ dir, now: () => NOW }).events(NEGOTIATION_ID).filter(
        (e) => e.event_kind === "message_sent",
      );
      expect(sent).toHaveLength(1);

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等冲突：同 message_id + 异 digest → idempotency_conflict（fail-closed）", async () => {
    const srv = await startServer(echoHandler());
    const { channel, dir } = clientFor(srv.url);
    try {
      const handle = await channel.open(OPEN_INPUT);
      const envelope = finalizeEnvelope(validEnvelopeFields());
      await handle.send({ envelope });

      const conflicted = finalizeEnvelope({ ...validEnvelopeFields(), public_message: "tampered" });
      expect(conflicted.message_id).toBe(envelope.message_id);
      expect(conflicted.digest).not.toBe(envelope.digest);

      await expect(handle.send({ envelope: conflicted })).rejects.toMatchObject({
        channel: "a2a-direct",
        code: "idempotency_conflict",
      });

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("出站校验 fail-closed：坏 envelope → invalid_envelope", async () => {
    const srv = await startServer(echoHandler());
    const { channel, dir } = clientFor(srv.url);
    try {
      const handle = await channel.open(OPEN_INPUT);
      const bad = {
        ...finalizeEnvelope(validEnvelopeFields()),
        protocol_version: "2.0",
      } as unknown as NegotiationEnvelope;
      await expect(handle.send({ envelope: bad })).rejects.toMatchObject({
        channel: "a2a-direct",
        code: "invalid_envelope",
      });
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("远端不可达 → send_failed，不自动降级", async () => {
    const { channel, dir } = clientFor("http://127.0.0.1:1/");
    try {
      const handle = await channel.open(OPEN_INPUT);
      await expect(handle.send({ envelope: finalizeEnvelope(validEnvelopeFields()) })).rejects.toMatchObject({
        channel: "a2a-direct",
        code: "send_failed",
      });
      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close 后 send fail-closed（channel_closed）", async () => {
    const srv = await startServer(echoHandler());
    const { channel, dir } = clientFor(srv.url);
    try {
      const handle = await channel.open(OPEN_INPUT);
      await handle.close();
      await expect(handle.send({ envelope: finalizeEnvelope(validEnvelopeFields()) })).rejects.toMatchObject({
        code: "channel_closed",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A2ADirectChannel: subscribe 用轮询实现", () => {
  it("send 后 subscribe 收到 terminal 状态变化事件", async () => {
    const srv = await startServer(echoHandler());
    const { channel, dir } = clientFor(srv.url);
    try {
      const handle = await channel.open(OPEN_INPUT);
      const result = await handle.send({ envelope: finalizeEnvelope(validEnvelopeFields()) });

      const events: RemoteEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for state_changed")), 3000);
        // a2a-direct 实现了 subscribe（轮询）；可选方法在此非空断言。
        handle
          .subscribe!(result.ref, (event) => {
            events.push(event);
            if (event.kind === "state_changed" && event.state?.state === "completed") {
              clearTimeout(timer);
              resolve();
            }
          })
          .then((unsub) => {
            // 事件到达后由 resolve 清理；unsub 兜底。
            void unsub;
          });
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
      const terminal = events.find((e) => e.state?.state === "completed");
      expect(terminal).toBeDefined();

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterAll(async () => {
  for (const srv of servers) {
    await new Promise<void>((resolve) => srv.httpServer.close(() => resolve()));
    rmSync(srv.serverDir, { recursive: true, force: true });
  }
});
