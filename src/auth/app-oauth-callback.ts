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
 * 应用级 OAuth 回调接收端点（GET /oauth/callback）。
 *
 * 这是**应用级**授权链（WorkBuddy 开放平台 → Buddy 应用的 Open API 能力授权）
 * 的回调落点——与连接器级 OAuth（本服务作为授权服务器的
 * /oauth/authorize|token，见 merchant-oauth.ts）是两条互不相通的链路。
 *
 * 产品现状：应用运行时不调用平台 Open API，因此收到的 authorization code
 * **永不兑换**。本端点只做三件事（创建表单「OAuth回调地址」必填项的真实落点，
 * BD 交付线 P1 自测路径第 1 步）：
 *   1. 如实接收 RFC 6749 §4.1.2 的两种回跳（成功带 code / 拒绝带 error）；
 *   2. 留痕——单行日志只含元数据；code 本身是凭据，绝不记录、绝不回显；
 *   3. 回一个商家和平台都能看懂的静态确认页。
 *
 * 端点故意无状态、无副作用：不建会话、不写存储、不发起任何出站请求。
 */

/** 平台错误码的安全形状（只用于回显白名单，其余一律不回显）。 */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface AppOAuthCallbackLogEntry {
  event: "app_oauth_callback";
  /** 平台回跳是否携带授权码（只记有无，绝不记值）。 */
  code_received: boolean;
  /** 是否携带 state（只记有无；state 不回显、不记录值）。 */
  state_present: boolean;
  /** 平台错误码（净化后）；成功回跳时缺省。 */
  error?: string;
}

export interface AppOAuthCallbackResult {
  status: number;
  html: string;
  log: AppOAuthCallbackLogEntry;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 处理一次应用级回调回跳。三个分支：
 *   error 参数  → 200「授权未完成」（回跳本身成功到达，浏览器落地页应为 200）；
 *   code 参数  → 200「授权完成」；
 *   两者皆无   → 400（不是平台回跳，多半是人为访问/扫描）。
 */
export function handleAppOAuthCallback(query: URLSearchParams): AppOAuthCallbackResult {
  const codeReceived = (query.get("code") ?? "") !== "";
  const statePresent = (query.get("state") ?? "") !== "";
  const rawError = query.get("error") ?? "";
  const baseLog: AppOAuthCallbackLogEntry = {
    event: "app_oauth_callback",
    code_received: codeReceived,
    state_present: statePresent,
  };

  if (rawError !== "") {
    // RFC 6749 §4.1.2.1：平台把用户带回 error（如 access_denied）。
    // error_description 是平台可控的自由文本，一律不回显——页面只展示
    // 净化后的错误码，其余场景给静态话术。
    const safeError = ERROR_CODE_PATTERN.test(rawError) ? rawError : undefined;
    const detail = safeError !== undefined
      ? `<p>平台回跳携带错误码：<code>${escapeHtml(safeError)}</code>。如非你主动取消授权，请回到开放平台重新发起。</p>`
      : "<p>平台回跳携带错误。如非你主动取消授权，请回到开放平台重新发起。</p>";
    return {
      status: 200,
      html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>授权未完成 — Kiwi 商家运营工作台</title></head>
<body>
  <h1>Kiwi 商家运营工作台</h1>
  <p>授权<strong>未完成</strong>。</p>
  ${detail}
</body>
</html>`,
      log: safeError !== undefined ? { ...baseLog, error: safeError } : baseLog,
    };
  }

  if (codeReceived) {
    // 授权码只确认"收到了"，不兑换（本应用不调用 Open API）、不回显、不入日志。
    return {
      status: 200,
      html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>授权完成 — Kiwi 商家运营工作台</title></head>
<body>
  <h1>Kiwi 商家运营工作台</h1>
  <p>授权完成。平台的授权回执已收到并记录。</p>
  <p>本应用当前不调用平台 Open API，无需任何进一步操作，此页可以关闭。</p>
</body>
</html>`,
      log: baseLog,
    };
  }

  return {
    status: 400,
    html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>回调参数缺失 — Kiwi 商家运营工作台</title></head>
<body>
  <h1>Kiwi 商家运营工作台</h1>
  <p>本地址是平台应用级 OAuth 的回调地址，只接受平台的授权回跳（需携带 <code>code</code> 或 <code>error</code> 参数），不提供其他功能。</p>
</body>
</html>`,
    log: baseLog,
  };
}

/** 单行留痕格式（stderr）。字段全部为元数据，无凭据、无自由文本。 */
export function formatAppOAuthCallbackLog(entry: AppOAuthCallbackLogEntry): string {
  const parts = [
    entry.event,
    `code_received=${entry.code_received}`,
    `state_present=${entry.state_present}`,
  ];
  if (entry.error !== undefined) parts.push(`error=${entry.error}`);
  return parts.join(" ");
}
