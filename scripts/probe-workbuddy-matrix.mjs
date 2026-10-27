#!/usr/bin/env node
// Copyright 2026 harrylabsj
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// WorkBuddy 平台行为实测矩阵（I-01）。
//
// 前提：目标应用已部署 Kiwi 云端运行时，且显式设置了 KIWI_CLOUD_PROBE_ECHO=1
// （见 docs/kiwi/Kiwi-WorkBuddy探针实测执行卡-20261027.md）。
//
//   node scripts/probe-workbuddy-matrix.mjs \
//     --origin https://xxx.app.workbuddy.host --code <分享码> [--report out.json]
//
// 它回答四个技术事实：
//   1. 门禁是否必须（无码/错码/正确码）；
//   2. 网关是否剥除 sharecode、是否保留其它查询参数与原始编码；
//   3. 网关是否改写或**注入** Authorization；
//   4. 签名头（Signature / Signature-Input / Content-Digest）是否原样透传。
//
// 纪律：分享码只做入参、永不打印；探针只发 GET/POST，不跟随重定向；报告里
// 不出现任何凭据值（Authorization 用一次性随机探针值，只比对摘要）。

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PARAMETER = "sharecode";
const ECHO_PATH = "/__probe/echo";
const PROBE_TOKEN = `probe-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 16)}`;
const REDACTED = "<redacted>";

const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    code: { type: "string" },
    path: { type: "string" },
    report: { type: "string" },
    "timeout-ms": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stdout.write(
    "usage: node scripts/probe-workbuddy-matrix.mjs --origin <https origin> --code <share code> [--path /__probe/echo] [--report out.json] [--timeout-ms 10000]\n",
  );
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const rawOrigin = String(values.origin ?? "").trim();
let origin;
try {
  origin = new URL(rawOrigin);
} catch {
  fail("error: --origin is not a valid URL");
}
const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost";
if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) {
  fail("error: --origin must be https (http accepted for loopback self-tests only)");
}
if (origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
  fail("error: --origin must be a bare origin");
}
const code = String(values.code ?? "");
if (code === "") fail("error: --code is required");
const path = String(values.path ?? ECHO_PATH);
const timeoutMs = Number.parseInt(String(values["timeout-ms"] ?? "10000"), 10);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) fail("error: --timeout-ms is out of range");

const base = `${origin.protocol}//${origin.host}`;
const digest = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;

async function call({ withCode = true, extraParams = [], headerLines = [], body, method = "GET" }) {
  // 手工拼查询串：URLSearchParams 会把 %20 归一成 +，那样就测不出网关是否重编码。
  const parts = extraParams.map(([name, value]) => `${name}=${value}`);
  if (withCode) parts.push(`${PARAMETER}=${encodeURIComponent(code)}`);
  const href = `${base}${path}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
  const headers = { accept: "application/json" };
  for (const [name, value] of headerLines) headers[name] = value;
  if (body !== undefined) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(href, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  } catch (error) {
    return {
      status: 0,
      json: undefined,
      error: controller.signal.aborted ? "timeout" : error instanceof Error ? error.name : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function headerEntry(json, name) {
  return (json?.headers ?? []).find((entry) => entry.name === name);
}

const findings = [];
function record(check, verdict, detail) {
  findings.push({ check, verdict, detail });
  process.stderr.write(`${verdict === "pass" ? "PASS" : verdict === "unknown" ? "????" : "NOTE"}: ${check} — ${detail}\n`);
}

const results = {};

// 1) 门禁差分
results.noCode = await call({ withCode: false });
results.wrongCode = await call({ extraParams: [[PARAMETER, `${code}-probe-mismatch`]], withCode: false });
results.correct = await call({});
const gateBlocked = [401, 403].includes(results.noCode.status);
record(
  "gate_required",
  gateBlocked ? "pass" : results.noCode.status === 200 ? "fail" : "unknown",
  `无码=${results.noCode.status} 错码=${results.wrongCode.status} 正确码=${results.correct.status}`,
);

if (results.correct.json === undefined) {
  // 没有回显就不能继续判断改写；把现状写清楚再退出。
  record("echo_reachable", "fail", "正确码请求没有拿到回显 JSON：目标运行时是否设置了 KIWI_CLOUD_PROBE_ECHO=1？");
} else {
  const echo = results.correct.json;

  // 2) sharecode 是否被网关剥除
  record(
    "sharecode_stripped",
    echo.sharecode?.present === false ? "pass" : "fail",
    echo.sharecode?.present === false
      ? "源站收到的地址不含 sharecode（网关已剥除）"
      : "源站仍收到 sharecode（网关未剥除）",
  );

  // 3) 路径是否原样
  record("path_preserved", echo.path === path ? "pass" : "fail", `期望 ${path}，实收 ${echo.path}`);

  // 4) 其它查询参数与原始编码
  const params = await call({ extraParams: [["x", "1"], ["y", "hello world"]] });
  const raw = params.json?.raw_query ?? "";
  const keepsOrder = raw.includes("x=1") && raw.indexOf("x=1") < raw.indexOf("y=");
  const keepsEncoding = raw.includes("hello%20world");
  record(
    "business_params",
    keepsOrder && keepsEncoding ? "pass" : "unknown",
    `实收 raw_query=${raw.replace(/sharecode=[^&]*/g, "sharecode=<redacted>")}`,
  );

  // 5) Authorization 是否被改写/注入
  const authValue = `Bearer ${PROBE_TOKEN}`;
  const withAuth = await call({ headerLines: [["authorization", authValue]] });
  const authEntry = headerEntry(withAuth.json, "authorization");
  const authExpected = digest(authValue);
  if (authEntry === undefined) {
    record("authorization_rewritten", "fail", "客户端带了 Authorization，源站却没收到该头");
  } else if (authEntry.values_sha256?.[0] === authExpected && authEntry.scheme === "Bearer") {
    record("authorization_rewritten", "pass", "Authorization 原样到达（值与方案均未变）");
  } else {
    record(
      "authorization_rewritten",
      "fail",
      `Authorization 被改写：到达方案=${authEntry.scheme ?? "无"}，摘要与发送值不一致`,
    );
  }
  // 不带 Authorization 时源站是否仍看到它 → 平台注入
  const withoutAuth = await call({});
  const injected = headerEntry(withoutAuth.json, "authorization") !== undefined;
  record(
    "authorization_injected",
    injected ? "fail" : "pass",
    injected ? "客户端未发送 Authorization，源站仍然收到（平台注入）" : "客户端未发送时源站也收不到（无注入）",
  );

  // 6) 签名头是否原样透传
  const signatureInput = 'sig1=("@method" "@target-uri");created=1;keyid="probe"';
  const signature = "probe-signature-value";
  const contentDigest = "sha-256=:probe-digest:";
  const signed = await call({
    headerLines: [
      ["signature-input", signatureInput],
      ["signature", signature],
      ["content-digest", contentDigest],
    ],
  });
  const same = (name, expected) => headerEntry(signed.json, name)?.values_sha256?.[0] === digest(expected);
  record(
    "signature_headers_passthrough",
    same("signature-input", signatureInput) && same("signature", signature) && same("content-digest", contentDigest)
      ? "pass"
      : "fail",
    "Signature / Signature-Input / Content-Digest 三项逐一比对",
  );

  // 7) 请求体完整性
  const body = JSON.stringify({ probe: true, at: "matrix" });
  const posted = await call({ method: "POST", body });
  const bodyIntact =
    posted.json?.body?.length === Buffer.byteLength(body) &&
    posted.json?.body?.sha256 === `sha256:${createHash("sha256").update(body).digest("hex")}`;
  record("body_intact", bodyIntact ? "pass" : "fail", `发送 ${Buffer.byteLength(body)} 字节并比对 sha256`);

  // 8) 重复 sharecode
  const duplicated = await call({ withCode: false, extraParams: [[PARAMETER, code], [PARAMETER, `${code}-x`]] });
  record(
    "duplicate_sharecode",
    duplicated.status === results.correct.status ? "unknown" : "fail",
    `重复参数时状态=${duplicated.status}（正确单参数=${results.correct.status}）`,
  );

  results.echo = echo;
  results.params = params.json;
  results.withAuth = { status: withAuth.status, authorization: authEntry ?? null };
  results.withoutAuth = { injected };
  results.signed = signed.json;
  results.posted = posted.json;
  results.duplicated = duplicated.status;
}

const report = {
  target: `${base}${path}`,
  generated_at: new Date().toISOString(),
  findings,
  gate: {
    no_code: results.noCode.status,
    wrong_code: results.wrongCode.status,
    correct_code: results.correct.status,
  },
  raw: {
    ...(results.echo !== undefined ? { echo: results.echo } : {}),
    ...(results.withAuth !== undefined ? { with_auth: results.withAuth } : {}),
    ...(results.signed !== undefined ? { signed: results.signed } : {}),
    ...(results.posted !== undefined ? { posted: results.posted } : {}),
    ...(results.duplicated !== undefined ? { duplicated_status: results.duplicated } : {}),
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (!serialized.includes(code)) {
  process.stdout.write(serialized);
  if (typeof values.report === "string" && values.report !== "") {
    writeFileSync(values.report, serialized);
    process.stderr.write(`report written to ${values.report}\n`);
  }
} else {
  fail(`error: report contained the share code; refusing to print or write (value ${REDACTED})`);
}

const failed = findings.filter((entry) => entry.verdict === "fail");
process.exit(failed.length === 0 ? 0 : 1);
