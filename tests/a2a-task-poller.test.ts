/**
 * A2A Task 轮询器测试（基线 §18.3 / §23 第 4 步）。
 *
 * 覆盖：
 *  - 终态返回（completed / canceled / failed）与 input-required 稳定点；
 *  - submitted → working → completed 的多轮推进；
 *  - 瞬态错误（network / timeout / http_status / jsonrpc_error）退避重试；
 *  - 预算耗尽（maxAttempts）→ budget_exhausted；
 *  - 墙钟截止 → timeout；
 *  - 未知状态 / 非法转换 / schema 错误 → rejected（fail-closed，不猜测）；
 *  - 状态变化落 Ledger（system 事件，含 remote taskId/contextId 引用）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { A2AClientError } from "../src/a2a/client/index.js";
import { A2ATaskPoller } from "../src/a2a/task/index.js";
import type { A2ATask } from "../src/a2a/client/index.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

const NOW = "2026-08-06T10:00:00.000Z";

function task(id: string, state: A2ATask["status"]["state"]): A2ATask {
  return { id, status: { state } };
}

interface ScriptEntry {
  value: A2ATask | A2AClientError;
}

/** 确定性脚本式 fake client：顺序返回脚本项，耗尽后一直返回最后一个成功项。 */
function scriptedClient(script: ScriptEntry[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    calls,
    async getTask(_taskId: string): Promise<A2ATask> {
      calls.push(i);
      const entry = script[Math.min(i, script.length - 1)];
      i += 1;
      if (entry === undefined) return task("t", "working");
      if (entry.value instanceof A2AClientError) throw entry.value;
      return entry.value;
    },
  };
}

describe("A2ATaskPoller: 稳定观察点", () => {
  it("returns completed when the task completes", async () => {
    const client = scriptedClient([{ value: task("t1", "working") }, { value: task("t1", "completed") }]);
    const poller = new A2ATaskPoller({
      client,
      taskId: "t1",
      now: () => 1000,
      sleep: async () => {},
    });
    const result = await poller.poll();
    expect(result.status).toBe("completed");
    expect(result.state).toBe("completed");
    expect(result.task?.id).toBe("t1");
  });

  it("returns canceled / failed for the other terminal states", async () => {
    const canceled = await new A2ATaskPoller({
      client: scriptedClient([{ value: task("t", "canceled") }]),
      taskId: "t",
      now: () => 1000,
      sleep: async () => {},
    }).poll();
    expect(canceled.status).toBe("canceled");

    const failed = await new A2ATaskPoller({
      client: scriptedClient([{ value: task("t", "failed") }]),
      taskId: "t",
      now: () => 1000,
      sleep: async () => {},
    }).poll();
    expect(failed.status).toBe("failed");
  });

  it("returns input-required as a stable waiting point", async () => {
    const poller = new A2ATaskPoller({
      client: scriptedClient([{ value: task("t", "input-required") }]),
      taskId: "t",
      now: () => 1000,
      sleep: async () => {},
    });
    const result = await poller.poll();
    expect(result.status).toBe("input-required");
    expect(result.state).toBe("input-required");
  });
});

describe("A2ATaskPoller: 预算 / 截止 / 退避", () => {
  it("exhausts the attempt budget on persistent transient errors", async () => {
    const client = scriptedClient([
      { value: new A2AClientError("network", "ECONNREFUSED") },
      { value: new A2AClientError("network", "ECONNREFUSED") },
      { value: new A2AClientError("network", "ECONNREFUSED") },
      { value: new A2AClientError("network", "ECONNREFUSED") },
    ]);
    const poller = new A2ATaskPoller({
      client,
      taskId: "t",
      maxAttempts: 4,
      baseBackoffMs: 10,
      maxBackoffMs: 40,
      now: () => 1000,
      sleep: async () => {},
    });
    const result = await poller.poll();
    expect(result.status).toBe("budget_exhausted");
    expect(result.attempts).toBe(4);
    expect(result.lastError).toBeInstanceOf(A2AClientError);
  });

  it("backs off with exponential delays between transient retries", async () => {
    const sleeps: number[] = [];
    const client = scriptedClient([
      { value: new A2AClientError("timeout", "timed out") },
      { value: new A2AClientError("timeout", "timed out") },
      { value: task("t", "working") },
      { value: task("t", "completed") },
    ]);
    const poller = new A2ATaskPoller({
      client,
      taskId: "t",
      maxAttempts: 10,
      baseBackoffMs: 100,
      maxBackoffMs: 1000,
      backoffMultiplier: 2,
      now: () => 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await poller.poll();
    expect(result.status).toBe("completed");
    // attempt 1 失败 → base(100)；attempt 2 失败 → 100*2=200；成功后 attempt 3 观察
    // working → 该次尝试后的退避 = 100*2^2=400。
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("hits the wall-clock deadline before a terminal state", async () => {
    let nowMs = 1000;
    const client = scriptedClient([
      { value: task("t", "working") },
      { value: task("t", "working") },
      { value: task("t", "working") },
    ]);
    const poller = new A2ATaskPoller({
      client,
      taskId: "t",
      maxAttempts: 10,
      deadlineMs: 250,
      baseBackoffMs: 100,
      maxBackoffMs: 100,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms; // 退避消耗墙钟
      },
    });
    const result = await poller.poll();
    expect(result.status).toBe("timeout");
    // 三次 poll（working,working,working）后退避累计 300ms > 250ms 截止。
    expect(result.attempts).toBe(3);
  });

  it("rejects immediately on a schema-invalid response (fail-closed, no retry)", async () => {
    const client = scriptedClient([
      { value: new A2AClientError("schema_invalid", "response schema invalid") },
    ]);
    const poller = new A2ATaskPoller({
      client,
      taskId: "t",
      maxAttempts: 10,
      baseBackoffMs: 1,
      now: () => 1000,
      sleep: async () => {},
    });
    const result = await poller.poll();
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("schema_invalid");
    expect(result.attempts).toBe(1);
  });

  it("rejects on an illegal transition (working → submitted is a protocol violation)", async () => {
    const client = scriptedClient([{ value: task("t", "working") }, { value: task("t", "submitted") }]);
    const poller = new A2ATaskPoller({
      client,
      taskId: "t",
      now: () => 1000,
      sleep: async () => {},
    });
    const result = await poller.poll();
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("illegal_transition");
  });
});

describe("A2ATaskPoller: Ledger 落账", () => {
  it("records each state change to the Ledger with task/context refs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-task-poller-"));
    try {
      const ledger = new LedgerStore({ dir, now: () => NOW });
      const client = scriptedClient([
        { value: { id: "task_9", status: { state: "working" }, contextId: "ctx_remote" } },
        {
          value: {
            id: "task_9",
            status: { state: "completed", message: { role: "agent", parts: [{ kind: "text", text: "done" }], messageId: "msg_remote_last" } },
          },
        },
      ]);
      const poller = new A2ATaskPoller({
        client,
        taskId: "task_9",
        contextId: "ctx_local",
        now: () => 1000,
        sleep: async () => {},
        ledger: { ledger, negotiation_id: "neg_1" },
      });
      const result = await poller.poll();
      expect(result.status).toBe("completed");

      const events = ledger.events("neg_1");
      expect(events.length).toBe(2);
      const [first, second] = events;
      expect(first?.event_kind).toBe("system");
      expect(first?.remote_task_id).toBe("task_9");
      expect(first?.remote_context_id).toBe("ctx_local");
      expect(first?.outcome.kind === "ok" ? first.outcome.result : null).toMatchObject({
        task_id: "task_9",
        task_state: "working",
      });
      expect(second?.event_kind).toBe("system");
      expect(second?.message_id).toBe("msg_remote_last");
      expect(second?.outcome.kind === "ok" ? second.outcome.result : null).toMatchObject({
        task_state: "completed",
      });
      expect(ledger.verifyChain("neg_1").valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not double-record a repeated same-state observation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-task-poller-"));
    try {
      const ledger = new LedgerStore({ dir, now: () => NOW });
      const client = scriptedClient([
        { value: task("t", "working") },
        { value: task("t", "working") },
        { value: task("t", "completed") },
      ]);
      const poller = new A2ATaskPoller({
        client,
        taskId: "t",
        now: () => 1000,
        sleep: async () => {},
        ledger: { ledger, negotiation_id: "neg_2" },
      });
      await poller.poll();
      expect(ledger.events("neg_2").length).toBe(2); // working, completed —— 不重复记 working
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
