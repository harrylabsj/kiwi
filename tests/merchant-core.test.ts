/**
 * Merchant Core 测试（V2 阶段二）：
 * - 包装 V1 facade（委托语义不变；facade 白名单/租户/fail-closed 语义沿用）；
 * - 两轨统一列表：source_protocol/source_id 携带、状态名保留各协议口径、
 *   needs_human_review 各轨各自语义；
 * - 人工处理路由：跨轨调用 fail-closed（A2A 人审绝不调 shopping 轨）；
 * - 私密阈值读取（F23）：审计落盘且不记值；无审计目录拒绝裸读。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import type { IncomingConsultation } from "../src/agent/merchant/types.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { assertReviewRoute } from "../src/merchant-core/negotiation-adapters.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function writeA2aFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-core-ledger-"));
  dirs.push(dir);
  const ledger = new LedgerStore({ dir, now: () => T0 });
  ledger.append({
    event_kind: "message_sent",
    negotiation_id: "neg_a2a_001",
    identity: {
      sender_identity: "mkt_veyquo",
      counterparty_identity: "buyer:*",
      actor: "merchant",
    },
    capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
    wire_payload: {
      action: "conditional_offer",
      payload: { base_terms: { items: [{ sku: "sku-001", quantity: { value: 2 } }] } },
    },
    outcome: { kind: "ok" },
    occurred_at: T0,
  });
  return dir;
}

const SHOP_CONSULTATION: IncomingConsultation = {
  conversation_id: "conv-shop-001",
  status: "human_required",
  buyer_id: "buyer-9",
  sku: "sku-001",
  last_message: "能便宜点吗",
  last_message_at: T0,
};

function setupCore(
  options: {
    a2aLedgerDir?: string;
    consultations?: IncomingConsultation[];
    auditDir?: string;
    privateValues?: () => Array<{ key: string; value: string }>;
  } = {},
): MerchantCoreService {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  return new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({
      products: [fakeMerchantProduct()],
      consultations: options.consultations ?? [],
    }),
    approvals: new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 }),
    mode: () => "supervised",
    now: () => T0,
    ...(options.a2aLedgerDir !== undefined ? { a2aLedgerDir: options.a2aLedgerDir } : {}),
    ...(options.auditDir !== undefined ? { auditDir: options.auditDir } : {}),
    ...(options.privateValues !== undefined ? { privateValues: options.privateValues } : {}),
  });
}

describe("MerchantCoreService", () => {
  it("委托 V1 facade：目录读取与草稿候选语义不变", async () => {
    const core = setupCore();
    const { items } = await core.listPublicProducts();
    expect(items[0]).toMatchObject({ sku: "sku-001", title: "手写陶瓷杯" });
    const draft = await core.draftProductChange({ sku: "sku-001", changes: { price: 88 } });
    expect(draft.outcome.kind).toBe("pending_approval");
  });

  it("两轨统一列表：source_protocol/source_id + 各协议状态名不抹平", async () => {
    const core = setupCore({
      a2aLedgerDir: writeA2aFixture(),
      consultations: [SHOP_CONSULTATION],
    });
    const { total, items } = await core.listUnifiedNegotiations();
    expect(total).toBe(2);
    const a2a = items.find((r) => r.source_protocol === "a2a");
    const shop = items.find((r) => r.source_protocol === "shopping");
    expect(a2a).toMatchObject({ source_id: "neg_a2a_001", status: "OPEN" });
    expect(shop).toMatchObject({
      source_id: "conv-shop-001",
      status: "human_required", // shopping 轨原生状态名
      needs_human_review: true,
    });
  });

  it("人工处理目标按来源路由；跨轨调用 fail-closed", async () => {
    const core = setupCore({ consultations: [SHOP_CONSULTATION] });
    const targets = await core.listHumanReviewTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.source_protocol).toBe("shopping");
    // 路由正确：不抛
    expect(() => core.assertReviewRoute(targets[0]!, "shopping")).not.toThrow();
    // 跨轨：A2A 人审走 shopping 通道 → 拒绝（绝不调 shopping-cli resolve-review）
    expect(() => assertReviewRoute("a2a", "shopping")).toThrow(/路由错误/);
    expect(() => assertReviewRoute("shopping", "a2a")).toThrow(/路由错误/);
  });

  it("私密阈值读取写审计（不记值）；无审计目录 fail-closed 拒绝", () => {
    const auditDir = path.join(mkdtempSync(path.join(tmpdir(), "kiwi-core-audit-")), "audit");
    const core = setupCore({
      auditDir,
      privateValues: () => [
        { key: "min_unit_price_private", value: "80" },
        { key: "cost", value: "40" },
      ],
    });
    const values = core.readPrivateThresholds();
    expect(values).toHaveLength(2);
    const audit = readFileSync(path.join(auditDir, "private-access.jsonl"), "utf8");
    expect(audit).toContain("read_private_thresholds");
    expect(audit).toContain(PRINCIPAL);
    expect(audit).toContain('"keys_count":2');
    // 审计绝不记值
    expect(audit).not.toContain('"80"');
    expect(audit).not.toContain("cost");

    // 无审计目录 → 拒绝裸读
    const noAudit = setupCore({ privateValues: () => [{ key: "k", value: "v" }] });
    expect(() => noAudit.readPrivateThresholds()).toThrow(/fail-closed|审计/);
  });
});
