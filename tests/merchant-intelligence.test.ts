import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../src/agent/merchant/fake-merchant-client.js";
import { DefaultMerchantIntelligenceBackend } from "../src/agent/merchant/intelligence/default-backend.js";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import { buildMerchantTools } from "../src/agent/merchant/merchant-tools.js";
import { openMerchantStatsStore } from "../src/merchant/stats-store.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-08-20T10:00:00.000Z";

function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-merchant-intelligence-"));
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run("merchant-agent:merchant-001", NOW, NOW);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: "merchant-agent:merchant-001",
    now: () => NOW,
  });
  const client = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
  const stats = openMerchantStatsStore({ dbPath: path.join(dataDir, "a2a", "stats.sqlite") });
  stats.recordBuyerContact({
    message_id: "msg-1",
    buyer_identity: "buyer-1",
    negotiation_id: "neg-1",
    exchange_id: "ex-1",
    action: "rfq",
    skus: ["sku-001"],
    occurred_at: NOW,
  });
  return { dataDir, db, approvals, client, stats };
}

describe("DefaultMerchantIntelligenceBackend", () => {
  it("projects current contact metrics and catalog health", async () => {
    const f = fixture();
    try {
      const backend = new DefaultMerchantIntelligenceBackend({
        merchant_id: "merchant-001",
        data_dir: f.dataDir,
        principal_id: "merchant-agent:merchant-001",
        merchant_client: f.client,
        approvals: f.approvals,
        now: () => NOW,
      });
      const snapshot = await backend.getBusinessSnapshot({ merchant_id: "merchant-001", period: "7d" });
      expect(snapshot.metrics.find((m) => m.name === "distinct_buyers")?.value).toBe(1);
      expect(snapshot.metrics.find((m) => m.name === "contact_events")?.value).toBe(1);
      expect(snapshot.metrics.find((m) => m.name === "agreements_reached")?.value).toBe(0);
      expect(snapshot.metrics.find((m) => m.name === "agreement_rate")?.value).toBe(0);
      expect(snapshot.top_sku_contacts?.[0]).toMatchObject({ sku: "sku-001", contact_events: 1 });
      expect(snapshot.limitations.some((x) => x.source === "inventory")).toBe(true);

      const series = await backend.queryMetric({ merchant_id: "merchant-001", metric: "contact_events", period: "2d" });
      expect(series.points).toHaveLength(2);
      expect(series.points.at(-1)?.value).toBe(1);

      const weekly = await backend.queryMetric({
        merchant_id: "merchant-001",
        metric: "contact_events",
        period: "14d",
        granularity: "week",
      });
      expect(weekly.granularity).toBe("week");
      expect(weekly.points.reduce((sum, point) => sum + point.value, 0)).toBe(1);
      expect(weekly.points.every((point) => new Date(`${point.date}T00:00:00Z`).getUTCDay() === 1)).toBe(true);

      await expect(
        backend.queryMetric({ merchant_id: "merchant-001", metric: "contact_events", period: "forever" }),
      ).rejects.toThrow("period must use Nd syntax");
      await expect(
        backend.getBusinessSnapshot({ merchant_id: "merchant-001", period: "91d" }),
      ).rejects.toThrow("between 1 and 90");

      await expect(backend.getCatalogHealth({ merchant_id: "merchant-001" })).resolves.toMatchObject({
        total: 1,
        active: 1,
        paused: 0,
        out_of_stock: 0,
      });
    } finally {
      f.stats.close();
      f.db.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("exposes only pending candidate metadata", async () => {
    const f = fixture();
    try {
      f.approvals.create({
        tool: "update_product",
        arguments: { sku: "sku-001", changes: { price: 90 } },
        preconditions: { sku: "sku-001", price: 99 },
        risk: "write_catalog",
        expires_at: "2026-08-20T10:15:00.000Z",
      });
      const backend = new DefaultMerchantIntelligenceBackend({
        merchant_id: "merchant-001",
        data_dir: f.dataDir,
        principal_id: "merchant-agent:merchant-001",
        merchant_client: f.client,
        approvals: f.approvals,
        now: () => NOW,
      });
      const pending = await backend.getPendingActions();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ tool: "update_product", risk: "write_catalog", stale_sensitive: true });
      expect(pending[0]).not.toHaveProperty("arguments");
      expect(pending[0]).not.toHaveProperty("preconditions");
      const preview = await backend.getCandidatePreview({
        principal_id: "merchant-agent:merchant-001",
        candidate_id: pending[0]!.candidate_id,
      });
      expect(preview).toMatchObject({ candidate_id: pending[0]!.candidate_id, stale_sensitive: true });
      expect(preview?.changes).toEqual([{ field: "price", before: 99, after: 90 }]);
      await expect(backend.getCandidatePreview({
        principal_id: "merchant-agent:merchant-evil",
        candidate_id: pending[0]!.candidate_id,
      })).rejects.toThrow("principal identity does not match");
    } finally {
      f.stats.close();
      f.db.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("mounts the opt-in intelligence and presentation tools", async () => {
    const f = fixture();
    try {
      const backend = new DefaultMerchantIntelligenceBackend({
        merchant_id: "merchant-001",
        data_dir: f.dataDir,
        merchant_client: f.client,
        approvals: f.approvals,
        now: () => NOW,
      });
      const events: Array<{ type: string; data: unknown }> = [];
      const tools = buildMerchantTools({
        profile: testProfile({ merchant_experience: { enabled: true, intelligence: true, presentation: true } }),
        merchantClient: f.client,
        broker: new StaticCredentialBroker({ catalog: "catalog", inventory: "inventory" }),
        approvals: f.approvals,
        mode: () => "supervised",
        now: () => NOW,
        intelligence: backend,
        emitEvent: async (type, data) => {
          events.push({ type, data });
        },
      });
      const getSnapshot = tools.find((tool) => tool.name === "get_business_snapshot");
      const presentDigest = tools.find((tool) => tool.name === "present_merchant_digest");
      expect(getSnapshot).toBeDefined();
      expect(presentDigest).toBeDefined();
      const snapshot = await getSnapshot?.execute("test", {}, undefined, undefined, undefined);
      expect(snapshot?.content[0]).toMatchObject({ type: "text" });
      expect((snapshot?.content[0] as { text: string }).text).toContain("kiwi_external_data_metric");
      await presentDigest?.execute("test", {}, undefined, undefined, undefined);
      expect(events.some((event) => event.type === "ui")).toBe(true);
    } finally {
      f.stats.close();
      f.db.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a cross-merchant intelligence request", async () => {
    const f = fixture();
    try {
      const backend = new DefaultMerchantIntelligenceBackend({
        merchant_id: "merchant-001",
        data_dir: f.dataDir,
        merchant_client: f.client,
        approvals: f.approvals,
        now: () => NOW,
      });
      await expect(backend.getBusinessSnapshot({ merchant_id: "merchant-evil" })).rejects.toThrow(
        "merchant identity does not match",
      );
    } finally {
      f.stats.close();
      f.db.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("accepts formal sales analytics without allowing authority collisions", async () => {
    const f = fixture();
    try {
      const backend = new DefaultMerchantIntelligenceBackend({
        merchant_id: "merchant-001",
        data_dir: f.dataDir,
        merchant_client: f.client,
        approvals: f.approvals,
        analytics_source: {
          async getMetrics() {
            return {
              metrics: [
                { name: "gross_sales", value: 12_345, unit: "minor_currency", currency: "CNY", observed_at: NOW },
                { name: "contact_events", value: 999, unit: "count", observed_at: NOW },
              ],
            };
          },
          async queryMetric(input) {
            if (input.metric === "bad_series") {
              return {
                metric: input.metric,
                unit: "count",
                period: input.period,
                granularity: input.granularity,
                points: [{ date: "2026-08-17", value: Number.NaN }],
              } as never;
            }
            if (input.metric !== "gross_sales") return undefined;
            return {
              metric: input.metric,
              unit: "minor_currency",
              currency: "CNY",
              period: input.period,
              granularity: input.granularity,
              points: [{ date: "2026-08-17", value: 12_345 }],
            };
          },
        },
        now: () => NOW,
      });
      const snapshot = await backend.getBusinessSnapshot({ merchant_id: "merchant-001", period: "7d" });
      expect(snapshot.metrics.find((metric) => metric.name === "gross_sales")).toMatchObject({
        value: 12_345,
        unit: "minor_currency",
        currency: "CNY",
      });
      expect(snapshot.metrics.find((metric) => metric.name === "contact_events")?.value).toBe(1);
      expect(snapshot.limitations.some((item) => item.note.includes("contact_events") && item.note.includes("冲突"))).toBe(true);
      const series = await backend.queryMetric({ merchant_id: "merchant-001", metric: "gross_sales", period: "7d", granularity: "week" });
      expect(series).toMatchObject({ metric: "gross_sales", unit: "minor_currency", currency: "CNY", period: "7d", granularity: "week" });
      await expect(backend.queryMetric({ merchant_id: "merchant-001", metric: "bad_series", period: "7d" })).resolves.toMatchObject({
        points: [],
        note: "分析数据源返回了无效指标序列",
      });
    } finally {
      f.stats.close();
      f.db.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("deduplicates distinct buyers within week and month buckets", async () => {
    const f = fixture();
    try {
      f.stats.recordBuyerContact({
        message_id: "msg-2",
        buyer_identity: "buyer-1",
        negotiation_id: "neg-2",
        exchange_id: "ex-2",
        action: "rfq",
        skus: ["sku-001"],
        occurred_at: "2026-08-19T10:00:00.000Z",
      });
      const backend = new DefaultMerchantIntelligenceBackend({
        merchant_id: "merchant-001",
        data_dir: f.dataDir,
        merchant_client: f.client,
        approvals: f.approvals,
        now: () => NOW,
      });
      const weekly = await backend.queryMetric({ merchant_id: "merchant-001", metric: "distinct_buyers", period: "14d", granularity: "week" });
      const monthly = await backend.queryMetric({ merchant_id: "merchant-001", metric: "distinct_buyers", period: "14d", granularity: "month" });
      expect(weekly.points.reduce((sum, point) => sum + point.value, 0)).toBe(1);
      expect(monthly.points.reduce((sum, point) => sum + point.value, 0)).toBe(1);
    } finally {
      f.stats.close();
      f.db.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });
});
