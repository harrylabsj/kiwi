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
const quantity = Number(arg("--quantity") ?? process.env.KIWI_ACCEPTANCE_QUANTITY ?? "1");
const catalogUrl = arg("--catalog") ?? process.env.KIWI_ACCEPTANCE_CATALOG_URL ?? "https://catalog.kiwi.harrylabsj.com";
const signingKeyDir = process.env.KIWI_A2A_SIGNING_KEY_DIR ?? "";
const timeoutMs = Number(process.env.KIWI_ACCEPTANCE_TIMEOUT_MS ?? "240000");

const fail = (message) => {
  console.error(`ACCEPTANCE_FAILED ${message}`);
  process.exit(1);
};
if (merchantId === "" || sku === "") {
  fail("需要 KIWI_ACCEPTANCE_MERCHANT_ID 与 KIWI_ACCEPTANCE_SKU（真实商家与 SKU，不允许编造）");
}

const child = spawn(
  process.execPath,
  [path.join(root, "dist/cli.js"), "mcp", "serve", "--catalog-url", catalogUrl,
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
const terms = offer?.payload?.terms ?? {};
const unitPrice = terms.items?.[0]?.unit_price ?? {};
record("quote", true, `报价 ${unitPrice.amount_minor} ${unitPrice.currency} × ${quantity}`, {
  offer_id: String(candidate.provenance?.offer_id ?? ""),
  unit_price_minor: String(unitPrice.amount_minor ?? ""),
  currency: String(unitPrice.currency ?? ""),
  trade_entry: terms.handoff_destination ?? null,
});

// 3) 接受（非约束性协议，带审批）
let accept = await call("kiwi_accept_agreement", { task_id: task.task_id, candidate_id: candidate.candidate_id });
const approvalId = accept.json?.approval_required?.approval_id;
if (approvalId !== undefined) {
  await call("kiwi_approve", { approval_id: approvalId });
  accept = await call("kiwi_accept_agreement", {
    task_id: task.task_id,
    candidate_id: candidate.candidate_id,
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
  kiwi_version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
  shopping_cli_commit: JSON.parse(readFileSync(path.join(root, "portfolio.lock.json"), "utf8")).repositories?.["shopping-cli"]?.commit,
  signed_buyer: signingKeyDir !== "",
  chain,
};
const out = path.join(root, "build-inputs/release-acceptance.json");
writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`acceptance receipt written: ${path.relative(root, out)}`);
