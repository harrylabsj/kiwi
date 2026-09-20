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
 * M1 平台实测探针（外部、只读 + 一次真实询价）。
 *
 *   node scripts/probe-m1-platform.mjs --origin https://<app>.app.workbuddy.host \
 *        [--expect-amount-minor 12850] [--out <json 路径>]
 *
 * 对**已部署实例**执行 M1 的对外可验证项，逐项记录 HTTP 状态、耗时与响应摘要：
 *   1. /livez、/healthz（平台拦截）、/readyz（就绪四项）
 *   2. Agent Card（T017：名片是否反映真实能力/端点/扩展）
 *   3. 真实 A2A 1.0 SendMessage 询价 → 确定性报价（商品表价）
 *   4. /.cloud/* 不被业务接管、/control/challenge 明确 501
 *   5. 商家面可达与 /merchant/* 别名
 *
 * 记录制品摘要与期望金额，供证据归档；不对平台数据做任何写操作（询价是只读业务语义）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { origin: undefined, expectAmountMinor: undefined, out: undefined, artifact: path.join(REPO_ROOT, "build", "cloud-artifact") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--origin") options.origin = argv[++i];
    else if (arg === "--expect-amount-minor") options.expectAmountMinor = Number(argv[++i]);
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--artifact") options.artifact = path.resolve(argv[++i]);
    else throw new Error(`未知参数 ${arg}`);
  }
  if (options.origin === undefined) throw new Error("必须提供 --origin");
  options.origin = options.origin.replace(/\/+$/, "");
  return options;
}

async function timedFetch(url, init) {
  const started = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, text, contentType: res.headers.get("content-type") };
}

function jsonOr(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const origin = options.origin;
  const checks = [];
  const record = (name, ok, detail, extra = {}) =>
    checks.push({ check: name, ok, detail, ...extra });

  const artifactManifestPath = path.join(options.artifact, "artifact-manifest.json");
  let artifactSha = null;
  try {
    artifactSha = JSON.parse(readFileSync(artifactManifestPath, "utf8")).artifact_sha256;
  } catch {
    artifactSha = null;
  }

  // 1) 探针
  const livez = await timedFetch(`${origin}/livez`);
  record("livez", livez.status === 200, `status=${livez.status} ${livez.ms}ms`, { body: livez.text.slice(0, 200) });

  const healthz = await timedFetch(`${origin}/healthz`);
  record(
    "healthz",
    healthz.status === 200,
    `status=${healthz.status} ${healthz.ms}ms（平台拦截时返回平台应答，不代表应用存活）`,
    { body: healthz.text.slice(0, 200) },
  );

  const readyz = await timedFetch(`${origin}/readyz`);
  const readyBody = jsonOr(readyz.text);
  record("readyz", readyz.status === 200 && readyBody?.ready === true, `status=${readyz.status} ${readyz.ms}ms`, {
    body: readyz.text.slice(0, 500),
  });

  // 2) Agent Card（T017）
  const card = await timedFetch(`${origin}/.well-known/agent-card.json`);
  const cardBody = jsonOr(card.text);
  const extensions = cardBody?.capabilities?.extensions ?? [];
  record(
    "agent_card",
    card.status === 200 && typeof cardBody?.name === "string",
    `name=${String(cardBody?.name)} url=${String(cardBody?.url)} extensions=${extensions.length}`,
    { body: card.text.slice(0, 1200) },
  );

  // 3) 真实 A2A 询价（T018 平台侧证据）
  let rfqDetail = "skipped（未提供期望金额）";
  let rfqOk = false;
  if (options.expectAmountMinor !== undefined) {
    try {
      const { finalizeEnvelope } = await import(
        path.join(options.artifact, "app", "negotiation", "domain", "envelope.js")
      );
      const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const envelope = finalizeEnvelope({
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
        negotiation_id: `neg_probe_${runId}`,
        exchange_id: `ex_probe_${runId}`,
        message_id: `msg_probe_${runId}`,
        actor: "buyer",
        action: "rfq",
        created_at: new Date().toISOString(),
        payload: { type: "rfq", items: [{ sku: process.env.M1_PROBE_SKU ?? "sku-pilot-1", quantity: { value: 1, unit: "piece" } }] },
      });
      const extensionUri = extensions[0]?.uri;
      const rfq = await timedFetch(`${origin}/a2a`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "A2A-Version": "1.0",
          ...(extensionUri !== undefined ? { "A2A-Extensions": extensionUri } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `probe-${runId}`,
          method: "SendMessage",
          params: {
            message: {
              role: "ROLE_USER",
              parts: [{ data: { knp_envelope: envelope }, mediaType: "application/json" }],
              messageId: `msg_probe_${runId}`,
            },
          },
        }),
      });
      const expected = `"amount_minor":${options.expectAmountMinor}`;
      rfqOk = rfq.status === 200 && rfq.text.includes(expected);
      rfqDetail = `status=${rfq.status} ${rfq.ms}ms expected=${expected} found=${rfq.text.includes(expected)}`;
      record("a2a_rfq_quote", rfqOk, rfqDetail, { body: rfq.text.slice(0, 1500) });
    } catch (err) {
      record("a2a_rfq_quote", false, `异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4) 平台保留路径与未实现端点
  // /  .cloud/* 属平台数据面：要么平台自己拦截（实测 401 invalid_client，因为没带
  // publishableKey），要么落到我们的 router 并返回 reserved_path。两者都算通过——
  // 要排除的是"业务 handler 返回了 2xx 正常业务响应"（那才是真抢占）。
  const reserved = await timedFetch(`${origin}/.cloud/database/rest/items`);
  const reservedBody = jsonOr(reserved.text);
  const reservedError = String(reservedBody?.error ?? "");
  const cloudHandledByPlatform = [401, 403, 404].includes(reserved.status) && reservedError !== "reserved_path";
  record(
    "cloud_reserved",
    reservedError === "reserved_path" || cloudHandledByPlatform,
    `status=${reserved.status} error=${reservedError || "(none)"} ${reserved.ms}ms ` +
      `handledBy=${reservedError === "reserved_path" ? "app-router(不接管)" : "platform-data-plane"}`,
    { body: reserved.text.slice(0, 300) },
  );

  const challenge = await timedFetch(`${origin}/control/challenge`, { method: "POST" });
  record("challenge_not_implemented", challenge.status === 501, `status=${challenge.status} ${challenge.ms}ms`);

  // 5) 商家面（可达性；未登录应被会话门挡住或给登录页）
  const adminLogin = await timedFetch(`${origin}/admin/login`);
  record(
    "merchant_login_page",
    adminLogin.status === 200 && (adminLogin.contentType ?? "").includes("text/html"),
    `status=${adminLogin.status} ${adminLogin.ms}ms`,
  );
  const adminPending = await timedFetch(`${origin}/admin/pending`, { redirect: "manual" });
  record(
    "merchant_pending_requires_session",
    adminPending.status === 303 || adminPending.status === 302,
    `status=${adminPending.status}（未登录应重定向到登录页）`,
  );
  const merchantAlias = await timedFetch(`${origin}/merchant/pending`, { redirect: "manual" });
  record(
    "merchant_alias",
    merchantAlias.status === 303 || merchantAlias.status === 302,
    `status=${merchantAlias.status}（/merchant/* → /admin/* 别名）`,
  );

  const result = {
    probe: "m1-platform",
    origin,
    artifact_sha256: artifactSha,
    ran_at: new Date().toISOString(),
    checks,
    passed: checks.every((c) => c.ok),
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out !== undefined) writeFileSync(options.out, text);
  process.stdout.write(text);
  if (!result.passed) process.exitCode = 1;
}

await main();
