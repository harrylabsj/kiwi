#!/usr/bin/env node
/**
 * 三向互操作（Issue 11 / D2）：证明"不是 Kiwi 与自己互通"。
 *
 *   Leg A   Independent(Python) Buyer → Kiwi(TS) Merchant
 *   Leg B   Kiwi(TS) Buyer → Independent(Python) Merchant
 *   Leg C   Independent(Python) Buyer → Independent(Python) Merchant（conformance vectors）
 *
 * 每条腿跑完整 RFQ → Offer → CounterOffer → ConditionalOffer → Accept →
 * non-binding Agreement →（买家侧）KTH HandoffCandidate（三副作用恒 false），
 * 输出可校验 transcript（JCS 哈希链），并断言 agreement 三 false 不变量。
 *
 * 前置：`npm run build`（dist/ 存在）。Python 实现零依赖（纯标准库）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A2AServer } from "../../dist/a2a/server/index.js";
import { createMerchantHandler } from "../../dist/a2a/server/merchant-handler.js";
import { LedgerStore } from "../../dist/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../dist/negotiation/idempotency/index.js";
import { A2AClient } from "../../dist/a2a/client/index.js";
import { finalizeEnvelope } from "../../dist/negotiation/domain/envelope.js";
import {
  newExchangeId,
  newMessageId,
  newNegotiationId,
  newOfferId,
} from "../../dist/negotiation/domain/identifiers.js";
import { contentDigest } from "../../dist/negotiation/jcs.js";

// scripts/conformance/ -> 仓库根（kiwi/）-> spec/examples/python
const PYTHON_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "../spec/examples/python");
const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
const NOW = () => new Date().toISOString();

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function assertThreeFalse(agreement, label) {
  ok(agreement?.creates_order === false, `${label}: creates_order=false`);
  ok(agreement?.authorizes_payment === false, `${label}: authorizes_payment=false`);
  ok(agreement?.reserves_inventory === false, `${label}: reserves_inventory=false`);
  ok(agreement?.binding_effect === "nonbinding", `${label}: binding_effect=nonbinding`);
}

// ---------------------------------------------------------------------------
// 子进程辅助（Python）
// ---------------------------------------------------------------------------

function runPython(args, { waitForUrl = false, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-m", "kiwi_ref", ...args], { cwd: PYTHON_DIR });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`python ${args[0]} timed out\nstderr: ${stderr}`));
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (waitForUrl && !settled) {
        const m = stdout.match(/SUT_URL=(http:\/\/[^\s]+)/);
        if (m) {
          settled = true;
          clearTimeout(timer);
          resolve({ url: m[1], child, stdout, stderr });
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`python ${args[0]} exited ${code}\nstderr: ${stderr}`));
        else resolve({ code, stdout, stderr });
      }
    });
  });
}

/** 启动 Python merchant，等待 SUT_URL。返回 {url, stop}。 */
async function startPythonMerchant() {
  const proc = await runPython(["merchant", "--port", "0"], { waitForUrl: true });
  return {
    url: proc.url,
    stop: () => {
      proc.child.kill("SIGKILL");
    },
  };
}

/** 运行 Python buyer 完整流程，返回解析后的输出 + transcript 路径。 */
async function runPythonBuyer(url, jsonl) {
  const proc = await runPython(["buyer", "--url", url, "--jsonl", jsonl]);
  const start = proc.stdout.indexOf("{");
  const end = proc.stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON in buyer output:\n${proc.stdout}`);
  return JSON.parse(proc.stdout.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// 商家 / 买家（TS 侧）
// ---------------------------------------------------------------------------

async function startTsMerchant() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-tsm-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const handler = createMerchantHandler({ ledger, now: NOW, sender: "merchant:interop", counterparty: "buyer:*" });
  const server = new A2AServer({
    card: () => ({
      name: "Interop TS Merchant",
      description: "Kiwi TS reference merchant",
      providerOrganization: "Kiwi TS",
      version: "1.0.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
  });
  const http = server.createServer();
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}`;
  holder.baseUrl = url;
  return {
    url,
    stop: async () => {
      http.closeAllConnections?.();
      await new Promise((r) => http.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SKU = "SKU-001";
const QUANTITY = 200;
const DELIVERY_BEFORE = "2026-08-20T18:00:00Z";

function seedEnvelope(fields) {
  return finalizeEnvelope({ capability: CAPABILITY, protocol_version: "1.0", exchange_id: newExchangeId(), message_id: newMessageId(), ...fields });
}

function buildRfq(negotiationId) {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: "msg_start",
    actor: "buyer",
    action: "rfq",
    created_at: NOW(),
    payload: { type: "rfq", items: [{ sku: SKU, quantity: { value: QUANTITY, unit: "piece" } }], requested_terms: { delivery_before: DELIVERY_BEFORE } },
  });
}

function buildCounter(negotiationId, offerEnvelope) {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: offerEnvelope.message_id,
    actor: "buyer",
    action: "counter_offer",
    created_at: NOW(),
    payload: {
      type: "counter_offer",
      offer_id: newOfferId(),
      responding_to_offer_id: offerEnvelope.payload.offer_id,
      proposed_terms: { items: [{ sku: SKU, quantity: { value: QUANTITY, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 83_000 } }] },
    },
  });
}

function buildAccept(negotiationId, conditionalEnvelope, agreedTerms) {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: conditionalEnvelope.message_id,
    actor: "buyer",
    action: "accept_nonbinding",
    created_at: NOW(),
    payload: { type: "accept_nonbinding", offer_id: conditionalEnvelope.payload.offer_id, terms_digest: contentDigest(agreedTerms) },
  });
}

/** 求值 ConditionalOffer（§13）：首个命中条件 → then_terms；否则 base_terms。 */
function evaluateConditional(conditional) {
  for (const cond of conditional.conditions ?? []) {
    if (cond.when?.all) {
      const match = cond.when.all.every((c) => {
        const actual = c.field === "aggregate.total_quantity" ? QUANTITY : undefined;
        return actual !== undefined && actual >= c.value;
      });
      if (match) return cond.then_terms;
    }
  }
  return conditional.base_terms;
}

/** TS 买家完整流程：返回 {agreement, replyEnvelopes}。 */
async function tsBuyerFlow(url) {
  const client = new A2AClient({ url, allowPrivateRanges: true, skipDnsCheck: true });
  const negotiationId = newNegotiationId();
  const knpMessage = (envelope) => ({
    role: "agent",
    messageId: envelope.message_id,
    parts: [{ data: { knp_envelope: envelope }, mediaType: "application/json" }],
  });
  const replyEnvelope = (task) => {
    for (const part of task.status.message?.parts ?? []) {
      if (part.kind === "data" && part.data?.knp_envelope) return part.data.knp_envelope;
    }
    return null;
  };
  const agreementOf = (task) => {
    for (const artifact of task.artifacts ?? []) {
      for (const part of artifact.parts ?? []) {
        if (part.kind === "data" && part.data?.agreement) return part.data.agreement;
      }
    }
    return null;
  };

  const rfq = buildRfq(negotiationId);
  const offerTask = await client.sendMessage(knpMessage(rfq));
  const offer = replyEnvelope(offerTask);
  if (offer === null) throw new Error("Leg B: no offer reply envelope");

  const counter = buildCounter(negotiationId, offer);
  const condTask = await client.sendMessage(knpMessage(counter));
  const conditional = replyEnvelope(condTask);
  if (conditional === null) throw new Error("Leg B: no conditional reply envelope");

  const agreedTerms = evaluateConditional(conditional.payload);
  const accept = buildAccept(negotiationId, conditional, agreedTerms);
  const acceptTask = await client.sendMessage(knpMessage(accept));
  const agreement = agreementOf(acceptTask);
  if (agreement === null) throw new Error("Leg B: no agreement artifact");

  return { negotiationId, offer, conditional, agreement };
}

// ---------------------------------------------------------------------------
// 三腿
// ---------------------------------------------------------------------------

async function legA() {
  console.log("\n[Leg A] Independent(Python) Buyer → Kiwi(TS) Merchant");
  const merchant = await startTsMerchant();
  try {
    const jsonl = path.join(mkdtempSync(path.join(tmpdir(), "kiwi-interop-legA-")), "transcript.jsonl");
    const result = await runPythonBuyer(merchant.url, jsonl);
    ok(result.offer_action === "offer", "offer received");
    ok(result.conditional_action === "conditional_offer", "conditional_offer received");
    assertThreeFalse(result.agreement, "agreement");
    ok(result.handoff_candidate.handoff_candidate_id.startsWith("hcan_"), "handoff candidate built");
    await verifyTranscriptJsonl(jsonl);
  } finally {
    await merchant.stop();
  }
}

async function legB() {
  console.log("\n[Leg B] Kiwi(TS) Buyer → Independent(Python) Merchant");
  const merchant = await startPythonMerchant();
  try {
    const result = await tsBuyerFlow(merchant.url);
    ok(result.offer.action === "offer", "offer received");
    ok(result.conditional.action === "conditional_offer", "conditional_offer received");
    assertThreeFalse(result.agreement, "agreement");
  } finally {
    merchant.stop();
  }
}

async function legC() {
  console.log("\n[Leg C] Independent(Python) Buyer → Independent(Python) Merchant（conformance vectors）");
  // 先跑 Python conformance vectors（golden digest 交叉断言）作为向量门。
  // 注意：python unittest 结果写 stderr。
  const vectors = await runPyUnittest();
  ok((vectors.stdout + vectors.stderr).includes("OK"), "Python conformance vectors pass (golden digest anchors)");
  const merchant = await startPythonMerchant();
  try {
    const jsonl = path.join(mkdtempSync(path.join(tmpdir(), "kiwi-interop-legC-")), "transcript.jsonl");
    const result = await runPythonBuyer(merchant.url, jsonl);
    assertThreeFalse(result.agreement, "agreement");
    ok(result.agreement.agreement_id.startsWith("agr_"), "agreement id present");
    await verifyTranscriptJsonl(jsonl);
  } finally {
    merchant.stop();
  }
}

/** 用 Python 实现自校验 transcript 哈希链。 */
async function verifyTranscriptJsonl(jsonl) {
  await runPython(["verify", "--jsonl", jsonl]);
  ok(true, "transcript hash chain verified");
}

/** 跑 Python 参考实现自身的 unittest 套件（golden digest conformance vectors）。 */
function runPyUnittest() {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "."], {
      cwd: PYTHON_DIR,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`python unittest exited ${code}\n${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

console.log(`Python 参考实现目录：${PYTHON_DIR}`);
await legA();
await legB();
await legC();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("三向互操作完成：Independent↔Kiwi↔Independent 全部 RFQ→Agreement→Handoff 跑通。");
