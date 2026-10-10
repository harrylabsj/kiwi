/**
 * A342 P1-4 R1/R2 返修自有强控（A336 后继，A341 源码审查两项必要接缝）。
 *
 * R1（kernel 下一 tick 重驱缝）：kernel 每 tick 新 runner；一次性 rename 前
 * 文件 fsync EIO（committed=false，旧可读空 JSONL 保留）→ 围栏持久化失败
 * 上抛被 kernel catch 转普通 unknown 文案 → failClaim 成功（failed 可重领）
 * → 下一 tick 新 runner 空 Map + 旧文件无条目 → 再次 submit（重复外发效果）。
 * 修复后：kernel 识别 UnknownFencePersistenceError → 同 host 明确停机状态
 * （fail-closed，跨 tick 有效），不再重驱；healthy 会话同形状正常推进。
 *
 * R2（pre-send hints 回调释放缝）：hintsFor 在 claim+snapshot 之后、decision
 * try 之前同步调用；taskStore/Vault 读取抛错时 claim 已取得却不 release
 * （2-13 释放回归破坏）。修复后：回调/建 hints 纳入既有 pre-send 释放保护段，
 * 异常正常 release 恰一次、零 submit、零 unknown fence（效果未开始）；故障
 * 恢复后 healthy 以真实目标 hints 推进。
 *
 * 本文件在修复前冻结源（A336 freeze）上先跑红，证明缺陷可检出。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 一次性 rename 前文件 fsync EIO 注入（A341 补核的精确故障形态：
// committed=false，旧可读文件保留；非长期 ENOTDIR、非目录 fsync committed=true）。
const h = vi.hoisted(() => ({ failFsyncOnce: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (h.failFsyncOnce) {
        h.failFsyncOnce = false;
        const err = new Error("EIO: i/o error") as Error & { code?: string };
        err.code = "EIO";
        throw err;
      }
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

let workDir: string | undefined;
afterEach(() => {
  if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
  delete process.env.KIWI_DATA_KEY;
  h.failFsyncOnce = false;
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

interface Harness {
  kernel: AgentKernel;
  claims: Array<{ conversation_id: string; message_id: number }>;
  abandons: number[];
  failClaims: number[];
  submissions: Array<{ conversation_id: string; unit_price?: number; quantity?: number }>;
  effects: Map<string, number>;
  workDir: string;
}

/**
 * 真实 claim 生命周期 mock：outstanding claim 未 complete/fail/abandon 前
 * 重新 claim 返回 claimed:false（2-13 卡 processing 形态）；failed 的消息
 * 留在 pending（A341 实证「failed 可重领」）。
 */
async function openBuyerKernel(initial: PendingMessage[]): Promise<Harness> {
  const claims: Harness["claims"] = [];
  const abandons: number[] = [];
  const failClaims: number[] = [];
  const submissions: Harness["submissions"] = [];
  const effects = new Map<string, number>();
  const pending = [...initial];
  const outstanding = new Set<string>();
  const client = {
    listPendingMessages: async () => [...pending],
    claimMessage: async (input: { conversation_id: string; message_id: number }) => {
      const key = `${input.conversation_id}:${input.message_id}`;
      if (outstanding.has(key)) return { claimed: false };
      outstanding.add(key);
      claims.push({ conversation_id: input.conversation_id, message_id: input.message_id });
      return { claimed: true };
    },
    getNegotiationSnapshot: async (input: { conversation_id: string; message_id: number }) =>
      buyerSnapshot(input.conversation_id, input.message_id),
    submitNegotiationDecision: async (input: {
      decision: { conversation_id: string; proposal?: { unit_price: number; quantity: number } };
    }) => {
      const conv = input.decision.conversation_id;
      effects.set(conv, (effects.get(conv) ?? 0) + 1); // 服务端效果计数（真实接口）
      submissions.push({
        conversation_id: conv,
        unit_price: input.decision.proposal?.unit_price,
        quantity: input.decision.proposal?.quantity,
      });
      if (conv === "conv-U") throw new Error("gateway unreachable after write"); // lost-response
      return { result: "accepted", public_reason: "" };
    },
    completeClaim: async (input: { message_id: number; conversation_id?: string }) => {
      const idx = pending.findIndex((m) => m.message_id === input.message_id);
      if (idx >= 0) {
        outstanding.delete(`${pending[idx]!.conversation_id}:${pending[idx]!.message_id}`);
        pending.splice(idx, 1);
      }
      return {};
    },
    abandonClaim: async (input: { message_id: number }) => {
      abandons.push(input.message_id);
      const idx = pending.findIndex((m) => m.message_id === input.message_id);
      if (idx >= 0) outstanding.delete(`${pending[idx]!.conversation_id}:${pending[idx]!.message_id}`);
      return {};
    },
    failClaim: async (input: { message_id: number }) => {
      failClaims.push(input.message_id);
      const idx = pending.findIndex((m) => m.message_id === input.message_id);
      if (idx >= 0) outstanding.delete(`${pending[idx]!.conversation_id}:${pending[idx]!.message_id}`);
      return {};
    },
  } as unknown as CommerceClient;

  const { providers, model } = createFakeChatModels();
  workDir = mkdtempSync(path.join(tmpdir(), "a342-kernel-"));
  const kernel = await AgentKernel.open({
    profile: testProfile({
      agent_id: "buyer-agent:a342",
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
  return { kernel, claims, abandons, failClaims, submissions, effects, workDir };
}

function seedTask(kernel: AgentKernel, conversationId: string, quantity: number, target: number, key: string): void {
  const store = kernel.buyerTasks;
  expect(store).toBeDefined();
  const task = store!.createTask({
    goal_text: `买 ${quantity} 件，砍到 ${target}`,
    intent: { quantity, target_unit_price: target },
    idempotency_key: `a342-task-${key}`,
  });
  store!.createConsultationLink({
    task_id: task.task_id,
    connector_id: "shopping-cli",
    conversation_id: conversationId,
    idempotency_key: `a342-link-${key}`,
  });
}

describe("A342 R1：kernel 一次性围栏写失败 → 下一 tick 不得重驱（fail-closed 停机）", () => {
  it("一次性文件 fsync EIO + 旧可读空文件：tick1 停机，tick2/tick3 效果不增，healthy 同形状推进", async () => {
    const hr = await openBuyerKernel([pendingOf("conv-U", 1), pendingOf("conv-H", 2)]);
    seedTask(hr.kernel, "conv-H", 2, 90, "h");
    // 精确故障形态：先存在可读空 JSONL（初建/历史可读），一次 rename 前 fsync EIO
    const fenceDir = path.join(hr.workDir, "submit-unknown");
    mkdirSync(fenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(fenceDir, "submit-unknown.jsonl"), "", { mode: 0o600 });
    h.failFsyncOnce = true;

    const line1 = await hr.kernel.negotiationAutoTick();
    // tick1：conv-U lost-response → 服务端效果 1 次；围栏写失败 → failClaim 成功
    expect(hr.effects.get("conv-U")).toBe(1);
    expect(hr.failClaims).toEqual([1]);
    // 修复后：fail-closed 停机文案（可审），不是普通 unknown 文案
    expect(String(line1)).toMatch(/围栏持久化失败|fail-closed/);

    const line2 = await hr.kernel.negotiationAutoTick();
    // tick2（存储已恢复可读）：conv-U 不得重新 claim / 再次 submit；
    // healthy conv-H 同形状正常推进（90×2 绑定 conv-H）
    expect(hr.effects.get("conv-U")).toBe(1);
    expect(hr.claims.filter((c) => c.conversation_id === "conv-U")).toHaveLength(1);
    expect(hr.submissions.filter((s) => s.conversation_id === "conv-H")).toEqual([
      { conversation_id: "conv-H", unit_price: 90, quantity: 2 },
    ]);
    expect(String(line2)).toContain("conv-H");

    const line3 = await hr.kernel.negotiationAutoTick();
    // tick3：仅剩已停机消息 → 无事可做，效果/claim 均不增
    expect(line3).toBeUndefined();
    expect(hr.effects.get("conv-U")).toBe(1);
    expect(hr.claims.filter((c) => c.conversation_id === "conv-U")).toHaveLength(1);
  });
});

describe("A342 R1（runner 层）：持久化失败为可识别类型化错误，旧文件保持可读", () => {
  it("一次性 EIO → UnknownFencePersistenceError（name），failClaim 仍打标记，旧空文件保留", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a342-runner-"));
    const fenceDir = path.join(dir, "fence");
    mkdirSync(fenceDir, { recursive: true, mode: 0o700 });
    const fenceFile = path.join(fenceDir, "submit-unknown.jsonl");
    writeFileSync(fenceFile, "", { mode: 0o600 });
    let failClaims = 0;
    const client = {
      async submitNegotiationDecision() {
        throw new Error("gateway unreachable after write");
      },
      async failClaim() {
        failClaims += 1;
      },
      async completeClaim() {},
    } as unknown as CommerceClient;
    const runner = new DeterministicNegotiationRunner(
      {
        agent_id: "buyer-agent:a342",
        role: "buyer",
        buyer_policy: {
          max_total_price_private: 100_000,
          acceptable_eta_latest: "9999-12-31T23:59:59Z",
          required_after_sales_terms: [],
        },
      } as never,
      client,
      { unknownFenceDir: fenceDir },
    );
    h.failFsyncOnce = true;
    const err = await runner
      .submit({
        binding: { conversation_id: "conv-U", message_id: 1, idempotency_key: "idem-1" },
        decision: { action: "accept_nonbinding" } as never,
      })
      .catch((e: unknown) => e);
    // 可识别类型化错误（kernel 据此 fail-closed，不转普通 unknown）
    expect((err as Error).name).toBe("UnknownFencePersistenceError");
    expect(String(err)).toContain("unknown fence persistence failed");
    expect(failClaims).toBe(1);
    // committed=false：旧可读文件保留（内容仍为空、不含新条目），新实例读取不抛
    const recovered = new DeterministicNegotiationRunner(
      { agent_id: "buyer-agent:a342", role: "buyer" } as never,
      client,
      { unknownFenceDir: fenceDir },
    );
    expect(recovered.getUnknownFenceKeys().size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("A342 R2：hintsFor 异常纳入 pre-send 释放保护（效果未开始 → release，零 fence）", () => {
  it("kernel：taskStore 读取故障 tick → release 恰一次零 submit；恢复后 healthy 真实 hints 推进", async () => {
    const hr = await openBuyerKernel([pendingOf("conv-B", 2)]);
    seedTask(hr.kernel, "conv-B", 2, 90, "b");
    // 白盒一次性故障：hintsFor 回调内的 taskStore/Vault 读取抛错
    const store = hr.kernel.buyerTasks!;
    const orig = store.linkByConversation.bind(store);
    let armed = true;
    (store as { linkByConversation: typeof orig }).linkByConversation = (cid: string) => {
      if (armed) {
        armed = false;
        throw new Error("vault read fault");
      }
      return orig(cid);
    };

    const line1 = await hr.kernel.negotiationAutoTick();
    expect(line1).toBeUndefined(); // prepare 失败（kernel catch），非 unknown 文案
    // 修复后：claim 已 release 恰一次（abandon），零 submit / 零服务端效果
    expect(hr.abandons).toEqual([2]);
    expect(hr.submissions).toHaveLength(0);
    expect(hr.effects.size).toBe(0);
    expect(hr.failClaims).toHaveLength(0);

    const line2 = await hr.kernel.negotiationAutoTick();
    // 故障恢复：claim 未卡 processing（已 release）→ healthy 真实目标 hints 推进
    expect(String(line2)).toContain("conv-B");
    expect(hr.submissions).toEqual([{ conversation_id: "conv-B", unit_price: 90, quantity: 2 }]);
  });

  it("runner：hintsFor 抛错 → prepare 拒原错误、abandon 恰一次、零 submit、零围栏文件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a342-r2-runner-"));
    const fenceDir = path.join(dir, "fence");
    let abandons = 0;
    let submits = 0;
    const client = {
      async listPendingMessages() {
        return [{ conversation_id: "conv-B", message_id: 2 }];
      },
      async claimMessage() {
        return { claimed: true };
      },
      async getNegotiationSnapshot() {
        return buyerSnapshot("conv-B", 2);
      },
      async submitNegotiationDecision() {
        submits += 1;
        return { result: "accepted", public_reason: "" };
      },
      async abandonClaim() {
        abandons += 1;
      },
      async failClaim() {},
      async completeClaim() {},
    } as unknown as CommerceClient;
    const runner = new DeterministicNegotiationRunner(
      {
        agent_id: "buyer-agent:a342",
        role: "buyer",
        buyer_policy: {
          max_total_price_private: 100_000,
          acceptable_eta_latest: "9999-12-31T23:59:59Z",
          required_after_sales_terms: [],
        },
      } as never,
      client,
      { unknownFenceDir: fenceDir },
    );
    const err = await runner
      .prepare({
        hintsFor: () => {
          throw new Error("vault read fault");
        },
      })
      .catch((e: unknown) => e);
    // 原错误保留（不吞、不换成 unknown）
    expect(String(err)).toContain("vault read fault");
    // 已 claim → 必须 release 恰一次（2-13 回归）；零 submit、零 unknown 围栏
    expect(abandons).toBe(1);
    expect(submits).toBe(0);
    expect(existsSync(path.join(fenceDir, "submit-unknown.jsonl"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
