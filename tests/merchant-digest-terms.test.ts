/**
 * 磋商摘要 terms 提取测试（V2 §8.7 P0-4）：
 * - terms 提取覆盖 counter_offer.proposed_terms、conditional_offer.base_terms、
 *   最终协议 agreed_terms（此前只读 terms，还价/成交价在摘要里静默丢失）；
 * - needs_human_review 不简单等价 AWAITING_CLARIFICATION：非终态且最后一条
 *   消息是买家入站（offer/counter_offer/clarification 等待商家回应）也算。
 *
 * 确定性：临时 Ledger + 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { DefaultMerchantIntelligenceBackend } from "../src/agent/merchant/intelligence/default-backend.js";

const T0 = "2026-09-15T10:00:00.000Z";
const T1 = "2026-09-15T10:01:00.000Z";
const T2 = "2026-09-15T10:02:00.000Z";
const T3 = "2026-09-15T10:03:00.000Z";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

interface Fixture {
  backend: DefaultMerchantIntelligenceBackend;
  ledger: LedgerStore;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-digest-terms-"));
  dirs.push(dataDir);
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run("merchant-agent:merchant-001", T0, T0);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: "merchant-agent:merchant-001",
    now: () => T0,
  });
  const backend = new DefaultMerchantIntelligenceBackend({
    merchant_id: "merchant-001",
    data_dir: dataDir,
    principal_id: "merchant-agent:merchant-001",
    merchant_client: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals,
    now: () => T0,
  });
  const ledger = new LedgerStore({ dir: path.join(dataDir, "a2a"), now: () => T0 });
  return { backend, ledger, cleanup: () => db.close() };
}

const IDENTITY_IN = {
  sender_identity: "buyer:buyer-001",
  counterparty_identity: "mkt_veyquo",
  actor: "buyer",
} as const;
const IDENTITY_OUT = {
  sender_identity: "mkt_veyquo",
  counterparty_identity: "buyer:buyer-001",
  actor: "merchant",
} as const;
const CAPABILITY = {
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
} as const;

function item(sku: string, qty: number, priceMinor: number) {
  return {
    sku,
    quantity: { value: qty, unit: "piece" },
    unit_price: { currency: "CNY", amount_minor: priceMinor },
  };
}

describe("磋商摘要 terms 提取（P0-4）", () => {
  it("覆盖 counter_offer.proposed_terms / conditional_offer.base_terms / agreed_terms", async () => {
    const f = fixture();
    try {
      const nid = "neg_terms_001";
      f.ledger.append({
        event_kind: "message_received",
        negotiation_id: nid,
        identity: IDENTITY_IN,
        capability: CAPABILITY,
        wire_payload: {
          action: "rfq",
          payload: { terms: { items: [item("sku-001", 200, 0)] } },
        },
        outcome: { kind: "ok" },
        occurred_at: T0,
      });
      // 买家还价（counter_offer.proposed_terms）——此前摘要不读这个字段
      f.ledger.append({
        event_kind: "message_received",
        negotiation_id: nid,
        identity: IDENTITY_IN,
        capability: CAPABILITY,
        wire_payload: {
          action: "counter_offer",
          payload: { proposed_terms: { items: [item("sku-001", 200, 80_000)] } },
        },
        outcome: { kind: "ok" },
        occurred_at: T1,
      });
      // 商家条件报价（conditional_offer.base_terms）
      f.ledger.append({
        event_kind: "message_sent",
        negotiation_id: nid,
        identity: IDENTITY_OUT,
        capability: CAPABILITY,
        wire_payload: {
          action: "conditional_offer",
          payload: { base_terms: { items: [item("sku-001", 200, 85_000)] } },
        },
        outcome: { kind: "ok" },
        occurred_at: T2,
      });
      // 最终协议（agreed_terms）+ 终态
      f.ledger.append({
        event_kind: "message_sent",
        negotiation_id: nid,
        identity: IDENTITY_OUT,
        capability: CAPABILITY,
        wire_payload: {
          action: "accept_nonbinding",
          payload: { agreed_terms: { items: [item("sku-001", 200, 83_500)] } },
        },
        agreement_id: "agr_terms_001",
        outcome: { kind: "ok" },
        occurred_at: T3,
      });
      f.ledger.append({
        event_kind: "state_transition",
        negotiation_id: nid,
        identity: IDENTITY_OUT,
        capability: CAPABILITY,
        state_transition: { from_phase: "OFFER_OPEN", to_phase: "AGREEMENT_REACHED" },
        outcome: { kind: "ok" },
        occurred_at: T3,
      });

      const rows = await f.backend.getNegotiationDigest({ merchant_id: "merchant-001" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        negotiation_id: nid,
        phase: "AGREEMENT_REACHED",
        skus: ["sku-001"],
        quantity: 200,
        latest_price_minor: 83_500, // 最终协议价（agreed_terms），不是初始 rfq
        currency: "CNY",
        agreement_id: "agr_terms_001",
        needs_human_review: false, // 终态不需要人工
      });
    } finally {
      f.cleanup();
    }
  });

  it("needs_human_review：买家还价后等待商家回应 → true；商家已回应 → false", async () => {
    const f = fixture();
    try {
      const nid = "neg_review_001";
      f.ledger.append({
        event_kind: "state_transition",
        negotiation_id: nid,
        identity: IDENTITY_IN,
        capability: CAPABILITY,
        state_transition: { from_phase: "OPEN", to_phase: "OFFER_OPEN" },
        outcome: { kind: "ok" },
        occurred_at: T0,
      });
      // 最后一条是买家入站还价（等待商家回应）→ 需要处理
      f.ledger.append({
        event_kind: "message_received",
        negotiation_id: nid,
        identity: IDENTITY_IN,
        capability: CAPABILITY,
        wire_payload: {
          action: "counter_offer",
          payload: { proposed_terms: { items: [item("sku-001", 5, 1000)] } },
        },
        outcome: { kind: "ok" },
        occurred_at: T1,
      });
      let rows = await f.backend.getNegotiationDigest({ merchant_id: "merchant-001" });
      expect(rows[0]?.needs_human_review).toBe(true);

      // 商家已回应（出站 conditional_offer 更晚）→ 不需要人工
      f.ledger.append({
        event_kind: "message_sent",
        negotiation_id: nid,
        identity: IDENTITY_OUT,
        capability: CAPABILITY,
        wire_payload: {
          action: "conditional_offer",
          payload: { base_terms: { items: [item("sku-001", 5, 1200)] } },
        },
        outcome: { kind: "ok" },
        occurred_at: T2,
      });
      rows = await f.backend.getNegotiationDigest({ merchant_id: "merchant-001" });
      expect(rows[0]?.needs_human_review).toBe(false);
      expect(rows[0]?.latest_price_minor).toBe(1200);
    } finally {
      f.cleanup();
    }
  });

  it("AWAITING_CLARIFICATION 仍需人工（不依赖消息先后）", async () => {
    const f = fixture();
    try {
      const nid = "neg_clar_001";
      f.ledger.append({
        event_kind: "message_sent",
        negotiation_id: nid,
        identity: IDENTITY_OUT,
        capability: CAPABILITY,
        wire_payload: { action: "offer", payload: { terms: { items: [item("sku-001", 1, 500)] } } },
        outcome: { kind: "ok" },
        occurred_at: T0,
      });
      f.ledger.append({
        event_kind: "state_transition",
        negotiation_id: nid,
        identity: IDENTITY_IN,
        capability: CAPABILITY,
        state_transition: { from_phase: "OFFER_OPEN", to_phase: "AWAITING_CLARIFICATION" },
        outcome: { kind: "ok" },
        occurred_at: T1,
      });
      const rows = await f.backend.getNegotiationDigest({ merchant_id: "merchant-001" });
      expect(rows[0]?.phase).toBe("AWAITING_CLARIFICATION");
      expect(rows[0]?.needs_human_review).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});
