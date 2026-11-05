#!/usr/bin/env node
// 跑一遍**真实**端到端链路并把验收回执写进 build-inputs/release-acceptance.json。
//
//   KIWI_ACCEPTANCE_MERCHANT_ID=mkt_xxx \
//   KIWI_ACCEPTANCE_SKU=VQ-101 \
//   KIWI_ACCEPTANCE_QUERY=保温杯 \
//   KIWI_ACCEPTANCE_UNIT=个 \
//   KIWI_A2A_SIGNING_KEY_DIR=~/.kiwi/mcp/buyer-signing \
//   node scripts/run-acceptance.mjs [--quantity 1] [--catalog https://catalog.kiwi.harrylabsj.com]
//
// 链路：kiwi_search → kiwi_request_quotes → kiwi_accept_agreement（含审批）→
// kiwi_handoff（含审批）。走的是**公开工具面**（MCP stdio），与宿主（Hermes /
// WorkBuddy）实际调用的完全同一套；任何一步失败就不写回执，发布门禁随后 fail-closed。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findNegotiationExtensions, parseAgentCard } from "../dist/discovery/agent-card/index.js";
import { jsonRpcEndpoints } from "../dist/discovery/catalog-source/cloud-card.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const merchantId = process.env.KIWI_ACCEPTANCE_MERCHANT_ID ?? "";
const sku = process.env.KIWI_ACCEPTANCE_SKU ?? "";
const query = process.env.KIWI_ACCEPTANCE_QUERY ?? "商品";
const unit = process.env.KIWI_ACCEPTANCE_UNIT ?? "piece";
const quantity = Number(arg("--quantity") ?? process.env.KIWI_ACCEPTANCE_QUANTITY ?? "2");
const catalogUrl = arg("--catalog") ?? process.env.KIWI_ACCEPTANCE_CATALOG_URL ?? "https://catalog.kiwi.harrylabsj.com";
const signingKeyDir = process.env.KIWI_A2A_SIGNING_KEY_DIR ?? "";
const timeoutMs = Number(process.env.KIWI_ACCEPTANCE_TIMEOUT_MS ?? "240000");

const testMarker = `【测试，请勿履约】linkluck 验收询价：SKU ${sku}，${quantity} 盒；仅用于非约束报价、协议与交接，不下单、不付款、不锁库存。`;
const fail = (message) => {
  console.error(`ACCEPTANCE_FAILED ${message}`);
  process.exit(1);
};
if (merchantId === "" || sku === "") {
  fail("需要 KIWI_ACCEPTANCE_MERCHANT_ID 与 KIWI_ACCEPTANCE_SKU（真实商家与 SKU，不允许编造）");
}

function validateQuotedTerms(offer, expected) {
  const terms = offer?.payload?.terms;
  if (terms === null || typeof terms !== "object" || Array.isArray(terms)) {
    fail("商家报价缺少结构化 terms，不能确认 SKU/数量/单价");
  }
  const items = Array.isArray(terms.items) ? terms.items : [];
  if (items.length !== 1) fail(`商家报价明细必须恰好 1 行，实际 ${items.length}`);
  const item = items[0];
  if (item?.sku !== expected.sku) fail(`商家报价 SKU 不一致：${String(item?.sku)} != ${expected.sku}`);
  const q = item?.quantity;
  if (q?.value !== expected.quantity || q?.unit !== expected.unit) {
    fail(`商家报价数量/单位不一致：${String(q?.value)} ${String(q?.unit)} != ${expected.quantity} ${expected.unit}`);
  }
  const price = item?.unit_price;
  if (!Number.isSafeInteger(price?.amount_minor) || price.amount_minor < 0
    || typeof price?.currency !== "string" || price.currency === "") {
    fail("商家报价单价不是安全的 minor 金额或缺少币种");
  }
  const total = price.amount_minor * q.value;
  if (terms.total_price_minor !== undefined && terms.total_price_minor !== total) {
    fail(`商家报价总价不一致：${String(terms.total_price_minor)} != ${total}`);
  }
  return { sku: item.sku, quantity: q.value, unit: q.unit, unit_price_minor: price.amount_minor, currency: price.currency, total_price_minor: total };
}

async function verifyCatalogCardBinding(found, catalogUrl, expectedMerchantId, expectedSku, timeoutMs) {
  if (found.merchant_id !== expectedMerchantId) fail("catalog 返回的 merchant_id 与请求商家不一致");
  const catalogAgentId = typeof found.catalog_agent_id === "string" ? found.catalog_agent_id.trim() : "";
  if (catalogAgentId === "") fail("catalog 记录缺少 catalog_agent_id，不能用官方 agent-card 路径绑定");
  if (!Array.isArray(found.matching_skus) || !found.matching_skus.map(String).includes(expectedSku)) {
    fail("catalog 搜索结果未把目标 SKU 绑定到该商家");
  }
  let catalog;
  try { catalog = new URL(catalogUrl); } catch { fail("catalog URL 无效"); }
  if (catalog.protocol !== "https:" || catalog.username !== "" || catalog.password !== "") {
    fail("Catalog agent-card 验证要求无凭据的 HTTPS catalog URL");
  }
  const cardUrl = new URL(`/v1/agents/${encodeURIComponent(catalogAgentId)}/agent-card.json`, catalog);
  let returnedCardUrl;
  try {
    if (typeof found.agent_card_url !== "string" || found.agent_card_url.trim() === "") throw new Error("missing");
    returnedCardUrl = new URL(found.agent_card_url);
  } catch { fail("catalog 搜索结果缺少合法 agent_card_url；拒绝用构造路由替代"); }
  if (returnedCardUrl.username !== "" || returnedCardUrl.password !== "" || returnedCardUrl.protocol !== "https:") {
    fail("catalog agent_card_url 必须是无凭据 HTTPS 地址");
  }
  if (returnedCardUrl.href !== cardUrl.href) {
    fail(`catalog 返回 agent_card_url 与 catalog_agent_id 路由不一致：${returnedCardUrl.href} != ${cardUrl.href}`);
  }
  let response;
  try {
    response = await fetch(cardUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
    });
  } catch { fail("Catalog agent-card 读取失败"); }
  if (response.status !== 200 || response.type === "opaqueredirect") fail("Catalog agent-card 非 200 或被重定向");
  let raw;
  try { raw = await response.json(); } catch { fail("Catalog agent-card JSON 无效"); }
  let card;
  try { card = parseAgentCard(raw); } catch { fail("Catalog agent-card 未通过既有 parser"); }
  const extensions = findNegotiationExtensions(card);
  const hasNegotiation = extensions.some((uri) => {
    try { return new URL(uri).pathname === "/a2a/extensions/negotiation/1.0"; } catch { return false; }
  });
  if (!hasNegotiation) fail("Catalog agent-card 未声明 negotiation/1.0 扩展");
  let endpoints;
  try { endpoints = jsonRpcEndpoints(card); } catch { fail("Catalog agent-card 未声明 JSONRPC 1.0 端点"); }
  if (endpoints.length === 0) fail("Catalog agent-card 未声明 JSONRPC 1.0 端点");
  if (card.supportedInterfaces.some((entry) => entry.protocolBinding === "JSONRPC" && entry.protocolVersion !== "1.0")) {
    fail("Catalog agent-card 的 JSONRPC 端点不是 1.0");
  }
  return { catalog_agent_id: catalogAgentId, card_url: cardUrl.toString(), extension: "/a2a/extensions/negotiation/1.0", jsonrpc_endpoints: endpoints };
}

const child = spawn(
  process.execPath,
  [path.join(root, "dist/cli.js"), "mcp", "serve", "--catalog-url", catalogUrl,
    "--rfq-public-message", testMarker,
    ...(signingKeyDir !== "" ? ["--a2a-signing-key-dir", signingKeyDir] : [])],
  { stdio: ["pipe", "pipe", "inherit"] },
);
let buffer = "";
let seq = 0;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    try {
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch { /* 非 JSON-RPC 输出忽略 */ }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const call = async (name, params) => {
  const result = await rpc("tools/call", { name, arguments: params });
  const text = result?.result?.content?.[0]?.text ?? JSON.stringify(result?.result ?? result?.error ?? {});
  return { text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
};
const deadline = setTimeout(() => {
  child.kill("SIGTERM");
  fail(`链路超时 ${timeoutMs}ms`);
}, timeoutMs);

const chain = {};
const record = (name, ok, detail, extra = {}) => {
  chain[name] = { ok, detail, ...extra };
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
};

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kiwi-acceptance", version: "1" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// 1) 发现
const search = await call("kiwi_search", { query, limit: 5 });
const merchants = search.json?.merchants ?? [];
const found = merchants.find((entry) => entry.merchant_id === merchantId);
if (found === undefined) {
  record("search", false, `catalog 未搜到商家 ${merchantId}（返回 ${merchants.length} 个）`);
  fail("discovery failed");
}
const listing = (found.products ?? []).find((product) => String(product.title ?? "").includes(query)) ?? found.products?.[0];
record("search", true, `命中 ${found.name ?? merchantId}，listing ${listing?.listing_id ?? "?"}`, {
  merchant_id: merchantId,
  merchant_name: found.name ?? "",
  listing_id: String(listing?.listing_id ?? ""),
});

// 2a) Bind the exact merchant/SKU to the Catalog-hosted official card before any RFQ.
const catalogCard = await verifyCatalogCardBinding(found, catalogUrl, merchantId, sku, timeoutMs);
record("catalog_card", true, `Catalog agent-card ${catalogCard.catalog_agent_id}：JSONRPC 1.0 + negotiation/1.0`, catalogCard);

// 2) 询价
const rfq = await call("kiwi_request_quotes", {
  merchant_ids: [merchantId],
  intent: {
    intent_id: `acceptance-${randomUUID()}`,
    intent_type: "inquiry",
    items: [{ query, sku, quantity: { value: quantity, unit } }],
  },
});
const task = rfq.json?.task;
const candidate = task?.candidates?.[0];
if (task?.status !== "succeeded" || candidate?.status !== "succeeded") {
  record("quote", false, candidate?.failure?.detail ?? rfq.text.slice(0, 200));
  fail("quote failed");
}
const offer = (() => { try { return JSON.parse(candidate.provenance?.reply_text ?? "{}"); } catch { return {}; } })();
const quoted = validateQuotedTerms(offer, { sku, quantity, unit });
const terms = offer.payload.terms;
record("quote", true, `报价 ${quoted.unit_price_minor} ${quoted.currency} × ${quoted.quantity} ${quoted.unit}（总价 ${quoted.total_price_minor}）`, {
  offer_id: String(candidate.provenance?.offer_id ?? ""),
  sku: quoted.sku,
  quantity_value: String(quoted.quantity),
  quantity_unit: quoted.unit,
  unit_price_minor: String(quoted.unit_price_minor),
  total_price_minor: String(quoted.total_price_minor),
  currency: quoted.currency,
  trade_entry: terms.handoff_destination ?? null,
});

// 2b) 一轮非约束磋商：明确测试/不履约，不改变商业承诺。
const negotiation = await call("kiwi_negotiate", {
  task_id: task.task_id,
  action: "clarification",
  summary: `${testMarker} 请确认本询价为测试用途，且回复不创建订单、不锁库存、不授权付款。`,
});
const step = negotiation.json?.step;
if (step?.action !== "clarification" || typeof step.reply !== "string" || step.reply.trim() === "") {
  record("negotiation", false, negotiation.text.slice(0, 200));
  fail("clarification negotiation failed or produced no merchant reply");
}
record("negotiation", true, "一轮 clarification 已获商家回复", { action: step.action });

// Re-read the task after negotiation; accept must bind the current offer, not a stale snapshot.
const afterNegotiation = await call("kiwi_get_task", { task_id: task.task_id });
const currentCandidate = (afterNegotiation.json?.task?.candidates ?? []).find(
  (entry) => entry.status === "succeeded" && entry.candidate_id === candidate.candidate_id,
) ?? (afterNegotiation.json?.task?.candidates ?? []).find((entry) => entry.status === "succeeded");

// 2c) Pre-accept evidence. KNP exposes no merchant-side "nonbinding" flag on an
// offer; the strongest available evidence is the advertised negotiation
// capability, an offer-like merchant reply, and the protocol's dedicated
// accept_nonbinding action. A merchant cannot be proven nonbinding before it
// returns the agreement; the agreement flags are rechecked immediately below
// before handoff. Missing capability/reply stops here.
// Catalog card was verified before the first outbound RFQ; repeat the evidence
// record at the accept boundary. A catalog extension is a declaration, not
// merchant consent to this test and not proof of zero side effects.
const replyForEvidence = (() => { try { return JSON.parse(currentCandidate?.provenance?.reply_text ?? "{}"); } catch { return {}; } })();
if (!["offer", "conditional_offer"].includes(replyForEvidence.action)) {
  record("preaccept", false, "商家最新回复不是 offer-like，不能进入非约束接受");
  fail("pre-accept nonbinding evidence missing: offer-like reply");
}
if (replyForEvidence.action !== "conditional_offer") {
  record("preaccept", false, "商家最新回复是 offer，不是协议可远程接受的 conditional_offer");
  fail("A2A accept_nonbinding requires conditional_offer; refusing local agreement");
}
const preacceptEvidence = {
  negotiation_capability: catalogCard.extension,
  catalog_agent_id: catalogCard.catalog_agent_id,
  catalog_card_url: catalogCard.card_url,
  offer_action: replyForEvidence.action,
  accept_action: "accept_nonbinding",
  merchant_preaccept_nonbinding_flag: null,
};
record("preaccept", true, "协议能力 + offer-like 回复 + accept_nonbinding 动作；商家未提供接受前 nonbinding 字段", preacceptEvidence);

// 3) 接受（非约束性协议，带审批）
if (currentCandidate === undefined) {
  record("agreement", false, "negotiation 后没有 succeeded candidate");
  fail("agreement candidate missing after negotiation");
}
const acceptedCandidate = currentCandidate;
let accept = await call("kiwi_accept_agreement", { task_id: task.task_id, candidate_id: acceptedCandidate.candidate_id });
const approvalId = accept.json?.approval_required?.approval_id;
if (approvalId !== undefined) {
  await call("kiwi_approve", { approval_id: approvalId });
  accept = await call("kiwi_accept_agreement", {
    task_id: task.task_id,
    candidate_id: acceptedCandidate.candidate_id,
    approval_id: approvalId,
  });
}
const agreement = accept.json?.agreement;
const agreementId = typeof agreement?.agreement_id === "string" ? agreement.agreement_id : "";
if (agreementId === "") {
  record("agreement", false, accept.text.slice(0, 200));
  fail("agreement failed");
}
if (agreement?.creates_order !== false || agreement?.reserves_inventory !== false || agreement?.authorizes_payment !== false) {
  record("agreement", false, "协议不是非约束性的（creates_order/reserves_inventory/authorizes_payment 必须为 false）");
  fail("agreement is not non-binding");
}
const agreedTerms = agreement?.agreed_terms;
if (agreedTerms === null || typeof agreedTerms !== "object" || Array.isArray(agreedTerms)) {
  record("agreement", false, "协议缺少 agreed_terms，不能确认接受的就是目标报价");
  fail("agreement terms missing");
}
const agreedQuote = validateQuotedTerms({ payload: { terms: agreedTerms } }, { sku, quantity, unit });
record("agreement_terms", true, "协议条款与目标 SKU/数量/单位/价格一致", agreedQuote);
record("agreement", true, `非约束性协议 ${agreementId}（不下单/不锁库/不付款）`, {
  agreement_id: agreementId,
  binding_effect: String(agreement?.binding_effect ?? ""),
});

// 4) 交接（成交入口）
const destination = terms.handoff_destination;
let handoff = await call("kiwi_handoff", {
  agreement_id: String(agreementId ?? ""),
  destination_type: "external_checkout_url",
  ...(typeof destination === "string" && destination !== "" ? { url: destination } : {}),
});
let handoffApproval = handoff.json?.approval_required?.approval_id;
if (handoffApproval !== undefined) {
  await call("kiwi_approve", { approval_id: handoffApproval });
  handoff = await call("kiwi_handoff", {
    agreement_id: String(agreementId ?? ""),
    destination_type: "external_checkout_url",
    approval_id: handoffApproval,
    ...(typeof destination === "string" && destination !== "" ? { url: destination } : {}),
  });
}
const handoffRef = handoff.json?.handoff_ref;
if (handoffRef?.destination_type !== "external_checkout_url" || typeof handoffRef?.url !== "string") {
  record("handoff", false, handoff.text.slice(0, 200));
  fail("handoff failed");
}
record("handoff", true, `成交入口 ${handoffRef.url}`, {
  destination_type: handoffRef.destination_type,
  url: handoffRef.url,
});

clearTimeout(deadline);
child.kill("SIGTERM");

const receipt = {
  schema: "kiwi.release-acceptance/1",
  recorded_at: new Date().toISOString(),
  catalog_url: catalogUrl,
  merchant_id: merchantId,
  sku,
  quantity,
  unit,
  quoted_quantity: quoted.quantity,
  quoted_unit: quoted.unit,
  quoted_unit_price_minor: quoted.unit_price_minor,
  quoted_total_price_minor: quoted.total_price_minor,
  quoted_currency: quoted.currency,
  test_marker: testMarker,
  preaccept_evidence: preacceptEvidence,
  kiwi_version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
  shopping_cli_commit: JSON.parse(readFileSync(path.join(root, "portfolio.lock.json"), "utf8")).repositories?.["shopping-cli"]?.commit,
  signed_buyer: signingKeyDir !== "",
  chain,
};
const out = path.join(root, "build-inputs/release-acceptance.json");
writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`acceptance receipt written: ${path.relative(root, out)}`);
