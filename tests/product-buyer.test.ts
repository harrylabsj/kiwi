/**
 * `kiwi buyer` 命令面测试（product-strategy rev1.1 §2.2/§19 D4）。
 *
 * 覆盖：
 * - buyerInit：生成可被 loadProfile 读取的 buyer profile（role: buyer、
 *   agent_id 即身份、无需 shopping-cli）；
 * - buyerSearch：Product-first 搜索（mock KiwiCatalogSource 的
 *   /v1/listings/search）→ 结果带 authority/requires_direct_confirmation
 *   标注与 owner_agent_id（discovery projection 语义）；
 * - buyerTasks：临时 state.sqlite 插 buyer_tasks 行 → 读取；
 * - 空 agentId / 已存在输出 fail-closed。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProfile } from "../src/config/profile.js";
import { buyerInit, buyerSearch, buyerTasks } from "../src/product-buyer.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kiwi-buyer-"));
}

function listingSearchResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      results: [
        {
          listing: {
            listing_id: "lst_buyer_001",
            listing_type: "product",
            owner_agent_id: "cagt_merchant_001",
            merchant_id: "mrc_1",
            source_product_ref: "SKU-21",
            title: "21.5 inch Industrial Touch Display",
            category: "industrial-display",
            listing_digest: "d",
            publication_state: "ACTIVE",
            listing_freshness_state: "FRESH",
            published_at: "2026-08-07T00:00:00Z",
            updated_at: "2026-08-07T00:00:00Z",
            fresh_until: "2026-08-08T00:00:00Z",
            commercial_hints: { moq: 50, price_range_hint: "CNY 800-1200" },
          },
          merchant: { merchant_id: "mrc_1", display_name: "Acme Displays" },
          agent: {
            catalog_agent_id: "cagt_merchant_001",
            verification_level: "commerce_verified",
            freshness_state: "fresh",
            administrative_state: "active",
          },
          listing_freshness_state: "FRESH",
          authority: "discovery_projection",
          requires_direct_confirmation: true,
        },
      ],
      next_cursor: "",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("buyer init (D4)", () => {
  it("generates a loadable buyer profile without shopping-cli", async () => {
    const dir = tmpDir();
    try {
      const outputPath = path.join(dir, "buyer.yaml");
      const report = buyerInit({
        agentId: "buyer-alice",
        outputPath,
      });
      expect(report.ok).toBe(true);
      expect(report.agent_id).toBe("buyer-alice");

      const profile = loadProfile(outputPath);
      expect(profile.role).toBe("buyer");
      expect(profile.agent_id).toBe("buyer-alice");
      expect(profile.owner_id).toBe("buyer-alice");
      expect(profile.buyer_policy?.auto_negotiate).toBe(true);

      // secret 不入 profile
      const raw = readFileSync(outputPath, "utf-8");
      expect(raw).not.toMatch(/api_key:\s*\S+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty agent id and existing output fail closed", () => {
    const dir = tmpDir();
    try {
      const bad = buyerInit({ agentId: "  " });
      expect(bad.ok).toBe(false);

      const outputPath = path.join(dir, "buyer.yaml");
      expect(buyerInit({ agentId: "a", outputPath }).ok).toBe(true);
      const second = buyerInit({ agentId: "b", outputPath });
      expect(second.ok).toBe(false);
      expect(second.detail).toContain("已存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buyer search (D4, product-first)", () => {
  it("returns discovery projections with authority markers", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/v1/listings/search")) return listingSearchResponse();
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    const hits = await buyerSearch({
      query: "21.5 寸工业触摸屏",
      catalogUrl: "http://127.0.0.1:8600",
      fetchImpl,
    });

    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.listing_id).toBe("lst_buyer_001");
    expect(hit.owner_agent_id).toBe("cagt_merchant_001");
    expect(hit.owner_verification).toBe("commerce_verified");
    expect(hit.authority).toBe("discovery_projection");
    expect(hit.requires_direct_confirmation).toBe(true);
    expect(hit.merchant).toBe("Acme Displays");
  });

  it("search failure propagates (network fail-closed)", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    await expect(
      buyerSearch({ query: "x", catalogUrl: "http://127.0.0.1:8600", fetchImpl }),
    ).rejects.toThrow();
  });
});

describe("buyer tasks (D4)", () => {
  it("lists tasks from the agent data dir", async () => {
    const dir = tmpDir();
    try {
      const dbPath = path.join(dir, "state.sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(
        "create table if not exists buyer_tasks (" +
          "task_id text primary key, principal_id text, status text, goal_text text," +
          " intent_json text, constraints_json text, ranking_policy_json text," +
          " connector_scope_json text, search_budget_json text, tracking_policy_json text," +
          " selected_candidate_id text, next_run_at text, expires_at text, version integer," +
          " created_at text, updated_at text)",
      );
      db.prepare(
        "insert into buyer_tasks(task_id, principal_id, status, goal_text, intent_json," +
          " constraints_json, ranking_policy_json, connector_scope_json, search_budget_json," +
          " tracking_policy_json, version, created_at, updated_at)" +
          " values (?, ?, ?, ?, '{}', '{}', '{}', '{}', '{}', '{}', 1, ?, ?)",
      ).run("task_1", "buyer-alice", "searching", "买 500 台触摸屏", "t0", "t1");
      db.close();

      const tasks = await buyerTasks({ dataDir: dir });
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.task_id).toBe("task_1");
      expect(tasks[0]!.status).toBe("searching");
      expect(tasks[0]!.goal_text).toBe("买 500 台触摸屏");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing data dir fails closed with guidance", async () => {
    const dir = tmpDir();
    try {
      await expect(buyerTasks({ dataDir: dir })).rejects.toThrow("buyer start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
