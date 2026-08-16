#!/usr/bin/env node
/**
 * Merchant Analytics（战略 v2.5 §7.1 / §十二 漏斗）。
 *
 * 从 marketplace 商家会话数据计算谈判漏斗：
 *   询价量（RFQ volume）、报价率（merchant 已回复）、谈判率（有还价往返，
 *   message_count≥3）、人工审核率（human_required）、审计事件量。
 * 数据来自真实商家会话（status/last_sender/message_count/unresolved_flag_count）。
 *
 * 用法：
 *   node scripts/pilot/merchant-analytics.mjs \
 *     --marketplace-url http://127.0.0.1:8765 \
 *     --merchant-tokens .kiwi/pilot/merchant-tokens.env
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (name, fb) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fb; };
const MARKETPLACE = flag("marketplace-url", "http://127.0.0.1:8765");
const TOKENS = flag("merchant-tokens", `${root}/.kiwi/pilot/merchant-tokens.env`);

// merchantId=token 每行
const tokens = new Map();
for (const line of readFileSync(TOKENS, "utf8").split("\n")) {
  const idx = line.indexOf("=");
  if (idx > 0) tokens.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
}

const funnel = [];
for (const [merchantId, token] of tokens) {
  const res = await fetch(`${MARKETPLACE}/merchants/${encodeURIComponent(merchantId)}/conversations`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) { console.error(`skip ${merchantId} (${res.status})`); continue; }
  const cs = (await res.json()).conversations ?? [];
  const total = cs.length;
  const quoted = cs.filter((c) => c.last_sender === "merchant_agent" || c.status === "waiting_buyer").length;
  const negotiated = cs.filter((c) => Number(c.message_count ?? 0) >= 3).length;
  const humanReview = cs.filter((c) => c.status === "human_required").length;
  const auditEvents = cs.reduce((n, c) => n + Number(c.audit_event_count ?? 0), 0);
  funnel.push({
    merchant_id: merchantId,
    rfq_volume: total,
    quoted,
    quote_rate: total ? Math.round((quoted / total) * 100) : 0,
    negotiated,
    negotiation_rate: total ? Math.round((negotiated / total) * 100) : 0,
    human_review: humanReview,
    human_review_rate: total ? Math.round((humanReview / total) * 100) : 0,
    audit_events: auditEvents,
  });
}

const report = { generated_at: new Date().toISOString(), merchants: funnel };
writeFileSync(`${root}/.kiwi/pilot/evidence/merchant-analytics.json`, JSON.stringify(report, null, 2));
console.log("===== Merchant Analytics（§7.1 漏斗）=====");
for (const m of funnel) {
  console.log(`  ${m.merchant_id.padEnd(26)} rfq=${m.rfq_volume} 报价率=${m.quote_rate}% 谈判率=${m.negotiation_rate}% 人工=${m.human_review_rate}% audit=${m.audit_events}`);
}
console.log(`report: ${root}/.kiwi/pilot/evidence/merchant-analytics.json`);
