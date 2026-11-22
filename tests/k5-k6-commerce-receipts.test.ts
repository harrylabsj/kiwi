/**
 * 买家识别与交易回执 · K5/K6 买卖两端上报各自的意向/入口证据。
 *
 * 覆盖：商家“协议已签发”（binding thumbprint 与买方同口径）、“商家已提供
 * 入口”（带入口报价正式发出后，早于协议）；outbox 幂等/退避/重启补报；
 * 买方提交器 JWS 形状（与 Catalog C1 的自包含 JWS 契约一致）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import {
  BuyerReceiptSubmitter,
  ReceiptOutbox,
  thumbprintFromOpenInquiryIdentity,
  type CommerceReceipt,
  type EntryReceipt,
  type IntentReceipt,
} from "../src/commerce/receipt/receipts.js";
import { ReceiptDispatcher } from "../src/commerce/receipt/dispatcher.js";

const NOW = "2026-11-07T04:00:00.000Z";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const MERCHANT = "merchant-a";
const SKU = "VQ-001";

/** 生成真实 Ed25519 钥对 + 对应的开放询价身份串（keyid）。 */
function makeOpenInquiryIdentity(): {
  identity: string;
  publicKeyPem: string;
  privateKeyPem: string;
  thumbprint: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawPublic = spki.subarray(spki.length - 32);
  const encoded = rawPublic.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const identity = `kiwi-inquiry-session-v1:${encoded}`;
  return { identity, publicKeyPem, privateKeyPem, thumbprint: thumbprintFromOpenInquiryIdentity(identity)! };
}

describe("K5 binding 同口径（商家看到的身份 ↔ 买方签名钥）", () => {
  it("开放询价身份推导的 thumbprint = 同钥买方提交器的 buyerBinding", () => {
    const { identity, publicKeyPem, privateKeyPem, thumbprint } = makeOpenInquiryIdentity();
    const submitter = new BuyerReceiptSubmitter({ catalogUrl: "http://placeholder.local", publicKeyPem, privateKeyPem });
    expect(thumbprintFromOpenInquiryIdentity(identity)).toBe(thumbprint);
    expect(submitter.buyerBinding).toBe(thumbprint);
    expect(thumbprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("无前缀 / 畸形身份 → undefined（不产生错误 binding）", () => {
    expect(thumbprintFromOpenInquiryIdentity("buyer:static")).toBeUndefined();
    expect(thumbprintFromOpenInquiryIdentity("kiwi-inquiry-session-v1:not-base64!!")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 商家侧：入口上报（K6）+ 协议签发上报（K5）
// ---------------------------------------------------------------------------

describe("K5/K6 商家侧回执", () => {
  let dir: string;
  let ledger: LedgerStore;
  let seq = 0;
  let identity: ReturnType<typeof makeOpenInquiryIdentity>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k5-merchant-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    identity = makeOpenInquiryIdentity();
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envelopeOf = (action: string, payload: Record<string, unknown>, negotiationId = "neg_k5"): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: negotiationId,
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
    handler: ReturnType<typeof makeHandler>,
    envelope: NegotiationEnvelope,
  ) =>
    await handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${envelope.message_id}`,
      senderIdentity: identity.identity,
      identityVerified: true,
    });

  const makeHandler = (submitted: CommerceReceipt[], dispatcher?: ReceiptDispatcher) =>
    createMerchantHandler({
      productSource: {
        async getProduct() {
          return {
            price: 110,
            currency: "CNY",
            stock: 500,
            unit: "piece",
            source_evidence: { system: "owned-test-fixture" },
            handoff_destination: "ucp://checkout/channel-x/session",
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant-agent",
      counterparty: "buyer:*",
      commerceReceipts: {
        merchantId: MERCHANT,
        dispatcher: dispatcher ?? {
          enqueueAndDeliver: async (receipt: CommerceReceipt) => {
            submitted.push(receipt);
          },
        } as never,
      },
    });

  it("带入口的报价正式发出 → merchant_entry_offered（早于协议，quote_ref 关联）", async () => {
    const submitted: CommerceReceipt[] = [];
    const handler = makeHandler(submitted);
    const result = await runWith(handler, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }));
    expect(result.kind).toBe("accepted");
    const entries = submitted.filter(
      (r): r is EntryReceipt => r.event_type === "merchant_entry_offered",
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.merchant_id).toBe(MERCHANT);
    expect(entry.entry_type).toBe("quote_handoff");
    expect(entry.quote_ref.negotiation_id).toBe("neg_k5");
    expect(entry.quote_ref.offer_id).toMatch(/^off_/);
    expect(entry.quote_ref.terms_digest).toMatch(/^sha256:/);
    expect(entry.event_id).toBe(`merchant-entry:${entry.event_id.split(":")[1]}`);
    // 无协议回执：入口事实独立于意向。
    expect(submitted.filter((r) => r.event_type === "merchant_agreement_issued")).toHaveLength(0);
  });

  it("recovers a missing outbox entry once and skips ledger reads on idle ticks and restarts", async () => {
    await runWith(makeHandler([]), envelopeOf("rfq", {
      type: "rfq", items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }));
    const outbox = new ReceiptOutbox({ dbPath: join(dir, "checkpoint.sqlite"), now: () => NOW });
    try {
      const dispatcher = new ReceiptDispatcher({ outbox, submitter: { submit: async () => {} } });
      let reads = 0;
      const read = ledger.readReceiptLedger.bind(ledger);
      ledger.readReceiptLedger = (file) => { reads++; return read(file); };
      const handler = makeHandler([], dispatcher);
      handler.recoverReceipts?.();
      expect(outbox.due()).toHaveLength(1);
      handler.recoverReceipts?.();
      makeHandler([], dispatcher).recoverReceipts?.();
      expect(reads).toBe(1);
    } finally {
      outbox.close();
    }
  });

  it("有效 accept → merchant_agreement_issued（binding=thumbprint，event_id 绑定协议号）", async () => {
    const submitted: CommerceReceipt[] = [];
    const handler = makeHandler(submitted);
    await runWith(handler, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }));
    const offerReply = await runWith(handler, envelopeOf("counter_offer", {
      offer_id: "off_buyer",
      proposed_terms: { items: [{ sku: SKU, quantity: { value: 50, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 11000 } }] },
    }));
    if (offerReply.kind !== "accepted" || offerReply.message === undefined) throw new Error("counter flow failed");
    const conditional = (offerReply.message.parts[0] as unknown as {
      data: { knp_envelope: { payload: Record<string, unknown> } };
    }).data.knp_envelope.payload;
    const { evaluateConditionalOffer } = await import("../src/negotiation/condition/evaluator.js");
    const agreedTerms = evaluateConditionalOffer(conditional as never, { "aggregate.total_quantity": 50 }) as Record<string, unknown>;
    const offerId = (conditional as { offer_id?: string }).offer_id as string;
    seq += 1;
    const acceptEnvelope = finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: "neg_k5",
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: `msg_${seq - 1}`,
      actor: "buyer",
      action: "accept_nonbinding",
      created_at: NOW,
      payload: { type: "accept_nonbinding", offer_id: offerId, terms_digest: contentDigest(agreedTerms as never) } as never,
    });
    const accepted = await runWith(handler, acceptEnvelope);
    expect(accepted.kind).toBe("accepted");
    const intents = submitted.filter(
      (r): r is IntentReceipt => r.event_type === "merchant_agreement_issued",
    );
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.merchant_id).toBe(MERCHANT);
    expect(intent.negotiation_id).toBe("neg_k5");
    expect(intent.merchant_agreement_id).toMatch(/^agr_/);
    expect(intent.accepted_offer_id).toBe(offerId);
    expect(intent.terms_digest).toBe(contentDigest(agreedTerms as never));
    // binding 与买方提交器同口径（同一把会话钥）。
    expect(intent.buyer_binding).toBe(identity.thumbprint);
    expect(intent.event_id).toBe(`merchant-agreement:${intent.merchant_agreement_id}`);
  });
});

// ---------------------------------------------------------------------------
// Outbox：幂等、退避、重启补报、无重复
// ---------------------------------------------------------------------------

describe("K5/K6 outbox 与调度", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k5-outbox-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sample: CommerceReceipt = {
    event_id: "merchant-agreement:agr_1",
    event_type: "merchant_agreement_issued",
    merchant_id: "merchant-a",
    negotiation_id: "neg-1",
    merchant_agreement_id: "agr_1",
    accepted_offer_id: "off_1",
    terms_digest: "sha256:" + "a".repeat(64),
    buyer_binding: "sha256:" + "b".repeat(64),
    occurred_at: NOW,
  };

  it("同 event_id 幂等入队；故障后退避；重启 drain 补报且无重复统计（B4）", async () => {
    let nowMs = Date.parse(NOW);
    const now = () => new Date(nowMs).toISOString();
    const dbPath = join(dir, "outbox.sqlite");
    let outbox = new ReceiptOutbox({ dbPath, now });
    expect(outbox.enqueue(sample)).toBe(true);
    expect(outbox.enqueue(sample)).toBe(false); // 同 ID 不重复
    expect(outbox.pendingCount()).toBe(1);

    let healthy = false;
    const dispatcher = new ReceiptDispatcher({
      outbox,
      submitter: {
        submit: async () => {
          if (!healthy) throw new Error("catalog down");
        },
      },
    });
    await dispatcher.drain();
    expect(outbox.pendingCount()).toBe(1);
    // 退避期内不出队。
    nowMs += 1000;
    expect(outbox.due()).toHaveLength(0);

    // “重启”：新实例打开同一库，退避到期后补报。
    nowMs += 60_000;
    outbox.close();
    outbox = new ReceiptOutbox({ dbPath, now });
    healthy = true;
    const recovered = new ReceiptDispatcher({ outbox, submitter: { submit: async () => undefined } });
    expect(await recovered.drain()).toBe(1);
    expect(outbox.pendingCount()).toBe(0);
    expect(await recovered.drain()).toBe(0); // 无重复
    outbox.close();
  });

  it("入队即投递成功路径：不重复投递", async () => {
    const submitted: CommerceReceipt[] = [];
    const outbox = new ReceiptOutbox({ dbPath: join(dir, "outbox-ok.sqlite"), now: () => NOW });
    const dispatcher = new ReceiptDispatcher({
      outbox,
      submitter: { submit: async (receipt): Promise<void> => void submitted.push(receipt) },
    });
    await dispatcher.enqueueAndDeliver(sample);
    expect(submitted).toHaveLength(1);
    expect(outbox.pendingCount()).toBe(0);
    outbox.close();
  });
});

// ---------------------------------------------------------------------------
// 买方提交器 JWS 形状（与 Catalog C1 自包含 JWS 契约一致）
// ---------------------------------------------------------------------------

describe("买方回执提交器 JWS 形状", () => {
  it("sign 覆盖回执字段 + jwk 嵌入 + kid=thumbprint；submit 走 buyer_signature 通道", async () => {
    const { publicKeyPem, privateKeyPem } = makeOpenInquiryIdentity();
    const submitter = new BuyerReceiptSubmitter({ catalogUrl: "http://placeholder.local", publicKeyPem, privateKeyPem });
    const receipt: CommerceReceipt = {
      event_id: "buyer-agreement:agreement-1",
      event_type: "buyer_agreement_accepted",
      merchant_id: "merchant-a",
      negotiation_id: "neg-1",
      merchant_agreement_id: "agr-1",
      accepted_offer_id: "off-1",
      terms_digest: "sha256:" + "c".repeat(64),
      buyer_binding: submitter.buyerBinding,
      occurred_at: NOW,
    };
    const jws = submitter.sign(receipt, NOW);
    const segments = jws.split(".");
    expect(segments).toHaveLength(3);
    const header = JSON.parse(Buffer.from(segments[0]!, "base64").toString());
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64").toString());
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(submitter.buyerBinding);
    expect(payload.event_id).toBe(receipt.event_id);
    expect(payload.terms_digest).toBe(receipt.terms_digest);
    expect(payload.jwk.kty).toBe("OKP");
    expect(payload.jwk.crv).toBe("Ed25519");
    expect(payload.issued_at).toBe(NOW);

    const bodies: Array<Record<string, unknown>> = [];
    const postingSubmitter = new BuyerReceiptSubmitter({
      catalogUrl: "http://placeholder.local",
      publicKeyPem,
      privateKeyPem,
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    await postingSubmitter.submit(receipt);
    expect(typeof bodies[0]?.buyer_signature).toBe("string");
    expect((bodies[0] as { event_id?: string }).event_id).toBe(receipt.event_id);
  });
});
