/**
 * 店主经营面（WP：磋商旁观 + 及时参与）。
 *
 * 覆盖 owner 投影、审批 rejected、低于底价拦截、`/ops` loopback Bearer 面。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { createNegotiationObserver } from "../src/merchant/negotiation-observer.js";
import { createNegotiationOps } from "../src/merchant/negotiation-ops.js";
import { startMerchantOpsServer } from "../src/mcp/merchant-ops-server.js";

const NOW = "2026-10-30T02:00:00Z";
const NEGOTIATION_ID = "neg_ops_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";
/** 850 元；公开折扣 5% → 807.50；私有底价 810 → 公开边界低于底价。 */
const merchantPolicy = { price_floors: { [SKU]: 810 }, max_auto_discount_percent: 5 };

describe("merchant negotiation ops", () => {
  let base: string;
  let dataDir: string;
  let ledger: LedgerStore;
  let approvals: NegotiationApprovalStore;
  let seq = 0;
  let handler: ReturnType<typeof createMerchantHandler>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kiwi-ops-"));
    dataDir = join(base, "data");
    ledger = new LedgerStore({ dir: join(dataDir, "a2a"), now: () => NOW });
    approvals = NegotiationApprovalStore.forDataDir(dataDir, () => NOW);
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
      merchantPolicy,
      negotiationApprovals: approvals,
    });
    seq = 5;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
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

  const rfq = () =>
    run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }));

  const counter = (unitPriceMinor: number) =>
    run(
      envelopeFor("counter_offer", {
        type: "counter_offer",
        offer_id: `off_${seq}`,
        proposed_terms: {
          currency: "CNY",
          items: [
            {
              sku: SKU,
              quantity: { value: 10, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: unitPriceMinor },
            },
          ],
        },
      }),
    );

  const ops = () =>
    createNegotiationOps({
      ledgerDir: join(dataDir, "a2a"),
      approvals,
      merchantId: "merchant-001",
      version: "0.12.16",
      now: () => NOW,
    });

  it("默认投影不出现金额；owner 投影出现单价/币种", async () => {
    await rfq();
    const observer = createNegotiationObserver({ ledgerDir: join(dataDir, "a2a"), now: () => NOW });

    const publicList = observer.list({ status: "all" });
    expect(publicList.items[0]?.price_minor).toBeUndefined();
    const publicDetail = observer.timeline(NEGOTIATION_ID);
    expect(publicDetail.timeline.some((entry) => entry.unit_price_minor !== undefined)).toBe(false);

    const ownerList = observer.listOwner({ status: "all" });
    expect(ownerList.items[0]).toMatchObject({
      price_minor: 85_000,
      currency: "CNY",
      last_event_kind: expect.any(String),
    });
    const ownerDetail = observer.timelineOwner(NEGOTIATION_ID);
    const merchantOffer = ownerDetail.timeline.find((entry) => entry.direction === "merchant");
    expect(merchantOffer).toMatchObject({ unit_price_minor: 85_000, currency: "CNY" });
  });

  it("低于私有底价的批准被拦截；底价批准成功且重复批准 409", async () => {
    await rfq();
    await counter(70_000);
    const service = ops();
    const pending = service.listApprovals("pending");
    expect(pending).toHaveLength(1);
    const approvalId = pending[0]!.approval_id;

    expect(() =>
      service.approve({ approval_id: approvalId, approved_minor: 80_900, actor: "catalog:account:12" }),
    ).toThrowError(/低于私有底价/);

    const approved = service.approve({
      approval_id: approvalId,
      approved_minor: 81_000,
      actor: "catalog:account:12",
    });
    expect(approved.status).toBe("approved");
    expect(approved.approved_minor).toBe(81_000);
    expect(() =>
      service.approve({ approval_id: approvalId, approved_minor: 81_000, actor: "catalog:account:12" }),
    ).toThrowError(/已处理/);
  });

  it("拒绝 pending 后不可再批准，且记录原因", async () => {
    await rfq();
    await counter(70_000);
    const service = ops();
    const approvalId = service.listApprovals("pending")[0]!.approval_id;
    const rejected = service.reject({
      approval_id: approvalId,
      reason: "低于成本",
      actor: "catalog:account:12",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejected_reason).toBe("低于成本");
    expect(() =>
      service.approve({ approval_id: approvalId, approved_minor: 81_000, actor: "catalog:account:12" }),
    ).toThrowError(/已处理/);
  });

  it("/ops 只接受 loopback Bearer，并完成读/审批流程", async () => {
    await rfq();
    await counter(70_000);
    const service = ops();
    const handle = await startMerchantOpsServer({ service, token: "t".repeat(64), port: 0 });
    try {
      const baseUrl = `http://127.0.0.1:${handle.port}`;
      expect((await fetch(`${baseUrl}/ops/v1/info`)).status).toBe(401);
      expect(
        (
          await fetch(`${baseUrl}/ops/v1/info`, {
            headers: { authorization: `Bearer ${"t".repeat(64)}`, "x-forwarded-for": "203.0.113.9" },
          })
        ).status,
      ).toBe(403);

      const auth = { authorization: `Bearer ${"t".repeat(64)}` };
      const info = await (await fetch(`${baseUrl}/ops/v1/info`, { headers: auth })).json();
      expect(info).toMatchObject({ ok: true, merchant_id: "merchant-001", ledger_negotiations: 1 });

      const list = (await (
        await fetch(`${baseUrl}/ops/v1/negotiations`, { headers: auth })
      ).json()) as { items: Array<{ sku?: string; price_minor?: number }> };
      expect(list.items[0]).toMatchObject({ sku: SKU, price_minor: 85_000 });

      const detail = (await (
        await fetch(`${baseUrl}/ops/v1/negotiations/${NEGOTIATION_ID}`, { headers: auth })
      ).json()) as { negotiation: { timeline: Array<{ unit_price_minor?: number }> } };
      expect(detail.negotiation.timeline.some((entry) => entry.unit_price_minor === 85_000)).toBe(true);

      const approvalsList = (await (
        await fetch(`${baseUrl}/ops/v1/approvals?status=pending`, { headers: auth })
      ).json()) as { approvals: Array<{ approval_id: string }> };
      const approvalId = approvalsList.approvals[0]!.approval_id;

      const below = await fetch(`${baseUrl}/ops/v1/approvals/approve`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ approval_id: approvalId, approved_minor: 80_900, actor: "catalog:account:12" }),
      });
      expect(below.status).toBe(400);

      const ok = await fetch(`${baseUrl}/ops/v1/approvals/approve`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ approval_id: approvalId, approved_minor: 81_000, actor: "catalog:account:12" }),
      });
      expect(ok.status).toBe(200);
      const repeat = await fetch(`${baseUrl}/ops/v1/approvals/approve`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ approval_id: approvalId, approved_minor: 81_000, actor: "catalog:account:12" }),
      });
      expect(repeat.status).toBe(409);
    } finally {
      await handle.close();
    }
  });
});
