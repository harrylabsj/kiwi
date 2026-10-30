/**
 * 过期报价自动终止：OFFER_OPEN + valid_until 过期 → Ledger 追加 EXPIRED。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { createNegotiationObserver } from "../src/merchant/negotiation-observer.js";
import { expireOverdueOffers } from "../src/merchant-runtime/expire-offers.js";

const NOW = "2026-10-30T00:00:00Z";
const LATER = "2026-10-31T01:00:00Z"; // NOW + 25h
const SOON = "2026-10-30T01:00:00Z"; // NOW + 1h
const NEGOTIATION_ID = "neg_expiry_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";

describe("offers expire after 24h", () => {
  let dataDir: string;
  let ledger: LedgerStore;
  let seq = 0;
  let handler: ReturnType<typeof createMerchantHandler>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "kiwi-expiry-"));
    ledger = new LedgerStore({ dir: join(dataDir, "a2a"), now: () => NOW });
    handler = createMerchantHandler({
      productSource: {
        async getProduct() {
          return {
            price: 850,
            currency: "CNY",
            unit: "piece",
            stock: 1_000,
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      merchantPolicy: { price_floors: { [SKU]: 800 } },
    });
    seq = 10;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const envelopeFor = (action: string, payload: Record<string, unknown>): NegotiationEnvelope => {
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

  const run = async (envelope: NegotiationEnvelope) =>
    handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });

  const createOffer = async (): Promise<void> => {
    await run(
      envelopeFor("rfq", {
        type: "rfq",
        items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }],
      }),
    );
    const offer = await run(
      envelopeFor("counter_offer", {
        type: "counter_offer",
        offer_id: `off_${seq}`,
        proposed_terms: {
          currency: "CNY",
          items: [
            {
              sku: SKU,
              quantity: { value: 10, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 84_000 },
            },
          ],
        },
      }),
    );
    expect(offer.kind).toBe("accepted");
  };

  it("未到期不终止；到期后追加 EXPIRED 且幂等", async () => {
    await createOffer();
    const observer = createNegotiationObserver({ ledgerDir: join(dataDir, "a2a"), now: () => NOW });
    expect(observer.timeline(NEGOTIATION_ID).phase).toBe("OFFER_OPEN");

    expect((await expireOverdueOffers({ dataDir, now: () => SOON })).expired).toBe(0);
    expect((await expireOverdueOffers({ dataDir, now: () => LATER })).expired).toBe(1);
    expect(observer.timeline(NEGOTIATION_ID).phase).toBe("EXPIRED");
    expect((await expireOverdueOffers({ dataDir, now: () => LATER })).expired).toBe(0);
  });

  it("runtime 标准任务在提供 expireOffers 时注册 offer-expiry", async () => {
    const { standardMerchantJobs } = await import("../src/merchant-runtime/jobs.js");
    const base = standardMerchantJobs({ healthPoll: async () => {} });
    expect(base.map((job) => job.name)).toEqual(["health-poll", "backup"]);
    const withExpiry = standardMerchantJobs({
      healthPoll: async () => {},
      expireOffers: async () => {},
    });
    expect(withExpiry.map((job) => job.name)).toEqual(["health-poll", "backup", "offer-expiry"]);
  });

  it("外部写入 EXPIRED 后，A2A handler 的下一轮商业动作被拒绝", async () => {
    await createOffer();
    await expireOverdueOffers({ dataDir, now: () => LATER });
    const result = await run(
      envelopeFor("counter_offer", {
        type: "counter_offer",
        offer_id: "off_late",
        proposed_terms: {
          currency: "CNY",
          items: [{ sku: SKU, quantity: { value: 10, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 80_000 } }],
        },
      }),
    );
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") expect(result.reasonCode).toBe("state_conflict");
  });
});
