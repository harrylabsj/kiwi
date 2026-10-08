/**
 * A336 原 P1-4 K3 返修自有强控（unknown 围栏持久安全 + hints 选中消息绑定 +
 * completeClaim 失败窗口分层）。
 *
 * 口径（授权卡）：
 * - 真实 submitNegotiationDecision 接口（服务端效果计数 +1 后 lost-response
 *   抛错），非 sendMessage 缺接口 TypeError 造 unknown；
 * - 记录先于 failClaim 卡住/抛；文件 fsync + 目录 fsync（复用 writeFileAtomic）；
 *   写失败/坏或不可写存储 fail-closed 上抛（不“Map 先写失败吞后重启空 Map 放行”）；
 * - completeClaim 在网关 accepted 后失败 = 确认未知 → 同层围栏（不泛封
 *   policy rejected / 本地门未过等效果未开始失败）；
 * - clearUnknown 无生产权威对账 caller（明确限制保持）：写失败上抛且条目
 *   保持围栏，不以内存已解除冒充已恢复；
 * - kernel 两次 list 之间列表可变：hints 必须由实际 prepared 目标现产，
 *   B 的 hints 不得用于 C；稳定列表 unknownA→healthyB 改善保持、healthy 恰一次。
 *
 * 本文件在修复前冻结源上先跑红（T1/T2/T3/T6/K1 FAIL），证明缺陷可检出。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// fsync 计数（writeFileAtomic 文件 fsync + 目录 fsync 的行为证据）。
const h = vi.hoisted(() => ({ fsyncCount: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      h.fsyncCount += 1;
      return actual.fsyncSync(fd);
    },
  };
});

import { DeterministicNegotiationRunner } from "../src/operator/runner.js";
import type { CommerceClient, PendingMessage } from "../src/commerce/types.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { FakeCommerceConnector } from "../src/agent/connector/fake-connector.js";
import { PROTOCOL_VERSION, type NegotiationSnapshot } from "../src/negotiation/types.js";
import { testProfile } from "./helpers.js";

const TEST_KEY = "a".repeat(64);
const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const BUYER_PROFILE = {
  agent_id: "buyer-agent:a336",
  role: "buyer",
  buyer_policy: {
    max_total_price_private: 100_000,
    acceptable_eta_latest: "9999-12-31T23:59:59Z",
    required_after_sales_terms: [],
  },
} as never;

const BINDING = { conversation_id: "conv-a336", message_id: 7, idempotency_key: "idem-7" };

interface FenceClientOpts {
  failClaimNever?: boolean;
  completeClaimThrows?: boolean;
  gatewayResult?: { result: string; public_reason: string };
}

/** 真实 submitNegotiationDecision 接口：服务端效果计数 +1 后 lost-response。 */
function makeFenceClient(opts: FenceClientOpts = {}) {
  const state = {
    submitEffects: 0,
    failClaimCalls: 0,
    completeClaimCalls: 0,
    releaseFailClaim: undefined as (() => void) | undefined,
  };
  const client = {
    async listPendingMessages() {
      return [{ conversation_id: BINDING.conversation_id, message_id: BINDING.message_id }];
    },
    async claimMessage() {
      return { claimed: true };
    },
    async getNegotiationSnapshot() {
      return {
        role: "buyer" as const,
        conversation: { id: BINDING.conversation_id, status: "open" },
        messages: [],
      };
    },
    async submitNegotiationDecision() {
      state.submitEffects += 1; // 效果已落地，响应丢失
      if (opts.gatewayResult !== undefined) return opts.gatewayResult;
      throw new Error("gateway unreachable after write");
    },
    async failClaim() {
      state.failClaimCalls += 1;
      if (opts.failClaimNever === true) {
        await new Promise<void>((r) => {
          state.releaseFailClaim = r;
        });
      }
    },
    async completeClaim() {
      state.completeClaimCalls += 1;
      if (opts.completeClaimThrows === true) throw new Error("confirm response lost");
    },
    async abandonClaim() {},
  } as unknown as CommerceClient;
  return { client, state };
}

function makeRunner(fenceDir: string, client: CommerceClient): DeterministicNegotiationRunner {
  return new DeterministicNegotiationRunner(BUYER_PROFILE, client, { unknownFenceDir: fenceDir });
}

function fenceEntries(fenceFile: string): Array<Record<string, unknown>> {
  if (!existsSync(fenceFile)) return [];
  return readFileSync(fenceFile, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("A336 P1-4：unknown 围栏写安全（fsync + 失败闭合）", () => {
  it("T1 记录先于 failClaim 卡住可见，且文件+目录 fsync（writeFileAtomic）", async () => {
    const dir = tmp("a336-t1-");
    const fenceDir = path.join(dir, "fence");
    const { client, state } = makeFenceClient({ failClaimNever: true });
    const runner = makeRunner(fenceDir, client);
    h.fsyncCount = 0;
    const p = runner
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch((e) => e);
    await new Promise((r) => setTimeout(r, 80));
    // failClaim 仍挂起，围栏已落盘（顺序证据）
    expect(state.failClaimCalls).toBe(1);
    const entries = fenceEntries(path.join(fenceDir, "submit-unknown.jsonl"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.conversation_id).toBe("conv-a336");
    expect(entries[0]?.message_id).toBe(7);
    // 文件 fsync + 目录 fsync 各至少一次（旧实现 appendFileSync 无 fsync → 0）
    expect(h.fsyncCount).toBeGreaterThanOrEqual(2);
    state.releaseFailClaim?.();
    await p;
  });

  it("T2 不可写存储：围栏落盘失败上抛（不吞），内存围栏仍挡本进程重驱", async () => {
    const dir = tmp("a336-t2-");
    // 以常规文件占位 → 其下建目录必然 ENOTDIR（不可写存储形态）
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not-a-dir");
    const fenceDir = path.join(blocker, "sub");
    const { client, state } = makeFenceClient();
    const runner = makeRunner(fenceDir, client);
    const err = await runner
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch((e: unknown) => e);
    // 落盘失败必须显式上抛（旧实现 catch 吞 → 只抛原始网络错，无围栏失败信号）
    expect(String(err)).toMatch(/ATOMIC_REPLACE_FAILED|unknown fence/i);
    // failClaim 仍 best-effort 打过 unknown 标记
    expect(state.failClaimCalls).toBe(1);
    // 本进程内存围栏仍生效（不重驱）；失败已上抛，调用方知道持久化未保证
    const prepared = await runner.prepare();
    expect(prepared).toBeUndefined();
  });

  it("T3 网关 accepted 后 completeClaim 失败 = 确认未知 → 落围栏，重启不重驱（效果恰一次）", async () => {
    const dir = tmp("a336-t3-");
    const fenceDir = path.join(dir, "fence");
    const { client, state } = makeFenceClient({
      gatewayResult: { result: "accepted", public_reason: "" },
      completeClaimThrows: true,
    });
    const runner = makeRunner(fenceDir, client);
    const err = await runner
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch((e: unknown) => e);
    expect(String(err)).toContain("confirm response lost");
    expect(state.submitEffects).toBe(1);
    // 效果已落地：不打 failClaim 失败标记，而是落 unknown 围栏
    expect(state.failClaimCalls).toBe(0);
    const entries = fenceEntries(path.join(fenceDir, "submit-unknown.jsonl"));
    expect(entries).toHaveLength(1);
    expect(String(entries[0]?.reason)).toMatch(/completion unknown|确认未知/);
    // 重启（新实例）+ 消息仍在 pending（TTL 重挂）→ prepare 跳过，效果不重复
    const r2 = makeRunner(fenceDir, {
      async listPendingMessages() {
        return [{ conversation_id: BINDING.conversation_id, message_id: BINDING.message_id }];
      },
      async getNegotiationSnapshot() {
        throw new Error("must not reach");
      },
    } as unknown as CommerceClient);
    expect(await r2.prepare()).toBeUndefined();
    expect(state.submitEffects).toBe(1);
  });

  it("T4 不泛封效果未开始失败：网关 policy rejected / 本地预算门 → failClaim，无围栏", async () => {
    const dir = tmp("a336-t4-");
    // (a) 网关权威门拒绝
    const fenceDirA = path.join(dir, "fence-a");
    const a = makeFenceClient({ gatewayResult: { result: "rejected", public_reason: "below floor" } });
    const runnerA = makeRunner(fenceDirA, a.client);
    const outcomeA = await runnerA.submit({
      binding: BINDING,
      decision: { action: "accept_nonbinding" } as never,
    });
    expect(outcomeA.settlement).toBe("failed");
    expect(a.state.failClaimCalls).toBe(1);
    expect(existsSync(path.join(fenceDirA, "submit-unknown.jsonl"))).toBe(false);
    // (b) 买方本地私有门未过（效果从未开始）
    const fenceDirB = path.join(dir, "fence-b");
    const b = makeFenceClient();
    const poorRunner = new DeterministicNegotiationRunner(
      {
        agent_id: "buyer-agent:a336",
        role: "buyer",
        buyer_policy: {
          max_total_price_private: 1,
          acceptable_eta_latest: "9999-12-31T23:59:59Z",
          required_after_sales_terms: [],
        },
      } as never,
      b.client,
      { unknownFenceDir: fenceDirB },
    );
    const outcomeB = await poorRunner.submit({
      binding: BINDING,
      decision: {
        action: "counter",
        proposal: {
          unit_price: 100,
          quantity: 5,
          currency: "CNY",
          delivery: { eta_start: "2026-08-04T00:00:00Z", eta_end: "2026-08-04T04:00:00Z", fee: 0 },
          after_sales_policy_refs: [],
        },
      } as never,
    });
    expect(outcomeB.settlement).toBe("failed");
    expect(b.state.submitEffects).toBe(0); // 从未触网
    expect(existsSync(path.join(fenceDirB, "submit-unknown.jsonl"))).toBe(false);
  });

  it("T5 坏行围栏文件 → 构造 fail-closed（回归保持）", () => {
    const dir = tmp("a336-t5-");
    const fenceDir = path.join(dir, "submit-unknown");
    mkdirSync(fenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(fenceDir, "submit-unknown.jsonl"), "broken json line\n", { mode: 0o600 });
    expect(() => makeRunner(fenceDir, {} as unknown as CommerceClient)).toThrow(/fail-closed/);
  });

  it("T6 clearUnknown 写失败上抛且条目保持围栏（不以内存解除冒充已恢复）", async () => {
    const dir = tmp("a336-t6-");
    const fenceDir = path.join(dir, "fence");
    const { client } = makeFenceClient();
    const runner = makeRunner(fenceDir, client);
    await runner
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch(() => undefined);
    const fenceFile = path.join(fenceDir, "submit-unknown.jsonl");
    expect(fenceEntries(fenceFile)).toHaveLength(1);
    // 存储损坏形态：围栏文件路径被替换成目录 → 重写必然失败
    rmSync(fenceFile);
    mkdirSync(fenceFile);
    expect(() => runner.clearUnknown("conv-a336", 7)).toThrow();
    // 解除未生效：内存仍围栏（保守方向），prepare 继续跳过
    expect(await runner.prepare()).toBeUndefined();
  });

  it("T7 重启 + TTL 重挂：围栏消息不重驱，服务端效果恰一次（回归保持）", async () => {
    const dir = tmp("a336-t7-");
    const fenceDir = path.join(dir, "fence");
    const { client, state } = makeFenceClient();
    const r1 = makeRunner(fenceDir, client);
    await r1
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch(() => undefined);
    const r2 = makeRunner(fenceDir, client); // 重启语义（同 client 计数）
    expect(await r2.prepare()).toBeUndefined();
    expect(state.submitEffects).toBe(1);
  });
});

// ── kernel：hints 选中消息强绑定 ─────────────────────────────────

let workDir: string | undefined;
afterEach(() => {
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
  delete process.env.KIWI_DATA_KEY;
});

function pendingOf(conversationId: string, messageId: number): PendingMessage {
  return {
    conversation_id: conversationId,
    message_id: messageId,
    conversation_status: "waiting_buyer",
    sender_role: "merchant",
    preview: "报价 100",
    created_at: "2026-08-03T00:00:00Z",
  };
}

function buyerSnapshot(conversationId: string, messageId: number): NegotiationSnapshot {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation: { id: conversationId, status: "waiting_buyer", next_actor: "buyer" },
    role: "buyer",
    in_reply_to_message_id: messageId,
    product: { sku: "sku-001", title: "手写陶瓷杯", currency: "CNY", list_price: 100 },
    stock: {
      status: "available",
      quantity: 50,
      observed_at: "2026-08-03T00:00:00Z",
      reserved: false,
      source: { backend: "local_marketplace", observed_at: "2026-08-03T00:00:00Z" },
    },
    delivery: { eta_start: "2026-08-04T00:00:00Z", eta_end: "2026-08-04T04:00:00Z", fee: 0 },
    after_sales_policies: [{ ref: "policy:return-7d", summary: "签收后 7 天内无理由退货。" }],
    messages: [
      { id: messageId, sender_role: "merchant", created_at: "2026-08-03T00:00:00Z", public_message: "单价 100，十件起。" },
    ],
    current_proposal: {
      unit_price: 100,
      quantity: 10,
      currency: "CNY",
      delivery: { eta_start: "2026-08-04T00:00:00Z", eta_end: "2026-08-04T04:00:00Z", fee: 0 },
      after_sales_policy_refs: ["policy:return-7d"],
    },
    open_issues: [],
    policy_results: [],
  } as unknown as NegotiationSnapshot;
}

interface KernelHarness {
  kernel: AgentKernel;
  claims: Array<{ conversation_id: string; message_id: number }>;
  submissions: Array<{ conversation_id: string; unit_price?: number; quantity?: number }>;
  workDir: string;
}

/** 双会话不同价格/数量：B=90×2，C=50×5。listWindows 控制第 N 次 list 返回。 */
async function openBuyerKernel(listWindows: PendingMessage[][]): Promise<KernelHarness> {
  const claims: KernelHarness["claims"] = [];
  const submissions: KernelHarness["submissions"] = [];
  let listCalls = 0;
  const client = {
    listPendingMessages: async () => listWindows[Math.min(listCalls++, listWindows.length - 1)],
    claimMessage: async (input: { conversation_id: string; message_id: number }) => {
      claims.push({ conversation_id: input.conversation_id, message_id: input.message_id });
      return { claimed: true };
    },
    getNegotiationSnapshot: async (input: { conversation_id: string; message_id: number }) =>
      buyerSnapshot(input.conversation_id, input.message_id),
    submitNegotiationDecision: async (input: {
      decision: { conversation_id: string; proposal?: { unit_price: number; quantity: number } };
    }) => {
      submissions.push({
        conversation_id: input.decision.conversation_id,
        unit_price: input.decision.proposal?.unit_price,
        quantity: input.decision.proposal?.quantity,
      });
      return { result: "accepted", public_reason: "" };
    },
    completeClaim: async () => ({}),
    abandonClaim: async () => ({}),
    failClaim: async () => ({}),
  } as unknown as CommerceClient;

  const { providers, model } = createFakeChatModels();
  workDir = mkdtempSync(path.join(tmpdir(), "a336-kernel-"));
  const kernel = await AgentKernel.open({
    profile: testProfile({
      agent_id: "buyer-agent:a336",
      role: "buyer",
      buyer_policy: {
        max_total_price_private: 100_000,
        acceptable_eta_latest: "9999-12-31T23:59:59Z",
        required_after_sales_terms: [],
      } as never,
    }),
    paths: ensurePathsForDir(workDir),
    providers,
    model,
    vault: new PrivateVault(new EnvKeyProvider(TEST_KEY)),
    commerceClient: client,
    connector: new FakeCommerceConnector(),
    mode: "autopilot",
  });
  // 双任务双会话：B 砍到 90 买 2 件；C 砍到 50 买 5 件
  const store = kernel.buyerTasks;
  expect(store).toBeDefined();
  const taskB = store!.createTask({
    goal_text: "买 2 件，砍到 90",
    intent: { quantity: 2, target_unit_price: 90 },
    idempotency_key: "a336-task-b",
  });
  store!.createConsultationLink({
    task_id: taskB.task_id,
    connector_id: "shopping-cli",
    conversation_id: "conv-B",
    idempotency_key: "a336-link-b",
  });
  const taskC = store!.createTask({
    goal_text: "买 5 件，砍到 50",
    intent: { quantity: 5, target_unit_price: 50 },
    idempotency_key: "a336-task-c",
  });
  store!.createConsultationLink({
    task_id: taskC.task_id,
    connector_id: "shopping-cli",
    conversation_id: "conv-C",
    idempotency_key: "a336-link-c",
  });
  return { kernel, claims, submissions, workDir };
}

describe("A336 P1-4：kernel hints 与实际 prepared 目标强绑定", () => {
  it("K1 两次 list 之间列表改变（B→C）：hints 必须跟随实际目标 C（50×5），不得 B hints→C", async () => {
    const { kernel, claims, submissions } = await openBuyerKernel([
      [pendingOf("conv-B", 2)], // kernel 第一次 list
      [pendingOf("conv-C", 3)], // prepare 第二次 list（B 已消失）
    ]);
    const line = await kernel.negotiationAutoTick();
    expect(line).toBeDefined();
    // 实际处理的是 C，且 wire 决策与 C 自己的 task 绑定（50×5）
    expect(claims).toEqual([{ conversation_id: "conv-C", message_id: 3 }]);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.conversation_id).toBe("conv-C");
    expect(submissions[0]?.unit_price).toBe(50);
    expect(submissions[0]?.quantity).toBe(5);
  });

  it("K2 稳定列表 unknownA→healthyB：A 被围栏跳过，B 用 B 的 hints（90×2）恰一次推进", async () => {
    const { kernel, claims, submissions, workDir: wd } = await openBuyerKernel([
      [pendingOf("conv-A", 1), pendingOf("conv-B", 2)],
    ]);
    // 预置持久围栏：conv-A:1 为 unknown（A331 改善的稳定过滤场景）
    const fenceDir = path.join(wd, "submit-unknown");
    mkdirSync(fenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(fenceDir, "submit-unknown.jsonl"),
      `${JSON.stringify({
        conversation_id: "conv-A",
        message_id: 1,
        idempotency_key: "idem-a1",
        reason: "submit result unknown (test seeded)",
        at: "2026-08-03T00:00:00Z",
      })}\n`,
      { mode: 0o600 },
    );
    const line = await kernel.negotiationAutoTick();
    expect(line).toBeDefined();
    expect(line).toContain("conv-B");
    // healthy B 恰一次：claim 一次、submit 一次，A 零触碰
    expect(claims).toEqual([{ conversation_id: "conv-B", message_id: 2 }]);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.conversation_id).toBe("conv-B");
    expect(submissions[0]?.unit_price).toBe(90);
    expect(submissions[0]?.quantity).toBe(2);
  });
});
