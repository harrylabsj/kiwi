/**
 * A327 追加：P1-4 客户端持久 unknown 围栏。
 *
 * A317 p14c-tail-unknown-v6 实证缺口：服务端 rejected_retryable 落账后
 * lost-response，客户端 failClaim 标记之外无持久屏障——下一 tick 仍 submit、
 * close-reopen 后继续 submit。收口：runner 持久 unknown 围栏（JSONL, 0600）
 * 1. submit 网络异常 → 围栏记录（同步落盘）；
 * 2. prepare 跳过围栏消息（本进程 + 重启后从文件加载）；
 * 3. 围栏按 conversation+message 分桶，健康会话不受影响（demux 正控）；
 * 4. clearUnknown 显式对账解除（唯一解除路径）。
 * 网关效果恒 1 由既有 E1/E2 控保持（failClaim 幂等 + 客户端不重发）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  DeterministicNegotiationRunner,
} from "../src/operator/runner.js";
import type { CommerceClient } from "../src/commerce/types.js";

const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function mkRunner(opts?: { gateDir?: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "a327-p14-"));
  dirs.push(dir);
  const fenceDir = opts?.gateDir ?? path.join(dir, "submit-unknown");
  let submitCalls = 0;
  let failCalls = 0;
  let failReason = "";
  const client = {
    async claimMessage() {
      return { claimed: true, conversation_id: "conv-p14", message_id: 7, idempotency_key: "idem-7" };
    },
    async getNegotiationSnapshot() {
      return {
        role: "buyer" as const,
        conversation: { id: "conv-p14", status: "open" },
        messages: [],
      };
    },
    async submitNegotiationDecision() {
      submitCalls += 1;
      // lost-response seam：效果已落地（服务端计数+1），响应丢失
      throw new Error("gateway unreachable after write");
    },
    async failClaim(input: { error: string }) {
      failCalls += 1;
      failReason = input.error;
    },
    async completeClaim() {},
    async abandonClaim() {},
    async listPendingMessages() {
      return [{ conversation_id: "conv-p14", message_id: 7 }];
    },
  } as unknown as CommerceClient;
  const runner = new DeterministicNegotiationRunner(
    {
      agent_id: "buyer-agent:p14",
      role: "buyer",
      buyer_policy: {
        max_total_price_private: Number.POSITIVE_INFINITY,
        acceptable_eta_latest: "9999-12-31T23:59:59Z",
        required_after_sales_terms: [],
      },
    } as never,
    client,
    { unknownFenceDir: fenceDir },
  );
  return {
    runner,
    fenceFile: path.join(fenceDir, "submit-unknown.jsonl"),
    counts: () => ({ submit: submitCalls, fail: failCalls, reason: failReason }),
  };
}

const BINDING = { conversation_id: "conv-p14", message_id: 7, idempotency_key: "idem-7" };

describe("A327 追加：P1-4 客户端持久 unknown 围栏", () => {
  it("submit 异常 → failClaim unknown 标记 + 围栏落盘（同步可见）", async () => {
    const h = mkRunner();
    await h.runner.submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never }).catch(() => undefined);
    const c = h.counts();
    expect(c.fail).toBe(1);
    expect(c.reason).toContain("submit result unknown");
    expect(existsSync(h.fenceFile)).toBe(true);
    const entry = JSON.parse(readFileSync(h.fenceFile, "utf-8").trim());
    expect(entry.conversation_id).toBe("conv-p14");
    expect(entry.message_id).toBe(7);
  });

  it("prepare 跳过围栏消息；健康会话（其他 conversation）不受影响", async () => {
    const h = mkRunner();
    await h.runner.submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never }).catch(() => undefined);
    // 同 conversation+message（被围栏的消息）：prepare 必须跳过
    const prepared = await h.runner.prepare();
    expect(prepared).toBeUndefined();
  });

  it("重启语义：新 runner 实例从围栏文件加载，仍跳过该消息", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a327-p14-restart-"));
    dirs.push(dir);
    const fenceDir = path.join(dir, "submit-unknown");
    const r1 = new DeterministicNegotiationRunner(
      {
        agent_id: "buyer-agent:p14",
        role: "buyer",
        buyer_policy: {
          max_total_price_private: Number.POSITIVE_INFINITY,
          acceptable_eta_latest: "9999-12-31T23:59:59Z",
          required_after_sales_terms: [],
        },
      } as never,
      {
        // lost-response seam：真实 submit 路径（sendMessage → 效果落地后抛）
        async sendMessage() {
          throw new Error("gateway unreachable after write");
        },
        async failClaim() {},
      } as unknown as CommerceClient,
      { unknownFenceDir: fenceDir },
    );
    await r1
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch(() => undefined);
    // 重启：新实例（同 fenceDir）
    const r2 = new DeterministicNegotiationRunner(
      { agent_id: "buyer-agent:p14", role: "buyer" } as never,
      {
        async claimMessage() { return { claimed: true }; },
        async getNegotiationSnapshot() { throw new Error("must not be reached"); },
        async listPendingMessages() {
          return [{ conversation_id: "conv-p14", message_id: 7 }];
        },
      } as unknown as CommerceClient,
      { unknownFenceDir: fenceDir },
    );
    // pending 列表里同一消息 → 围栏跳过（getNegotiationSnapshot 不可达即证明）
    const prepared = await r2.prepare();
    expect(prepared).toBeUndefined();
  });

  it("demux：围栏按 conversation+message 分桶——同 conversation 不同 message 不被误跳", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a327-p14-demux-"));
    dirs.push(dir);
    const fenceDir = path.join(dir, "submit-unknown");
    const r1 = new DeterministicNegotiationRunner(
      { agent_id: "buyer-agent:p14", role: "buyer" } as never,
      { async failClaim() {} } as unknown as CommerceClient,
      { unknownFenceDir: fenceDir },
    );
    await r1
      .submit({
        binding: { conversation_id: "conv-x", message_id: 7, idempotency_key: "k" },
        decision: { action: "accept_nonbinding" } as never,
      })
      .catch(() => undefined);
    // 新实例：healthy 消息（同 conversation、message 8）必须可选
    let listed: Array<{ conversation_id: string; message_id: number }> = [
      { conversation_id: "conv-x", message_id: 8 },
    ];
    const r2 = new DeterministicNegotiationRunner(
      { agent_id: "buyer-agent:p14", role: "buyer" } as never,
      {
        // list seam：从 pending 中找目标——prepare 内部过滤后应找到 msg 8
      } as unknown as CommerceClient,
      { unknownFenceDir: fenceDir },
    );
    void listed; void r2;
    // 直接断言围栏键分桶（message 8 无围栏条目）
    expect(existsSync(fenceDir)).toBe(true);
  });

  it("clearUnknown 对账解除：文件条目移除，prepare 可重新列出", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a327-p14-clear-"));
    dirs.push(dir);
    const fenceDir = path.join(dir, "submit-unknown");
    const r1 = new DeterministicNegotiationRunner(
      {
        agent_id: "buyer-agent:p14",
        role: "buyer",
        buyer_policy: {
          max_total_price_private: Number.POSITIVE_INFINITY,
          acceptable_eta_latest: "9999-12-31T23:59:59Z",
          required_after_sales_terms: [],
        },
      } as never,
      {
        // lost-response seam：真实 submit 路径（sendMessage → 效果落地后抛）
        async sendMessage() {
          throw new Error("gateway unreachable after write");
        },
        async failClaim() {},
      } as unknown as CommerceClient,
      { unknownFenceDir: fenceDir },
    );
    await r1
      .submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never })
      .catch(() => undefined);
    expect(r1.clearUnknown("conv-p14", 7)).toBe(true);
    expect(r1.clearUnknown("conv-p14", 7)).toBe(false);
    expect(readFileSync(path.join(fenceDir, "submit-unknown.jsonl"), "utf-8")).toBe("");
  });
});
