/**
 * negotiationAutoTick 饥饿回归测试（KW-REL-01，2026-08-09 安全审查）。
 *
 * 已结算（settled）消息 abandon 后回到 pending 队首（conversations.updated_at
 * desc），若 autopilot 每次只取第一条，队尾的 live 消息会被永久饿死。
 * 修复：settled 键为 (conversation_id, message_id) 复合粒度，prepare 透传
 * skipKeys 并选择 firstLive——message_id 是会话内的，不能用裸 message_id 做
 * 跨会话跳过（否则其他会话同号的 live 消息会被误压制）。
 *
 * 覆盖：
 * - 混合队列（settled 最新 + live 较旧）：单次 tick 只 claim live 消息，
 *   已结算消息不被重复 claim；
 * - 连续 tick：live 消息每次都被推进（不因 settled 阻塞）；
 * - 跨会话 message_id 撞车：settled 会话与 live 会话共享同号 message_id 时，
 *   live 消息仍被推进。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import type { CommerceClient, PendingMessage } from "../src/commerce/types.js";
import { PROTOCOL_VERSION, type NegotiationSnapshot } from "../src/negotiation/types.js";
import { testProfile } from "./helpers.js";

const TEST_KEY = "a".repeat(64);

let workDir: string;

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.KIWI_DATA_KEY;
});

/** 最小合法 merchant snapshot（复用 http-client.test.ts VALID_SNAPSHOT 形状）。 */
function snapshot(conversationId: string, messageId: number): NegotiationSnapshot {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation: { id: conversationId, status: "waiting_merchant", next_actor: "merchant" },
    role: "merchant",
    in_reply_to_message_id: messageId,
    product: { sku: "sku-001", title: "手写陶瓷杯", currency: "CNY", list_price: 99 },
    stock: {
      status: "available",
      quantity: 12,
      observed_at: "2026-08-03T00:00:00Z",
      reserved: false,
      source: { backend: "local_marketplace", observed_at: "2026-08-03T00:00:00Z" },
    },
    delivery: { eta_start: "2026-08-04T00:00:00Z", eta_end: "2026-08-04T04:00:00Z", fee: 0 },
    after_sales_policies: [{ ref: "policy:return-7d", summary: "签收后 7 天内无理由退货。" }],
    messages: [
      {
        id: messageId,
        sender_role: "buyer",
        created_at: "2026-08-03T00:00:00Z",
        public_message: "便宜点？",
      },
    ],
    current_proposal: null,
    open_issues: [],
    policy_results: [],
  };
}

/**
 * 多会话 mock client：pending 恒为 [settled:101(队首), live:201(队尾)]——
 * 模拟已结算消息 abandon 后回到队首的饥饿场景。claimMessage 记录所有
 * claim 调用（断言 settled 不被重复 claim）。
 */
function starvationClient(): { client: CommerceClient; claims: number[] } {
  const claims: number[] = [];
  const pending: PendingMessage[] = [
    {
      conversation_id: "conv-settled",
      message_id: 101,
      conversation_status: "waiting_merchant",
      sender_role: "buyer",
      preview: "便宜点？",
      created_at: "2026-08-03T00:00:00Z",
    },
    {
      conversation_id: "conv-live",
      message_id: 201,
      conversation_status: "waiting_merchant",
      sender_role: "buyer",
      preview: "能再便宜点吗？",
      created_at: "2026-08-03T00:01:00Z",
    },
  ];
  const client = {
    listPendingMessages: async () => pending,
    claimMessage: async (input: { message_id: number }) => {
      claims.push(input.message_id);
      return { claimed: true };
    },
    getNegotiationSnapshot: async (input: { conversation_id: string }) =>
      snapshot(input.conversation_id, input.conversation_id === "conv-live" ? 201 : 101),
    submitNegotiationDecision: async () => ({ ok: true, accepted: true }),
    completeClaim: async () => ({ ok: true }),
    abandonClaim: async () => ({ ok: true }),
    failClaim: async () => ({ ok: true }),
    health: async () => ({ ok: true }),
    getCapabilities: async () => ({
      protocol_version: PROTOCOL_VERSION,
      capabilities: ["price_negotiate"],
    }),
  } as unknown as CommerceClient;
  return { client, claims };
}

/**
 * 跨会话 message_id 撞车 client：pending 为 [settled:101(conv-settled),
 * live:101(conv-live)]——两个会话共享同一 message_id。若按裸 message_id 跳过
 * 已结算消息，conv-live 的 live 消息会被误压制（饥饿）。claimMessage 记录
 * (conversation_id, message_id) 以断言 claim 落在 live 会话上。
 */
function collisionClient(): { client: CommerceClient; claims: { conversation_id: string; message_id: number }[] } {
  const claims: { conversation_id: string; message_id: number }[] = [];
  const pending: PendingMessage[] = [
    {
      conversation_id: "conv-settled",
      message_id: 101,
      conversation_status: "waiting_merchant",
      sender_role: "buyer",
      preview: "便宜点？",
      created_at: "2026-08-03T00:00:00Z",
    },
    {
      conversation_id: "conv-live",
      message_id: 101,
      conversation_status: "waiting_merchant",
      sender_role: "buyer",
      preview: "能再便宜点吗？",
      created_at: "2026-08-03T00:01:00Z",
    },
  ];
  const client = {
    listPendingMessages: async () => pending,
    claimMessage: async (input: { conversation_id: string; message_id: number }) => {
      claims.push({ conversation_id: input.conversation_id, message_id: input.message_id });
      return { claimed: true };
    },
    getNegotiationSnapshot: async (input: { conversation_id: string }) =>
      snapshot(input.conversation_id, 101),
    submitNegotiationDecision: async () => ({ ok: true, accepted: true }),
    completeClaim: async () => ({ ok: true }),
    abandonClaim: async () => ({ ok: true }),
    failClaim: async () => ({ ok: true }),
    health: async () => ({ ok: true }),
    getCapabilities: async () => ({
      protocol_version: PROTOCOL_VERSION,
      capabilities: ["price_negotiate"],
    }),
  } as unknown as CommerceClient;
  return { client, claims };
}

async function openAutopilotKernel(client: CommerceClient): Promise<AgentKernel> {
  const { models, model } = createFakeChatModels();
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-autotick-"));
  workDir = dir;
  const paths = ensurePathsForDir(dir);
  return AgentKernel.open({
    profile: testProfile(), // merchant（多会话场景）
    paths,
    models,
    model,
    vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    commerceClient: client,
    mode: "autopilot",
  });
}

describe("negotiationAutoTick 饥饿回归（KW-REL-01）", () => {
  it("混合队列：已结算消息在队首也不被 claim，live 消息被推进", async () => {
    const { client, claims } = starvationClient();
    const kernel = await openAutopilotKernel(client);
    // 白盒预置 settled：conv-settled:101 已达成共识（修复前按 conversation_id
    // 记忆，101 每次都会 claim→abandon→回队首，饿死 201）。
    (
      kernel as unknown as { settledNegotiations: Set<string> }
    ).settledNegotiations.add("conv-settled:101");

    const result = await kernel.negotiationAutoTick();

    // live 消息被处理（claim → snapshot → submit → complete），settled 不碰
    expect(claims).toEqual([201]);
    expect(result).toBeDefined();
  });

  it("连续 tick：live 消息每次都被推进，settled 永不重复 claim", async () => {
    const { client, claims } = starvationClient();
    const kernel = await openAutopilotKernel(client);
    (
      kernel as unknown as { settledNegotiations: Set<string> }
    ).settledNegotiations.add("conv-settled:101");

    await kernel.negotiationAutoTick();
    await kernel.negotiationAutoTick();
    await kernel.negotiationAutoTick();

    // 每 tick 恰好 claim 一次 live；101 一次都不出现
    expect(claims.filter((id) => id === 101)).toEqual([]);
    expect(claims.filter((id) => id === 201)).toHaveLength(3);
  });

  it("跨会话 message_id 撞车：已结算 conv-settled:101 不压制 conv-live:101 的 live 消息", async () => {
    const { client, claims } = collisionClient();
    const kernel = await openAutopilotKernel(client);
    // 只结算 conv-settled:101；conv-live:101 是 live。两会话共享 message_id 101。
    (
      kernel as unknown as { settledNegotiations: Set<string> }
    ).settledNegotiations.add("conv-settled:101");

    const result = await kernel.negotiationAutoTick();

    // live 会话的 101 被 claim 推进，而不是被已结算会话的同号 message_id 压制。
    expect(claims).toEqual([{ conversation_id: "conv-live", message_id: 101 }]);
    expect(result).toBeDefined();
  });

  it("权威门持续拒绝的消息失败 3 次后进入冷却，不再饿死队尾 live（审查 P2-I）", async () => {
    const claims: number[] = [];
    const pending: PendingMessage[] = [
      {
        conversation_id: "conv-rejected",
        message_id: 301,
        conversation_status: "waiting_merchant",
        sender_role: "buyer",
        preview: "再便宜点",
        created_at: "2026-08-03T00:01:00Z",
      },
      {
        conversation_id: "conv-live",
        message_id: 401,
        conversation_status: "waiting_merchant",
        sender_role: "buyer",
        preview: "能更便宜吗",
        created_at: "2026-08-03T00:02:00Z",
      },
    ];
    const client = {
      listPendingMessages: async () => pending,
      claimMessage: async (input: { message_id: number }) => {
        claims.push(input.message_id);
        return { claimed: true };
      },
      getNegotiationSnapshot: async (input: { conversation_id: string }) =>
        snapshot(input.conversation_id, input.conversation_id === "conv-rejected" ? 301 : 401),
      // 网关权威门确定性拒绝：每次 tick 同一决策 → 同一拒绝
      submitNegotiationDecision: async () => ({
        result: "rejected",
        public_reason: "authority gate: price below floor",
      }),
      completeClaim: async () => ({ ok: true }),
      abandonClaim: async () => ({ ok: true }),
      failClaim: async () => ({ ok: true }),
      health: async () => ({ ok: true }),
      getCapabilities: async () => ({
        protocol_version: PROTOCOL_VERSION,
        capabilities: ["price_negotiate"],
      }),
    } as unknown as CommerceClient;
    const kernel = await openAutopilotKernel(client);

    // 前 3 tick：301 被 claim 并失败（计数 1→2→3）
    await kernel.negotiationAutoTick();
    await kernel.negotiationAutoTick();
    const third = await kernel.negotiationAutoTick();
    expect(claims.filter((id) => id === 301)).toHaveLength(3);
    expect(third).toContain("暂停自动处理");

    // 第 4 tick：301 进入冷却窗口被跳过 → 队尾 live 401 被推进
    // （修复前 301 每 tick 无限 claim→fail，401 永久饿死）
    const fourth = await kernel.negotiationAutoTick();
    expect(claims).toEqual([301, 301, 301, 401]);
    expect(fourth).toContain("conv-live");
  });

  it("全部 settled 时 tick 直接返回（不 claim 任何消息）", async () => {
    const { client, claims } = starvationClient();
    const kernel = await openAutopilotKernel(client);
    (
      kernel as unknown as { settledNegotiations: Set<string> }
    ).settledNegotiations.add("conv-settled:101");
    (
      kernel as unknown as { settledNegotiations: Set<string> }
    ).settledNegotiations.add("conv-live:201");

    const result = await kernel.negotiationAutoTick();

    expect(result).toBeUndefined();
    expect(claims).toEqual([]);
  });
});
