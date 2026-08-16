#!/usr/bin/env node
/**
 * Hosted Sourcing Index（战略 v2.5 §十一 Phase 4 / §3.2）。
 *
 * kiwi-catalog 聚焦 Merchant verification、freshness、routing、ranking：
 *   1) refresh 每个注册商家（更新 FreshnessState）；
 *   2) 计算路由评分 = freshness（fresh>stale）+ verification_level
 *      + 商品覆盖（marketplace 真实商品数）+ capability；
 *   3) 输出排序后的 Sourcing Index（供 kiwi_search 路由参考）。
 * 商品 truth 留在 merchant/marketplace；本索引进路由（§3.2 不拥有商品 truth）。
 *
 * 用法：
 *   node scripts/pilot/sourcing-index.mjs \
 *     --catalog-url http://127.0.0.1:8000 \
 *     --catalog-admin-token <TOKEN> --marketplace-url http://127.0.0.1:8765
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name, fb) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb; };
const CATALOG = flag("catalog-url", "http://127.0.0.1:8000");
const ADMIN = flag("catalog-admin-token", "kiwi-pilot-admin-0123456789abcdef");
const MARKETPLACE = flag("marketplace-url", "http://127.0.0.1:8765");

const FRESH_WEIGHT = { fresh: 1.0, stale: 0.5, unreachable: 0.1 };
const VERIFY_WEIGHT = {
  discovered: 0.3, profile_valid: 0.4, domain_verified: 0.6,
  agent_verified: 0.8, commerce_verified: 1.0,
};

// 1) 从 catalog 取商家列表
const agentsRes = await fetch(`${CATALOG}/v1/agents`, { signal: AbortSignal.timeout(5000) });
const agents = agentsRes.ok ? ((await agentsRes.json()).results ?? []) : [];
const merchants = agents.filter((a) => a.merchant_id !== undefined && a.merchant_id !== "");

// 2) refresh 每个商家（更新 FreshnessState）
for (const a of merchants) {
  await fetch(`${CATALOG}/v1/agents/${a.catalog_agent_id}/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}
const refreshedRes = await fetch(`${CATALOG}/v1/agents`, { signal: AbortSignal.timeout(5000) });
const refreshed = refreshedRes.ok ? ((await refreshedRes.json()).results ?? []) : [];

// 3) 商品覆盖（marketplace 真实商品 per merchant）
const prodRes = await fetch(`${MARKETPLACE}/search/products?limit=100`, { signal: AbortSignal.timeout(5000) });
const products = prodRes.ok ? ((await prodRes.json()).results ?? []) : [];
const productCount = new Map();
for (const p of products) if (p.merchant_id) productCount.set(p.merchant_id, (productCount.get(p.merchant_id) ?? 0) + 1);

// 4) 路由评分 + 排序
const entries = refreshed
  .filter((a) => a.merchant_id !== undefined && a.merchant_id !== "")
  .map((a) => {
    const freshness = (a.freshness_state ?? a.freshness?.state ?? "stale").toLowerCase();
    const verify = (a.verification_level ?? "discovered").toLowerCase();
    const coverage = productCount.get(a.merchant_id) ?? 0;
    const score = Math.round(
      ((FRESH_WEIGHT[freshness] ?? 0.5) * 0.4 +
        (VERIFY_WEIGHT[verify] ?? 0.3) * 0.3 +
        Math.min(coverage / 10, 1) * 0.2 +
        (a.capabilities?.length ? 0.1 : 0)) * 100,
    );
    return {
      merchant_id: a.merchant_id,
      display_name: a.display_name,
      freshness: freshness,
      verification: verify,
      product_coverage: coverage,
      capabilities: a.capabilities ?? [],
      routing_score: score,
    };
  })
  .sort((x, y) => y.routing_score - x.routing_score);

const report = { generated_at: new Date().toISOString(), merchants: entries };
writeFileSync(`${root}/.kiwi/pilot/evidence/sourcing-index.json`, JSON.stringify(report, null, 2));
console.log("===== Hosted Sourcing Index（routing ranking）=====");
for (const e of entries) {
  console.log(`  #${String(entries.indexOf(e) + 1)} ${e.merchant_id.padEnd(26)} score=${e.routing_score} fresh=${e.freshness} verify=${e.verification} products=${e.product_coverage}`);
}
console.log(`report: ${root}/.kiwi/pilot/evidence/sourcing-index.json`);
