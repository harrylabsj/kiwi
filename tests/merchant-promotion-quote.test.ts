import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";

const NOW = "2026-09-21T12:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: {
  promotionPrice?: Parameters<typeof createMerchantHandler>[0]["promotionPrice"];
  floorMajor?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-promotion-quote-"));
  dirs.push(dir);
  const handler = createMerchantHandler({
    ledger: new LedgerStore({ dir, now: () => NOW }),
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    productSource: {
      async getProduct() {
        return { price: 100, currency: "CNY", stock: 1000 };
      },
    },
    ...(options.promotionPrice !== undefined ? { promotionPrice: options.promotionPrice } : {}),
    ...(options.floorMajor !== undefined
      ? { merchantPolicy: { price_floors: { "SKU-001": options.floorMajor } } }
      : {}),
  });
  return async (): Promise<NegotiationHandlerResult> =>
    await handler.handle({
      envelope: finalizeEnvelope({
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
        negotiation_id: `neg_${Math.random().toString(16).slice(2)}`,
        exchange_id: `ex_${Math.random().toString(16).slice(2)}`,
        message_id: `msg_${Math.random().toString(16).slice(2)}`,
        in_reply_to: "msg_previous",
        actor: "buyer",
        action: "rfq",
        created_at: NOW,
        payload: {
          items: [{ sku: "SKU-001", quantity: { value: 20, unit: "piece" } }],
        } as never,
      }) as never,
      message: { role: "user", parts: [], messageId: "msg_input" },
      taskId: "task-promotion",
      senderIdentity: "buyer:buyer-001",
    });
}

function offerTerms(result: NegotiationHandlerResult): {
  items?: Array<{ unit_price?: { currency?: string; amount_minor?: number } }>;
  valid_until?: string;
} {
  expect(result.kind).toBe("accepted");
  const part = result.kind === "accepted" ? result.message?.parts[0] : undefined;
  return (part as { data?: { knp_envelope?: { payload?: { terms?: unknown } } } }).data
    ?.knp_envelope?.payload?.terms as never;
}

describe("Workbench promotion authority in deterministic A2A quoting", () => {
  it("reads the same persisted promotion authority and stops applying it at the end boundary", async () => {
    let now = NOW;
    const store = new MerchantPromotionStore({ db: new DatabaseSync(":memory:"), now: () => now });
    const draft = store.createDraft("merchant-001", {
      skuRefs: ["SKU-001"],
      rule: {
        kind: "quantity_tiers",
        tiers: [
          {
            min_quantity: 20,
            unit_price: { currency: "CNY", amount_minor: "7500" },
          },
        ],
      },
      audience: "public",
      starts: "2026-09-21T12:00:00Z",
      ends: "2026-09-21T13:00:00Z",
      timezone: "UTC",
    });
    store.publish("merchant-001", draft.promotion_id, 1, {
      publishedBy: "owner:merchant-001",
      approvalRef: "operation-publish",
    });
    const promotionPrice = ({ sku, quantity }: { sku: string; quantity: number }) => {
      const promotion = store.activeForSku("merchant-001", sku, quantity)[0];
      return promotion === undefined
        ? undefined
        : {
            promotionId: promotion.promotion_id,
            revision: promotion.revision,
            currency: promotion.unit_price.currency,
            amountMinor: promotion.unit_price.amount_minor,
            endsAt: promotion.ends_at,
          };
    };
    const during = offerTerms(await fixture({ promotionPrice })());
    expect(during.items?.[0]?.unit_price?.amount_minor).toBe(7500);
    now = "2026-09-21T13:00:00.000Z";
    const after = offerTerms(await fixture({ promotionPrice })());
    expect(after.items?.[0]?.unit_price?.amount_minor).toBe(10_000);
  });

  it("uses the exact promotion price and caps offer validity at promotion end", async () => {
    const run = fixture({
      promotionPrice: () => ({
        promotionId: "prm-1",
        revision: 2,
        currency: "CNY",
        amountMinor: "8000",
        endsAt: "2026-09-21T13:00:00.000Z",
      }),
    });
    const terms = offerTerms(await run());
    expect(terms.items?.[0]?.unit_price).toEqual({ currency: "CNY", amount_minor: 8000 });
    expect(terms.valid_until).toBe("2026-09-21T13:00:00.000Z");
  });

  it("does not auto-quote a promotion below the private floor", async () => {
    const run = fixture({
      floorMajor: 90,
      promotionPrice: () => ({
        promotionId: "prm-1",
        revision: 2,
        currency: "CNY",
        amountMinor: "8000",
        endsAt: "2026-09-21T13:00:00.000Z",
      }),
    });
    const result = await run();
    expect(result.kind).toBe("declined");
    expect(result.kind === "declined" && result.reasonCode).toBe("approval_required");
  });

  it("fails closed on currency/range mismatch or promotion authority failure", async () => {
    const mismatch = fixture({
      promotionPrice: () => ({
        promotionId: "prm-1",
        revision: 2,
        currency: "USD",
        amountMinor: "8000",
        endsAt: "2026-09-21T13:00:00.000Z",
      }),
    });
    const mismatchResult = await mismatch();
    expect(mismatchResult.kind === "declined" && mismatchResult.reasonCode).toBe(
      "approval_required",
    );

    const unavailable = fixture({
      promotionPrice: () => {
        throw new Error("promotion database unavailable");
      },
    });
    const unavailableResult = await unavailable();
    expect(unavailableResult.kind === "declined" && unavailableResult.reasonCode).toBe(
      "temporarily_unavailable",
    );
  });
});
