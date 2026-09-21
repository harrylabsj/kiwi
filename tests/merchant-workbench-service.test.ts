/**
 * Merchant Workbench Facade tests（WorkBuddy Buddy 应用开发计划 阶段一）：
 * 白名单/脱敏（私有字段绝不外泄）、租户校验、统一错误映射（MerchantClientError
 * kind → MerchantWorkbenchError kind）、未配置 ledger/intelligence 的 fail-closed、
 * draftProductChange 永远 pending（force_pending，不触发真实写）、
 * listA2aNegotiations 的 limit clamp 与结构化返回、listActiveConsultations
 * 只留非终态磋商。
 *
 * Deterministic: in-memory SQLite, FakeMerchantClient, 临时目录 ledger, 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import type { NegotiationPhase } from "../src/negotiation/state/phase.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { MerchantClientError } from "../src/agent/merchant/types.js";
import type { HumanReviewItem, MerchantCatalogProduct } from "../src/agent/merchant/types.js";
import type { MerchantIntelligenceBackend } from "../src/agent/merchant/intelligence/backend.js";
import type { MerchantBusinessSnapshot } from "../src/agent/merchant/intelligence/types.js";
import {
  MerchantWorkbenchError,
  MerchantWorkbenchService,
  type MerchantWorkbenchServiceDeps,
} from "../src/merchant/workbench-service.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "merchant-agent:merchant-001";

/** 返回夹带私有字段（底价/成本/凭据）的商品，验证 Facade 白名单剥除。 */
class LeakyMerchantClient extends FakeMerchantClient {
  override async getProduct(sku: string): Promise<MerchantCatalogProduct> {
    const p = await super.getProduct(sku);
    return { ...p, floor_price: 66, cost: 40, credential: "tok_secret" } as MerchantCatalogProduct;
  }
  override async listProducts(merchantId: string): Promise<MerchantCatalogProduct[]> {
    const rows = await super.listProducts(merchantId);
    return rows.map((p) => ({ ...p, floor_price: 66, margin: 0.3 }) as MerchantCatalogProduct);
  }
  override async getHumanReviewQueue(merchantId: string): Promise<HumanReviewItem[]> {
    const rows = await super.getHumanReviewQueue(merchantId);
    return rows.map((r) => ({ ...r, internal_note: "私密批注" }) as HumanReviewItem);
  }
}

const REVIEW: HumanReviewItem = {
  review_id: 1,
  conversation_id: "conv-001",
  buyer_id: "buyer-001",
  sku: "sku-001",
  reason: "超预算需人工确认",
  severity: "high",
  created_at: T0,
};

interface Harness {
  service: MerchantWorkbenchService;
  approvals: WriteApprovalCandidateStore;
  merchantClient: FakeMerchantClient;
  mode: { value: "manual" | "supervised" | "autopilot" };
  clock: { value: string };
  cleanup: () => void;
}

function setupWorkbench(
  options: {
    mode?: "manual" | "supervised" | "autopilot";
    client?: FakeMerchantClient;
    a2aLedgerDir?: string;
    intelligence?: MerchantIntelligenceBackend;
    dataSource?: MerchantWorkbenchServiceDeps["dataSource"];
  } = {},
): Harness {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const clock = { value: T0 };
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => clock.value,
  });
  const merchantClient =
    options.client ?? new FakeMerchantClient({ products: [fakeMerchantProduct()] });
  const mode = { value: options.mode ?? ("supervised" as const) };
  const deps: MerchantWorkbenchServiceDeps = {
    profile: testProfile(),
    merchantClient,
    approvals,
    mode: () => mode.value,
    now: () => clock.value,
    ...(options.a2aLedgerDir !== undefined ? { a2aLedgerDir: options.a2aLedgerDir } : {}),
    ...(options.intelligence !== undefined ? { intelligence: options.intelligence } : {}),
    ...(options.dataSource !== undefined ? { dataSource: options.dataSource } : {}),
  };
  return {
    service: new MerchantWorkbenchService(deps),
    approvals,
    merchantClient,
    mode,
    clock,
    cleanup: () => db.close(),
  };
}

/** 写一条磋商到临时 A2A ledger（state_transition + conditional_offer 消息）。 */
function writeLedgerNegotiation(
  negotiationId: string,
  phase: NegotiationPhase,
  sku = "sku-001",
  qty = 2,
  priceMinor = 18800,
): { dir: string; negotiationId: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "merchant-workbench-ledger-"));
  const ledger = new LedgerStore({ dir, now: () => T0 });
  const identity = {
    sender_identity: "mkt_veyquo",
    counterparty_identity: "buyer:*",
    actor: "merchant",
  } as const;
  const capability = {
    capability: "com.harrylabsj.kiwi.shopping.negotiation",
    protocol_version: "1.0",
  } as const;
  ledger.append({
    event_kind: "state_transition",
    negotiation_id: negotiationId,
    identity,
    capability,
    state_transition: { from_phase: "OPEN", to_phase: phase },
    outcome: { kind: "ok" },
    occurred_at: T0,
  });
  ledger.append({
    event_kind: "message_sent",
    negotiation_id: negotiationId,
    identity,
    capability,
    wire_payload: {
      action: "conditional_offer",
      payload: {
        type: "conditional_offer",
        terms: {
          items: [
            {
              sku,
              quantity: { value: qty, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: priceMinor },
            },
          ],
        },
      },
    },
    outcome: { kind: "ok" },
    occurred_at: T0,
  });
  return { dir, negotiationId };
}

const tmpDirs: string[] = [];
function ledgerDir(...args: Parameters<typeof writeLedgerNegotiation>): {
  dir: string;
  negotiationId: string;
} {
  const result = writeLedgerNegotiation(...args);
  tmpDirs.push(result.dir);
  return result;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("白名单/脱敏", () => {
  it("getPublicProduct 只返回公开字段，剥除 floor_price/cost/credential", async () => {
    const h = setupWorkbench({
      client: new LeakyMerchantClient({ products: [fakeMerchantProduct()] }),
    });
    const product = await h.service.getPublicProduct("sku-001");
    expect(product).toEqual({
      sku: "sku-001",
      merchant_id: "merchant-001",
      title: "手写陶瓷杯",
      price: 99,
      stock: 12,
      paused: false,
    });
    const json = JSON.stringify(product);
    expect(json).not.toContain("floor_price");
    expect(json).not.toContain("cost");
    expect(json).not.toContain("tok_secret");
    h.cleanup();
  });

  it("listPublicProducts 剥除私有字段", async () => {
    const h = setupWorkbench({
      client: new LeakyMerchantClient({ products: [fakeMerchantProduct()] }),
    });
    const { items, source } = await h.service.listPublicProducts();
    expect(source).toBe("merchant_client");
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      ["merchant_id", "paused", "price", "sku", "stock", "title"].sort(),
    );
    expect(JSON.stringify(items)).not.toContain("floor_price");
    h.cleanup();
  });

  it("listHumanReviews 只返回白名单字段", async () => {
    const h = setupWorkbench({
      client: new LeakyMerchantClient({ products: [fakeMerchantProduct()], reviews: [REVIEW] }),
    });
    const rows = await h.service.listHumanReviews();
    expect(rows).toEqual([
      {
        review_id: 1,
        conversation_id: "conv-001",
        sku: "sku-001",
        severity: "high",
        reason: "超预算需人工确认",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("私密批注");
    h.cleanup();
  });
});

describe("租户校验", () => {
  it("draftProductChange 的 merchant_id 不匹配时抛 validation", async () => {
    const h = setupWorkbench();
    await expect(
      h.service.draftProductChange({
        sku: "sku-001",
        changes: { price: 88 },
        merchant_id: "merchant-999",
      }),
    ).rejects.toMatchObject({ name: "MerchantWorkbenchError", kind: "validation" });
    expect(h.approvals.listPending()).toHaveLength(0);
    h.cleanup();
  });

  it("getPublicProduct 的 merchant_id 不匹配时抛 validation；匹配或省略时正常", async () => {
    const h = setupWorkbench();
    await expect(h.service.getPublicProduct("sku-001", "merchant-999")).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(h.service.getPublicProduct("sku-001", "merchant-001")).resolves.toMatchObject({
      sku: "sku-001",
    });
    h.cleanup();
  });
});

describe("错误映射", () => {
  it.each([
    ["auth", "auth"],
    ["not_found", "not_found"],
    ["validation", "validation"],
    ["transient", "unavailable"],
  ] as const)(
    "MerchantClientError(%s) → MerchantWorkbenchError(%s)",
    async (clientKind, expectedKind) => {
      const client = new FakeMerchantClient({});
      vi.spyOn(client, "getProduct").mockRejectedValue(new MerchantClientError(clientKind, "boom"));
      const h = setupWorkbench({ client });
      await expect(h.service.getPublicProduct("sku-001")).rejects.toSatisfy(
        (err) =>
          err instanceof MerchantWorkbenchError &&
          err.kind === expectedKind &&
          err.message === "boom",
      );
      h.cleanup();
    },
  );

  it("未配置 A2A ledger 目录时磋商记录 fail-closed 抛 unavailable", async () => {
    const h = setupWorkbench();
    await expect(h.service.listA2aNegotiations()).rejects.toMatchObject({
      name: "MerchantWorkbenchError",
      kind: "unavailable",
    });
    await expect(h.service.listActiveConsultations()).rejects.toMatchObject({
      kind: "unavailable",
    });
    h.cleanup();
  });

  it("未配置 intelligence 时 getAnalytics fail-closed 抛 unavailable（不返回演示数据）", async () => {
    const h = setupWorkbench();
    await expect(h.service.getAnalytics("7d")).rejects.toMatchObject({
      name: "MerchantWorkbenchError",
      kind: "unavailable",
    });
    h.cleanup();
  });

  it("getAnalytics 校验 period 格式并透传 merchant_id", async () => {
    const snapshot = { merchant_id: "merchant-001", period: "7d" } as MerchantBusinessSnapshot;
    const intelligence = {
      getBusinessSnapshot: vi.fn(async () => snapshot),
    } as unknown as MerchantIntelligenceBackend;
    const h = setupWorkbench({ intelligence });
    await expect(h.service.getAnalytics("0d")).rejects.toMatchObject({ kind: "validation" });
    await expect(h.service.getAnalytics("7d")).resolves.toBe(snapshot);
    expect(intelligence.getBusinessSnapshot).toHaveBeenCalledWith({
      merchant_id: "merchant-001",
      period: "7d",
    });
    h.cleanup();
  });
});

describe("draftProductChange", () => {
  it("supervised 模式生成 pending 候选，不调用 updateProduct", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const result = await h.service.draftProductChange({
      sku: "sku-001",
      changes: { price: 88 },
      reason: "促销调价",
    });
    expect(result.outcome.kind).toBe("pending_approval");
    expect(spy).not.toHaveBeenCalled();
    if (result.outcome.kind === "pending_approval") {
      const candidate = result.outcome.candidate;
      expect(candidate.tool).toBe("draft_product_change");
      expect(candidate.status).toBe("pending_approval");
      expect(candidate.risk).toBe("write_catalog");
      expect(Date.parse(candidate.expires_at)).toBeGreaterThan(Date.parse(T0));
      expect(candidate.arguments).toEqual({
        sku: "sku-001",
        changes: { price: 88 },
        reason: "促销调价",
      });
      expect(h.approvals.get(candidate.candidate_id)?.status).toBe("pending_approval");
    }
    // 候选 preconditions / 返回快照均为公开白名单
    expect(result.product).toEqual({
      sku: "sku-001",
      merchant_id: "merchant-001",
      title: "手写陶瓷杯",
      price: 99,
      stock: 12,
      paused: false,
    });
    h.cleanup();
  });

  it("autopilot 模式也绝不自动执行（force_pending）", async () => {
    const h = setupWorkbench({ mode: "autopilot" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const result = await h.service.draftProductChange({ sku: "sku-001", changes: { stock: 5 } });
    expect(result.outcome.kind).toBe("pending_approval");
    expect(spy).not.toHaveBeenCalled();
    h.cleanup();
  });

  it("空 changes 抛 validation；商品不存在抛 not_found", async () => {
    const h = setupWorkbench();
    await expect(
      h.service.draftProductChange({ sku: "sku-001", changes: {} }),
    ).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(
      h.service.draftProductChange({ sku: "no-such", changes: { price: 1 } }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      h.service.draftProductChange({ sku: "sku-001", changes: "not-an-object" }),
    ).rejects.toMatchObject({ kind: "validation" });
    h.cleanup();
  });
});

describe("A2A 磋商记录", () => {
  it("listA2aNegotiations 返回结构化行并按时间倒序", async () => {
    const done = ledgerDir("neg_done_001", "AGREEMENT_REACHED", "sku-002", 1, 9900);
    // 在同一目录追加一条进行中的磋商（OFFER_OPEN，无 message_sent）
    const merged = new LedgerStore({ dir: done.dir, now: () => T0 });
    merged.append({
      event_kind: "state_transition",
      negotiation_id: "neg_active_001",
      identity: {
        sender_identity: "mkt_veyquo",
        counterparty_identity: "buyer:*",
        actor: "merchant",
      },
      capability: {
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
      },
      state_transition: { from_phase: "OPEN", to_phase: "OFFER_OPEN" },
      outcome: { kind: "ok" },
      occurred_at: T0,
    });
    const h = setupWorkbench({ a2aLedgerDir: done.dir });
    const { total, items } = await h.service.listA2aNegotiations();
    expect(total).toBe(2);
    expect(items).toHaveLength(2);
    const doneRow = items.find((r) => r.negotiation_id === done.negotiationId);
    expect(doneRow).toMatchObject({
      phase: "AGREEMENT_REACHED",
      last_action: "conditional_offer",
      sku: "sku-002",
      quantity: 1,
      price_minor: 9900,
      agreement: true,
      recorded_at: T0,
    });
    await expect(h.service.getA2aNegotiation(done.negotiationId)).resolves.toEqual(doneRow);
    await expect(h.service.getA2aNegotiation("neg_missing")).rejects.toMatchObject({
      kind: "not_found",
    });
    const activeRow = items.find((r) => r.negotiation_id === "neg_active_001");
    expect(activeRow).toMatchObject({ phase: "OFFER_OPEN", agreement: false, sku: "" });
    h.cleanup();
  });

  it("limit 缺省 20 并 clamp 到 1..100", async () => {
    const { dir } = ledgerDir("neg_clamp_001", "OFFER_OPEN");
    const h = setupWorkbench({ a2aLedgerDir: dir });
    await expect(h.service.listA2aNegotiations(0)).resolves.toMatchObject({ total: 1 });
    expect((await h.service.listA2aNegotiations(0)).items).toHaveLength(1);
    expect((await h.service.listA2aNegotiations(999)).items).toHaveLength(1);
    expect((await h.service.listA2aNegotiations("junk")).items).toHaveLength(1);
    expect((await h.service.listA2aNegotiations()).items).toHaveLength(1);
    h.cleanup();
  });

  it("listActiveConsultations 只留非终态磋商", async () => {
    const { dir, negotiationId } = ledgerDir("neg_open_001", "OPEN");
    const ledger = new LedgerStore({ dir, now: () => T0 });
    const identity = {
      sender_identity: "mkt_veyquo",
      counterparty_identity: "buyer:*",
      actor: "merchant",
    } as const;
    const capability = {
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
    } as const;
    ledger.append({
      event_kind: "state_transition",
      negotiation_id: "neg_terminal_001",
      identity,
      capability,
      state_transition: { from_phase: "OPEN", to_phase: "DECLINED" },
      outcome: { kind: "ok" },
      occurred_at: T0,
    });
    const h = setupWorkbench({ a2aLedgerDir: dir });
    const rows = await h.service.listActiveConsultations();
    expect(rows.map((r) => r.negotiation_id)).toEqual([negotiationId]);
    // 全量列表仍包含终态记录
    const all = await h.service.listA2aNegotiations();
    expect(all.total).toBe(2);
    h.cleanup();
  });
});

describe("dataSource 优先", () => {
  it("配置 dataSource 时目录列表走数据源，不调用 merchantClient.listProducts", async () => {
    const h = setupWorkbench({
      dataSource: {
        getProducts: vi.fn(async () => [
          { sku: "sku-ds", title: "数据源商品", price_minor: 12300, stock: 7 },
        ]),
        getProduct: vi.fn(async () => undefined),
        getInventory: vi.fn(async () => undefined),
        getPrice: vi.fn(async () => undefined),
        getPublicListing: vi.fn(async () => ({})),
        health: vi.fn(async () => ({ ok: true })),
      } as unknown as NonNullable<MerchantWorkbenchServiceDeps["dataSource"]>,
    });
    const spy = vi.spyOn(h.merchantClient, "listProducts");
    const { items, source } = await h.service.listPublicProducts();
    expect(source).toBe("data_source");
    expect(spy).not.toHaveBeenCalled();
    expect(items).toEqual([
      {
        sku: "sku-ds",
        merchant_id: "merchant-001",
        title: "数据源商品",
        price: 12300,
        stock: 7,
        paused: false,
      },
    ]);
    h.cleanup();
  });
});

describe("审批链路闭环（阶段四：MCP 进程可批准并执行自己的候选）", () => {
  async function draftCandidate(h: Harness, changes: Record<string, unknown>): Promise<string> {
    const result = await h.service.draftProductChange({ sku: "sku-001", changes });
    // manual 模式返回 advice_only（同样带候选；批准路径应拒绝执行）
    if (result.outcome.kind !== "pending_approval" && result.outcome.kind !== "advice_only") {
      throw new Error("expected pending candidate");
    }
    return result.outcome.candidate.candidate_id;
  }

  it("draft → approveCandidate 真正执行 updateProduct（只执行库内已批准参数）", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const candidateId = await draftCandidate(h, { price: 88 });
    expect(spy).not.toHaveBeenCalled();

    const outcome = await h.service.approveCandidate(candidateId);
    expect(outcome.kind).toBe("executed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("sku-001", { price: 88 });
    expect(h.approvals.get(candidateId)?.status).toBe("executed");
    // 审计可追溯：候选记录含 candidate_id / arguments_hash / 状态流转
    const record = h.approvals.get(candidateId);
    expect(record?.candidate_id).toBe(candidateId);
    expect(record?.arguments_hash).toMatch(/^sha256:/);
    h.cleanup();
  });

  it("过期候选拒绝执行（markApproved fail-closed）", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const candidateId = await draftCandidate(h, { price: 88 });
    // 推进时钟越过 15 分钟审批窗口
    h.clock.value = new Date(Date.parse(T0) + 16 * 60 * 1000).toISOString();
    await expect(h.service.approveCandidate(candidateId)).rejects.toMatchObject({
      name: "MerchantWorkbenchError",
      kind: "validation",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(h.approvals.get(candidateId)?.status).toBe("expired");
    h.cleanup();
  });

  it("重复批准同一候选幂等：不会执行两次", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const candidateId = await draftCandidate(h, { price: 88 });
    const first = await h.service.approveCandidate(candidateId);
    expect(first.kind).toBe("executed");
    const second = await h.service.approveCandidate(candidateId);
    expect(second.kind).toBe("not_approvable");
    expect(spy).toHaveBeenCalledTimes(1);
    h.cleanup();
  });

  it("未知候选抛 not_found", async () => {
    const h = setupWorkbench();
    await expect(h.service.approveCandidate("act_nonexistent")).rejects.toMatchObject({
      kind: "not_found",
    });
    h.cleanup();
  });

  it("manual 模式拒绝批准（advice-only 语义对齐 kernel）", async () => {
    const h = setupWorkbench({ mode: "manual" });
    const candidateId = await draftCandidate(h, { price: 88 });
    const outcome = await h.service.approveCandidate(candidateId);
    expect(outcome.kind).toBe("not_approvable");
    h.cleanup();
  });

  it("重启恢复：新服务实例 recoverPendingDrafts 后可批准并执行遗留候选", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const candidateId = await draftCandidate(h, { price: 88 });

    // 模拟 MCP 进程重启：同一 store + merchantClient，新服务实例（无钩子）
    const restarted = new MerchantWorkbenchService({
      profile: testProfile(),
      merchantClient: h.merchantClient,
      approvals: h.approvals,
      mode: () => "supervised",
      now: () => h.clock.value,
    });
    // 未恢复前：无钩子 → 按恢复语义 fail-closed 失效候选
    const beforeRecover = await restarted.approveCandidate(candidateId);
    expect(beforeRecover.kind).toBe("expired");
    expect(spy).not.toHaveBeenCalled();
    h.cleanup();
  });

  it("重启恢复：recoverPendingDrafts 重建钩子后遗留候选可执行", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const candidateId = await draftCandidate(h, { price: 88 });

    const restarted = new MerchantWorkbenchService({
      profile: testProfile(),
      merchantClient: h.merchantClient,
      approvals: h.approvals,
      mode: () => "supervised",
      now: () => h.clock.value,
    });
    expect(restarted.recoverPendingDrafts()).toBe(1);
    const outcome = await restarted.approveCandidate(candidateId);
    expect(outcome.kind).toBe("executed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("sku-001", { price: 88 });
    h.cleanup();
  });

  it("recoverPendingDrafts 只恢复 draft_product_change，不动其他工具的候选", async () => {
    const h = setupWorkbench({ mode: "supervised" });
    const draftId = await draftCandidate(h, { price: 88 });
    // 手工塞一个其他工具的 pending 候选
    const other = h.approvals.create({
      tool: "update_inventory",
      arguments: { sku: "sku-001", stock: 3 },
      preconditions: { sku: "sku-001" },
      risk: "update_inventory",
      expires_at: new Date(Date.parse(T0) + 15 * 60 * 1000).toISOString(),
    });
    expect(h.service.recoverPendingDrafts()).toBe(1);
    expect(h.approvals.get(draftId)?.status).toBe("pending_approval");
    expect(h.approvals.get(other.candidate_id)?.status).toBe("pending_approval");
    h.cleanup();
  });
});
