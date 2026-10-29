/**
 * B2：低于自动折扣边界的还价转商家审批，人工批准后买家重试命中一次性
 * 授权价。
 *
 * 覆盖：
 *  - 越界还价不再静默丢失：返回 approval_required 且队列里有 pending；
 *  - 批准后同一 negotiation 重试 → conditional_offer 使用授权价；
 *  - 授权只消费一次，第二次重试回到审批流程；
 *  - 未批准时队列为空，行为与旧版一致（approval_required）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-10-29T10:00:00Z";
const NEGOTIATION_ID = "neg_b2_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";

/** 商品 850 元；公开折扣 5% → 807.50；私有底价 810 → 公开边界低于底价。 */
const merchantPolicy = {
  price_floors: { [SKU]: 810 },
  max_auto_discount_percent: 5,
};

describe("merchant negotiation approval (B2)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let approvals: NegotiationApprovalStore;
  let handler: NegotiationHandler;
  let seq = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-b2-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    approvals = new NegotiationApprovalStore(dir, () => NOW);
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
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envelopeFor = (
    action: string,
    payload: Record<string, unknown>,
    inReplyTo?: string,
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: inReplyTo ?? `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const run = async (envelope: NegotiationEnvelope): Promise<NegotiationHandlerResult> =>
    handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });

  const counter = (unitPriceMinor: number) => {
    const envelope = envelopeFor("counter_offer", {
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
    });
    return envelope;
  };

  const offerPrice = (result: NegotiationHandlerResult): number | undefined => {
    const envelope =
      result.kind === "accepted" && result.message
        ? (
            result.message.parts[0] as unknown as {
              data?: {
                knp_envelope?: {
                  payload?: { base_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } };
                };
              };
            }
          ).data?.knp_envelope
        : undefined;
    return envelope?.payload?.base_terms?.items?.[0]?.unit_price?.amount_minor;
  };

  it("越界还价：approval_required + 队列登记 pending（不静默拒绝）", async () => {
    await run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }));
    const result = await run(counter(70_000));
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") {
      expect(result.reasonCode).toBe("approval_required");
      expect(result.message).toContain("approval request");
    }
    const pending = approvals.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      negotiation_id: NEGOTIATION_ID,
      sku: SKU,
      buyer_offer_minor: 70_000,
      floor_minor: 81_000,
      public_bound_minor: 80_750,
    });
  });

  it("批准后重试：conditional_offer 使用一次性授权价；第二次重试回到审批", async () => {
    await run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }));
    await run(counter(70_000));
    const pending = approvals.list("pending")[0]!;
    const approved = approvals.approve({
      approval_id: pending.approval_id,
      approved_minor: 75_000,
      ttl_seconds: 600,
      approved_by: "merchant:operator",
    });
    expect(approved.status).toBe("approved");

    const retried = await run(counter(70_000));
    expect(retried.kind).toBe("accepted");
    expect(offerPrice(retried)).toBe(75_000);

    // 授权已消费：再谈一次必须重新走审批，不能重复使用批准价。
    const again = await run(counter(70_000));
    expect(again.kind).toBe("declined");
    if (again.kind === "declined") expect(again.reasonCode).toBe("approval_required");
    expect(approvals.list("pending")).toHaveLength(1);
  });

  it("重试价已高于自动边界时按常规报价，授权留到真正越界的那一笔", async () => {
    await run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }));
    await run(counter(70_000));
    const pending = approvals.list("pending")[0]!;
    approvals.approve({ approval_id: pending.approval_id, approved_minor: 75_000, ttl_seconds: 600 });

    // 840 元 > floor 810 元：本轮不需要人工授权，按常规还价响应。
    const above = await run(counter(84_000));
    expect(above.kind).toBe("accepted");
    expect(offerPrice(above)).toBe(84_000);
    // 授权没有被顺带消费，仍可用于后续真正低于边界的还价。
    expect(approvals.list("approved")).toHaveLength(1);

    const retried = await run(counter(70_000));
    expect(retried.kind).toBe("accepted");
    expect(offerPrice(retried)).toBe(75_000);
  });

  it("批准价低于买家重试出价时，报价不得低于买家出价", async () => {
    await run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }));
    await run(counter(70_000));
    const pending = approvals.list("pending")[0]!;
    approvals.approve({ approval_id: pending.approval_id, approved_minor: 75_000, ttl_seconds: 600 });

    // 800 元仍低于 floor 810，会消费授权；但买家已愿意出 800，不能回 750。
    const retried = await run(counter(80_000));
    expect(retried.kind).toBe("accepted");
    expect(offerPrice(retried)).toBe(80_000);
    expect(approvals.list("consumed")).toHaveLength(1);
  });

  it("授权过期后不生效，回到审批流程", async () => {
    await run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }));
    await run(counter(70_000));
    const pending = approvals.list("pending")[0]!;
    approvals.approve({
      approval_id: pending.approval_id,
      approved_minor: 75_000,
      ttl_seconds: 0, // 立即过期
    });
    const retried = await run(counter(70_000));
    expect(retried.kind).toBe("declined");
    if (retried.kind === "declined") expect(retried.reasonCode).toBe("approval_required");
  });

  it("审批文件固定在 <dataDir>/a2a 下（Runtime 与 CLI 必须同一约定）", () => {
    const base = mkdtempSync(join(tmpdir(), "kiwi-b2-datadir-"));
    try {
      const store = NegotiationApprovalStore.forDataDir(base, () => NOW);
      store.recordPending({
        negotiation_id: NEGOTIATION_ID,
        sku: SKU,
        currency: "CNY",
        quantity: 10,
        buyer_offer_minor: 70_000,
      });
      // 运营命令 `kiwi merchant approvals list` 读的就是这个文件；多拼一层
      // a2a 会让节点写入的 pending 永远不可见。
      expect(existsSync(join(base, "a2a", "negotiation-approvals.json"))).toBe(true);
      expect(existsSync(join(base, "a2a", "a2a", "negotiation-approvals.json"))).toBe(false);
      expect(store.list("pending")).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("审批文件读改写持有跨进程锁，完成后释放", () => {
    approvals.recordPending({
      negotiation_id: NEGOTIATION_ID,
      sku: SKU,
      currency: "CNY",
      quantity: 10,
      buyer_offer_minor: 70_000,
    });
    expect(existsSync(`${path.join(dir, "negotiation-approvals.json")}.lock`)).toBe(false);
  });

  it("回收陈旧锁，避免崩溃进程永久阻塞审批", () => {
    const stateDir = path.join(dir, "a2a");
    mkdirSync(stateDir, { recursive: true });
    const lock = path.join(stateDir, "negotiation-approvals.json.lock");
    writeFileSync(lock, "stale");
    utimesSync(lock, new Date(0), new Date(0));
    const store = new NegotiationApprovalStore(stateDir, () => NOW);
    store.recordPending({
      negotiation_id: "neg_lock",
      sku: SKU,
      currency: "CNY",
      quantity: 1,
      buyer_offer_minor: 1,
    });
    expect(store.list("pending")).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("终态记录超过保留期后在新写入时修剪，pending/有效授权保留", () => {
    let clock = NOW;
    const store = new NegotiationApprovalStore(dir, () => clock);
    const old = store.recordPending({
      negotiation_id: "neg_old",
      sku: SKU,
      currency: "CNY",
      quantity: 1,
      buyer_offer_minor: 1,
    });
    store.approve({ approval_id: old.approval_id, approved_minor: 1, ttl_seconds: 0 });
    clock = "2026-12-01T10:00:00.000Z";
    store.recordPending({
      negotiation_id: "neg_new",
      sku: SKU,
      currency: "CNY",
      quantity: 1,
      buyer_offer_minor: 1,
    });
    expect(store.list().map((record) => record.negotiation_id)).toEqual(["neg_new"]);
  });

  it("未配置审批队列时保持原有硬拒行为", async () => {
    const legacy = createMerchantHandler({
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
    });
    const rfq = envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] });
    await legacy.handle({
      envelope: rfq as never,
      message: { role: "user", parts: [], messageId: rfq.message_id },
      taskId: "task_legacy",
      senderIdentity: "buyer:buyer-001",
    });
    const result = await legacy.handle({
      envelope: counter(70_000) as never,
      message: { role: "user", parts: [], messageId: "msg_legacy" },
      taskId: "task_legacy",
      senderIdentity: "buyer:buyer-001",
    });
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") expect(result.reasonCode).toBe("approval_required");
  });
});
