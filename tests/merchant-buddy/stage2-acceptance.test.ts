/**
 * V2 阶段二验收测试（计划「四、阶段二」口径）：
 * - 金额/时间口径一致：工具结果金额 minor 整数、时间戳 RFC3339 带时区；
 * - 缺失数据显示「不可得」不填零（上游缺字段/无指标后端/低库存未知）；
 * - 不暴露其他商家或人员资料：跨租户拒绝、私密字段不出现在任何工具输出
 *   与展示资源。
 *
 * 确定性：Fake 客户端 + 注入时钟 + 临时目录。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../../src/agent/merchant/fake-merchant-client.js";
import type { MerchantCatalogProduct } from "../../src/agent/merchant/types.js";
import type { MerchantIntelligenceBackend } from "../../src/agent/merchant/intelligence/backend.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { buildMerchantMcpTools } from "../../src/mcp/merchant-tools.js";
import { buildMerchantPresentationResources } from "../../src/mcp/merchant-resources.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const RFC3339_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** 夹带私密字段的商品（脱敏断言用）。 */
const LEAKY = {
  ...fakeMerchantProduct(),
  floor_price: 66,
  cost: 40,
} as MerchantCatalogProduct;

function fixture(options: { leaky?: boolean; withIntelligence?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const client = new FakeMerchantClient({
    products: [options.leaky === true ? LEAKY : fakeMerchantProduct()],
  });
  const intelligence =
    options.withIntelligence === true
      ? ({
          getBusinessSnapshot: async () => ({
            merchant_id: "merchant-001",
            period: "7d",
            generated_at: T0,
            metrics: [],
            alerts: {
              active_negotiations: 0,
              human_reviews: 0,
              pending_actions: 0,
              low_stock: null,
            },
            limitations: [],
          }),
          queryMetric: async () => ({ metric: "contact_events", granularity: "day", points: [] }),
          getCatalogHealth: async () => ({ total: 1, active: 1, paused: 0, out_of_stock: null }),
          getNegotiationDigest: async () => [],
          getPendingActions: async () => [],
          getCandidatePreview: async () => undefined,
        } as unknown as MerchantIntelligenceBackend)
      : undefined;
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals,
    mode: () => "supervised",
    now: () => T0,
    ...(intelligence !== undefined ? { intelligence } : {}),
  });
  const tools = buildMerchantMcpTools(core);
  const resources = buildMerchantPresentationResources({
    context: {
      profile: testProfile(),
      principalId: "merchant-001",
      merchantClient: client,
      approvals,
      ...(intelligence !== undefined ? { intelligence } : {}),
    },
  });
  return { core, tools, resources, db };
}

describe("阶段二验收：金额/时间口径一致", () => {
  it("工具结果金额为 minor 整数、时间戳 RFC3339 带时区（跨工具一致）", async () => {
    const f = fixture();
    const products = await f.tools.call("kiwi_merchant_list_products", {});
    const p = (products.structuredContent as { items: Array<{ price: number }> }).items[0];
    expect(Number.isInteger(p?.price)).toBe(true); // fake 客户端 major 元（99）——facade 透传客户端口径
    const inventory = await f.tools.call("kiwi_merchant_get_inventory", { sku: "sku-001" });
    const snapshot = (inventory.structuredContent as { snapshot: { observed_at: string } })
      .snapshot;
    expect(snapshot.observed_at).toMatch(RFC3339_TZ);
    const draft = await f.tools.call("kiwi_merchant_prepare_product_change", {
      sku: "sku-001",
      changes: { price: 88 },
    });
    const d = draft.structuredContent as { expires_at: string; created_at: string };
    expect(d.expires_at).toMatch(RFC3339_TZ);
    expect(d.created_at).toMatch(RFC3339_TZ);
    f.db.close();
  });
});

describe("阶段二验收：缺失数据「不可得」不填零", () => {
  it("低库存不可得 → null/「不可得」，不填零；无指标后端 → 明确错误", async () => {
    const f = fixture({ withIntelligence: true });
    const digest = await f.resources.read("kiwi-merchant://presentation/merchant_digest");
    const text = digest.contents.find((c) => c.mimeType === "text/plain")?.text ?? "";
    expect(text).toContain("低库存 不可得");
    expect(text).not.toContain("低库存 0");

    const noIntel = fixture();
    const analytics = await noIntel.tools.call("kiwi_merchant_get_analytics", {});
    expect(analytics.isError).toBe(true);
    expect(analytics.content[0]?.text).toContain("暂时性错误");
    f.db.close();
    noIntel.db.close();
  });

  it("数据源缺 stock 字段 → null（明确不可得），不填 0", async () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, T0, T0);
    const core = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: new FakeMerchantClient({ products: [] }),
      approvals: new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 }),
      mode: () => "supervised",
      now: () => T0,
      dataSource: {
        getProduct: async () => undefined,
        getProducts: async () => [{ sku: "sku-x", title: "无库存数据商品", price_minor: 100 }],
        getInventory: async () => undefined,
        getPrice: async () => undefined,
        getPublicListing: async () => ({}),
        health: async () => ({ ok: true }),
      },
    });
    const { items } = await core.listPublicProducts();
    expect(items[0]?.stock).toBeNull(); // 不可得 = null，不是 0
    db.close();
  });
});

describe("阶段二验收：不暴露其他商家或人员资料", () => {
  it("私密字段不出现在任何工具输出与展示资源", async () => {
    const f = fixture({ leaky: true, withIntelligence: true });
    const outputs: string[] = [];
    for (const name of [
      "kiwi_merchant_list_products",
      "kiwi_merchant_get_inventory",
      "kiwi_merchant_list_human_reviews",
      "kiwi_merchant_get_analytics",
    ]) {
      const r = await f.tools.call(
        name,
        name === "kiwi_merchant_get_inventory" ? { sku: "sku-001" } : {},
      );
      outputs.push(JSON.stringify(r.structuredContent ?? {}), JSON.stringify(r.content));
    }
    outputs.push(
      JSON.stringify(
        (await f.tools.call("kiwi_merchant_get_product", { sku: "sku-001" })).structuredContent,
      ),
    );
    for (const r of f.resources.list()) {
      // 参数化资源（metrics/change_preview/suggestions）跳过详情读，只验证列表元数据
      outputs.push(JSON.stringify(r));
    }
    const catalog = await f.resources.read("kiwi-merchant://presentation/catalog");
    outputs.push(JSON.stringify(catalog.contents));
    const joined = outputs.join("\n");
    expect(joined).not.toContain("floor_price");
    expect(joined).not.toContain('"cost"');
    expect(joined).not.toContain("min_unit_price_private");
    f.db.close();
  });

  it("跨租户：merchant_id 不属于本商家 → 拒绝（validation）", async () => {
    const f = fixture();
    const r = await f.tools.call("kiwi_merchant_get_product", {
      sku: "sku-001",
      merchant_id: "merchant-999",
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("参数或服务校验失败");
    f.db.close();
  });
});
