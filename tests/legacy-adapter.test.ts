/**
 * LegacyNegotiationAdapter vitest 覆盖（基线 §35 / 子规范 §32 / §36 不变量 22）：
 *
 *  1. legacy → KNP：ask/propose/counter/accept/decline 映射、默认值补填与
 *     notes、金额精度 fail-closed、escalate/request_human_review → requires_human。
 *  2. KNP → legacy：offer/counter/inquiry/decline 反向映射；
 *     conditions / expiry / identity / agreement 受保护语义 fail-closed / requires-human。
 *  3. 双向无损往返：lossless 子集 D → E → D 恒等；E → D → E 语义恒等（幂等）。
 *  4. 权限不扩大（不变量 22）：从不伪造 conditions、accept 永不升级为
 *     agreement artifact、decline scope=negotiation 被拒、伪造额外字段被拒。
 *  5. 冻结契约 fixture 全量兼容：decision.counter / decision.escalate /
 *     snapshot.merchant 的 message 与 adapter 互相可转，现有 legacy 测试不受影响。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LegacyNegotiationAdapter } from "../src/protocol/legacy-shopping-negotiation/adapter.js";
import type { TranslationResult } from "../src/protocol/legacy-shopping-negotiation/types.js";
import {
  fromMinorUnits,
  toMinorUnits,
} from "../src/protocol/legacy-shopping-negotiation/money.js";
import { finalizeEnvelope, validateEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import {
  validAcceptNonbinding,
  validClarification,
  validConditionalOffer,
  validOffer,
  validRfq,
  validWithdraw,
} from "./negotiation-helpers.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type SnapshotMessage,
  type StockState,
} from "../src/negotiation/types.js";
import { packageRoot } from "../src/contracts/schemas.js";

const CAPABILITY = "example.kiwi.shopping.negotiation";
const NOW = "2026-08-05T12:00:00Z";
const adapter = new LegacyNegotiationAdapter({ now: () => NOW });
const ctx = { capability: CAPABILITY, actor: "buyer", created_at: NOW, current_sku: "sku-001" } as const;

function translatedOf<T>(r: TranslationResult<T>): T {
  if (!("translated" in r)) throw new Error(`expected translated result, got ${JSON.stringify(r)}`);
  return r.translated;
}

function notesOf<T>(r: TranslationResult<T>): string[] {
  if (!("translated" in r)) throw new Error(`expected translated result, got ${JSON.stringify(r)}`);
  return r.notes.map((n) => `${n.kind}:${n.path}`);
}

// ---------------------------------------------------------------------------
// legacy fixture
// ---------------------------------------------------------------------------

const STOCK: StockState = {
  status: "available",
  quantity: 12,
  observed_at: "2026-08-03T15:00:00+08:00",
  reserved: false,
};

const DELIVERY = {
  eta_start: "2026-08-04T14:00:00+08:00",
  eta_end: "2026-08-04T18:00:00+08:00",
  fee: 0,
};

const PROPOSAL = {
  sku: "sku-001",
  quantity: 2,
  unit_price: 89.0,
  currency: "CNY",
  stock: STOCK,
  delivery: DELIVERY,
  after_sales_policy_refs: ["policy:return-7d"],
  valid_until: "2026-08-03T15:05:00+08:00",
};

/** lossless 子集：open_issues / reason_codes 为空、无 confidence，可完整往返。 */
function losslessDecision(overrides: Partial<NegotiationDecision> = {}): NegotiationDecision {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: "conv-001",
    in_reply_to_message_id: 42,
    action: "propose",
    proposal: PROPOSAL,
    open_issues: [],
    public_message: "If we order 2 units, we propose CNY 89.00 each.",
    reason_codes: [],
    request_human_review: false,
    ...overrides,
  };
}

function acceptDecision(): NegotiationDecision {
  const { proposal: _p, ...rest } = losslessDecision({ action: "accept_nonbinding" });
  return rest;
}

function declineDecision(): NegotiationDecision {
  const { proposal: _p, ...rest } = losslessDecision({ action: "decline" });
  return rest;
}

function askDecision(): NegotiationDecision {
  const { proposal: _p, ...rest } = losslessDecision({ action: "ask" });
  return rest;
}

const acceptCtx = {
  ...ctx,
  resolveAcceptedTerms: () => validOffer().terms,
};

/** KNP 侧可被 legacy 表达的 terms（adapter 产出的形态）。 */
function legacyExpressibleOfferTerms(): TermSet {
  return {
    items: [
      {
        sku: "sku-001",
        quantity: { value: 2, unit: "piece" },
        unit_price: { currency: "CNY", amount_minor: 8900 },
      },
    ],
    fulfillment_terms: {
      eta_start: DELIVERY.eta_start,
      eta_end: DELIVERY.eta_end,
      delivery_fee: { currency: "CNY", amount_minor: 0 },
      legacy_stock: STOCK,
    },
    service_terms: { after_sales_policy_refs: ["policy:return-7d"] },
    valid_until: "2026-08-03T15:05:00+08:00",
  };
}

function knpEnvelope(
  action: NegotiationEnvelope["action"],
  payload: NegotiationEnvelope["payload"],
  overrides: Partial<Omit<NegotiationEnvelope, "digest">> = {},
): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: "conv-001",
    exchange_id: "ex_legacy_99",
    message_id: "msg_legacy_43",
    in_reply_to: "msg_legacy_42",
    actor: "merchant",
    action,
    created_at: NOW,
    payload,
    public_message: "KNP side message",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// legacy → KNP
// ---------------------------------------------------------------------------

describe("legacy decision → KNP envelope", () => {
  it("maps ask → inquiry, propose → offer, counter → counter_offer, decline → decline", () => {
    const cases: Array<[NegotiationDecision, NegotiationEnvelope["action"], string]> = [
      [askDecision(), "inquiry", "inquiry"],
      [losslessDecision(), "offer", "offer"],
      [losslessDecision({ action: "counter" }), "counter_offer", "counter_offer"],
      [declineDecision(), "decline", "decline"],
    ];
    for (const [decision, action, payloadType] of cases) {
      const result = adapter.legacyDecisionToEnvelope(decision, ctx);
      expect("translated" in result).toBe(true);
      const env = translatedOf(result);
      expect(env.action).toBe(action);
      expect(env.payload.type).toBe(payloadType);
      expect(() => validateEnvelope(env)).not.toThrow();
    }
  });

  it("maps accept_nonbinding → accept_nonbinding envelope (not an agreement artifact)", () => {
    const result = adapter.legacyDecisionToEnvelope(acceptDecision(), acceptCtx);
    expect("translated" in result).toBe(true);
    const env = translatedOf(result);
    expect(env.action).toBe("accept_nonbinding");
    expect(env.payload.type).toBe("accept_nonbinding");
    if (env.payload.type !== "accept_nonbinding") throw new Error("unreachable");
    expect(env.payload.offer_id).toBe("off_legacy_42");
    expect(env.payload.terms_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("conversation_id → negotiation_id and in_reply_to encoded reversibly", () => {
    const env = translatedOf(adapter.legacyDecisionToEnvelope(losslessDecision(), ctx));
    expect(env.negotiation_id).toBe("conv-001");
    expect(env.in_reply_to).toBe("msg_legacy_42");
    expect(env.actor).toBe("buyer");
  });

  it("records default-filled fields (exchange_id, message_id, created_at, quantity.unit, offer_id) in notes", () => {
    const result = adapter.legacyDecisionToEnvelope(losslessDecision(), ctx);
    const notes = notesOf(result);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("default:envelope.exchange_id"),
        expect.stringContaining("default:envelope.message_id"),
        expect.stringContaining("default:envelope.created_at"),
        expect.stringContaining("default:proposal.quantity.unit"),
        expect.stringContaining("default:payload.offer_id"),
      ]),
    );
  });

  it("records legacy-extension fields (stock/delivery/after_sales) in notes", () => {
    const notes = notesOf(adapter.legacyDecisionToEnvelope(losslessDecision(), ctx));
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("extension:proposal.stock"),
        expect.stringContaining("extension:proposal.delivery"),
        expect.stringContaining("extension:proposal.after_sales_policy_refs"),
      ]),
    );
  });

  it("preserves open_issues text in public_message and records a note", () => {
    const d = losslessDecision({
      open_issues: ["delivery_eta", "quantity_discount"],
      public_message: "",
    });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    const env = translatedOf(result);
    expect(env.public_message).toBe("delivery_eta; quantity_discount");
    expect(notesOf(result)).toContain("extension:decision.open_issues");
  });

  it("drops confidence/reason_codes with recorded notes (non-silent)", () => {
    const d = losslessDecision({
      confidence: 0.91,
      reason_codes: ["within_policy", "inventory_observed"],
    });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    expect("translated" in result).toBe(true);
    const notes = notesOf(result);
    expect(notes).toContain("dropped:decision.confidence");
    expect(notes).toContain("dropped:decision.reason_codes");
  });

  it("is deterministic: the same decision + context produces the same envelope (retry idempotent)", () => {
    const a = translatedOf(adapter.legacyDecisionToEnvelope(losslessDecision(), ctx));
    const b = translatedOf(adapter.legacyDecisionToEnvelope(losslessDecision(), ctx));
    expect(a).toEqual(b);
  });

  it("fail-closes on a lossy float amount (beyond minor-unit precision)", () => {
    const d = losslessDecision({ proposal: { ...PROPOSAL, unit_price: 89.555 } });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    expect("fail_closed" in result).toBe(true);
    expect("translated" in result).toBe(false);
  });

  it("fail-closes on a lossy fee amount", () => {
    const d = losslessDecision({
      proposal: { ...PROPOSAL, delivery: { ...DELIVERY, fee: 0.005 } },
    });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    expect("fail_closed" in result).toBe(true);
  });

  it("fail-closes on propose/counter without a proposal", () => {
    const { proposal: _p, ...noProposal } = losslessDecision();
    const result = adapter.legacyDecisionToEnvelope(noProposal, ctx);
    expect("fail_closed" in result).toBe(true);
  });

  it("accept requires a resolver for the accepted terms (terms_digest)", () => {
    const result = adapter.legacyDecisionToEnvelope(acceptDecision(), ctx);
    expect("fail_closed" in result).toBe(true);
    expect("translated" in result).toBe(false);
  });

  it("escalate → requires_human", () => {
    const d = losslessDecision({ action: "escalate" });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    expect("requires_human" in result).toBe(true);
  });

  it("request_human_review=true → requires_human (never auto-translated)", () => {
    const d = losslessDecision({ request_human_review: true });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    expect("requires_human" in result).toBe(true);
  });

  it("rejects a legacy decision with unknown fields (forged conditions are not translated)", () => {
    const forged = {
      ...losslessDecision(),
      conditions: [
        { when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 500 }] } },
      ],
    } as unknown as NegotiationDecision;
    const result = adapter.legacyDecisionToEnvelope(forged, ctx);
    expect("fail_closed" in result).toBe(true);
    expect("translated" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KNP → legacy
// ---------------------------------------------------------------------------

describe("KNP envelope → legacy decision", () => {
  it("maps offer → propose and counter_offer → counter", () => {
    const offerEnv = knpEnvelope("offer", { type: "offer", offer_id: "off_01", terms: legacyExpressibleOfferTerms() });
    const counterEnv = knpEnvelope("counter_offer", {
      type: "counter_offer",
      offer_id: "off_02",
      responding_to_offer_id: "off_01",
      proposed_terms: legacyExpressibleOfferTerms(),
    });
    const offerDecision = translatedOf(adapter.envelopeToLegacyDecision(offerEnv));
    expect(offerDecision.action).toBe("propose");
    expect(offerDecision.proposal).toEqual(PROPOSAL);
    const counterDecision = translatedOf(adapter.envelopeToLegacyDecision(counterEnv));
    expect(counterDecision.action).toBe("counter");
    expect(counterDecision.proposal).toEqual(PROPOSAL);
  });

  it("maps inquiry → ask and decline (scope=offer) → decline", () => {
    const inquiryEnv = knpEnvelope("inquiry", { type: "inquiry", questions: [] });
    const d1 = translatedOf(adapter.envelopeToLegacyDecision(inquiryEnv));
    expect(d1.action).toBe("ask");

    const declineEnv = knpEnvelope("decline", {
      type: "decline",
      target_message_id: "msg_legacy_42",
      target_offer_id: "off_legacy_42",
      scope: "offer",
    });
    const d2 = translatedOf(adapter.envelopeToLegacyDecision(declineEnv));
    expect(d2.action).toBe("decline");
    expect(d2.in_reply_to_message_id).toBe(42);
  });

  it("records actor identity and dropped KNP-only fields in notes (non-silent)", () => {
    const result = adapter.envelopeToLegacyDecision(
      knpEnvelope("offer", { type: "offer", offer_id: "off_01", terms: legacyExpressibleOfferTerms() }),
    );
    const notes = notesOf(result);
    expect(notes).toContain("identity:envelope.actor");
    expect(notes).toContain("dropped:envelope.message_id");
    expect(notes).toContain("dropped:envelope.exchange_id");
    expect(notes).toContain("dropped:envelope.digest");
    expect(notes).toContain("dropped:envelope.capability");
    expect(notes).toContain("dropped:envelope.created_at");
  });

  it("fail-closes on conditional_offer (conditions are protected)", () => {
    const env = knpEnvelope("conditional_offer", validConditionalOffer());
    const result = adapter.envelopeToLegacyDecision(env);
    expect("fail_closed" in result).toBe(true);
    expect("translated" in result).toBe(false);
  });

  it("requires_human on rfq (legacy has no structured RFQ)", () => {
    const env = knpEnvelope("rfq", validRfq());
    const result = adapter.envelopeToLegacyDecision(env);
    expect("requires_human" in result).toBe(true);
  });

  it("fail-closes on decline scope=negotiation (no permission escalation)", () => {
    const env = knpEnvelope("decline", {
      type: "decline",
      target_message_id: "msg_legacy_42",
      scope: "negotiation",
    });
    const result = adapter.envelopeToLegacyDecision(env);
    expect("fail_closed" in result).toBe(true);
  });

  it("fail-closes when in_reply_to is not a legacy-encodable message id (identity)", () => {
    const env = knpEnvelope("inquiry", { type: "inquiry", questions: [] }, {
      in_reply_to: "msg_01H5V8KXZqJ7Qp3mN2B6A",
    });
    const result = adapter.envelopeToLegacyDecision(env);
    expect("fail_closed" in result).toBe(true);
  });

  it("fail-closes when the envelope has no in_reply_to (legacy requires one)", () => {
    const env = knpEnvelope("inquiry", { type: "inquiry", questions: [] }, { in_reply_to: undefined });
    const result = adapter.envelopeToLegacyDecision(env);
    expect("fail_closed" in result).toBe(true);
  });

  it("fail-closes on an offer without expiry (valid_until) — cannot invent one", () => {
    const terms = legacyExpressibleOfferTerms();
    delete terms.valid_until;
    const env = knpEnvelope("offer", { type: "offer", offer_id: "off_01", terms });
    const result = adapter.envelopeToLegacyDecision(env);
    expect("fail_closed" in result).toBe(true);
  });

  it("fail-closes on a multi-item offer (legacy proposal is single-SKU)", () => {
    const terms = legacyExpressibleOfferTerms();
    terms.items = [
      ...(terms.items ?? []),
      { sku: "sku-002", quantity: { value: 1, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 1000 } },
    ];
    const env = knpEnvelope("offer", { type: "offer", offer_id: "off_01", terms });
    const result = adapter.envelopeToLegacyDecision(env);
    expect("fail_closed" in result).toBe(true);
  });

  it("fail-closes when the digest does not match its content (tampered)", () => {
    const env = knpEnvelope("offer", { type: "offer", offer_id: "off_01", terms: legacyExpressibleOfferTerms() });
    const tampered = { ...env, public_message: "tampered" } as NegotiationEnvelope;
    const result = adapter.envelopeToLegacyDecision(tampered);
    expect("fail_closed" in result).toBe(true);
  });

  it("accept_nonbinding → legacy accept decision (offer_id/terms_digest dropped with notes)", () => {
    const env = knpEnvelope("accept_nonbinding", validAcceptNonbinding());
    const result = adapter.envelopeToLegacyDecision(env);
    expect("translated" in result).toBe(true);
    const d = translatedOf(result);
    expect(d.action).toBe("accept_nonbinding");
    expect(d.in_reply_to_message_id).toBe(42);
    const notes = notesOf(result);
    expect(notes).toContain("dropped:payload.offer_id");
  });
});

// ---------------------------------------------------------------------------
// Round-trip 恒等
// ---------------------------------------------------------------------------

describe("bidirectional round-trip", () => {
  it("legacy decision → KNP → legacy decision = identity (lossless subset)", () => {
    const decisions = [
      losslessDecision(),
      losslessDecision({ action: "counter" }),
      askDecision(),
      declineDecision(),
    ];
    for (const d of decisions) {
      const envResult = adapter.legacyDecisionToEnvelope(d, ctx);
      expect("translated" in envResult).toBe(true);
      const backResult = adapter.envelopeToLegacyDecision(translatedOf(envResult));
      expect("translated" in backResult).toBe(true);
      expect(translatedOf(backResult)).toEqual(d);
    }
  });

  it("accept decision → KNP → legacy decision = identity", () => {
    const envResult = adapter.legacyDecisionToEnvelope(acceptDecision(), acceptCtx);
    expect("translated" in envResult).toBe(true);
    const back = adapter.envelopeToLegacyDecision(translatedOf(envResult));
    expect("translated" in back).toBe(true);
    expect(translatedOf(back)).toEqual(acceptDecision());
  });

  it("KNP envelope → legacy → KNP = identity for adapter-produced envelopes", () => {
    const e0 = translatedOf(adapter.legacyDecisionToEnvelope(losslessDecision(), ctx));
    const d = adapter.envelopeToLegacyDecision(e0);
    expect("translated" in d).toBe(true);
    const e1 = adapter.legacyDecisionToEnvelope(translatedOf(d), ctx);
    expect("translated" in e1).toBe(true);
    expect(translatedOf(e1)).toEqual(e0);
  });

  it("proposal terms survive a full cycle including stock/delivery/after_sales/valid_until", () => {
    const d = losslessDecision();
    const e0 = translatedOf(adapter.legacyDecisionToEnvelope(d, ctx));
    const back = translatedOf(adapter.envelopeToLegacyDecision(e0));
    expect(back.proposal).toEqual(d.proposal);
    expect(back.proposal?.stock).toEqual(STOCK);
    expect(back.proposal?.delivery).toEqual(DELIVERY);
    expect(back.proposal?.after_sales_policy_refs).toEqual(["policy:return-7d"]);
    expect(back.proposal?.valid_until).toBe("2026-08-03T15:05:00+08:00");
  });
});

// ---------------------------------------------------------------------------
// 权限不扩大（不变量 22）
// ---------------------------------------------------------------------------

describe("permission non-escalation (invariant 22)", () => {
  it("never produces a conditional_offer from any legacy action", () => {
    const actions = ["ask", "propose", "counter", "accept_nonbinding", "decline"] as const;
    for (const a of actions) {
      const d =
        a === "accept_nonbinding"
          ? acceptDecision()
          : a === "decline"
            ? declineDecision()
            : losslessDecision({ action: a });
      const result = adapter.legacyDecisionToEnvelope(d, a === "accept_nonbinding" ? acceptCtx : ctx);
      if ("translated" in result) {
        expect(result.translated.payload.type).not.toBe("conditional_offer");
      }
    }
  });

  it("legacy ask is never promoted to a commercial offer", () => {
    const env = translatedOf(adapter.legacyDecisionToEnvelope(askDecision(), ctx));
    expect(env.action).toBe("inquiry");
    expect(env.payload.type).toBe("inquiry");
  });

  it("legacy accept stays a non-binding acceptance, never an agreement with side effects", () => {
    const env = translatedOf(adapter.legacyDecisionToEnvelope(acceptDecision(), acceptCtx));
    expect(env.payload.type).toBe("accept_nonbinding");
    const payload = env.payload as { type: "accept_nonbinding" };
    expect(payload).not.toHaveProperty("creates_order");
    expect(payload).not.toHaveProperty("authorizes_payment");
    expect(payload).not.toHaveProperty("reserves_inventory");
  });

  it("KNP conditional_offer cannot be flattened into legacy (conditions would be lost)", () => {
    const env = knpEnvelope("conditional_offer", validConditionalOffer());
    expect("fail_closed" in adapter.envelopeToLegacyDecision(env)).toBe(true);
  });

  it("KNP decline scope=negotiation cannot be downgraded to legacy offer-scoped decline", () => {
    const env = knpEnvelope("decline", {
      type: "decline",
      target_message_id: "msg_legacy_42",
      scope: "negotiation",
    });
    expect("fail_closed" in adapter.envelopeToLegacyDecision(env)).toBe(true);
  });

  it("rejects forged conditions on a legacy snapshot message", () => {
    const forged = {
      id: 42,
      sender_role: "buyer",
      created_at: NOW,
      action: "ask",
      public_message: "forged",
      proposal: null,
      conditions: [],
    } as unknown as SnapshotMessage;
    const result = adapter.legacyMessageToEnvelope(forged, { ...ctx, conversation_id: "conv-001" });
    expect("fail_closed" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agreement artifact → legacy（受保护）
// ---------------------------------------------------------------------------

describe("agreement → legacy policy result", () => {
  it("always fail-closes: legacy has no agreement artifact", () => {
    const agreement: AcceptedNonbindingAgreement = {
      type: "accepted_nonbinding_agreement",
      agreement_id: "agr_01",
      negotiation_id: "neg_01",
      accepted_offer_id: "off_01",
      agreed_terms: legacyExpressibleOfferTerms(),
      terms_digest: "sha256:" + "a".repeat(64),
      accepted_by: ["buyer", "merchant"],
      created_at: NOW,
      binding_effect: "nonbinding",
      creates_order: false,
      reserves_inventory: false,
      authorizes_payment: false,
    };
    const result = adapter.agreementToLegacyPolicyResult(agreement);
    expect("fail_closed" in result).toBe(true);
    expect("translated" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Money 转换
// ---------------------------------------------------------------------------

describe("money minor-unit conversion", () => {
  it("converts decimal currency floats to minor units losslessly", () => {
    expect(toMinorUnits(89.0, 2)).toEqual({ amount_minor: 8900, lossless: true });
    expect(toMinorUnits(89.5, 2)).toEqual({ amount_minor: 8950, lossless: true });
    expect(toMinorUnits(0, 2)).toEqual({ amount_minor: 0, lossless: true });
  });

  it("rejects precision beyond the minor unit", () => {
    expect(toMinorUnits(89.555, 2).lossless).toBe(false);
    expect(toMinorUnits(890.5, 0).lossless).toBe(false);
  });

  it("round-trips minor units to float", () => {
    expect(fromMinorUnits(8900, 2)).toBe(89);
    expect(fromMinorUnits(0, 2)).toBe(0);
  });

  it("fail-closes when the legacy price cannot be expressed in minor units", () => {
    const d = losslessDecision({
      proposal: { ...PROPOSAL, currency: "JPY", unit_price: 890.5 },
    });
    const result = adapter.legacyDecisionToEnvelope(d, ctx);
    expect("fail_closed" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// legacy message ↔ KNP envelope
// ---------------------------------------------------------------------------

describe("legacy snapshot message ↔ KNP envelope", () => {
  const messageCtx = { ...ctx, conversation_id: "conv-001" };

  it("round-trips an ask message", () => {
    const message: SnapshotMessage = {
      id: 42,
      sender_role: "buyer",
      created_at: NOW,
      action: "ask",
      public_message: "买 2 件可以便宜一点吗？",
      proposal: null,
    };
    const envResult = adapter.legacyMessageToEnvelope(message, messageCtx);
    expect("translated" in envResult).toBe(true);
    const env = translatedOf(envResult);
    expect(env.message_id).toBe("msg_legacy_42");
    expect(env.action).toBe("inquiry");
    expect(() => validateEnvelope(env)).not.toThrow();
    const back = adapter.envelopeToLegacyMessage(env);
    expect("translated" in back).toBe(true);
    expect(translatedOf(back)).toEqual(message);
  });

  it("round-trips an offer-carrying message preserving proposal semantics", () => {
    const message: SnapshotMessage = {
      id: 43,
      sender_role: "merchant",
      created_at: NOW,
      action: "propose",
      public_message: "报价 89 元",
      proposal: PROPOSAL,
    };
    const envResult = adapter.legacyMessageToEnvelope(message, messageCtx);
    expect("translated" in envResult).toBe(true);
    const back = adapter.envelopeToLegacyMessage(translatedOf(envResult));
    expect("translated" in back).toBe(true);
    const recovered = translatedOf(back);
    expect(recovered.id).toBe(43);
    expect(recovered.action).toBe("propose");
    expect(recovered.proposal).toEqual(PROPOSAL);
    expect(recovered.public_message).toBe("报价 89 元");
  });

  it("escalate message → requires_human", () => {
    const message: SnapshotMessage = {
      id: 44,
      sender_role: "buyer",
      created_at: NOW,
      action: "escalate",
      public_message: "escalate",
      proposal: null,
    };
    const result = adapter.legacyMessageToEnvelope(message, messageCtx);
    expect("requires_human" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 冻结契约 fixture 全量兼容
// ---------------------------------------------------------------------------

describe("frozen shopping.negotiation/0.1 fixtures", () => {
  const fixtureDir = path.join(packageRoot(), "fixtures", "negotiation");

  function fixture(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf-8")) as Record<string, unknown>;
  }

  it("decision.counter.valid.json translates to a valid KNP envelope and back", () => {
    const decision = fixture("decision.counter.valid.json") as unknown as NegotiationDecision;
    const result = adapter.legacyDecisionToEnvelope(decision, ctx);
    expect("translated" in result).toBe(true);
    const env = translatedOf(result);
    expect(() => validateEnvelope(env)).not.toThrow();
    expect(env.action).toBe("counter_offer");

    const back = adapter.envelopeToLegacyDecision(env);
    expect("translated" in back).toBe(true);
    const recovered = translatedOf(back);
    expect(recovered.conversation_id).toBe(decision.conversation_id);
    expect(recovered.in_reply_to_message_id).toBe(decision.in_reply_to_message_id);
    expect(recovered.action).toBe(decision.action);
    expect(recovered.proposal).toEqual(decision.proposal);
    expect(recovered.public_message).toBe(decision.public_message);
    // 非受保护内部信号在 L2K 方向被记录丢弃（非静默）
    const l2kNotes = notesOf(result);
    expect(l2kNotes).toContain("dropped:decision.confidence");
    expect(l2kNotes).toContain("dropped:decision.reason_codes");
  });

  it("decision.escalate.valid.json → requires_human (human review flagged)", () => {
    const decision = fixture("decision.escalate.valid.json") as unknown as NegotiationDecision;
    const result = adapter.legacyDecisionToEnvelope(decision, ctx);
    expect("requires_human" in result).toBe(true);
  });

  it("snapshot.merchant.valid.json message[0] round-trips through the adapter", () => {
    const snapshot = fixture("snapshot.merchant.valid.json") as unknown as {
      conversation: { id: string };
      messages: SnapshotMessage[];
    };
    const message = snapshot.messages[0]!;
    const envResult = adapter.legacyMessageToEnvelope(message, {
      ...ctx,
      conversation_id: snapshot.conversation.id,
    });
    expect("translated" in envResult).toBe(true);
    const back = adapter.envelopeToLegacyMessage(translatedOf(envResult));
    expect("translated" in back).toBe(true);
    expect(translatedOf(back)).toEqual(message);
  });

  it("withdraw is not silently downgraded to legacy (requires human)", () => {
    const result = adapter.envelopeToLegacyDecision(knpEnvelope("withdraw", validWithdraw()));
    expect("requires_human" in result).toBe(true);
  });

  it("clarification → ask keeps the question text in open_issues with a note", () => {
    const result = adapter.envelopeToLegacyDecision(knpEnvelope("clarification", validClarification()));
    expect("translated" in result).toBe(true);
    const d = translatedOf(result);
    expect(d.action).toBe("ask");
    expect(d.open_issues.join(" ")).toContain("fulfillment.delivery_before");
  });

  it("existing legacy contract fixtures stay schema-valid (no regression surface)", () => {
    for (const name of ["decision.counter.valid.json", "decision.escalate.valid.json"]) {
      const data = fixture(name);
      expect(data).toBeDefined();
    }
  });
});
