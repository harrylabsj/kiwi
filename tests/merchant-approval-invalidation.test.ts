/**
 * T047（M2 首验）：审批前规则/商品变化 → 旧许可失效，不得按旧价成交。
 *
 * 设计 §10.2：`审批时商品/规则已变化 → 使旧候选失效或重新确认，不能执行过期许可`。
 *
 * 历史行为（本次修复前）：`conditional_offer` 只带 terms/valid_until，
 * accept 只校验 offer_id / valid_until / terms_digest —— 商家在发出条件价之后
 * 提高底价、改促销或改商品价，买家仍可**按旧价**成交（等于执行过期许可）。
 *
 * 修复后：条件价携带 `policy_digest`（运行中规则摘要）与 `product_fingerprint`
 * （商品事实指纹），accept 前重验两者；任一变化 → `approval_required`，且不产生
 * 任何终态副作用（不推进相位、不产出 agreement）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { evaluateConditionalOffer } from "../src/negotiation/condition/evaluator.js";
import type { MerchantPolicy } from "../src/config/profile.js";

const NOW = "2026-09-21T02:00:00Z";
const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

function envelopeFor(
  action: string,
  payload: Record<string, unknown>,
  negotiationId = "neg_approval_001",
): NegotiationEnvelope {
  seq += 1;
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: negotiationId,
    exchange_id: `ex_approval_${seq}`,
    message_id: `msg_approval_${seq}`,
    actor: "buyer",
    action,
    created_at: NOW,
    payload: { type: action, ...payload },
  } as never);
}

async function run(
  handler: NegotiationHandler,
  envelope: NegotiationEnvelope,
): Promise<NegotiationHandlerResult> {
  return handler.handle({
    envelope: envelope as never,
    message: { role: "user", parts: [], messageId: envelope.message_id },
    taskId: `task_approval_${seq}`,
    senderIdentity: "buyer:buyer-001",
  });
}

interface Harness {
  handler: NegotiationHandler;
  setPolicy: (policy: MerchantPolicy) => void;
  setPrice: (price: number) => void;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-approval-"));
  dirs.push(dir);
  let policy: MerchantPolicy = { max_auto_discount_percent: 10 };
  let price = 850; // major：850.00 → 85000 minor
  const handler = createMerchantHandler({
    ledger: new LedgerStore({ dir: join(dir, "ledger"), now: () => NOW }),
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    productSource: {
      getProduct: async () => ({ price, currency: "CNY", stock: 200 }),
    },
    merchantPolicy: () => policy,
  });
  return { handler, setPolicy: (p) => { policy = p; }, setPrice: (p) => { price = p; } };
}

function payloadOf(result: NegotiationHandlerResult): Record<string, unknown> | undefined {
  if (result.kind !== "accepted" || result.message === undefined) return undefined;
  return (
    result.message.parts[0] as unknown as {
      data?: { knp_envelope?: { payload?: Record<string, unknown> } };
    }
  ).data?.knp_envelope?.payload;
}

/** rfq → counter_offer → conditional_offer，返回条件价与其 agreed terms。 */
async function reachConditional(handler: NegotiationHandler): Promise<{
  offerId: string;
  termsDigest: string;
}> {
  await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
  const conditional = await run(
    handler,
    envelopeFor("counter_offer", {
      offer_id: "off_buyer",
      proposed_terms: { items: [{ sku: "SKU-001", quantity: { value: 200 }, unit_price: { amount_minor: 80000 } }] },
    }),
  );
  const payload = payloadOf(conditional);
  expect(payload?.["type"]).toBe("conditional_offer");
  const agreedTerms = evaluateConditionalOffer(payload as never, { "aggregate.total_quantity": 200 });
  return {
    offerId: String(payload?.["offer_id"] ?? ""),
    termsDigest: contentDigest(agreedTerms as never),
  };
}

describe("T047：规则/商品变化使旧许可失效", () => {
  it("规则未变 → accept 正常成交（对照组）", async () => {
    const { handler } = setup();
    const { offerId, termsDigest } = await reachConditional(handler);
    const accepted = await run(
      handler,
      envelopeFor("accept_nonbinding", { offer_id: offerId, terms_digest: termsDigest }),
    );
    expect(accepted.kind).toBe("accepted");
    expect(JSON.stringify(accepted)).toContain("agreement");
  });

  it("报价后商家改了规则（公开折扣边界）→ accept 被拒 approval_required，不产出 agreement", async () => {
    const { handler, setPolicy } = setup();
    const { offerId, termsDigest } = await reachConditional(handler);
    // 商家收紧公开折扣边界（10% → 0）：先前发出的条件价已不在规则内。
    setPolicy({ max_auto_discount_percent: 0 });
    const accepted = await run(
      handler,
      envelopeFor("accept_nonbinding", { offer_id: offerId, terms_digest: termsDigest }),
    );
    expect(accepted.kind).toBe("declined");
    expect(accepted.kind === "declined" && accepted.reasonCode).toBe("approval_required");
    expect(JSON.stringify(accepted)).not.toContain("agreement");
  });

  it("报价后商品价变化 → accept 被拒 approval_required（商品事实指纹失配）", async () => {
    const { handler, setPrice } = setup();
    const { offerId, termsDigest } = await reachConditional(handler);
    setPrice(900); // 850 → 900：报价依据的商品事实已变
    const accepted = await run(
      handler,
      envelopeFor("accept_nonbinding", { offer_id: offerId, terms_digest: termsDigest }),
    );
    expect(accepted.kind).toBe("declined");
    expect(accepted.kind === "declined" && accepted.reasonCode).toBe("approval_required");
  });

  it("拒绝后不产生终态副作用：规则改回后同一 conditional 仍可成交", async () => {
    const { handler, setPolicy } = setup();
    const { offerId, termsDigest } = await reachConditional(handler);
    setPolicy({ max_auto_discount_percent: 0 });
    const refused = await run(
      handler,
      envelopeFor("accept_nonbinding", { offer_id: offerId, terms_digest: termsDigest }),
    );
    expect(refused.kind).toBe("declined");
    // 规则恢复 → 旧 conditional 的规则摘要重新匹配，且相位未被推进过。
    setPolicy({ max_auto_discount_percent: 10 });
    const accepted = await run(
      handler,
      envelopeFor("accept_nonbinding", { offer_id: offerId, terms_digest: termsDigest }),
    );
    expect(accepted.kind).toBe("accepted");
  });
});
