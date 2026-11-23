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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-10-29T10:00:00Z";
const NEGOTIATION_ID = "neg_b2_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";
const COLLECTION_VERSION = "00000000-0000-4000-8000-000000000001";
const NEXT_COLLECTION_VERSION = "00000000-0000-4000-8000-000000000002";

/** 商品 850 元；公开折扣 5% → 807.50；私有底价 810 → 公开边界低于底价。 */
const merchantPolicy = {
  price_floors: { [SKU]: 810 },
  max_auto_discount_percent: 5,
};

describe("merchant negotiation approval (B2)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let approvals: NegotiationApprovalStore;
  let handler: ReturnType<typeof createMerchantHandler>;
  let seq = 0;
  let clock: string;
  let collection: { version: string; enabled: boolean; recipient: string };
  let origin: string;
  let destination: string | undefined;

  const buildHandler = () => createMerchantHandler({
    productSource: {
      async getProduct() {
        return {
          price: 850,
          currency: "CNY",
          unit: "piece",
          stock: 1_000,
          source_evidence: { system: "owned-test-fixture" },
          ...(destination !== undefined ? { handoff_destination: destination } : {}),
        };
      },
    },
    ledger,
    now: () => clock,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    merchantPolicy,
    negotiationApprovals: approvals,
    alipayCollection: { origin, current: () => collection },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-b2-"));
    clock = NOW;
    collection = { version: COLLECTION_VERSION, enabled: true, recipient: "张三示例" };
    origin = "https://collections.kiwi.example";
    destination = undefined;
    ledger = new LedgerStore({ dir, now: () => clock });
    approvals = new NegotiationApprovalStore(dir, () => clock);
    handler = buildHandler();
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
      created_at: clock,
      payload: payload as never,
    });
  };

  const run = async (envelope: NegotiationEnvelope, verified = false): Promise<NegotiationHandlerResult> =>
    handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
      identityVerified: verified,
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

  it("仅把明确批准的正整数分 CNY 应付总额持久化到一次性授权", () => {
    const newPending = (negotiation_id: string, currency: string) => approvals.recordPending({
      negotiation_id, sku: SKU, currency, quantity: 10, unit: "piece", buyer_offer_minor: 70_000,
    });
    const pending = newPending(NEGOTIATION_ID, "CNY");
    const usd = newPending("neg_b2_usd", "USD");
    for (const total of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => approvals.approve({
        approval_id: pending.approval_id, approved_minor: 75_000, alipay_total_minor: total,
      })).toThrow(/alipay_total_minor/);
    }
    expect(() => approvals.approve({
      approval_id: usd.approval_id, approved_minor: 75_000, alipay_total_minor: 754_321,
    })).toThrow(/alipay_total_minor/);
    approvals.approve({ approval_id: pending.approval_id, approved_minor: 75_000, alipay_total_minor: 754_321 });
    const reopened = new NegotiationApprovalStore(dir, () => NOW);
    expect(reopened.consume({ negotiation_id: NEGOTIATION_ID, sku: SKU, currency: "CNY", quantity: 11, unit: "piece" })).toBeUndefined();
    expect(reopened.consume({ negotiation_id: NEGOTIATION_ID, sku: SKU, currency: "CNY", quantity: 10, unit: "piece" }))
      .toMatchObject({ approved_minor: 75_000, alipay_total_minor: 754_321 });
    expect(reopened.consume({ negotiation_id: NEGOTIATION_ID, sku: SKU })).toBeUndefined();
  });

  const approvedCounter = async (input: { total?: number; retryMinor?: number; verified?: boolean } = {}) => {
    const verified = input.verified ?? true;
    await run(envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] }), verified);
    expect(await run(counter(70_000), verified)).toMatchObject({ kind: "declined", reasonCode: "approval_required" });
    approvals.approve({
      approval_id: approvals.list("pending")[0]!.approval_id,
      approved_minor: 75_000,
      ...(input.total !== undefined ? { alipay_total_minor: input.total } : {}),
    });
    const result = await run(counter(input.retryMinor ?? 70_000), verified);
    if (result.kind !== "accepted" || result.message?.parts[0]?.kind !== "data") throw new Error("missing merchant offer");
    const envelope = result.message.parts[0].data.knp_envelope as NegotiationEnvelope;
    expect(envelope.action).toBe("conditional_offer");
    if (envelope.payload.type !== "conditional_offer") throw new Error("missing conditional offer payload");
    return { envelope, terms: envelope.payload.base_terms as unknown as Record<string, unknown>, offerId: envelope.payload.offer_id };
  };

  it("在发出最终报价前绑定商家批准的总额、脱敏收款人和同源入口", async () => {
    const { envelope, offerId, terms } = await approvedCounter({ total: 754_321 });
    expect(terms).toMatchObject({
      handoff_destination: `${origin}/collect/alipay/${NEGOTIATION_ID}/${offerId}/${COLLECTION_VERSION}`,
      kiwi_alipay_collection: { version: COLLECTION_VERSION, recipient_summary: "张***", total_minor: 754_321, currency: "CNY", expires_at: "2026-10-29T11:00:00.000Z" },
    });
    expect(JSON.stringify(envelope)).not.toContain(collection.recipient);
  });

  const acceptEnvelopeFor = ({ envelope, offerId, terms }: Awaited<ReturnType<typeof approvedCounter>>) =>
    envelopeFor("accept_nonbinding", { type: "accept_nonbinding", offer_id: offerId, terms_digest: contentDigest(terms as never) }, envelope.message_id);

  it("仅为对应已达成协议的验签买家解析同一报价，重启后保持有效", async () => {
    const quote = await approvedCounter({ total: 754_321 });
    const accept = acceptEnvelopeFor(quote);
    const result = await run(accept, true);
    if (result.kind !== "accepted" || result.artifactParts?.[0]?.kind !== "data") throw new Error("missing merchant agreement");
    const agreement = result.artifactParts[0].data.agreement as Record<string, unknown>;
    expect(agreement).toMatchObject({
      agreed_terms: quote.terms,
      handoff_destination: quote.terms.handoff_destination,
      creates_order: false,
      reserves_inventory: false,
      authorizes_payment: false,
    });
    const input = {
      negotiationId: NEGOTIATION_ID,
      offerId: quote.offerId,
      agreementId: String(agreement.agreement_id),
      termsDigest: contentDigest(quote.terms as never),
      version: COLLECTION_VERSION,
      buyerPrincipalId: "buyer:buyer-001",
    };
    const expected = { version: COLLECTION_VERSION, totalMinor: 754_321, currency: "CNY", expiresAt: "2026-10-29T11:00:00.000Z" };
    expect(handler.resolveAlipayCollection(input)).toEqual(expected);
    handler = buildHandler();
    expect(handler.resolveAlipayCollection(input)).toEqual(expected);
    for (const key of Object.keys(input) as Array<keyof typeof input>) {
      expect(handler.resolveAlipayCollection({ ...input, [key]: "wrong" })).toBeUndefined();
    }
    collection.enabled = false;
    expect(handler.resolveAlipayCollection(input)).toBeUndefined();
    collection.enabled = true;
    collection.version = NEXT_COLLECTION_VERSION;
    expect(handler.resolveAlipayCollection(input)).toBeUndefined();
    collection.version = COLLECTION_VERSION;
    clock = "2026-10-29T11:00:00Z";
    expect(handler.resolveAlipayCollection(input)).toBeUndefined();
  });

  it("协议预写完成但相位未持久化时不得解析，补齐后才可解析", async () => {
    const quote = await approvedCounter({ total: 754_321 });
    const accept = acceptEnvelopeFor(quote);
    const append = ledger.append.bind(ledger);
    let agreementId: string | undefined;
    const storageFault = vi.spyOn(ledger, "append").mockImplementation((event) => {
      if (event.state_transition?.to_phase === "AGREEMENT_REACHED") throw new Error("phase storage unavailable");
      const result = append(event);
      if (event.event_kind === "system" && event.outcome.kind === "ok" && event.outcome.result?.kind === "agreement_issued") {
        agreementId = event.agreement_id;
      }
      return result;
    });
    await expect(run(accept, true)).rejects.toThrow("phase storage unavailable");
    storageFault.mockRestore();
    expect(agreementId).toBeDefined();
    const input = {
      negotiationId: NEGOTIATION_ID, offerId: quote.offerId, agreementId: agreementId!,
      termsDigest: contentDigest(quote.terms as never), version: COLLECTION_VERSION, buyerPrincipalId: "buyer:buyer-001",
    };
    expect(handler.resolveAlipayCollection(input)).toBeUndefined();
    handler = buildHandler();
    expect(handler.resolveAlipayCollection(input)).toBeUndefined();
    const recover = () => handler.recoverAccept?.({
      envelope: accept, message: { role: "user", parts: [], messageId: accept.message_id },
      taskId: "task_recovery", senderIdentity: input.buyerPrincipalId, identityVerified: true,
    });
    collection.version = NEXT_COLLECTION_VERSION;
    expect(await recover()).toBeUndefined();
    collection.version = COLLECTION_VERSION;
    expect(await recover()).toMatchObject({ kind: "accepted" });
    expect(handler.resolveAlipayCollection(input)).toMatchObject({ totalMinor: 754_321 });
  });

  it.each([
    { title: "未批准总额", input: {} },
    { title: "报价单价与人工批准单价不同", input: { total: 754_321, retryMinor: 80_000 } },
    { title: "买家未验签", input: { total: 754_321, verified: false } },
    { title: "已有平台商品入口", input: { total: 754_321 }, marketplace: "https://item.jd.com/10001000001.html" },
    { title: "配置非 HTTPS", input: { total: 754_321 }, invalidOrigin: "http://collections.kiwi.example" },
  ])("$title 时不发布支付宝收款入口", async ({ input, marketplace, invalidOrigin }) => {
    destination = marketplace;
    if (invalidOrigin !== undefined) origin = invalidOrigin;
    handler = buildHandler();
    const { terms } = await approvedCounter(input);
    expect(terms.kiwi_alipay_collection).toBeUndefined();
    expect(terms.handoff_destination).toBe(marketplace);
  });

  it("已验签报价拒绝未验签接受及配置换绑后接受", async () => {
    const quote = await approvedCounter({ total: 754_321 });
    const accept = acceptEnvelopeFor(quote);
    expect(await run(accept)).toMatchObject({ kind: "declined", reasonCode: "approval_required" });
    collection.version = NEXT_COLLECTION_VERSION;
    expect(await run(accept, true)).toMatchObject({ kind: "declined", reasonCode: "approval_required" });
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
