/**
 * 跨进程 context 恢复测试（基线 §23 八步 / 子规范 §27）。
 *
 * WP4 收敛：恢复走唯一 CounterpartyChannel 接口（ChannelHandle.openChannel），
 * 不再有第二套 RemoteTaskGateway 契约。
 *
 * 覆盖 §23 三类分支：
 *  1. remote ahead：远端有新消息 → fetch → validate → append Ledger；
 *  2. local pending：本地已发消息未被确认 → 同 message_id + 同 digest 安全重放；
 *  3. 不可调和：pending + 远端终态 / 无 profile / 无法安全重放 → reconciliation_required。
 *
 * 以及：
 *  - 远端内容校验失败（坏 envelope）→ fail-closed；
 *  - 本地终态 phase vs 远端活跃 task → reconciliation_required；
 *  - 重启后 Ledger 链仍 valid；
 *  - 正常 counter 流（远端已回应）→ 重放幂等 + 补记远端消息，不转人工。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore, ledgerFileName } from "../src/negotiation/ledger/index.js";
import { ContextMapStore } from "../src/negotiation/context-map/index.js";
import {
  NegotiationRecovery,
  recordOutboundMessage,
  type RecoveryResult,
} from "../src/negotiation/recovery/index.js";
import type {
  ChannelHandle,
  ChannelSendInput,
  ChannelSendResult,
  CounterpartyProfile,
  RemoteRef,
  RemoteState,
} from "../src/counterparty/index.js";
import type { AgentCard } from "../src/discovery/index.js";
import type { A2ATask } from "../src/a2a/client/index.js";
import { CAPABILITY, NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

const NOW = "2026-08-06T10:00:00.000Z";
const IDENTITY = {
  sender_identity: "kiwi-buyer",
  counterparty_identity: "merchant-remote",
  actor: "buyer" as const,
};
const CAPABILITY_SNAPSHOT = { capability: CAPABILITY, protocol_version: "1.0" };

const CARD: AgentCard = {
  name: "merchant-remote",
  description: "test merchant agent",
  provider: { organization: "merchant-remote" },
  version: "1.0",
  supportedInterfaces: [
    { url: "http://127.0.0.1:1/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
};

const PROFILE: CounterpartyProfile = {
  identity: "merchant-remote",
  source: "card:http://127.0.0.1:1/.well-known/agent-card.json",
  agent_card: CARD,
  intersection: {
    compatible: true,
    candidates: CARD.supportedInterfaces,
    selected: CARD.supportedInterfaces[0],
    incompatible: [],
    unknownShared: [],
    oneSided: [],
  },
  channel_candidates: [{ kind: "a2a-direct", url: "http://127.0.0.1:1/a2a" }],
};

interface Setup {
  dir: string;
  ledger: LedgerStore;
  contextMap: ContextMapStore;
}

function setup(): Setup {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-recovery-"));
  return {
    dir,
    ledger: new LedgerStore({ dir, now: () => NOW }),
    contextMap: new ContextMapStore({ dir, now: () => NOW }),
  };
}

function teardown(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 记录出站消息证据（恢复的 local pending 来源）。 */
function recordSent(ledger: LedgerStore, opts: { message_id?: string } = {}): void {
  const fields = validEnvelopeFields();
  const envelope = finalizeEnvelope({ ...fields, message_id: opts.message_id ?? fields.message_id });
  recordOutboundMessage({
    ledger,
    negotiation_id: NEGOTIATION_ID,
    message_id: envelope.message_id,
    wire_digest: envelope.digest,
    wire_payload: envelope as unknown as Record<string, unknown>,
    remote_context_id: "ctx_remote",
    remote_task_id: "task_active",
    identity: IDENTITY,
    capability: CAPABILITY_SNAPSHOT,
    occurred_at: NOW,
  });
}

/** 最小 RemoteState（从 A2ATask 构造）。 */
function toState(task: A2ATask): RemoteState {
  return {
    channel: "a2a-direct",
    state: task.status.state,
    stable: true,
    task,
    message_ids: task.status.message?.messageId === undefined ? [] : [task.status.message.messageId],
    observed_at: NOW,
  };
}

/** 测试用 ChannelHandle：实现唯一接口的 fake direct handle。 */
class FakeHandle implements ChannelHandle {
  readonly kind = "a2a-direct" as const;
  readonly identity = "merchant-remote";
  sent: { envelope: NegotiationEnvelope; ref?: RemoteRef }[] = [];
  constructor(
    private readonly getStateResult: A2ATask | (() => A2ATask),
    private readonly sendResult: A2ATask = { id: "task_reply", status: { state: "working" } },
    private readonly getStateError?: Error,
  ) {}
  async getState(ref: RemoteRef): Promise<RemoteState> {
    if (this.getStateError !== undefined) throw this.getStateError;
    const task = typeof this.getStateResult === "function" ? this.getStateResult() : this.getStateResult;
    void ref;
    return toState(task);
  }
  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    this.sent.push({ envelope: input.envelope, ref: input.ref });
    return { channel: "a2a-direct", ref: { negotiation_id: NEGOTIATION_ID }, task: this.sendResult };
  }
  async close(): Promise<void> {}
}

function recovery(
  s: Setup,
  handle: FakeHandle,
  overrides: {
    resolveCounterparty?: () => Promise<CounterpartyProfile | null>;
    expireStale?: (negotiationId: string, stale: string[]) => void;
  } = {},
): { rec: NegotiationRecovery; result: Promise<RecoveryResult> } {
  const rec = new NegotiationRecovery({
    ledger: s.ledger,
    contextMap: s.contextMap,
    resolveCounterparty: overrides.resolveCounterparty ?? (async () => PROFILE),
    openChannel: async () => handle,
    now: () => NOW,
    ...(overrides.expireStale !== undefined ? { expireStale: overrides.expireStale } : {}),
  });
  return { rec, result: rec.recover(NEGOTIATION_ID) };
}

describe("Recovery: remote ahead（fetch → validate → append Ledger）", () => {
  it("appends reconciliation events for remote messages not seen locally", async () => {
    const s = setup();
    try {
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const remoteMid = "msg_remote_new";
      const handle = new FakeHandle({
        id: "task_active",
        status: {
          state: "working",
          message: { role: "agent", parts: [{ kind: "text", text: "we got your RFQ" }], messageId: remoteMid },
        },
      });
      const { result } = recovery(s, handle);
      const r = await result;

      expect(r.status).toBe("resumed");
      expect(r.remote_ahead_appended).toBe(1);
      expect(r.replayed_message_ids).toEqual([]);
      expect(s.ledger.findByMessageId(remoteMid)).not.toBeNull();
      const reconciliationEvents = s.ledger.events(NEGOTIATION_ID).filter((e) => e.event_kind === "reconciliation");
      expect(reconciliationEvents).toHaveLength(1);
      expect(reconciliationEvents[0]?.message_id).toBe(remoteMid);
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });

  it("fails closed when remote content carries an invalid KNP envelope", async () => {
    const s = setup();
    try {
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const handle = new FakeHandle({
        id: "task_active",
        status: {
          state: "working",
          message: {
            role: "agent",
            parts: [{ kind: "data", data: { knp_envelope: { bogus: true } } }],
            messageId: "msg_bad_env",
          },
        },
      });
      const { result } = recovery(s, handle);
      const r = await result;
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("validation");
      // 失败证据也落账，且链保持 valid。
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });
});

describe("Recovery: local pending（同 id + 同 digest 安全重放）", () => {
  it("replays a pending outbound message with the same message_id + digest", async () => {
    const s = setup();
    try {
      recordSent(s.ledger);
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      // 远端仍 working，且尚未确认我们的消息（无 status.message）。
      const handle = new FakeHandle({ id: "task_active", status: { state: "working" } });
      const { result } = recovery(s, handle);
      const r = await result;

      expect(r.status).toBe("resumed");
      expect(r.replayed_message_ids).toHaveLength(1);
      expect(handle.sent).toHaveLength(1);
      const sent = handle.sent[0];
      expect(sent?.envelope.message_id).toBe(validEnvelopeFields().message_id);
      expect(sent?.ref?.context_id).toBe("ctx_remote");
      expect(sent?.ref?.task_id).toBe("task_active");
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });

  it("handles the normal counter flow: replay is idempotent and the counter is recorded", async () => {
    const s = setup();
    try {
      recordSent(s.ledger);
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const counterMid = "msg_remote_counter";
      const handle = new FakeHandle({
        id: "task_active",
        status: {
          state: "input-required",
          message: { role: "agent", parts: [{ kind: "text", text: "how about 830?" }], messageId: counterMid },
        },
      });
      const { result } = recovery(s, handle);
      const r = await result;

      // 不转人工：重放幂等（远端若已处理则按 id 去重），远端 counter 补记。
      expect(r.status).toBe("resumed");
      expect(r.replayed_message_ids).toHaveLength(1);
      expect(s.ledger.findByMessageId(counterMid)).not.toBeNull();
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });
});

describe("Recovery: 不可调和 → reconciliation_required", () => {
  it("requires human when a pending message meets a terminal remote task", async () => {
    const s = setup();
    try {
      recordSent(s.ledger);
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const handle = new FakeHandle({ id: "task_active", status: { state: "failed" } });
      const { result } = recovery(s, handle);
      const r = await result;
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("terminal");
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });

  it("requires human when there are pending messages but no counterparty profile", async () => {
    const s = setup();
    try {
      recordSent(s.ledger);
      const { result } = recovery(s, new FakeHandle({ id: "t", status: { state: "working" } }), {
        resolveCounterparty: async () => null,
      });
      const r = await result;
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("no counterparty profile");
    } finally {
      teardown(s.dir);
    }
  });

  it("requires human when the remote task is unreachable", async () => {
    const s = setup();
    try {
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const handle = new FakeHandle(
        { id: "task_active", status: { state: "working" } },
        { id: "task_reply", status: { state: "working" } },
        new Error("ECONNREFUSED"),
      );
      const rec = new NegotiationRecovery({
        ledger: s.ledger,
        contextMap: s.contextMap,
        resolveCounterparty: async () => PROFILE,
        openChannel: async () => handle,
        now: () => NOW,
      });
      const r = await rec.recover(NEGOTIATION_ID);
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("unreachable");
    } finally {
      teardown(s.dir);
    }
  });

  it("requires human when the local phase is terminal but the remote task is still active", async () => {
    const s = setup();
    try {
      s.ledger.append({
        event_kind: "state_transition",
        negotiation_id: NEGOTIATION_ID,
        state_transition: { to_phase: "CANCELLED" },
        identity: IDENTITY,
        capability: CAPABILITY_SNAPSHOT,
        outcome: { kind: "ok" },
        occurred_at: NOW,
      });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const handle = new FakeHandle({ id: "task_active", status: { state: "working" } });
      const { result } = recovery(s, handle);
      const r = await result;
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("terminal");
    } finally {
      teardown(s.dir);
    }
  });
});

describe("Recovery: 幂等重跑", () => {
  it("skips re-replay and keeps the ledger chain valid on a second run", async () => {
    const s = setup();
    try {
      recordSent(s.ledger);
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      const handle = new FakeHandle({ id: "task_active", status: { state: "working" } });
      const { result: first } = recovery(s, handle);
      const r1 = await first;
      expect(r1.status).toBe("resumed");
      expect(r1.replayed_message_ids).toHaveLength(1);

      // 第二次运行：幂等守卫跳过重放，不重复落账，链仍 valid。
      const { result: second } = recovery(s, handle);
      const r2 = await second;
      expect(r2.status).toBe("resumed");
      expect(r2.replayed_message_ids).toHaveLength(1);
      expect(handle.sent).toHaveLength(1); // 只发送一次
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });
});

describe("Recovery: 八步流程边界", () => {
  it("resumes cleanly when there is no local negotiation at all", async () => {
    const s = setup();
    try {
      const { result } = recovery(s, new FakeHandle({ id: "t", status: { state: "working" } }), {
        resolveCounterparty: async () => null,
      });
      const r = await result;
      expect(r.status).toBe("resumed");
      expect(r.replayed_message_ids).toEqual([]);
      expect(r.remote_ahead_appended).toBe(0);
    } finally {
      teardown(s.dir);
    }
  });

  it("fails closed when the local ledger chain is invalid", async () => {
    const s = setup();
    try {
      // 直接写入残缺链（绕过 append 的链校验）。
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(path.join(s.dir, "ledger"), { recursive: true });
      writeFileSync(path.join(s.dir, "ledger", ledgerFileName("neg_1")), "{ corrupt\n");
      const rec = new NegotiationRecovery({
        ledger: s.ledger,
        contextMap: s.contextMap,
        resolveCounterparty: async () => null,
        now: () => NOW,
      });
      const r = await rec.recover("neg_1");
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("ledger");
    } finally {
      teardown(s.dir);
    }
  });

  it("requires human when the resolved profile selects a non-direct channel", async () => {
    const s = setup();
    try {
      const hostedProfile: CounterpartyProfile = {
        ...PROFILE,
        intersection: {
          compatible: false,
          candidates: [],
          incompatible: [{ binding: "JSONRPC", reason: "no compatible binding" }],
          unknownShared: [],
          oneSided: [],
        },
        channel_candidates: [{ kind: "shopping-cli-hosted", config_id: "local" }],
      };
      const hostedHandle: ChannelHandle = {
        kind: "shopping-cli-hosted",
        identity: "merchant-remote",
        send: async () => {
          throw new Error("recovery must not send over a hosted channel");
        },
        getState: async () => {
          throw new Error("recovery must not getState over a hosted channel");
        },
        close: async () => {},
      };
      const rec = new NegotiationRecovery({
        ledger: s.ledger,
        contextMap: s.contextMap,
        resolveCounterparty: async () => hostedProfile,
        openChannel: async () => hostedHandle,
        now: () => NOW,
      });
      const r = await rec.recover(NEGOTIATION_ID);
      expect(r.status).toBe("reconciliation_required");
      expect(r.reason).toContain("a2a-direct");
    } finally {
      teardown(s.dir);
    }
  });

  it("expires stale outbound messages when the remote revision changed", async () => {
    const s = setup();
    try {
      // 本地观察到任务状态 working，远端已推进到 completed（revision 变化）。
      s.ledger.append({
        event_kind: "system",
        negotiation_id: NEGOTIATION_ID,
        remote_task_id: "task_active",
        remote_context_id: "ctx_remote",
        identity: IDENTITY,
        capability: CAPABILITY_SNAPSHOT,
        outcome: { kind: "ok", result: { task_id: "task_active", task_state: "working" } },
        occurred_at: NOW,
      });
      recordSent(s.ledger);
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");
      // 远端确认了我们的消息（status.message = 我们的 messageId）且已完成 → 无 pending，
      // 但 revision 从 working 变到 completed → 本地出站消息置 stale。
      const ourMid = validEnvelopeFields().message_id;
      const handle = new FakeHandle({
        id: "task_active",
        status: {
          state: "completed",
          message: { role: "agent", parts: [{ kind: "text", text: "done" }], messageId: ourMid },
        },
      });
      const stale: string[] = [];
      const { result } = recovery(s, handle, {
        expireStale: (_neg, ids) => stale.push(...ids),
      });
      const r = await result;
      expect(r.status).toBe("resumed");
      expect(r.stale_message_ids).toContain(ourMid);
      expect(stale).toContain(ourMid);
    } finally {
      teardown(s.dir);
    }
  });
});

describe("Recovery: 重启后 Ledger 链仍 valid", () => {
  it("keeps the ledger chain valid across a full recovery + restart cycle", async () => {
    const s = setup();
    try {
      s.contextMap.set(NEGOTIATION_ID, { remote_context_id: "ctx_remote" });
      s.contextMap.addTask(NEGOTIATION_ID, "task_active");

      // 第一段：remote ahead（append reconciliation 事件）。
      const remoteMid = "msg_remote_new";
      const handle1 = new FakeHandle({
        id: "task_active",
        status: { state: "working", message: { role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: remoteMid } },
      });
      const r1 = await recovery(s, handle1).result;
      expect(r1.status).toBe("resumed");
      expect(r1.remote_ahead_appended).toBe(1);

      // 第二段：模拟重启——同数据目录全新 store 实例。
      const ledger2 = new LedgerStore({ dir: s.dir, now: () => NOW });
      const contextMap2 = new ContextMapStore({ dir: s.dir, now: () => NOW });
      const handle2 = new FakeHandle({ id: "task_active", status: { state: "completed" } });
      const rec2 = new NegotiationRecovery({
        ledger: ledger2,
        contextMap: contextMap2,
        resolveCounterparty: async () => PROFILE,
        openChannel: async () => handle2,
        now: () => NOW,
      });
      const r2 = await rec2.recover(NEGOTIATION_ID);

      expect(r2.status).toBe("resumed");
      // 两条链（第一段实例 + 重启后实例）都 valid。
      expect(s.ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
      expect(ledger2.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      teardown(s.dir);
    }
  });
});
