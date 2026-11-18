/**
 * 买家识别与交易回执 · K2 企业一次委托与报价历史。
 *
 * 覆盖验收 A3/A4 的授权维度与 A6 的委托边界：委托建立/续期/旧版本重放/
 * 撤销后重放；已发报价索引与查询授权（未验签/未委托不返回历史）；
 * 同 message ID 改委托内容 → 幂等冲突；查询扩展响应格式与解析。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import {
  ensureVerifiedCustomerIdentity,
} from "../src/merchant-core/customer-memory/auto-identity.js";
import {
  QuoteHistoryStore,
  delegationFromMetadata,
  parseHistoryQueryExtension,
  validateDelegationShape,
} from "../src/merchant-core/customer-memory/quote-history.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { InboundPipeline } from "../src/a2a/server/pipeline.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { TaskRegistry } from "../src/a2a/server/task-registry.js";
import { buildHistoryQueryEnvelope, parseHistoryReply } from "../src/buyer-core/a2a-quote-history.js";
import { envelopeToMessage } from "../src/buyer-core/a2a-knp.js";

const NOW = "2026-11-06T04:00:00.000Z";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const MERCHANT = "merchant-a";
const OPEN_ACTOR = "kiwi-inquiry-session-v1:buyerkey";
const SKU = "VQ-001";

const VALID_DELEGATION = {
  type: "kiwi.quote-history-delegation",
  version: 1,
  merchant_id: MERCHANT,
  purpose: "quote_history",
  delegation_id: "deleg-1",
  issued_at: NOW,
  expires_at: "2027-02-04T04:00:00.000Z",
};

describe("K2 委托校验与授权存取", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: QuoteHistoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k2-"));
    db = new DatabaseSync(join(dir, "state.sqlite"));
    registerGovernanceLedgers(db);
    store = new QuoteHistoryStore({ db, now: () => NOW });
    ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("委托建立：映射 subject + 建 history_recall grant", () => {
    const subject = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const outcome = store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: VALID_DELEGATION as never,
    });
    expect(outcome.status).toBe("active");
    if (outcome.status !== "active") return;
    expect(outcome.subject_id).toBe(subject.subject_id);
    const grant = db
      .prepare("SELECT purpose, status FROM data_grants WHERE grant_id = ?")
      .get(outcome.grant_id) as { purpose: string; status: string };
    expect(grant.purpose).toBe("history_recall");
    expect(grant.status).toBe("ACTIVE");
    const authorized = store.checkActive({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR });
    expect(authorized?.subject_id).toBe(subject.subject_id);
  });

  it("旧版本重放拒绝（撤销水位持久保存）", () => {
    const subject = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const base = { ...VALID_DELEGATION };
    store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: { ...base, version: 2, delegation_id: "deleg-2" } as never,
    });
    const stale = store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: base as never,
    });
    expect(stale.status).toBe("stale");
  });

  it("撤销后重放不得恢复授权：同版本/更高版本都被拒绝或按未委托", () => {
    const subject = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: VALID_DELEGATION as never,
    });
    expect(store.revokeDelegation({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR })).toBe(true);
    expect(store.checkActive({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR })).toBeUndefined();
    // 撤销后同版本重放：状态仍 REVOKED，授权不复活。
    const replay = store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: VALID_DELEGATION as never,
    });
    if (replay.status === "active") {
      // 实现选择：同版本重入返回既有 grant——但撤销标记必须仍然生效。
      expect(store.checkActive({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR })).toBeUndefined();
    } else {
      expect(["stale", "rejected"]).toContain(replay.status);
    }
    // 更新版本（新委托，需买方重新声明）可以重新建立——设计允许企业重新授权。
    const renewed = store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: { ...VALID_DELEGATION, version: 3, delegation_id: "deleg-3" } as never,
    });
    expect(renewed.status).toBe("active");
  });

  it("委托形状校验：商家不匹配/过期/未知用途拒绝", () => {
    expect(validateDelegationShape(VALID_DELEGATION, MERCHANT, NOW).ok).toBe(true);
    expect(validateDelegationShape({ ...VALID_DELEGATION, merchant_id: "merchant-b" }, MERCHANT, NOW).ok).toBe(false);
    expect(validateDelegationShape({ ...VALID_DELEGATION, expires_at: "2026-01-01T00:00:00.000Z" }, MERCHANT, NOW).ok).toBe(false);
    expect(validateDelegationShape({ ...VALID_DELEGATION, purpose: "marketing" }, MERCHANT, NOW).ok).toBe(false);
    expect(validateDelegationShape(undefined, MERCHANT, NOW).ok).toBe(false);
    expect(delegationFromMetadata({ kiwi_delegation: VALID_DELEGATION })).toEqual(VALID_DELEGATION);
    expect(delegationFromMetadata({})).toBeUndefined();
    expect(delegationFromMetadata(undefined)).toBeUndefined();
  });

  it("已发报价索引与查询：只返回本人正式报价；授权撤销后查不到", () => {
    const subject = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    store.applyDelegation({
      merchant_id: MERCHANT,
      buyer_actor: OPEN_ACTOR,
      subject_id: subject.subject_id,
      delegation: VALID_DELEGATION as never,
    });
    store.indexOffer({
      merchant_id: MERCHANT,
      subject_id: subject.subject_id,
      negotiation_id: "neg-1",
      offer_id: "off-1",
      message_id: "msg-1",
      sku: SKU,
      quantity: 50,
      unit: "piece",
      currency: "CNY",
      unit_price_minor: 8500,
      terms_digest: "sha256:" + "a".repeat(64),
      spec: { title: "500mL 白色瓶", source_evidence: { system: "owned-erp" } },
      valid_until: "2026-11-07T04:00:00.000Z",
      quoted_at: "2026-11-06T03:00:00.000Z",
    });
    const hits = store.queryHistory({ merchant_id: MERCHANT, subject_id: subject.subject_id, skus: [SKU] });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sku: SKU,
      quantity: 50,
      unit_price_minor: 8500,
      offer_version: 1,
    });
    expect(hits[0]?.spec).toEqual({ title: "500mL 白色瓶", source_evidence: { system: "owned-erp" } });

    // 跨店隔离：B 店查不到 A 店记录。
    ensureVerifiedCustomerIdentity(db, { merchant_id: "merchant-b", verified_actor: OPEN_ACTOR, now: NOW });
    const bStore = new QuoteHistoryStore({ db, now: () => NOW });
    expect(bStore.queryHistory({ merchant_id: "merchant-b", subject_id: subject.subject_id })).toHaveLength(0);

    // 授权撤销后查询拒绝。
    store.revokeDelegation({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR });
    expect(store.checkActive({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Handler 级：历史查询扩展 + 未验签不返回历史 + 同 ID 改委托幂等冲突
// ---------------------------------------------------------------------------

describe("K2 handler 历史查询与委托边界", () => {
  let dir: string;
  let ledger: LedgerStore;
  let db: DatabaseSync;
  let store: QuoteHistoryStore;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-k2-handler-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    db = new DatabaseSync(join(dir, "state.sqlite"));
    registerGovernanceLedgers(db);
    store = new QuoteHistoryStore({ db, now: () => NOW });
    seq = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeHandler = () =>
    createMerchantHandler({
      productSource: {
        async getProduct() {
          return { price: 110, currency: "CNY", stock: 500, unit: "piece", source_evidence: { system: "owned-test-fixture" } };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant-agent",
      counterparty: "buyer:*",
      customerIdentity: {
        merchantId: MERCHANT,
        writer: {
          ensure: async (input) => {
            const result = ensureVerifiedCustomerIdentity(db, {
              merchant_id: input.merchant_id,
              verified_actor: input.verified_actor,
              now: NOW,
            });
            return { status: "registered" as const, subject_id: result.subject_id, created: result.created };
          },
        },
      },
      quoteHistory: { store },
    });

  const envelopeOf = (
    action: "rfq" | "inquiry",
    payload: Record<string, unknown>,
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: `neg_k2_${seq}`,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      actor: "buyer",
      action,
      created_at: NOW,
      payload: payload as never,
    });
  };

  const runHandler = async (
    handler: ReturnType<typeof makeHandler>,
    envelope: NegotiationEnvelope,
    options: { verified?: boolean; identity?: string; metadata?: Record<string, unknown> } = {},
  ) => {
    seq += 1;
    return await handler.handle({
      envelope: envelope as never,
      message: {
        role: "user",
        parts: [],
        messageId: envelope.message_id,
        ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      },
      taskId: `task_${seq}`,
      senderIdentity: options.identity ?? OPEN_ACTOR,
      identityVerified: options.verified ?? true,
    });
  };

  it("带委托的 RFQ 建立授权；其后历史查询返回结构化候选（含来源规格与旧价）", async () => {
    // 先手动建档（writer stub 不建档，直接走 identity 服务）。
    const subject = ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const handler = makeHandler();
    const rfq = await runHandler(handler, envelopeOf("rfq", {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }],
    }), { metadata: { kiwi_delegation: VALID_DELEGATION } });
    expect(rfq.kind).toBe("accepted");

    // 报价发布后应已索引。
    const indexed = store.queryHistory({ merchant_id: MERCHANT, subject_id: subject.subject_id });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.quantity).toBe(50);

    // 历史查询（唯一匹配）。
    const query = envelopeOf("inquiry", {
      type: "inquiry",
      subject: { kiwi_history_query: { version: 1, skus: [SKU] } },
    });
    const reply = await runHandler(handler, query);
    expect(reply.kind).toBe("accepted");
    const message = reply.kind === "accepted" ? reply.message : undefined;
    const historyPart = message?.parts.find(
      (part) => part.kind === "data" && (part.data as Record<string, unknown>)["type"] === "kiwi_quote_history",
    ) as { kind: "data"; data: Record<string, unknown> } | undefined;
    expect(historyPart).toBeDefined();
    const hits = historyPart?.data["hits"] as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.["sku"]).toBe(SKU);
    expect((hits[0]?.["spec"] as Record<string, unknown>)["source_evidence"]).toEqual({ system: "owned-test-fixture" });
    expect(hits[0]?.["quoted_at"]).toBe("2026-11-06T04:00:00.000Z");
  });

  it("未验签 / 未委托 / 扩展不支持 → 不返回历史（走接待路径）", async () => {
    ensureVerifiedCustomerIdentity(db, { merchant_id: MERCHANT, verified_actor: OPEN_ACTOR, now: NOW });
    const handler = makeHandler();
    // 未验签。
    const unverified = await runHandler(handler, envelopeOf("inquiry", {
      type: "inquiry",
      subject: { kiwi_history_query: { version: 1 } },
    }), { verified: false });
    const unverifiedText = unverified.kind === "accepted"
      ? (unverified.message?.parts.find((part) => part.kind === "text") as { text?: string } | undefined)?.text
      : undefined;
    expect(unverifiedText).toBeDefined();
    expect(unverifiedText).not.toContain("kiwi_quote_history");

    // 验签但未委托 → 接待路径（无历史数据 part）。
    const noDelegation = await runHandler(handler, envelopeOf("inquiry", {
      type: "inquiry",
      subject: { kiwi_history_query: { version: 1 } },
    }));
    const noDelegationParts = noDelegation.kind === "accepted" ? noDelegation.message?.parts ?? [] : [];
    expect(
      noDelegationParts.some(
        (part) => part.kind === "data" && (part.data as Record<string, unknown>)["type"] === "kiwi_quote_history",
      ),
    ).toBe(false);
  });

  it("撤销后重发同一条已授权历史查询不会重用缓存报价", async () => {
    const handler = makeHandler();
    const rfq = envelopeOf("rfq", { type: "rfq", items: [{ sku: "SKU-001", quantity: { value: 50, unit: "piece" } }] });
    await runHandler(handler, rfq, { metadata: { kiwi_delegation: VALID_DELEGATION } });
    const query = envelopeOf("inquiry", { type: "inquiry", subject: { kiwi_history_query: { version: 1 } } });
    const pipeline = new InboundPipeline({
      handler, ledger, idempotency: new IdempotencyStore({ dir, now: () => NOW }),
      tasks: new TaskRegistry(), now: () => NOW, logError: () => {},
    });
    const message = { message: envelopeToMessage(query) };
    const caller = { senderIdentity: OPEN_ACTOR, identityVerified: true };
    const first = await pipeline.sendMessage(message, caller);
    expect(JSON.stringify(first.task)).toContain("kiwi_quote_history");
    expect(store.revokeDelegation({ merchant_id: MERCHANT, buyer_actor: OPEN_ACTOR })).toBe(true);
    const repeated = await pipeline.sendMessage(message, caller);
    expect(JSON.stringify(repeated.task)).not.toContain("kiwi_quote_history");
  });

  it("扩展解析：版本不符/形状不符返回 undefined", () => {
    expect(parseHistoryQueryExtension({ kiwi_history_query: { version: 1, skus: ["a"] } })).toEqual({
      version: 1,
      skus: ["a"],
    });
    expect(parseHistoryQueryExtension({ kiwi_history_query: { version: 2 } })).toBeUndefined();
    expect(parseHistoryQueryExtension({ other: 1 })).toBeUndefined();
    expect(parseHistoryQueryExtension(undefined)).toBeUndefined();
  });
});

describe("K2 pipeline：同 message ID 改委托内容 → 幂等冲突（A6）", () => {
  it("相同 KNP 内容但不同 metadata 的重放判 idempotency_conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-k2-idem-"));
    try {
      const ledger = new LedgerStore({ dir, now: () => NOW });
      const idempotency = new IdempotencyStore({ dir, now: () => NOW });
      const pipeline = new InboundPipeline({
        handler: { name: "stub", handle: async () => ({ kind: "accepted", taskState: "completed", message: { role: "agent", parts: [{ kind: "text", text: "ok" }], messageId: "msg_r" } }) },
        idempotency,
        ledger,
        tasks: new TaskRegistry(),
        now: () => NOW,
        logError: () => {},
      });
      const envelope = finalizeEnvelope({
        capability: CAP,
        protocol_version: "1.0",
        negotiation_id: "neg_idem",
        exchange_id: "ex_1",
        message_id: "msg_same",
        actor: "buyer",
        action: "inquiry",
        created_at: NOW,
        payload: { type: "inquiry" },
      });
      const message = envelopeToMessage(envelope, { kiwi_delegation: { ...VALID_DELEGATION, version: 1 } });
      const first = await pipeline.sendMessage({ message: message as never }, {
        senderIdentity: OPEN_ACTOR,
        identityVerified: true,
      });
      expect(first.task.status.state).toBe("completed");
      // 同 message ID、同 KNP 内容、不同委托版本 → 不得命中同一操作。
      const changed = envelopeToMessage(envelope, { kiwi_delegation: { ...VALID_DELEGATION, version: 2 } });
      await expect(
        pipeline.sendMessage({ message: changed as never }, {
          senderIdentity: OPEN_ACTOR,
          identityVerified: true,
        }),
      ).rejects.toMatchObject({ body: { data: { protocol_code: "idempotency_conflict" } } });
      // 完全一致的重放 → 幂等还原原结果。
      const replay = await pipeline.sendMessage({ message: message as never }, {
        senderIdentity: OPEN_ACTOR,
        identityVerified: true,
      });
      expect(replay.task.id).toBe(first.task.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("K2 买方历史查询协议对象", () => {
  it("查询 envelope 携带版本化 subject 扩展", () => {
    const envelope = buildHistoryQueryEnvelope({ skus: [SKU], limit: 3, now: () => NOW });
    expect(envelope.action).toBe("inquiry");
    const subject = (envelope.payload as { subject?: Record<string, unknown> }).subject;
    expect(subject?.kiwi_history_query).toEqual({ version: 1, skus: [SKU], limit: 3 });
  });

  it("parseHistoryReply：数据 part 候选解析 + 未支持版本拒绝", () => {
    const request = buildHistoryQueryEnvelope({ now: () => NOW });
    const task = {
      id: "task-1",
      status: {
        state: "completed" as const,
        message: {
          role: "agent" as const,
          messageId: "msg_reply",
          parts: [
            {
              kind: "data" as const,
              data: {
                knp_envelope: finalizeEnvelope({
                  capability: CAP,
                  protocol_version: "1.0",
                  negotiation_id: request.negotiation_id,
                  exchange_id: "ex_r",
                  message_id: "msg_reply",
                  in_reply_to: request.message_id,
                  actor: "merchant",
                  action: "clarification_response",
                  created_at: NOW,
                  payload: { type: "clarification_response", answers: [{ code: "quote_history", value: "available" }] },
                }),
              },
            },
            {
              kind: "data" as const,
              data: {
                type: "kiwi_quote_history",
                version: 1,
                subject_id: "subj_1",
                hits: [
                  {
                    negotiation_id: "neg_old",
                    offer_id: "off_old",
                    offer_version: 1,
                    sku: SKU,
                    quantity: 50,
                    unit: "piece",
                    price: { currency: "CNY", amount_minor: 8500 },
                    terms_digest: "sha256:" + "b".repeat(64),
                    spec: { title: "旧报价" },
                    quoted_at: "2026-11-01T00:00:00.000Z",
                    valid_until: "2026-11-02T00:00:00.000Z",
                  },
                ],
              },
            },
          ],
        },
      },
    };
    const parsed = parseHistoryReply(task as never, request);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.candidates).toHaveLength(1);
      expect(parsed.candidates[0]).toMatchObject({ sku: SKU, offer_id: "off_old", quantity: 50 });
    }

    // 商家不支持扩展 → 无数据 part → unavailable。
    const emptyTask = {
      id: "task-2",
      status: {
        state: "completed" as const,
        message: {
          role: "agent" as const,
          messageId: "msg_reply2",
          parts: [{ kind: "text" as const, text: "请提供 SKU" }],
        },
      },
    };
    expect(parseHistoryReply(emptyTask as never, request).status).toBe("unavailable");
  });

  it("contentDigest：terms 快照的摘要稳定", () => {
    const terms = { items: [{ sku: SKU, quantity: { value: 50, unit: "piece" } }] };
    expect(contentDigest(terms as never)).toBe(contentDigest({ ...terms } as never));
  });
});
