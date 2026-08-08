/**
 * fanout/orchestrator — WP2 多商家 RFQ 编排器（基线 §16 / §19 / §30）。
 *
 * 覆盖：
 *   - 并行发 RFQ（并发度、每腿独立 negotiation_id 与 message_id）；
 *   - 带超时的 Offer 收集（timed_out 腿）；
 *   - 部分失败隔离（send_error / timeout / no_offer / declined 腿不影响其他腿）；
 *   - 比较集聚合排序（价格升序 / 货币分组 / 交期 / 无价格排最后 / identity tie-break）；
 *   - 每腿独立 Ledger 链（verifyChain 有效、链数量、错误腿落 error 事件）；
 *   - 入站 envelope fail-closed（digest 篡改 → 该腿 failed）；
 *   - 披露 payload 正确进入出站 envelope（round 1 匿名档带 quantity_range）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ChannelError,
  type ChannelErrorCode,
  type ChannelHandle,
  type ChannelSendInput,
  type ChannelSendResult,
  type CounterpartyProfile,
  type RemoteRef,
  type RemoteState,
} from "../src/counterparty/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { FanoutOrchestrator } from "../src/fanout/orchestrator.js";
import {
  buildComparisonSet,
  compareRows,
  type FanoutComparisonRow,
  type FanoutLegResult,
  type FanoutLegSpec,
  type FanoutOrchestratorDeps,
} from "../src/fanout/orchestrator.js";
import { disclosurePayload, offerEnvelope, profile } from "./fanout-helpers.js";

const NOW = "2026-08-06T00:00:00Z";

type LegMode =
  | {
      kind: "offer";
      unitPriceMinor: number;
      currency?: string;
      delivery_before?: string;
      noUnitPrice?: boolean;
    }
  | { kind: "no_offer" }
  | { kind: "decline" }
  | { kind: "timeout" }
  | { kind: "task_failed" }
  | { kind: "send_error"; code?: ChannelErrorCode }
  | { kind: "tampered_offer" }
  | { kind: "foreign_then_offer"; unitPriceMinor: number };

interface Tracker {
  active: number;
  max: number;
  sentEnvelopes: NegotiationEnvelope[];
}

function working(_negotiationId: string): RemoteState {
  return {
    channel: "a2a-direct",
    state: "working",
    stable: false,
    message_ids: [],
    observed_at: NOW,
  };
}

function completed(negotiationId: string, envelope: NegotiationEnvelope): RemoteState {
  return {
    channel: "a2a-direct",
    state: "completed",
    stable: true,
    task: {
      id: `task-${negotiationId}`,
      status: {
        state: "completed",
        message: {
          role: "agent",
          messageId: envelope.message_id,
          parts: [{ kind: "data", data: { knp_envelope: envelope } }],
        },
      },
    },
    message_ids: [envelope.message_id],
    observed_at: NOW,
  };
}

function completedWithoutEnvelope(_negotiationId: string): RemoteState {
  return {
    channel: "a2a-direct",
    state: "completed",
    stable: true,
    message_ids: [],
    observed_at: NOW,
  };
}

function declineEnvelope(negotiationId: string): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: "knp.a2a.direct",
    protocol_version: "1.0",
    negotiation_id: negotiationId,
    exchange_id: `ex-decline-${negotiationId}`,
    message_id: `msg-decline-${negotiationId}`,
    actor: "merchant",
    action: "decline",
    created_at: NOW,
    payload: { type: "decline", scope: "offer", target_message_id: `msg-${negotiationId}` },
  });
}

class FakeHandle implements ChannelHandle {
  readonly kind = "a2a-direct" as const;
  readonly identity: string;
  private sent?: NegotiationEnvelope;
  private getStateCalls = 0;

  constructor(
    identity: string,
    private readonly mode: LegMode,
    private readonly tracker: Tracker,
  ) {
    this.identity = identity;
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    if (this.mode.kind === "send_error") {
      throw new ChannelError("a2a-direct", this.mode.code ?? "send_failed", "send failed");
    }
    this.sent = input.envelope;
    this.tracker.sentEnvelopes.push(input.envelope);
    return {
      channel: "a2a-direct",
      ref: {
        negotiation_id: input.envelope.negotiation_id,
        context_id: `ctx-${input.envelope.negotiation_id}`,
        task_id: `task-${input.envelope.negotiation_id}`,
      },
    };
  }

  async getState(_ref: RemoteRef): Promise<RemoteState> {
    this.getStateCalls++;
    const negotiationId = this.sent?.negotiation_id ?? `neg-${this.identity}`;
    switch (this.mode.kind) {
      case "offer": {
        if (this.getStateCalls === 1) return working(negotiationId);
        const envelope = offerEnvelope(negotiationId, this.mode.unitPriceMinor, {
          currency: this.mode.currency,
          delivery_before: this.mode.delivery_before,
          omitUnitPrice: this.mode.noUnitPrice,
        });
        return completed(negotiationId, envelope);
      }
      case "tampered_offer": {
        if (this.getStateCalls === 1) return working(negotiationId);
        // 篡改：finalize 后改 payload，digest 不再一致（§4.5 fail-closed）。
        const envelope = offerEnvelope(negotiationId, 100);
        const tampered: NegotiationEnvelope = {
          ...envelope,
          payload: { type: "offer", offer_id: "off-tampered", terms: {} },
        };
        return completed(negotiationId, tampered);
      }
      case "no_offer":
        if (this.getStateCalls === 1) return working(negotiationId);
        return completedWithoutEnvelope(negotiationId);
      case "decline": {
        if (this.getStateCalls === 1) return working(negotiationId);
        return completed(negotiationId, declineEnvelope(negotiationId));
      }
      case "foreign_then_offer": {
        // 先回传无关磋商的 envelope（对端任务状态残留/恶意；任务仍在途
        // stable=false → 轮询继续），再回传本腿 offer
        if (this.getStateCalls === 1) {
          return {
            ...completed("neg_FOREIGN", offerEnvelope("neg_FOREIGN", 100)),
            state: "working",
            stable: false,
          };
        }
        return completed(negotiationId, offerEnvelope(negotiationId, this.mode.unitPriceMinor));
      }
      case "timeout":
        return working(negotiationId);
      case "task_failed":
        return {
          channel: "a2a-direct",
          state: "failed",
          stable: true,
          message_ids: [],
          observed_at: NOW,
        };
      case "send_error":
        throw new Error("unreachable");
    }
  }

  async close(): Promise<void> {
    this.tracker.active--;
  }
}

function createOrchestrator(
  modes: Record<string, LegMode>,
  overrides: Partial<FanoutOrchestratorDeps> = {},
): { orchestrator: FanoutOrchestrator; tracker: Tracker } {
  const tracker: Tracker = { active: 0, max: 0, sentEnvelopes: [] };
  const openChannel = async (profile: CounterpartyProfile): Promise<ChannelHandle> => {
    tracker.active++;
    tracker.max = Math.max(tracker.max, tracker.active);
    return new FakeHandle(
      profile.identity,
      modes[profile.identity] ?? { kind: "timeout" },
      tracker,
    );
  };
  const orchestrator = new FanoutOrchestrator({
    sender_identity: "buyer-001",
    openChannel,
    pollIntervalMs: 5,
    now: () => NOW,
    ...overrides,
  });
  return { orchestrator, tracker };
}

function leg(identity: string, overrides: Partial<FanoutLegSpec> = {}): FanoutLegSpec {
  return {
    profile: profile(identity),
    payload: disclosurePayload("detailed"),
    timeoutMs: 1000,
    ...overrides,
  };
}

const workDirs: string[] = [];
afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-fanout-"));
  workDirs.push(dir);
  return dir;
}

describe("并行 + 每腿独立 negotiation_id / message_id", () => {
  it("N 条腿并行发出，每腿独立 negotiation_id 与 message_id（幂等键不混淆）", async () => {
    const { orchestrator, tracker } = createOrchestrator({
      "a.example": { kind: "offer", unitPriceMinor: 85000 },
      "b.example": { kind: "offer", unitPriceMinor: 83000 },
      "c.example": { kind: "offer", unitPriceMinor: 87000 },
    });
    const legs = [
      leg("a.example", { negotiation_id: "neg_a" }),
      leg("b.example", { negotiation_id: "neg_b" }),
      leg("c.example", { negotiation_id: "neg_c" }),
    ];
    const result = await orchestrator.fanout(legs);

    expect(result.offer_count).toBe(3);
    expect(result.offers.map((o) => o.identity).sort()).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);

    // 每条腿独立 negotiation_id（双边语义不混淆，§16）。
    const ids = tracker.sentEnvelopes.map((e) => e.negotiation_id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(expect.arrayContaining(["neg_a", "neg_b", "neg_c"]));

    // 每腿独立 message_id → 幂等键 (sender_identity, message_id) 各不相同。
    const messageIds = tracker.sentEnvelopes.map((e) => e.message_id);
    expect(new Set(messageIds).size).toBe(3);

    // 并行度达到 3（所有腿同步 open 后才开始 await）。
    expect(tracker.max).toBe(3);
    expect(tracker.active).toBe(0);

    // 每条腿结果携带自己的 negotiation_id。
    for (const r of result.legs) {
      expect(r.outcome).toBe("offer_received");
      expect(tracker.sentEnvelopes.some((e) => e.negotiation_id === r.negotiation_id)).toBe(true);
    }
  });
});

describe("带超时的 Offer 收集", () => {
  it("超时腿返回 timed_out，不影响其他腿", async () => {
    const { orchestrator } = createOrchestrator({
      "a.example": { kind: "offer", unitPriceMinor: 85000 },
      "b.example": { kind: "timeout" },
    });
    const result = await orchestrator.fanout([
      leg("a.example", { negotiation_id: "neg_a", timeoutMs: 500 }),
      leg("b.example", { negotiation_id: "neg_b", timeoutMs: 30 }),
    ]);

    const a = result.legs.find((l) => l.identity === "a.example")!;
    const b = result.legs.find((l) => l.identity === "b.example")!;
    expect(a.outcome).toBe("offer_received");
    expect(b.outcome).toBe("timed_out");
    expect(b.error?.code).toBe("timeout");
    expect(result.offer_count).toBe(1);
    expect(result.offers.map((o) => o.identity)).toEqual(["a.example"]);
  });
});

describe("部分失败隔离（§19）", () => {
  it("send_error / no_offer / declined / task_failed 腿各自结构化返回，不污染其他腿", async () => {
    const { orchestrator } = createOrchestrator({
      "a.example": { kind: "offer", unitPriceMinor: 85000 },
      "b.example": { kind: "send_error", code: "send_failed" },
      "c.example": { kind: "no_offer" },
      "d.example": { kind: "decline" },
      "e.example": { kind: "task_failed" },
    });
    const result = await orchestrator.fanout([
      leg("a.example", { negotiation_id: "neg_a" }),
      leg("b.example", { negotiation_id: "neg_b" }),
      leg("c.example", { negotiation_id: "neg_c" }),
      leg("d.example", { negotiation_id: "neg_d" }),
      leg("e.example", { negotiation_id: "neg_e" }),
    ]);

    const byId = (id: string) => result.legs.find((l) => l.identity === id)!;
    expect(byId("a.example").outcome).toBe("offer_received");
    expect(byId("b.example").outcome).toBe("failed");
    expect(byId("b.example").error?.code).toBe("send_failed");
    expect(byId("c.example").outcome).toBe("no_offer");
    expect(byId("d.example").outcome).toBe("declined");
    expect(byId("e.example").outcome).toBe("failed");
    expect(byId("e.example").error?.code).toBe("remote_task_failed");

    // 只聚合真正的 Offer。
    expect(result.offer_count).toBe(1);
    expect(result.offers.map((o) => o.identity)).toEqual(["a.example"]);
  });

  it("入站 envelope digest 被篡改 → 该腿 failed（§4.5 fail-closed）", async () => {
    const { orchestrator } = createOrchestrator({
      "a.example": { kind: "tampered_offer" },
    });
    const result = await orchestrator.fanout([leg("a.example", { negotiation_id: "neg_a" })]);
    expect(result.legs[0]?.outcome).toBe("failed");
    expect(result.offer_count).toBe(0);
  });

  it("无关 negotiation 的 envelope 被忽略：不污染比较集与审计链（评审项 P3-6）", async () => {
    const { orchestrator } = createOrchestrator({
      "a.example": { kind: "foreign_then_offer", unitPriceMinor: 500 },
    });
    const result = await orchestrator.fanout([leg("a.example", { negotiation_id: "neg_a" })]);
    // foreign envelope（neg_FOREIGN）被忽略，轮询继续直到本腿 offer 到达
    expect(result.legs[0]?.outcome).toBe("offer_received");
    expect(result.offer_count).toBe(1);
    // 采用的是本腿 offer（offer_id 归属 neg_a），foreign 报价未进比较集
    const offer = result.legs[0]?.offer;
    expect(offer?.offer_id).toContain("neg_a");
    expect(offer?.offer_id).not.toContain("FOREIGN");
  });
});

describe("比较集聚合排序", () => {
  it("价格升序；同价交期早优先；无价格排最后（确定性）", async () => {
    const legs: FanoutLegResult[] = [
      {
        identity: "c.example",
        negotiation_id: "neg_c",
        message_id: "msg_c",
        outcome: "offer_received",
        offer: {
          type: "offer",
          offer_id: "off_c",
          terms: {
            items: [
              {
                sku: "SKU-001",
                quantity: { value: 50, unit: "piece" },
                unit_price: { currency: "CNY", amount_minor: 90000 },
              },
            ],
            fulfillment_terms: { delivery_before: "2026-08-17T00:00:00Z" },
          },
        },
        elapsed_ms: 1,
      },
      {
        identity: "a.example",
        negotiation_id: "neg_a",
        message_id: "msg_a",
        outcome: "offer_received",
        offer: {
          type: "offer",
          offer_id: "off_a",
          terms: {
            items: [
              {
                sku: "SKU-001",
                quantity: { value: 50, unit: "piece" },
                unit_price: { currency: "CNY", amount_minor: 85000 },
              },
            ],
            fulfillment_terms: { delivery_before: "2026-08-18T00:00:00Z" },
          },
        },
        elapsed_ms: 1,
      },
      {
        identity: "b.example",
        negotiation_id: "neg_b",
        message_id: "msg_b",
        outcome: "offer_received",
        offer: {
          type: "offer",
          offer_id: "off_b",
          terms: {
            items: [
              {
                sku: "SKU-001",
                quantity: { value: 50, unit: "piece" },
                unit_price: { currency: "CNY", amount_minor: 85000 },
              },
            ],
            fulfillment_terms: { delivery_before: "2026-08-19T00:00:00Z" },
          },
        },
        elapsed_ms: 1,
      },
      {
        identity: "d.example",
        negotiation_id: "neg_d",
        message_id: "msg_d",
        outcome: "offer_received",
        offer: {
          type: "offer",
          offer_id: "off_d",
          terms: { items: [{ sku: "SKU-001", quantity: { value: 50, unit: "piece" } }] },
        },
        elapsed_ms: 1,
      },
    ];

    const rows = buildComparisonSet(legs);
    // a(85000, 08-18) < b(85000, 08-19) < c(90000) < d(无价格)。
    expect(rows.map((r) => r.identity)).toEqual([
      "a.example",
      "b.example",
      "c.example",
      "d.example",
    ]);
    expect(rows[0]?.price).toEqual({ currency: "CNY", amount_minor: 85000 });
    expect(rows[0]?.delivery_before).toBe("2026-08-18T00:00:00Z");
    expect(rows[3]?.price).toBeNull();
  });

  it("跨货币不比较数值，按货币码分组；同货币内价格升序", () => {
    const rows: FanoutComparisonRow[] = [
      {
        identity: "b.example",
        negotiation_id: "neg_b",
        offer_id: "off_b",
        price: { currency: "USD", amount_minor: 100 },
        terms: {},
      },
      {
        identity: "a.example",
        negotiation_id: "neg_a",
        offer_id: "off_a",
        price: { currency: "CNY", amount_minor: 90000 },
        terms: {},
      },
      {
        identity: "c.example",
        negotiation_id: "neg_c",
        offer_id: "off_c",
        price: { currency: "CNY", amount_minor: 85000 },
        terms: {},
      },
    ];
    rows.sort(compareRows);
    // CNY 组内 85000 < 90000；USD 组（字典序靠后）排最后；数值 100 不与 CNY 比较。
    expect(rows.map((r) => r.identity)).toEqual(["c.example", "a.example", "b.example"]);
  });

  it("编排器端到端：出站匿名档 payload 携带 quantity_range（round 1 渐进披露）", async () => {
    const { orchestrator, tracker } = createOrchestrator({
      "a.example": { kind: "offer", unitPriceMinor: 85000 },
    });
    const result = await orchestrator.fanout([
      leg("a.example", { negotiation_id: "neg_a", payload: disclosurePayload("anonymous") }),
    ]);
    expect(result.offer_count).toBe(1);
    const sent = tracker.sentEnvelopes[0]!;
    const payload = sent.payload as { type: "rfq"; requested_terms?: { quantity_range?: unknown } };
    expect(payload.type).toBe("rfq");
    expect(payload.requested_terms?.quantity_range).toEqual([{ sku: "SKU-001", min: 10, max: 50 }]);
    // 匿名档出站 envelope 不含交期。
    expect(JSON.stringify(sent.payload)).not.toContain("delivery_before");
  });
});

describe("每腿独立 Ledger 链", () => {
  it("每腿以独立 negotiation_id 落账；错误腿落 error 事件；链可校验", async () => {
    const dir = freshDir();
    const ledger = new LedgerStore({ dir });
    const { orchestrator } = createOrchestrator(
      {
        "a.example": { kind: "offer", unitPriceMinor: 85000 },
        "b.example": { kind: "timeout" },
      },
      { ledger },
    );
    const result = await orchestrator.fanout([
      leg("a.example", { negotiation_id: "neg_a", timeoutMs: 500 }),
      leg("b.example", { negotiation_id: "neg_b", timeoutMs: 30 }),
    ]);

    // 每腿独立链：三个 negotiation_id 都能 verifyChain。
    const allNegotiations = ledger.listNegotiations();
    expect(allNegotiations).toEqual(expect.arrayContaining(["neg_a", "neg_b"]));
    for (const id of ["neg_a", "neg_b"]) {
      const chain = ledger.verifyChain(id);
      expect(chain.valid).toBe(true);
      expect(chain.count).toBeGreaterThanOrEqual(2);
    }

    // 成功腿链上只有 ok 事件。
    const negAEvents = ledger.events("neg_a");
    expect(negAEvents.every((e) => e.outcome.kind === "ok")).toBe(true);

    // 超时腿链上含 error 事件（code=timeout）。
    const negBEvents = ledger.events("neg_b");
    expect(negBEvents.some((e) => e.outcome.kind === "error" && e.outcome.code === "timeout")).toBe(
      true,
    );

    // 每腿结果与链上的 negotiation_id 一一对应。
    for (const r of result.legs) {
      expect(ledger.hasNegotiation(r.negotiation_id)).toBe(true);
    }
  });
});
