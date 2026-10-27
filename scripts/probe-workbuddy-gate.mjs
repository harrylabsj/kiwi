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
// WorkBuddy 门禁探针（I-01 的可离线实现部分）。
//
// 只做**网络侧差分**：同一地址在"无码 / 错码 / 正确码"三种情况下的 HTTP 状态，
// 以及业务参数是否随正确码一起被接受。它不验证平台的头部改写、分享参数剥除或
// 签名覆盖——那些需要部署在被测平台上的探针源站（见 G0/G1 文档 §2 与 I-01）。
//
//   node scripts/probe-workbuddy-gate.mjs --share-link 'https://x.app.workbuddy.host/a2a?sharecode=…'
//   node scripts/probe-workbuddy-gate.mjs --origin https://x.app.workbuddy.host --code '…'
//
// 纪律：
//   - 分享码只从参数读入，**从不打印**（错误信息与报告里一律 <redacted>）；
//   - 只发 GET/HEAD，不发 POST——探针不得触发任何有副作用的业务动作；
//   - 不跟随重定向（3xx 可能是平台跳转到别的域，凭据不能跟着走）；
//   - 结果只含状态码、耗时与稳定分类，不含响应体（响应体可能含凭据）。

import { parseArgs } from "node:util";

const USAGE = `usage: node scripts/probe-workbuddy-gate.mjs (--share-link <url> | --origin <url> --code <code>)
                                          [--path /a2a] [--param x=1] [--timeout-ms 8000]

Probe the WorkBuddy share-code gate with GET/HEAD only. The code is never
printed; the report contains statuses and fixed classifications only.

options:
  --share-link <url>   full share link (the code is extracted from it)
  --origin <url>       app origin; requires --code
  --code <code>        share code (never printed)
  --path <path>        request path (default: the share link path, else /a2a)
  --param <k=v>        extra business query parameter (repeatable)
  --timeout-ms <n>     per-request timeout (default 8000)
  --help               show this help and exit
`;

const REDACTED = "<redacted>";
const PARAMETER = "sharecode";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      "share-link": { type: "string" },
      origin: { type: "string" },
      code: { type: "string" },
      path: { type: "string" },
      param: { type: "string", multiple: true },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  return values;
}

/** 敏感值不进任何输出；这里同时处理 URL 编码形态。 */
function redact(text, secret) {
  let out = String(text);
  for (const value of new Set([secret, encodeURIComponent(secret)])) {
    if (value !== "") out = out.split(value).join(REDACTED);
  }
  return out.replace(new RegExp(`([?&])${PARAMETER}=[^&\\s"']*`, "gi"), `$1${PARAMETER}=${REDACTED}`);
}

function classify(status) {
  if (status === 401 || status === 403) return "gate_rejected";
  if (status >= 300 && status < 400) return "redirect_refused(not_followed)";
  if (status >= 200 && status < 300) return "accepted";
  if (status >= 500) return "upstream_error";
  return `http_${status}`;
}

async function probe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json, text/plain, */*" },
    });
    return { status: response.status, ms: Date.now() - started, error: null };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      status: 0,
      ms: Date.now() - started,
      error: aborted ? "timeout" : error instanceof Error ? error.name : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 只允许 https；本机自测允许 loopback http（与其它验收脚本同口径）。 */
function requireOrigin(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("error: origin is not a valid URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    fail("error: origin must be https (http is accepted for loopback self-tests only)");
  }
  return parsed;
}

async function main() {
  const values = parseCli();
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  let origin;
  let secret;
  let path = values.path;
  if (typeof values["share-link"] === "string" && values["share-link"] !== "") {
    const parsed = requireOrigin(values["share-link"]);
    origin = `${parsed.protocol}//${parsed.host}`;
    path = path ?? parsed.pathname;
    const codes = parsed.searchParams.getAll(PARAMETER);
    if (codes.length !== 1 || codes[0] === "") fail(`error: --share-link must carry exactly one ${PARAMETER}`);
    secret = codes[0];
  } else {
    if (typeof values.origin !== "string" || values.origin === "") fail("error: missing --origin (or --share-link)");
    if (typeof values.code !== "string" || values.code === "") fail("error: missing --code");
    const parsed = requireOrigin(values.origin);
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      fail("error: --origin must be a bare https origin");
    }
    origin = `${parsed.protocol}//${parsed.host}`;
    secret = values.code;
  }

  const timeoutMs = Number.parseInt(String(values["timeout-ms"] ?? "8000"), 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) fail("error: --timeout-ms is out of range");

  const requestPath = path === undefined || path === "" ? "/a2a" : path;
  const extras = (values.param ?? []).map((entry) => {
    const index = String(entry).indexOf("=");
    if (index <= 0) fail("error: --param must be k=v");
    const name = String(entry).slice(0, index);
    if (name === PARAMETER) fail(`error: --param must not set ${PARAMETER}`);
    return [name, String(entry).slice(index + 1)];
  });

  const base = new URL(requestPath, origin);
  const withoutCode = new URL(base.href);
  const wrongCode = new URL(base.href);
  const withCode = new URL(base.href);
  for (const [name, value] of extras) {
    for (const target of [withoutCode, wrongCode, withCode]) target.searchParams.append(name, value);
  }
  wrongCode.searchParams.set(PARAMETER, `${secret}-probe-mismatch`);
  withCode.searchParams.set(PARAMETER, secret);

  try {
    const cases = [
      ["no_code", withoutCode],
      ["wrong_code", wrongCode],
      ["correct_code", withCode],
    ];
    const results = [];
    for (const [name, url] of cases) {
      const result = await probe(url.href, timeoutMs);
      results.push({
        case: name,
        status: result.status,
        classification: result.error ?? classify(result.status),
        ms: result.ms,
      });
    }
    // 报告：只有状态/分类/耗时；URL 一律脱敏（分享码永不出现）。
    process.stdout.write(
      `${JSON.stringify({ target: `${origin}${requestPath}`, extras: extras.length, results }, null, 2)}\n`,
    );
    const byCase = Object.fromEntries(results.map((r) => [r.case, r]));
    const expectations = [
      [byCase.no_code?.status === 401 || byCase.no_code?.status === 403, "no_code is rejected by the gate"],
      [byCase.wrong_code?.status === 401 || byCase.wrong_code?.status === 403, "wrong_code is rejected by the gate"],
      [byCase.correct_code?.status !== 0 && byCase.correct_code?.status !== 401 && byCase.correct_code?.status !== 403, "correct_code is accepted by the gate"],
    ];
    let ok = true;
    for (const [passed, label] of expectations) {
      process.stderr.write(`${passed ? "PASS" : "FAIL"}: ${label}\n`);
      if (!passed) ok = false;
    }
    process.stderr.write("NOTE: header rewriting, parameter stripping and signature coverage need an on-platform probe origin (I-01).\n");
    return ok ? 0 : 1;
  } catch (error) {
    // 异常文本可能带完整 URL——先脱敏再输出。
    fail(redact(`error: probe failed: ${error instanceof Error ? error.message : String(error)}`, secret));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
