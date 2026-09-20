#!/usr/bin/env node
/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * M2 平台复验探针（外部、只读 + 受控业务探测）。
 *
 *   node scripts/probe-m2-platform.mjs --origin https://<app>.app.workbuddy.host \
 *        [--expect-public-bound-minor 11565] [--floor-minor 10000] [--sku sku-pilot-1] [--out <json>]
 *
 * 检查：
 *   1. 身份保持：名片内 Ed25519 公钥指纹（与传入基线比对，可选）；
 *   2. 挑战端点已实装：空 body → 400 invalid_challenge；异指纹挑战 → 403；
 *   3. **不泄露底价**：低于公开折扣边界的还价 → 回价 = **公开边界**（不是底价）；
 *   4. 任务归属：匿名 tasks/get → authentication_required（协议错误）；
 *   5. 幂等：同 key 同 body → 响应字节级一致；同 key 异 body → 冲突。
 *
 * 只对被测实例发起它设计内的业务动作（询价/查询）；不写任何平台数据。
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const o = {
    origin: undefined,
    sku: "sku-pilot-1",
    expectPublicBoundMinor: undefined,
    floorMinor: undefined,
    baselineFingerprint: undefined,
    out: undefined,
    artifact: path.join(REPO_ROOT, "build", "cloud-artifact"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--origin") o.origin = argv[++i];
    else if (a === "--sku") o.sku = argv[++i];
    else if (a === "--expect-public-bound-minor") o.expectPublicBoundMinor = Number(argv[++i]);
    else if (a === "--floor-minor") o.floorMinor = Number(argv[++i]);
    else if (a === "--baseline-fingerprint") o.baselineFingerprint = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--artifact") o.artifact = path.resolve(argv[++i]);
    else throw new Error(`未知参数 ${a}`);
  }
  if (o.origin === undefined) throw new Error("必须提供 --origin");
  o.origin = o.origin.replace(/\/+$/, "");
  return o;
}

async function timedFetch(url, init) {
  const started = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, text, headers: res.headers };
}

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const origin = options.origin;
  const checks = [];
  const record = (check, ok, detail, extra = {}) => checks.push({ check, ok, detail, ...extra });

  const { finalizeEnvelope } = await import(
    path.join(options.artifact, "app", "negotiation", "domain", "envelope.js")
  );

  const cardRes = await timedFetch(`${origin}/.well-known/agent-card.json`);
  const card = json(cardRes.text);
  const scheme = card?.securitySchemes?.["kiwi-signature"];
  const fingerprint =
    typeof scheme?.publicKeyPem === "string"
      ? createHash("sha256").update(scheme.publicKeyPem).digest("hex")
      : undefined;
  const extensionUri = card?.capabilities?.extensions?.[0]?.uri;
  const headers = {
    "content-type": "application/json",
    "A2A-Version": "1.0",
    ...(extensionUri !== undefined ? { "A2A-Extensions": extensionUri } : {}),
  };

  record(
    "identity",
    typeof fingerprint === "string" &&
      (options.baselineFingerprint === undefined || fingerprint === options.baselineFingerprint),
    `fingerprint=${fingerprint?.slice(0, 32)}… baseline=${options.baselineFingerprint?.slice(0, 32) ?? "(未提供)"} match=${
      options.baselineFingerprint === undefined ? "n/a" : fingerprint === options.baselineFingerprint
    }`,
    { fingerprint: fingerprint ?? null },
  );

  // 2) 挑战端点：空 body → 400；异指纹挑战 → 403
  const emptyChallenge = await timedFetch(`${origin}/control/challenge`, { method: "POST" });
  const emptyBody = json(emptyChallenge.text);
  record(
    "challenge_endpoint_validates",
    emptyChallenge.status === 400 && emptyBody?.error === "invalid_challenge",
    `status=${emptyChallenge.status} error=${emptyBody?.error ?? ""}`,
  );

  const foreignChallenge = await timedFetch(`${origin}/control/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: {
        challenge_id: "chl_probe_foreign",
        purpose: "key-custody",
        nonce: "probe-nonce",
        agent_id: "probe-agent",
        merchant_id: "probe-merchant",
        origin,
        path: "/a2a",
        key_thumbprint: `sha256:${"0".repeat(64)}`,
        generation: 1,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  });
  record(
    "challenge_rejects_foreign_thumbprint",
    foreignChallenge.status === 403,
    `status=${foreignChallenge.status}（不属于本实例的挑战不签名）`,
  );

  // 3) 不泄露底价：还价远低于公开边界 → 回价应是公开边界而不是底价
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const negotiationId = `neg_m2probe_${runId}`;
  /**
   * 发送一条 KNP 询价/还价。`overrides` 用于幂等测试：必须**逐字节相同**
   * （created_at 固定、negotiation 不变），否则 digest 不同会被判成冲突。
   */
  const send = async (action, payload, messageId, overrides = {}) => {
    const env = finalizeEnvelope({
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
      negotiation_id: overrides.negotiationId ?? negotiationId,
      exchange_id: overrides.exchangeId ?? `ex_m2probe_${runId}`,
      message_id: messageId,
      actor: "buyer",
      action,
      created_at: overrides.createdAt ?? new Date().toISOString(),
      payload,
    });
    const res = await timedFetch(`${origin}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: messageId,
        method: "SendMessage",
        params: {
          message: {
            role: "ROLE_USER",
            parts: [{ data: { knp_envelope: env }, mediaType: "application/json" }],
            messageId,
          },
        },
      }),
    });
    return res;
  };

  const rfqRes = await send(
    "rfq",
    { type: "rfq", items: [{ sku: options.sku, quantity: { value: 10, unit: "piece" } }] },
    `msg_m2_rfq_${runId}`,
  );
  const offerPrices = [...rfqRes.text.matchAll(/"amount_minor":(\d+)/g)].map((m) => Number(m[1]));
  record("rfq_offer", rfqRes.status === 200 && offerPrices.length > 0, `prices=${offerPrices.join(",")}`);

  const counterRes = await send(
    "counter_offer",
    {
      type: "counter_offer",
      offer_id: "off_probe",
      responding_to_offer_id: "off_probe", // KNP schema 要求为字符串（缺省非法）
      proposed_terms: {
        items: [
          {
            sku: options.sku,
            quantity: { value: 10, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 5000 },
          },
        ],
      },
    },
    `msg_m2_counter_${runId}`,
  );
  const counterPrices = [...counterRes.text.matchAll(/"amount_minor":(\d+)/g)].map((m) => Number(m[1]));
  const floorLeaked = options.floorMinor !== undefined && counterPrices.includes(options.floorMinor);
  const atPublicBound =
    options.expectPublicBoundMinor === undefined || counterPrices.includes(options.expectPublicBoundMinor);
  record(
    "floor_not_leaked",
    counterRes.status === 200 && !floorLeaked && atPublicBound && counterPrices.length > 0,
    `counter_prices=${counterPrices.join(",")} expect_public_bound=${options.expectPublicBoundMinor ?? "(未提供)"} ` +
      `floor=${options.floorMinor ?? "(未提供)"} floor_leaked=${floorLeaked}`,
    { counter_body: counterRes.text.slice(0, 800) },
  );

  // 3b) 库存闸门（T046）：数量超过可得库存 → 明确不可报价，且不返回任何金额
  const overStock = await send(
    "rfq",
    { type: "rfq", items: [{ sku: options.sku, quantity: { value: 200, unit: "piece" } }] },
    `msg_m2_overstock_${runId}`,
    { negotiationId: `neg_m2stock_${runId}`, exchangeId: `ex_m2stock_${runId}` },
  );
  const overStockBody = json(overStock.text);
  const overStockSerialized = JSON.stringify(overStockBody ?? {});
  record(
    "stock_gate_blocks_over_request",
    overStock.status === 200 &&
      overStockSerialized.includes("temporarily_unavailable") &&
      !overStockSerialized.includes("amount_minor"),
    `decline=${overStockSerialized.includes("temporarily_unavailable")} has_amount=${overStockSerialized.includes("amount_minor")}`,
    { body: overStockSerialized.slice(0, 400) },
  );

  // 4) 任务归属：匿名 tasks/get → authentication_required
  const anonTask = await timedFetch(`${origin}/a2a`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "anon-task", method: "GetTask", params: { id: "task_probe" } }),
  });
  const anonBody = json(anonTask.text);
  const anonError = anonBody?.error;
  record(
    "anonymous_task_denied",
    anonError?.code === -32050 && String(anonError?.message ?? "").includes("authenticated"),
    `code=${anonError?.code} message=${String(anonError?.message ?? "").slice(0, 80)}`,
  );

  // 5) 幂等：同 key 同 body → 一致；同 key 异 body → 冲突
  const idemId = `msg_m2_idem_${runId}`;
  const idemFixed = {
    createdAt: "2026-09-21T00:00:00Z",
    negotiationId: `neg_m2idem_${runId}`,
    exchangeId: `ex_m2idem_${runId}`,
  };
  const idemPayload = { type: "rfq", items: [{ sku: options.sku, quantity: { value: 1, unit: "piece" } }] };
  const first = await send("rfq", idemPayload, idemId, idemFixed);
  const second = await send("rfq", idemPayload, idemId, idemFixed);
  record(
    "idempotent_replay",
    first.status === 200 && second.status === 200 && first.text === second.text,
    `identical=${first.text === second.text}`,
    { first_body: first.text.slice(0, 400), second_body: second.text.slice(0, 400) },
  );
  const conflict = await send(
    "rfq",
    { type: "rfq", items: [{ sku: options.sku, quantity: { value: 2, unit: "piece" } }] },
    idemId,
    idemFixed,
  );
  const conflictBody = json(conflict.text);
  record(
    "idempotency_conflict",
    conflictBody?.error?.code === -32050 && /different digest/.test(String(conflictBody?.error?.message ?? "")),
    `code=${conflictBody?.error?.code} message=${String(conflictBody?.error?.message ?? "").slice(0, 80)}`,
  );

  const result = {
    probe: "m2-platform",
    origin,
    ran_at: new Date().toISOString(),
    identity_fingerprint: fingerprint ?? null,
    checks,
    passed: checks.every((c) => c.ok),
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out !== undefined) writeFileSync(options.out, text);
  for (const c of checks) process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.check}  ${c.detail}\n`);
  process.stdout.write(`\n${result.passed ? "M2 平台复验通过" : "M2 平台复验存在失败项"}\n`);
  if (!result.passed) process.exitCode = 1;
}

await main();
