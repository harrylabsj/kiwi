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
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore, ledgerFileName } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../src/negotiation/context-map/index.js";
import {
  deriveSessionIdentity,
  NegotiationRecovery,
  RECOVERY_SENDER_IDENTITY,
  recordOutboundMessage,
  type RecoveryResult,
} from "../src/negotiation/recovery/index.js";
import { A2AServer } from "../src/a2a/server/index.js";
import { A2ADirectChannel } from "../src/counterparty/index.js";
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


it.each(["confirmed","replayed"])("A387 state change with %s evidence does not expire approvals without revision",async(kind)=>{const s=setup();try{s.ledger.append({event_kind:"system",negotiation_id:NEGOTIATION_ID,remote_task_id:"task_active",remote_context_id:"ctx_remote",identity:IDENTITY,capability:CAPABILITY_SNAPSHOT,outcome:{kind:"ok",result:{task_id:"task_active",task_state:"submitted"}},occurred_at:NOW});recordSent(s.ledger);s.contextMap.set(NEGOTIATION_ID,{remote_context_id:"ctx_remote"});s.contextMap.addTask(NEGOTIATION_ID,"task_active");const mid=validEnvelopeFields().message_id,expire=()=>{throw Error("must not expire on state");};const handle=new FakeHandle({id:"task_active",status:{state:"working",...(kind==="confirmed"?{message:{role:"agent",messageId:mid,parts:[]}}:{})}});const {result}=recovery(s,handle,{expireStale:expire});const r=await result;expect(r.status).toBe("resumed");expect(r.stale_message_ids).toEqual([]);expect(r.reason).toMatch(/revision unavailable.*unknown/);expect(r.replayed_message_ids.length).toBe(kind==="replayed"?1:0);expect(handle.sent.length).toBe(kind==="replayed"?1:0);}finally{teardown(s.dir);}});
