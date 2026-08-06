/**
 * CounterpartyChannel 契约测试 —— 三个实现跑同一组契约用例（§33 / §38）。
 *
 * 契约面（所有通道实现必须满足）：
 *   - open 返回 handle（kind/identity 与 open 输入一致）；
 *   - send 接受 KNP envelope 并返回结构化 ChannelSendResult（或抛 ChannelError）；
 *   - getState 返回 RemoteState（message_ids 数组 + observed_at RFC 3339）；
 *   - close 后 send/getState fail-closed（channel_closed）。
 *
 * 各通道进入「getState 可读」的时机不同（direct 需先 send 创建 task；hosted 在
 * open 内部 claim 后即可读），由 harness 的 makeGetStateReady 封装。
 *
 * platform-api 是 fail-closed 占位（未配置 → open 拒绝；已配置但未接线 →
 * send/getState not_implemented），单独断言。
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
import {
  A2ADirectChannel,
  ChannelError,
  PlatformApiChannel,
  ShoppingCliHostedChannel,
} from "../src/counterparty/index.js";
import type {
  ChannelHandle,
  ChannelOpenInput,
  ChannelSendResult,
  CounterpartyChannel,
  RemoteRef,
  RemoteState,
} from "../src/counterparty/index.js";
import { createFakeMarketplace } from "../src/commerce/fake-client.js";
import { CAPABILITY, NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

const NOW = "2026-08-06T10:00:00.000Z";

interface ChannelContractHarness {
  name: string;
  open(): Promise<{ channel: CounterpartyChannel; handle: ChannelHandle; identity: string }>;
  envelope(): NegotiationEnvelope;
  /** 让通道进入 getState 可读状态并返回 ref（direct 先 send；hosted open 已 claim）。 */
  makeGetStateReady(handle: ChannelHandle): Promise<RemoteRef>;
  /** 通道特有的 send 成功形状断言。 */
  expectSend(result: ChannelSendResult): void;
  expectGetState(state: RemoteState): void;
}

// ---------------------------------------------------------------------------
// 共享契约用例（direct / hosted）
// ---------------------------------------------------------------------------

function runOpenableChannelContract(harness: ChannelContractHarness): void {
  describe(`${harness.name}: CounterpartyChannel 契约`, () => {
    it("open 返回 kind/identity 匹配的 handle", async () => {
      const { channel, handle, identity } = await harness.open();
      expect(handle.kind).toBe(channel.kind);
      expect(handle.identity).toBe(identity);
      await handle.close();
    });

    it("getState 返回 RemoteState（message_ids + observed_at）", async () => {
      const { handle } = await harness.open();
      try {
        const ref = await harness.makeGetStateReady(handle);
        const state = await handle.getState(ref);
        expect(state.channel).toBe(handle.kind);
        expect(Array.isArray(state.message_ids)).toBe(true);
        expect(typeof state.observed_at).toBe("string");
        expect(state.observed_at.length).toBeGreaterThan(0);
        harness.expectGetState(state);
      } finally {
        await handle.close();
      }
    });

    it("send 返回结构化 ChannelSendResult", async () => {
      const { handle } = await harness.open();
      try {
        const result = await handle.send({ envelope: harness.envelope() });
        expect(result.channel).toBe(handle.kind);
        harness.expectSend(result);
      } finally {
        await handle.close();
      }
    });

    it("close 后 send fail-closed（channel_closed）", async () => {
      const { handle } = await harness.open();
      await handle.close();
      await expect(handle.send({ envelope: harness.envelope() })).rejects.toMatchObject({
        code: "channel_closed",
      });
    });
  });
}

// ---------------------------------------------------------------------------
// direct harness：本地 mock A2A server（echoHandler）
// ---------------------------------------------------------------------------

const directRegistry: Array<{ httpServer: http.Server; dir: string }> = [];
const directClientDirs: string[] = [];

async function startEchoServer(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-cc-direct-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: "Test Merchant",
      description: "contract test merchant",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
    }),
    ledger,
    idempotency,
    handler: echoHandler(),
    now: () => NOW,
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  holder.baseUrl = `http://127.0.0.1:${addr.port}`;
  directRegistry.push({ httpServer, dir });
  return `${holder.baseUrl}/`;
}

const directHarness: ChannelContractHarness = {
  name: "a2a-direct",
  async open() {
    const url = await startEchoServer();
    const clientLedgerDir = mkdtempSync(path.join(tmpdir(), "kiwi-cc-direct-ledger-"));
    const clientIdemDir = mkdtempSync(path.join(tmpdir(), "kiwi-cc-direct-idem-"));
    directClientDirs.push(clientLedgerDir, clientIdemDir);
    const channel = new A2ADirectChannel({
      url,
      ledger: new LedgerStore({ dir: clientLedgerDir, now: () => NOW }),
      idempotency: new IdempotencyStore({ dir: clientIdemDir, now: () => NOW }),
      now: () => NOW,
    });
    const openInput: ChannelOpenInput = {
      negotiation_id: NEGOTIATION_ID,
      sender_identity: "kiwi-buyer",
      identity: "merchant-remote",
    };
    return { channel, handle: await channel.open(openInput), identity: "merchant-remote" };
  },
  envelope() {
    return finalizeEnvelope(validEnvelopeFields());
  },
  async makeGetStateReady(handle) {
    const result = await handle.send({ envelope: this.envelope() });
    return result.ref;
  },
  expectSend(result) {
    expect(result.task).toBeDefined();
    expect(result.ref.task_id).toBe(result.task?.id);
  },
  expectGetState(state) {
    expect(state.task).toBeDefined();
  },
};

// ---------------------------------------------------------------------------
// hosted harness：FakeCommerceClient（merchant 角色）
// ---------------------------------------------------------------------------

const hostedHarness: ChannelContractHarness = {
  name: "shopping-cli-hosted",
  async open() {
    const mk = createFakeMarketplace({
      merchant_id: "merchant-001",
      buyer_id: "buyer-001",
      product: {
        sku: "SKU-001",
        title: "widget",
        currency: "CNY",
        list_price: 100,
        stock_quantity: 10,
        delivery: { eta_start: "2026-08-10T00:00:00Z", eta_end: "2026-08-11T00:00:00Z", fee: 5 },
        policies: [{ ref: "POL-1", summary: "7-day returns" }],
      },
      now: NOW,
    });
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const openInput: ChannelOpenInput = {
      negotiation_id: "conv-merchant-001",
      sender_identity: "kiwi-merchant",
      identity: "buyer-remote",
      remote: { conversation_id: "conv-merchant-001", message_id: 1 },
    };
    return { channel, handle: await channel.open(openInput), identity: "buyer-remote" };
  },
  envelope() {
    return finalizeEnvelope({
      capability: CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: "conv-merchant-001",
      exchange_id: "ex_contract",
      message_id: "msg_contract_1",
      actor: "merchant",
      action: "decline",
      created_at: NOW,
      payload: {
        type: "decline",
        target_message_id: "msg_legacy_1",
        target_offer_id: "off_legacy_1",
        scope: "offer",
      },
      public_message: "declining this offer",
    });
  },
  async makeGetStateReady(handle) {
    void handle;
    // open 已内部 claim 消息 1；权威快照在 claim 存活期内可读（§21）。
    return { negotiation_id: "conv-merchant-001", conversation_id: "conv-merchant-001", message_id: 1 };
  },
  expectSend(result) {
    expect(result.policy).toBeDefined();
    expect(result.policy?.result).toBe("accepted");
    expect(result.ref.conversation_id).toBe("conv-merchant-001");
    expect(result.ref.message_id).toBe(1);
  },
  expectGetState(state) {
    expect(state.snapshot).toBeDefined();
    expect(state.snapshot?.conversation.id).toBe("conv-merchant-001");
  },
};

// ---------------------------------------------------------------------------
// platform-api：fail-closed 占位断言
// ---------------------------------------------------------------------------

function runPlatformApiFailClosedContract(): void {
  describe("platform-api: fail-closed 占位契约", () => {
    it("未配置平台凭证 → open 拒绝（platform_not_configured，绝不静默降级）", async () => {
      const channel: CounterpartyChannel = new PlatformApiChannel();
      await expect(
        channel.open({
          negotiation_id: NEGOTIATION_ID,
          sender_identity: "kiwi-buyer",
          identity: "platform-merchant",
        }),
      ).rejects.toMatchObject({ channel: "platform-api", code: "platform_not_configured" });
    });

    it("已配置但未接线 → send/getState 抛 not_implemented", async () => {
      const channel: CounterpartyChannel = new PlatformApiChannel({
        configured: true,
        credentialRef: "platform:prod:acme",
      });
      const handle: ChannelHandle = await channel.open({
        negotiation_id: NEGOTIATION_ID,
        sender_identity: "kiwi-buyer",
        identity: "platform-merchant",
      });
      await expect(handle.send({ envelope: finalizeEnvelope(validEnvelopeFields()) })).rejects.toMatchObject({
        channel: "platform-api",
        code: "not_implemented",
      });
      await expect(handle.getState({ negotiation_id: NEGOTIATION_ID })).rejects.toMatchObject({
        channel: "platform-api",
        code: "not_implemented",
      });
      await handle.close();
    });

    it("ChannelError 携带通道 kind 与错误码", async () => {
      const channel = new PlatformApiChannel();
      try {
        await channel.open({
          negotiation_id: NEGOTIATION_ID,
          sender_identity: "kiwi-buyer",
          identity: "x",
        });
        throw new Error("expected open to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(ChannelError);
        expect((err as ChannelError).channel).toBe("platform-api");
        expect((err as ChannelError).code).toBe("platform_not_configured");
      }
    });
  });
}

describe("CounterpartyChannel: 三实现同一组契约用例", () => {
  runOpenableChannelContract(directHarness);
  runOpenableChannelContract(hostedHarness);
  runPlatformApiFailClosedContract();
});

afterAll(async () => {
  for (const { httpServer, dir } of directRegistry) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of directClientDirs) rmSync(dir, { recursive: true, force: true });
});
