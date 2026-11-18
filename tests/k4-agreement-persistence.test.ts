/**
 * 买家识别与交易回执 · K4 持久化商家接受结果（B6 的 Kiwi 部分）。
 *
 * 在「推进相位」「提交完整协议」「生成出站记录」之间模拟中断并重试，
 * 验证有效请求始终恢复同一商家协议号与摘要；拒绝和无法恢复的请求
 * 不产生协议证据。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InboundPipeline } from "../src/a2a/server/pipeline.js";
import { TaskRegistry } from "../src/a2a/server/task-registry.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { envelopeToMessage } from "../src/buyer-core/a2a-knp.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";

const NOW = "2026-11-05T08:00:00.000Z";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const NEGOTIATION_ID = "neg_k4_001";

describe("K4 商家协议持久化与中断恢复（B6）", () => {
  let dir: string;
  let ledger: LedgerStore;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k4-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeHandler = (): NegotiationHandler =>
    createMerchantHandler({
      productSource: {
        async getProduct() {
          return { price: 850, currency: "CNY", unit: "piece", stock: 1000, source_evidence: { system: "owned-test-fixture" } };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
    });

  const env = (action: string, payload: Record<string, unknown>): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const runWith = async (
    h: NegotiationHandler,
    envelope: NegotiationEnvelope,
    identityVerified = false,
  ): Promise<NegotiationHandlerResult> =>
    await h.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${envelope.message_id}`,
      senderIdentity: "kiwi-inquiry-session-v1:buyer-key",
      identityVerified,
    });

  const agreementIdOf = (result: NegotiationHandlerResult): string | undefined =>
    result.kind === "accepted"
      ? (
          result.artifactParts?.[0] as unknown as {
            data?: { agreement?: { agreement_id?: string } };
          }
        )?.data?.agreement?.agreement_id
      : undefined;

  const evidenceEvents = () =>
    ledger
      .events(NEGOTIATION_ID)
      .filter(
        (e) =>
          e.event_kind === "system" &&
          (e.outcome as { result?: { kind?: string } }).result?.kind === "agreement_issued",
      );

  /** 走到活跃 conditional（inquiry → rfq → counter_offer）。 */
  const reachConditional = async (h: NegotiationHandler) => {
    await runWith(h, env("inquiry", {}));
    await runWith(h, env("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] }));
    await runWith(h, env("offer", {
      offer_id: "off_buyer",
      terms: { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 85000 } }] },
    }));
    const cond = await runWith(h, env("counter_offer", {
      offer_id: "off_counter",
      proposed_terms: { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 85000 } }] },
    }));
    if (cond.kind !== "accepted") throw new Error("conditional flow failed");
    const conditional = (
      (cond.message!.parts[0] as unknown as { data?: { knp_envelope?: { payload?: unknown } } }).data?.knp_envelope?.payload
    ) as { conditions?: unknown };
    const { evaluateConditionalOffer } = await import("../src/negotiation/condition/evaluator.js");
    const agreedTerms = evaluateConditionalOffer(conditional as never, { "aggregate.total_quantity": 200 }) as Record<string, unknown>;
    const offerId = (
      (cond.message!.parts[0] as unknown as { data?: { knp_envelope?: { payload?: { offer_id?: string } } } }).data?.knp_envelope?.payload?.offer_id
    ) as string;
    return { offerId, agreedTerms };
  };

  it("正常成交：协议证据恰好一条，含商家协议号/摘要/买方绑定", async () => {
    const h = makeHandler();
    const { offerId, agreedTerms } = await reachConditional(h);
    const result = await runWith(h, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: contentDigest(agreedTerms as never),
    }), true);
    expect(result.kind).toBe("accepted");
    const evidence = evidenceEvents();
    expect(evidence).toHaveLength(1);
    const stored = (evidence[0] as unknown as { outcome: { result: Record<string, unknown> } }).outcome.result;
    expect(stored["accepted_offer_id"]).toBe(offerId);
    expect(String(stored["buyer_binding"])).toBe("kiwi-inquiry-session-v1:buyer-key");
    const agreement = stored["agreement"] as Record<string, unknown>;
    expect(agreement["agreement_id"]).toBe(agreementIdOf(result));
    expect(agreement["terms_digest"]).toBe(contentDigest(agreedTerms as never));
  });

  it("中断点①（证据已落账、相位未推进）重试：恢复同一协议号", async () => {
    const { offerId, agreedTerms } = await reachConditional(makeHandler());
    const digest = contentDigest(agreedTerms as never);
    // 手工预写证据（模拟进程在证据 append 后、相位推进前崩溃）。
    const agreementId = "agr_recovered_1";
    const agreement = {
      type: "accepted_nonbinding_agreement",
      agreement_id: agreementId,
      negotiation_id: NEGOTIATION_ID,
      accepted_offer_id: offerId,
      agreed_terms: agreedTerms,
      terms_digest: digest,
      accepted_by: ["buyer", "merchant"],
      created_at: NOW,
      binding_effect: "nonbinding",
      creates_order: false,
      reserves_inventory: false,
      authorizes_payment: false,
    };
    await ledger.append({
      event_kind: "system",
      negotiation_id: NEGOTIATION_ID,
      agreement_id: agreementId,
      terms_digest: digest,
      identity: { sender_identity: "merchant:merchant-001", counterparty_identity: "kiwi-inquiry-session-v1:buyer-key", actor: "merchant" },
      capability: { capability: CAP, protocol_version: "1.0" },
      outcome: { kind: "ok", result: { kind: "agreement_issued", agreement, accepted_offer_id: offerId, buyer_binding: "kiwi-inquiry-session-v1:buyer-key" } },
      occurred_at: NOW,
    });
    // “重启”后的 handler 处理重试 accept。
    const recovered = makeHandler();
    const replay = await runWith(recovered, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: digest,
    }), true);
    expect(replay.kind).toBe("accepted");
    expect(agreementIdOf(replay)).toBe(agreementId);
    expect(evidenceEvents()).toHaveLength(1);
    // 相位推进到终态：后续商业动作拒绝。
    const rfq = await runWith(recovered, env("rfq", { items: [{ sku: "SKU-001" }] }));
    expect(rfq.kind).toBe("declined");
    expect(rfq.kind === "declined" && rfq.reasonCode).toBe("state_conflict");
  });

  it("中断点②（相位已推进、响应未达买家）重试：终态守卫按证据幂等返回原协议", async () => {
    const h = makeHandler();
    const { offerId, agreedTerms } = await reachConditional(h);
    const digest = contentDigest(agreedTerms as never);
    const first = await runWith(h, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: digest,
    }), true);
    expect(first.kind).toBe("accepted");
    const originalId = agreementIdOf(first);
    // 全新 handler（重启）处理重试（新 message_id，同 offer/摘要）。
    const restarted = makeHandler();
    const retry = await runWith(restarted, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: digest,
    }), true);
    expect(retry.kind).toBe("accepted");
    expect(agreementIdOf(retry)).toBe(originalId);
    expect(evidenceEvents()).toHaveLength(1);
  });

  it.each(["phase", "received"] as const)(
    "pipeline recovers the same accepted message after failure writing %s",
    async (point) => {
      const handler = makeHandler();
      const { offerId, agreedTerms } = await reachConditional(handler);
      const envelope = env("accept_nonbinding", {
        type: "accept_nonbinding", offer_id: offerId, terms_digest: contentDigest(agreedTerms as never),
      });
      const buildPipeline = (instance: NegotiationHandler) => new InboundPipeline({
        handler: instance, ledger, idempotency: new IdempotencyStore({ dir, now: () => NOW }),
        tasks: new TaskRegistry(), now: () => NOW, logError: () => {},
      });
      const outbound = { message: envelopeToMessage(envelope) };
      const caller = { senderIdentity: "kiwi-inquiry-session-v1:buyer-key", identityVerified: true };
      const originalAppend = ledger.append.bind(ledger);
      const failure = vi.spyOn(ledger, "append").mockImplementation((event) => {
        if ((point === "phase" && event.state_transition?.to_phase === "AGREEMENT_REACHED") ||
            (point === "received" && event.event_kind === "message_received")) throw new Error("fixture interrupted");
        return originalAppend(event);
      });
      try {
        await expect(buildPipeline(handler).sendMessage(outbound, caller)).rejects.toBeDefined();
      } finally {
        failure.mockRestore();
      }
      const originalAgreementId = evidenceEvents()[0]?.agreement_id;
      expect(originalAgreementId).toBeTypeOf("string");
      const restarted = buildPipeline(makeHandler());
      const first = await restarted.sendMessage(outbound, caller);
      const second = await restarted.sendMessage(outbound, caller);
      expect(first.task.artifacts?.[0]?.parts[0]).toMatchObject({ data: { agreement: { agreement_id: originalAgreementId } } });
      expect(second).toEqual({ task: first.task });
      expect(evidenceEvents()).toHaveLength(1);
    },
  );

  it("被拒的 accept（offer_unknown）不产生证据；终态无证据重放拒绝（无法恢复窗口不补协议）", async () => {
    const h = makeHandler();
    const { offerId, agreedTerms } = await reachConditional(h);
    const digest = contentDigest(agreedTerms as never);
    // 未知 offer_id → 拒绝，无证据。
    const unknown = await runWith(h, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: "off_ghost", terms_digest: digest,
    }));
    expect(unknown.kind).toBe("declined");
    expect(evidenceEvents()).toHaveLength(0);
    // 正常成交后，伪造第三种摘要的重放被终态守卫拒绝，不生成替代协议。
    const ok = await runWith(h, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: digest,
    }), true);
    expect(ok.kind).toBe("accepted");
    const forged = await runWith(h, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }), true);
    expect(forged.kind).toBe("declined");
    expect(forged.kind === "declined" && forged.reasonCode).toBe("state_conflict");
    expect(evidenceEvents()).toHaveLength(1);
  });

  it("拒绝请求（terms_digest_mismatch）无意向证据", async () => {
    const h = makeHandler();
    const { offerId } = await reachConditional(h);
    const bad = await runWith(h, env("accept_nonbinding", {
      type: "accept_nonbinding", offer_id: offerId, terms_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }));
    expect(bad.kind).toBe("declined");
    expect(bad.kind === "declined" && bad.reasonCode).toBe("terms_digest_mismatch");
    expect(evidenceEvents()).toHaveLength(0);
  });
});
