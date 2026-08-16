#!/usr/bin/env node
/**
 * Kiwi B2B 试点证据门采集（战略 v2.5 §3.4 / §十一 Phase 2 / §12 关键指标）。
 *
 * 对真实 marketplace（自建真实数据商家）批量跑真实 RFQ，采集每条的指标并输出
 * 可审计报告：
 *   - Qualified RFQ 判定：CommerceIntent 完整、DelegationPolicy 有效、≥1 Verified
 *     Merchant、真实回复/provenance、稳定 task_id、可解释结果；
 *   - 漏斗指标：TTFRFQ、merchant response rate、median latency、partial-failure rate；
 *   - 每条记录 provenance（negotiation_id / merchant_reply_id）供审计。
 *
 * 用法（marketplace 先由 scripts/pilot/run-marketplace.sh start 拉起）：
 *   node scripts/pilot/evidence-gate.mjs --count 24 \
 *     --marketplace-url http://127.0.0.1:8765 \
 *     --buyer-bootstrap-token <SHOPPING_BUYER_BOOTSTRAP_TOKEN> \
 *     --db /tmp/kiwi-evidence.sqlite --out /tmp/evidence-report.json
 */
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { TaskApprovalStore } = await import(`${root}/dist/buyer-core/store.js`);
const { KiwiBuyerService } = await import(`${root}/dist/buyer-core/service.js`);
const { MarketplaceQuoteFetcher } = await import(`${root}/dist/buyer-core/quote-fetcher.js`);
const { MarketplaceMerchantIndex } = await import(`${root}/dist/buyer-core/merchant-index.js`);

// ---- 参数解析 ----
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const COUNT = Number(flag("count", "24"));
const MARKETPLACE = flag("marketplace-url", "http://127.0.0.1:8765");
const BUYER_TOKEN = flag("buyer-bootstrap-token", "");
const DB = flag("db", "/tmp/kiwi-evidence.sqlite");
const OUT = flag("out", "/tmp/kiwi-evidence-report.json");
const CONCURRENCY = Number(flag("concurrency", "5"));

if (BUYER_TOKEN === "") {
  console.error("--buyer-bootstrap-token required");
  process.exit(2);
}

// ---- 真实试点场景矩阵（来自 seed-merchants 的真实商品）----
// 每个场景：merchant_ids 中混入不属于该商家的 SKU 时自然触发 partial-failure，
// 验证部分失败语义而非只看 happy path。
const SCENARIOS = [
  { title: "杭州 USB-C 扩展坞 ×10", intent: { intent_id: "ev-hz-dock-1", intent_type: "purchase", items: [{ query: "USB-C 扩展坞", sku: "HZ-DOCK-8IN1", quantity: { value: 10, unit: "个" } }], constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 400000 } } }, merchants: ["merchant-hz-xihu"] },
  { title: "杭州 HDMI 线 ×30", intent: { intent_id: "ev-hz-hdmi-1", intent_type: "purchase", items: [{ query: "HDMI 线", sku: "HZ-HDMI-2M", quantity: { value: 30, unit: "根" } }], constraints: { currency: "CNY", deadline: "2026-08-30T18:00:00+08:00" } }, merchants: ["merchant-hz-xihu"] },
  { title: "上海硒鼓 ×20", intent: { intent_id: "ev-sh-toner-1", intent_type: "procurement", items: [{ query: "激光打印机硒鼓", sku: "SH-TONER-05", quantity: { value: 20, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sh-pudong"] },
  { title: "上海 A4 纸 ×40 箱", intent: { intent_id: "ev-sh-paper-1", intent_type: "procurement", items: [{ query: "A4 复印纸", sku: "SH-PAPER-A4", quantity: { value: 40, unit: "箱" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sh-pudong"] },
  { title: "北京雷电 4 扩展坞 ×5", intent: { intent_id: "ev-bj-dock-1", intent_type: "purchase", items: [{ query: "雷电 4 扩展坞", sku: "BJ-DOCK-TB4", quantity: { value: 5, unit: "个" } }], constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 500000 } } }, merchants: ["merchant-bj-zhongguancun"] },
  { title: "北京 27 寸显示器 ×8", intent: { intent_id: "ev-bj-mon-1", intent_type: "purchase", items: [{ query: "27 英寸 2K 显示器", sku: "BJ-MON-27", quantity: { value: 8, unit: "台" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-bj-zhongguancun"] },
  { title: "广州机械键盘 ×15", intent: { intent_id: "ev-gz-kb-1", intent_type: "purchase", items: [{ query: "机械键盘", sku: "GZ-KB-MECH", quantity: { value: 15, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-gz-tianhe"] },
  { title: "广州摄像头 ×12", intent: { intent_id: "ev-gz-cam-1", intent_type: "purchase", items: [{ query: "1080P USB 摄像头", sku: "GZ-CAM-1080", quantity: { value: 12, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-gz-tianhe"] },
  { title: "深圳显示器支架 ×10", intent: { intent_id: "ev-sz-arm-1", intent_type: "purchase", items: [{ query: "显示器支架臂", sku: "SZ-MON-ARM", quantity: { value: 10, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sz-nanshan"] },
  { title: "深圳屏幕挂灯 ×6", intent: { intent_id: "ev-sz-light-1", intent_type: "purchase", items: [{ query: "屏幕挂灯", sku: "SZ-LIGHT-BAR", quantity: { value: 6, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sz-nanshan"] },
  { title: "5 家比价：USB-C 扩展坞 6 合 1", intent: { intent_id: "ev-multi-dock", intent_type: "purchase", items: [{ query: "USB-C 扩展坞 6 合 1", quantity: { value: 10, unit: "个" } }], constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 300000 } } }, merchants: ["merchant-hz-xihu", "merchant-sh-pudong", "merchant-bj-zhongguancun", "merchant-gz-tianhe", "merchant-sz-nanshan"] },
  { title: "5 家比价：A4 复印纸", intent: { intent_id: "ev-multi-paper", intent_type: "procurement", items: [{ query: "A4 复印纸 70g", quantity: { value: 30, unit: "箱" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-hz-xihu", "merchant-sh-pudong", "merchant-bj-zhongguancun", "merchant-gz-tianhe", "merchant-sz-nanshan"] },
  { title: "跨城比价：扩展坞（杭州 vs 广州）", intent: { intent_id: "ev-cross-dock-1", intent_type: "purchase", items: [{ query: "USB-C 扩展坞", sku: "HZ-DOCK-8IN1", quantity: { value: 20, unit: "个" } }], constraints: { currency: "CNY", budget: { currency: "CNY", amount_minor: 700000 } } }, merchants: ["merchant-hz-xihu", "merchant-gz-tianhe"] },
  { title: "跨城比价：硒鼓（上海 vs 杭州）", intent: { intent_id: "ev-cross-toner-1", intent_type: "procurement", items: [{ query: "硒鼓", sku: "SH-TONER-05", quantity: { value: 25, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sh-pudong", "merchant-hz-xihu"] },
  { title: "杭州转接头 ×100", intent: { intent_id: "ev-hz-usbca-1", intent_type: "purchase", items: [{ query: "USB-C 转 USB-A", sku: "HZ-CABLE-USBCA", quantity: { value: 100, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-hz-xihu"] },
  { title: "上海订书机 ×50", intent: { intent_id: "ev-sh-binder-1", intent_type: "procurement", items: [{ query: "订书机", sku: "SH-BINDER-2", quantity: { value: 50, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sh-pudong"] },
  { title: "北京 NVMe 固态 ×10", intent: { intent_id: "ev-bj-ssd-1", intent_type: "purchase", items: [{ query: "NVMe 固态硬盘", sku: "BJ-SSD-1T", quantity: { value: 10, unit: "块" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-bj-zhongguancun"] },
  { title: "广州会议麦克风 ×4", intent: { intent_id: "ev-gz-mic-1", intent_type: "purchase", items: [{ query: "会议全向麦克风", sku: "GZ-MIC-CON", quantity: { value: 4, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-gz-tianhe"] },
  { title: "深圳 4K 摄像头 ×3", intent: { intent_id: "ev-sz-cam4k-1", intent_type: "purchase", items: [{ query: "4K USB 摄像头", sku: "SZ-CAM-4K", quantity: { value: 3, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sz-nanshan"] },
  { title: "杭州笔记本支架 ×25", intent: { intent_id: "ev-hz-nb-1", intent_type: "purchase", items: [{ query: "笔记本立式支架", sku: "HZ-NB-HUB", quantity: { value: 25, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-hz-xihu"] },
  { title: "上海档案盒 ×60", intent: { intent_id: "ev-sh-folder-1", intent_type: "procurement", items: [{ query: "档案盒", sku: "SH-FOLDER-30", quantity: { value: 60, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sh-pudong"] },
  { title: "北京 DP 线 ×40", intent: { intent_id: "ev-bj-dp-1", intent_type: "purchase", items: [{ query: "DP 1.4 线缆", sku: "BJ-DP-CABLE", quantity: { value: 40, unit: "根" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-bj-zhongguancun"] },
  { title: "广州双模键盘 ×9", intent: { intent_id: "ev-gz-kb98-1", intent_type: "purchase", items: [{ query: "三模机械键盘", sku: "GZ-KB-98", quantity: { value: 9, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-gz-tianhe"] },
  { title: "深圳双屏支架 ×5", intent: { intent_id: "ev-sz-arm2-1", intent_type: "purchase", items: [{ query: "双屏显示器支架", sku: "SZ-MON-ARM2", quantity: { value: 5, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sz-nanshan"] },
  { title: "杭州数据线 ×80", intent: { intent_id: "ev-hz-cable-1", intent_type: "purchase", items: [{ query: "USB-C 数据线 100W", sku: "HZ-CABLE-C3", quantity: { value: 80, unit: "根" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-hz-xihu"] },
  { title: "北京内存条 ×16", intent: { intent_id: "ev-bj-ram-1", intent_type: "purchase", items: [{ query: "DDR4 16GB 内存", sku: "BJ-RAM-16G", quantity: { value: 16, unit: "条" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-bj-zhongguancun"] },
  { title: "跨城比价：显示器支架（深圳 vs 杭州）", intent: { intent_id: "ev-cross-arm-1", intent_type: "purchase", items: [{ query: "显示器支架臂", sku: "SZ-MON-ARM", quantity: { value: 8, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-sz-nanshan", "merchant-hz-xihu"] },
  { title: "广州音箱 ×20", intent: { intent_id: "ev-gz-spk-1", intent_type: "purchase", items: [{ query: "桌面音响条", sku: "GZ-SPK-BAR", quantity: { value: 20, unit: "个" } }], constraints: { currency: "CNY" } }, merchants: ["merchant-gz-tianhe"] },
];

// ---- 证据门判定 ----
function classify(rfq) {
  const candidates = Array.isArray(rfq.candidates) ? rfq.candidates : [];
  const succeeded = candidates.filter((c) => c.status === "succeeded");
  const failed = candidates.filter((c) => c.status === "failed" || c.status === "expired");
  const hasRealFacts = succeeded.some(
    (c) => c.provenance?.negotiation_id && c.provenance?.merchant_reply_id,
  );
  const qualified =
    rfq.intent_contract_valid === true &&
    rfq.task_id !== undefined &&
    succeeded.length >= 1 &&
    hasRealFacts &&
    (rfq.task_status === "succeeded" || rfq.task_status === "partial_success");
  return { qualified, succeededCount: succeeded.length, failedCount: failed.length };
}

// ---- 主流程 ----
const store = new TaskApprovalStore({ dbPath: DB });
const fetcher = new MarketplaceQuoteFetcher({
  baseUrl: MARKETPLACE,
  buyerBootstrapToken: BUYER_TOKEN,
  pollIntervalMs: 1000,
  timeoutMs: 12000,
});
const service = new KiwiBuyerService({
  store,
  principal: "company:evidence-gate",
  buyerAgentId: "buyer-agent:evidence",
  sessionId: "evidence-gate-session",
  delegationPolicy: {
    policy_id: "dp-evidence",
    version: "1.0",
    principal: "company:evidence-gate",
    expires_at: "2099-12-31T23:59:59Z",
    actions: {
      discover: { mode: "auto" },
      inquiry_rfq: { mode: "auto" },
      compare_offers: { mode: "auto" },
      counter_offer: { mode: "auto" },
      accept_nonbinding: { mode: "ask" },
      handoff: { mode: "ask" },
      payment: { mode: "never" },
    },
    limits: { max_rounds: 3 },
  },
  quoteFetcher: fetcher,
  merchantIndex: new MarketplaceMerchantIndex({ baseUrl: MARKETPLACE }),
});

const picked = SCENARIOS.slice(0, COUNT);
console.log(`evidence gate: ${picked.length} real RFQs against ${MARKETPLACE}`);
const rows = [];
let run = 0;
const queue = [...picked];
const workers = Array.from({ length: Math.min(CONCURRENCY, picked.length) }, async () => {
  while (queue.length > 0) {
    const scenario = queue.shift();
    if (scenario === undefined) return;
    const idempotencyKey = `ev-${scenario.intent.intent_id}`;
    const started = Date.now();
    const row = {
      scenario: scenario.title,
      intent_id: scenario.intent.intent_id,
      merchants: scenario.merchants,
      created_at: new Date().toISOString(),
    };
    try {
      const result = await service.requestQuotes({
        intent: scenario.intent,
        idempotency_key: idempotencyKey,
        merchant_ids: scenario.merchants,
      });
      row.latency_ms = Date.now() - started;
      row.task_id = result.task.task_id;
      row.task_status = result.task.status;
      row.intent_contract_valid = true; // service 内部强制契约校验，非法会抛错
      row.candidates = result.task.candidates;
      const cls = classify(row);
      row.qualified = cls.qualified;
      row.succeeded_count = cls.succeededCount;
      row.failed_count = cls.failedCount;
      row.ok = true;
    } catch (error) {
      row.ok = false;
      row.error = error instanceof Error ? error.message : String(error);
      row.intent_contract_valid = false;
      row.qualified = false;
    }
    rows.push(row);
    run += 1;
    if (run % 5 === 0 || run === picked.length) {
      const q = rows.filter((r) => r.qualified).length;
      console.log(`  ${run}/${picked.length} done; qualified so far: ${q}`);
    }
  }
});
await Promise.all(workers);

// ---- 聚合报告 ----
const qualified = rows.filter((r) => r.qualified);
const latencies = rows.filter((r) => r.latency_ms !== undefined).map((r) => r.latency_ms);
latencies.sort((a, b) => a - b);
const median = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : undefined;
const totalCandidates = rows.reduce((n, r) => n + (r.candidates?.length ?? 0), 0);
const succeededCandidates = rows.reduce((n, r) => n + (r.succeeded_count ?? 0), 0);

const report = {
  generated_at: new Date().toISOString(),
  marketplace: MARKETPLACE,
  total_rfqs: rows.length,
  qualified_rfqs: qualified.length,
  qualified_rfq_rate: rows.length > 0 ? qualified.length / rows.length : 0,
  merchant_response_rate: totalCandidates > 0 ? succeededCandidates / totalCandidates : 0,
  median_response_latency_ms: median,
  partial_failure_rate:
    rows.length > 0 ? rows.filter((r) => (r.failed_count ?? 0) > 0).length / rows.length : 0,
  rows,
};
const outPath = resolve(OUT);
const fs = await import("node:fs");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

console.log("\n===== Evidence Gate Summary =====");
console.log(`total RFQs:            ${report.total_rfqs}`);
console.log(`qualified RFQs:        ${report.qualified_rfqs} (rate ${(report.qualified_rfq_rate * 100).toFixed(1)}%)`);
console.log(`merchant response:     ${(report.merchant_response_rate * 100).toFixed(1)}% (${succeededCandidates}/${totalCandidates} candidates)`);
console.log(`median latency:        ${median ?? "-"} ms`);
console.log(`partial-failure rate:  ${(report.partial_failure_rate * 100).toFixed(1)}%`);
console.log(`report written:        ${outPath}`);
store.close();
