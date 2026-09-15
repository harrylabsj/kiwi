/**
 * Merchant presentation → MCP 资源测试（V2 阶段二）：
 * - 七类组件全部映射为资源（kiwi-merchant://presentation/<component>）；
 * - read 返回结构化 JSON + 等效文本摘要（降级不丢关键字段）；
 * - 参数化资源缺参数时可读错误；
 * - 资源内容白名单脱敏（无私密字段）；私密类（阈值等）没有对应资源。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import type { MerchantIntelligenceBackend } from "../src/agent/merchant/intelligence/backend.js";
import {
  buildMerchantPresentationResources,
  MERCHANT_RESOURCE_PREFIX,
  textSummary,
} from "../src/mcp/merchant-resources.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";

function fixture() {
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
  const intelligence = {
    getBusinessSnapshot: async () => ({
      merchant_id: "merchant-001",
      period: "7d",
      generated_at: T0,
      metrics: [],
      alerts: { active_negotiations: 1, human_reviews: 2, pending_actions: 3, low_stock: null },
      limitations: [],
    }),
    queryMetric: async () => ({
      metric: "contact_events",
      granularity: "day",
      points: [{ date: "2026-09-15", value: 2 }],
    }),
    getCatalogHealth: async () => ({ total: 1, active: 1, paused: 0, out_of_stock: 0 }),
    getNegotiationDigest: async () => [],
    getPendingActions: async () => [],
    getCandidatePreview: async (input: { candidate_id: string }) => ({
      candidate_id: input.candidate_id,
      tool: "kiwi_merchant_prepare_product_change",
      status: "pending_approval",
    }),
  } as unknown as MerchantIntelligenceBackend;
  const resources = buildMerchantPresentationResources({
    context: {
      profile: testProfile(),
      // kernel 缺省 principalId = ownerId（merchantPresentations 以它作为商家 id 读目录）
      principalId: "merchant-001",
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      approvals,
      intelligence,
    },
  });
  return { resources, approvals, db };
}

describe("merchant presentation MCP 资源", () => {
  it("七类组件全部映射；私密类无资源", () => {
    const { resources } = fixture();
    const list = resources.list();
    expect(list.map((r) => r.name).sort()).toEqual(
      [
        "catalog",
        "change_preview",
        "human_review",
        "merchant_digest",
        "metrics",
        "negotiations",
        "suggestions",
      ].sort(),
    );
    for (const r of list) {
      expect(r.uri).toBe(`${MERCHANT_RESOURCE_PREFIX}${r.name}`);
      expect(r.mimeType).toBe("application/json");
    }
    // 私密阈值不是资源（F23：私密数值不进工具结果与资源）
    expect(JSON.stringify(list)).not.toContain("threshold");
    expect(JSON.stringify(list)).not.toContain("private");
  });

  it("read catalog：JSON payload + 文本摘要双 content，白名单字段", async () => {
    const { resources } = fixture();
    const { contents } = await resources.read(`${MERCHANT_RESOURCE_PREFIX}catalog`);
    expect(contents).toHaveLength(2);
    const json = contents.find((c) => c.mimeType === "application/json");
    const text = contents.find((c) => c.mimeType === "text/plain");
    const payload = JSON.parse(json?.text ?? "{}") as { products: Array<Record<string, unknown>> };
    expect(payload.products[0]).toMatchObject({ sku: "sku-001", title: "手写陶瓷杯" });
    expect(json?.text).not.toContain("floor_price");
    expect(json?.text).not.toContain("min_unit_price_private");
    expect(text?.text).toContain("商品目录");
    expect(text?.text).toContain("1 个商品");
  });

  it("read merchant_digest / negotiations / human_review / metrics 正常降级", async () => {
    const { resources } = fixture();
    const digest = await resources.read(`${MERCHANT_RESOURCE_PREFIX}merchant_digest`);
    expect(digest.contents[1]?.text).toContain("人工待处理 2");
    expect(digest.contents[1]?.text).toContain("低库存 不可得"); // null → 不可得，不填零
    const nego = await resources.read(`${MERCHANT_RESOURCE_PREFIX}negotiations`);
    expect(nego.contents[1]?.text).toContain("磋商列表");
    const review = await resources.read(`${MERCHANT_RESOURCE_PREFIX}human_review`);
    expect(review.contents[1]?.text).toContain("人工处理队列");
    const metrics = await resources.read(
      `${MERCHANT_RESOURCE_PREFIX}metrics?metric=contact_events`,
    );
    expect(metrics.contents[1]?.text).toContain("contact_events");
  });

  it("参数化资源缺参数 → 可读错误；未知资源 → 错误", async () => {
    const { resources } = fixture();
    await expect(resources.read(`${MERCHANT_RESOURCE_PREFIX}metrics`)).rejects.toThrow(/metric/);
    await expect(resources.read(`${MERCHANT_RESOURCE_PREFIX}change_preview`)).rejects.toThrow(
      /candidate_id/,
    );
    await expect(resources.read(`${MERCHANT_RESOURCE_PREFIX}nope`)).rejects.toThrow(/未知/);
    await expect(resources.read("other://x")).rejects.toThrow(/未知资源/);
  });

  it("read change_preview：候选元数据（展示不批准不执行）", async () => {
    const { resources, approvals } = fixture();
    const candidate = approvals.create({
      tool: "kiwi_merchant_prepare_product_change",
      arguments: { sku: "sku-001", changes: { price: 88 } },
      preconditions: { sku: "sku-001" },
      risk: "write_catalog",
      expires_at: "2026-09-15T11:00:00.000Z",
    });
    const { contents } = await resources.read(
      `${MERCHANT_RESOURCE_PREFIX}change_preview?candidate_id=${candidate.candidate_id}`,
    );
    const text = contents.find((c) => c.mimeType === "text/plain");
    expect(text?.text).toContain("变更预览");
    expect(text?.text).toContain(candidate.candidate_id);
    expect(text?.text).toContain("不批准不执行");
  });

  it("textSummary 降级摘要覆盖七类组件", () => {
    expect(textSummary("suggestions", { suggestions: ["A", "B"] })).toContain("A；B");
    expect(textSummary("unknown", { a: 1 })).toBe('{"a":1}');
  });
});
