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
 * 商家工作台同源页面（BD 设计 §9.1 的 `/merchant/` 静态资源；BD-03）。
 *
 * 形态：**单文件静态壳**——无框架、无构建步、无外部资源；以 TS 模板常量随
 * Runtime 编译进制品（不设第二份 web/ 拷贝，避免两处漂移；也不把 Node/Pi/
 * 秘密带进浏览器产物——红线 9，verify:package 会核）。
 *
 * 边界（BD §9.1）：页面壳本身不含业务数据也不做鉴权判断——所有数据经
 * `/merchant/api/*` 取得，未持会话一律 401，页面只展示「请登录」入口
 * （/admin/login）。`/merchant/api/*` 的 `Cache-Control: no-store` 同样
 * 适用于本页（壳内嵌确认流程的中间态不留缓存）。
 */

/** 页面按 owner 视角展示管理动作；角色由服务端权限逐次裁决，前端只是提示。 */
export function renderMerchantManagementPage(options: {
  productAuthority?: "file" | "exact";
  catalogConnection?: boolean;
  workbuddyAccess?: boolean;
} = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>商家工作台 — Kiwi</title>
<style>
  :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #23342d; background: #f5f7f4; font-size: 14px; line-height: 1.6; --kiwi: #205c43; --border: #dce4de; --muted: #5e7066; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; grid-template-columns: 216px minmax(0, 1fr); grid-template-rows: 76px 1fr; }
  button, input, select, textarea { font: inherit; }
  button, a, input, select, textarea { -webkit-tap-highlight-color: transparent; }
  a { color: var(--kiwi); text-underline-offset: 3px; }
  button { cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  .act.primary:disabled { background: #a4aea7; border-color: #a4aea7; color: #fff; }
  :focus-visible { outline: 3px solid #9b7214; outline-offset: 3px; }
  .skip-link { position: fixed; left: 16px; top: -80px; z-index: 20; padding: 10px 16px; background: #fff; border: 2px solid var(--kiwi); border-radius: 8px; }
  .skip-link:focus { top: 12px; }
  header { grid-column: 1 / -1; background: #fff; border-bottom: 1px solid var(--border); padding: 0 32px; display: flex; justify-content: space-between; align-items: center; gap: 24px; }
  .brand { display: flex; align-items: center; gap: 16px; }
  .brand-name { color: var(--kiwi); font-size: 30px; font-weight: 750; letter-spacing: -1.6px; line-height: 1; }
  .brand-title { font-size: 14px; font-weight: 600; padding-left: 16px; border-left: 1px solid var(--border); }
  header .who { font-size: 12px; color: var(--muted); padding: 7px 12px; border: 1px solid var(--border); border-radius: 8px; max-width: 50%; overflow-wrap: anywhere; }
  header .who:empty { display: none; }
  nav { padding: 28px 16px; background: #fff; border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; align-self: stretch; }
  .nav-label { margin: 0 12px 12px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 1.4px; }
  nav button { border: 1px solid transparent; padding: 12px 16px; border-radius: 8px; background: transparent; color: #53665b; text-align: left; font-weight: 500; line-height: 1.4; }
  nav button:hover { background: #f3f7f3; color: var(--kiwi); }
  nav button.on { background: #eaf2ec; color: #174c35; border-color: #d9e8dd; font-weight: 650; box-shadow: inset 3px 0 #2e7050; }
  .nav-foot { margin: auto 12px 0; padding-top: 40px; color: var(--muted); font-size: 11px; }
  .workspace { min-width: 0; padding: 32px clamp(20px, 3vw, 48px) 72px; width: 100%; max-width: 1400px; margin: 0 auto; }
  .page-head { margin-bottom: 24px; }
  .eyebrow { margin: 0 0 6px; color: var(--kiwi); font-size: 11px; letter-spacing: 1.8px; font-weight: 650; }
  .page-head h1 { margin: 0 0 6px; font-size: 26px; line-height: 1.35; letter-spacing: -.6px; font-weight: 650; }
  .page-head p:last-child { margin: 0; color: var(--muted); font-size: 13px; }
  main { min-width: 0; }
  .card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 3px 12px #243b2b04; min-width: 0; }
  .card h2 { font-size: 16px; line-height: 1.5; margin: 0 0 18px; color: #233b2d; font-weight: 650; }
  .card p { margin: 12px 0; overflow-wrap: anywhere; }
  .card > :last-child { margin-bottom: 0; }
  .table-scroll { width: 100%; overflow-x: auto; border: 1px solid #e4eae5; border-radius: 8px; margin: 12px 0 18px; }
  table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13px; line-height: 1.6; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #e9eee9; vertical-align: middle; }
  th { color: #53665b; font-weight: 600; white-space: nowrap; background: #f7f9f6; }
  tr:last-child > th, tr:last-child > td { border-bottom: 0; }
  tr:hover > td { background: #fafcf9; }
  .detail-table { min-width: 0; }
  .detail-table th { width: 190px; }
  td { overflow-wrap: anywhere; }
  .pill { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 5px; font-size: 12px; line-height: 1.7; font-weight: 550; background: #edf1ed; color: #53665b; white-space: nowrap; }
  .ok { background: #e9f4ec; color: #24623b; } .warn { background: #fcf2de; color: #795309; } .bad { background: #fcebea; color: #a03933; }
  .act { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #c8d5cc; background: #fff; color: #344c3d; border-radius: 7px; padding: 8px 14px; min-height: 38px; text-decoration: none; font-size: 13px; font-weight: 550; line-height: 1.5; }
  .act:hover { background: #f4f8f3; border-color: #8ba695; }
  .act.primary { background: var(--kiwi); color: #fff; border-color: var(--kiwi); }
  .act.primary:hover { background: #164a34; }
  .act.danger { color: #a03933; border-color: #e5c2bd; }
  .act.danger:hover { background: #fff4f2; }
  #bar { position: fixed; left: 240px; right: 24px; bottom: 20px; max-width: 760px; margin: auto; padding: 14px 20px; font-size: 13px; background: #244b36; color: #fff; border-radius: 9px; box-shadow: 0 6px 24px #233b2d26; display: none; z-index: 10; overflow-wrap: anywhere; }
  #bar.err { background: #89372f; }
  textarea, input[type=text] { width: 100%; max-width: 100%; border: 1px solid #c8d5cc; border-radius: 7px; padding: 10px 12px; color: #23342d; background: #fcfdfb; font: 13px ui-monospace, SFMono-Regular, monospace; line-height: 1.6; }
  textarea { resize: vertical; }
  input::placeholder, textarea::placeholder { color: #69796e; }
  input[type=file] { min-width: 0; max-width: 100%; border: 1px dashed #b4c9b9; border-radius: 8px; padding: 10px; background: #f7faf5; font-size: 13px; }
  input[type=file]::file-selector-button { border: 1px solid #c8d5cc; border-radius: 5px; background: #fff; color: #344c3d; padding: 6px 10px; margin-right: 10px; cursor: pointer; }
  input[type=checkbox] { accent-color: var(--kiwi); width: 16px; height: 16px; vertical-align: middle; }
  .muted { color: var(--muted); font-size: 12px; line-height: 1.8; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .consent-label { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .consent-label span { flex: 1; min-width: 0; }
  .consent-label input { flex: none; margin: 3px 0 0; }
  details summary { cursor: pointer; color: var(--kiwi); text-decoration: underline; text-underline-offset: 3px; }
  .row > .muted { flex: 1 1 180px; }
  pre.digest { font: 11px ui-monospace, monospace; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; max-width: 320px; }
  label { font-size: 13px; }
  select { border: 1px solid #c8d5cc; border-radius: 7px; padding: 8px 12px; font-size: 13px; color: #23342d; background: #fff; max-width: 100%; }
  .trendrow { display: flex; align-items: center; gap: 12px; margin: 10px 0; font-size: 12px; }
  .trendrow > span:first-child { width: 44px; color: var(--muted); }
  .trendbar { flex: 1; height: 8px; background: #edf2eb; border-radius: 4px; overflow: hidden; }
  .trendfill { height: 100%; background: #4b815c; }
  .login-card { max-width: 600px; padding: 32px; }
  .empty-state { padding: 24px 16px; background: #f8faf6; border: 1px dashed #d5e1d5; border-radius: 8px; }
  @media (max-width: 900px) {
    body { grid-template-columns: 176px minmax(0, 1fr); }
    header { padding: 0 24px; }
    nav { padding: 24px 10px; }
    nav button { padding: 12px; }
    .workspace { padding: 26px 24px 64px; }
    .card { padding: 20px; }
    #bar { left: 196px; }
  }
  @media (max-width: 640px) {
    body { display: block; }
    header { min-height: 72px; padding: 16px; gap: 12px; flex-wrap: wrap; }
    .brand-name { font-size: 27px; }
    header .who { max-width: 100%; padding: 0; border: 0; font-size: 11px; }
    nav { padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--border); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .nav-label, .nav-foot { display: none; }
    nav button { padding: 10px 4px; font-size: 12px; text-align: center; min-height: 40px; }
    nav button.on { box-shadow: none; }
    .workspace { padding: 24px 16px 64px; }
    .page-head { margin-bottom: 20px; }
    .page-head h1 { font-size: 23px; }
    .card, .login-card { padding: 20px 16px; border-radius: 10px; margin-bottom: 16px; }
    .card h2 { font-size: 15px; margin-bottom: 14px; }
    .detail-table th { width: 110px; white-space: normal; }
    th, td { padding: 10px 12px; }
    .detail-table td { word-break: break-word; }
    #bar { left: 16px; right: 16px; bottom: 16px; }
    .row { gap: 10px; }
  }
  @media (prefers-reduced-motion: no-preference) { .act, nav button { transition: background-color .15s, border-color .15s; } }
</style>
</head>
<body>
<a href="#view" class="skip-link">跳至工作区</a>
<header><div class="brand"><span class="brand-name" aria-label="Kiwi">kiwi</span><span class="brand-title">商家工作台</span></div><span class="who" id="who"></span></header>
<nav id="tabs" aria-label="工作台导航">
  <p class="nav-label">工作空间</p>
  <button data-v="status" class="on" aria-current="page">服务状态</button>
  <button data-v="products">商品与导入</button>
  <button data-v="approvals">待审批</button>
  <button data-v="negotiations">会话旁观</button>
  <button data-v="reports">运营报告</button>
  <button data-v="policy">报价规则</button>
  <button data-v="operating">商品经营</button>
  <button data-v="sales">销售工作台</button>
  <button data-v="outcomes">经营结果</button>
  <p class="nav-foot">日常经营，井然有序。<br>Kiwi Merchant</p>
</nav>
<div class="workspace">
  <section class="page-head" aria-labelledby="page-title"><p class="eyebrow">MERCHANT WORKSPACE</p><h1 id="page-title">服务状态</h1><p id="page-description">掌握接待状态，管理店铺与目录连接。</p></section>
  <main id="view" tabindex="-1" aria-label="商家工作区"><div class="card">加载中…</div></main>
</div>
<div id="bar" role="status" aria-live="polite" aria-atomic="true"></div>
<script>
"use strict";
var CSRF = "";
var ROLE = "";
var API = "/merchant/api/v1";
var FILE_PRODUCTS = ${options.productAuthority === "file"};
var CATALOG_CONNECT = ${options.catalogConnection === true};
var WORKBUDDY_ACCESS = ${options.workbuddyAccess === true};
// 与 cloud/access/workbuddy-share-link 的 WORKBUDDY_CUSTODY_TERMS_VERSION 同值；
// 浏览器产物必须自包含（verify:browser-artifact 禁止模块导入），所以这里是字面量，
// 由 tests/merchant-management-api 断言两者一致。
var ACCESS_CONSENT_TERMS = "workbuddy-share-v1-2026-10-27";
var catalogBeginKey = "";
var catalogBeginPending = false;
var catalogConnectionState = null;
var catalogAccessState = null;
var publicationDraft = null;
var publicationPicks = null;
var publicationBusy = false;
var $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function marketplaceLink(it) {
  var value = it.platform_product_url;
  if (typeof value !== "string") return "-";
  try {
    var url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        ["item.jd.com", "item.taobao.com", "detail.tmall.com"].indexOf(url.hostname) < 0) return "-";
    return '<a href="' + esc(value) + '" target="_blank" rel="noopener noreferrer">' + esc(value) + '</a>';
  } catch (_) { return "-"; }
}
function bar(msg, isErr) {
  var b = $("bar");
  b.textContent = msg;
  b.className = isErr ? "err" : "";
  b.style.display = "block";
  if (!isErr) setTimeout(function () { b.style.display = "none"; }, 4000);
}
function recoveryHint(action) {
  return {
    none: "请勿重复操作。",
    reauthenticate: "请重新登录后再试。",
    refresh_resource: "请刷新页面并核对最新状态。",
    confirm: "请在可信确认页完成授权。",
    query_operation: "结果尚未确认，请先查询原操作状态，不要重新提交。",
    retry_same_operation: "服务确认操作未生效；如需重试，请沿用原操作。",
    resync_feed: "请重新同步资料游标。",
    open_support: "请联系支持并提供请求编号。",
    unknown: "恢复方式尚不明确，请勿自动重试。",
  }[action] || "恢复方式尚不明确，请勿自动重试。";
}
async function apiError(res) {
  var problem;
  if ((res.headers.get("content-type") || "").toLowerCase().indexOf("application/problem+json") >= 0) {
    try { problem = await res.clone().json(); } catch (_) { problem = null; }
  }
  if (problem && typeof problem === "object" && typeof problem.detail === "string") {
    var text = problem.detail;
    if (problem.operation_id) text += "（操作 " + problem.operation_id + "）";
    if (problem.request_id) text += "（请求 " + problem.request_id + "）";
    var error = new Error(text + " " + recoveryHint(problem.recovery_action));
    // 写门令牌失效（运行时重启或重新登录后页面仍持旧令牌）。该 403 在业务逻辑
    // 之前抛出，重试不会产生第二次效果；标记后由调用方刷新令牌重试一次。
    error.csrf = problem.detail === "missing or invalid CSRF token";
    return error;
  }
  var fallback = await res.json().catch(function () { return {}; });
  return new Error((fallback.message || fallback.detail || fallback.code || ("HTTP " + res.status)) + "。请勿自动重复提交。");
}
function refreshCsrf() {
  return fetch("/merchant/api/session", { credentials: "same-origin" }).then(function (res) {
    if (res.status === 401) { showLogin(); throw new Error("需要登录"); }
    if (!res.ok) throw new Error("会话刷新失败，请重新登录后再试。");
    return res.json();
  }).then(function (session) {
    CSRF = session && session.csrf_token ? session.csrf_token : "";
    if (!CSRF) throw new Error("会话刷新失败，请重新登录后再试。");
  });
}
function csrfRetry(error, retry, again) {
  if (!again || !error.csrf) return Promise.reject(error);
  return refreshCsrf().then(retry);
}
function call(method, path, body, apiBase) {
  return send(method, path, body, apiBase, true);
}
function send(method, path, body, apiBase, again) {
  var headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    if (CSRF) headers["x-csrf-token"] = CSRF;
  }
  return fetch((apiBase || API) + path, {
    method: method,
    credentials: "same-origin",
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(function (res) {
    if (!res.ok) {
      if (res.status === 401) { showLogin(); throw new Error("需要登录"); }
      return apiError(res).then(function (error) {
        return csrfRetry(error, function () { return send(method, path, body, apiBase, false); }, again);
      });
    }
    return res.json();
  });
}
function showLogin() {
  $("view").innerHTML = '<div class="card login-card"><h2>登录你的商家工作台</h2>' +
    '<p class="muted">请使用商家管理员口令登录后回到本页。</p>' +
    '<p><a class="act primary" href="/admin/login?next=%2Fmerchant%2F">去登录</a></p></div>';
}
function key(p) { return p + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
function statePill(state) {
  var map = { OPERATING: ["ok", "营业中"], PAUSED: ["warn", "已暂停"], WITHDRAWN: ["bad", "已撤回"], DEGRADED: ["warn", "降级"] };
  var it = map[state] || ["warn", state];
  return '<span class="pill ' + it[0] + '">' + esc(it[1]) + "</span>";
}

var PAIRING_CODE_HINTS = {
  PAIRING_WINDOW_EXPIRED: "上次授权已过期：请重新发起，并在 10 分钟内到目录完成确认",
  BIND_REJECTED: "目录拒绝了本次绑定请求：请重新发起，反复出现请联系管理员",
  BIND_CLAIM_CARD_URL_MISMATCH: "目录名片地址与已确认的公开预览不一致：请重新核对后再发起",
  BIND_CLAIM_FIELD_MISMATCH: "目录绑定材料与预览不一致：请重新发起",
  BIND_CLAIM_INVALID: "目录签名材料未通过本机校验：请重新发起",
  CARD_PUBLISH_REJECTED: "名片发布被目录拒绝：请稍后重试或联系管理员",
  CARD_PUBLISH_INVALID: "名片发布回执不完整：请刷新后重试",
  PAIRING_COMMUNICATION_FAILED: "与目录通信暂时失败：请稍后刷新重试"
};

function catalogStatusText(s) {
  if (s.published) return "目录名片已发布";
  var labels = { idle: "尚未连接", preparing: "等待你确认授权", pending: "等待你确认授权",
    awaiting_confirmation: "等待你确认授权", authorized: "授权已收到，正在连接",
    bound: "已连接，正在检查接待能力", expired: "授权已过期，请重新发起",
    blocked: "连接未完成，请核对状态", paused: "目录服务已暂停", revoked: "授权已撤销" };
  return labels[s.status] || "连接尚未完成";
}
function appendCatalogConnection(html) {
  // 调用方固定按 appendCatalogConnection(...).then(appendCatalogAccess) 串联：
  // 没有目录连接或非 owner 时必须返回已决议的 Promise，返回字符串会在默认
  // 「服务状态」页抛 TypeError（旧流程整页停在“加载中…”）。
  if (!CATALOG_CONNECT || ROLE !== "owner") return Promise.resolve(html);
  catalogConnectionState = null;
  return call("GET", "/catalog/connect").then(function (s) {
    catalogConnectionState = s;
    return html + '<div class="card"><h2>连接 Kiwi 目录</h2><p id="catalog-status">' + esc(catalogStatusText(s)) +
      (s.errorCode ? ' <span class="muted">[' + esc(s.errorCode) + ']</span>' : '') + '</p>' +
      (s.bindingId ? '<p>Kiwi 账户：<span id="bound-account">正在核对…</span></p>' : '<p>Kiwi 账户：尚未连接</p>') +
      (s.errorCode && PAIRING_CODE_HINTS[s.errorCode] ? '<p class="muted">' + esc(PAIRING_CODE_HINTS[s.errorCode]) + '</p>' : '') +
      '<p class="muted">连接后，采购方可在目录发现本店。请本人核对配对码与公开资料，并在目录授权页确认发布。</p>' +
      (s.published ? "" : ((WORKBUDDY_ACCESS && !s.bindingId ? '<p class="muted">请在下方填写分享链接并授权，点击一次即可发起或继续连接。</p>' : '<button class="act primary" onclick="beginCatalogConnect()">发起或继续连接</button> ') +
        '<button class="act" onclick="showCatalogPairing()">本人查看配对信息</button>')) +
      ' <button class="act" onclick="refresh()">刷新连接状态</button><div id="catalog-pairing"></div></div>';
  }).catch(function () {
    return html + '<div class="card"><h2>连接 Kiwi 目录</h2><p>暂时无法读取连接状态，请稍后刷新。</p></div>';
  });
}
function accessStatusText(a) {
  if (!a) return "暂时无法读取访问配置状态";
  // 目录已有分享码，本次随绑凭据被按版本冲突跳过（目录保留原配置、不覆盖）。
  // 唯一可恢复路径是商家用权威版本显式更新，所以文案必须指向这个动作。
  if (a.statusReason === "catalog_access_exists")
    return "目录已有分享码配置，本次绑定没有覆盖它（不会用旧码顶掉已生效的码）。如需更换或启用，请重新粘贴分享链接并「提交或更新」，会按目录当前版本更新。";
  if (a.status === "active") return "已生效（配置版本 " + a.configVersion + "）";
  if (a.status === "pending" && a.statusReason === "local_staged") return "已加密暂存，请继续连接；绑定完成后由目录验证";
  if (a.status === "pending") return "已提交，等待平台校验";
  if (a.status === "invalid") return "校验未通过，请重新提交分享链接";
  if (a.status === "revoked") {
    return a.statusReason === "superseded"
      ? "已被新版本替换（旧码不再发放）"
      : "已撤回，采购方当前无法经平台网关访问";
  }
  return "未配置：WorkBuddy 上的采购方无法访问本店";
}
function appendCatalogAccess(html) {
  if (!CATALOG_CONNECT || ROLE !== "owner") return html;
  return call("GET", "/catalog/access").then(function (result) {
    var a = result.access || {};
    catalogAccessState = a;
    var firstConnect = WORKBUDDY_ACCESS && catalogConnectionState && !catalogConnectionState.bindingId && !catalogConnectionState.published;
    return html + '<div class="card"><h2>WorkBuddy 分享码（平台门禁）</h2>' +
      '<p id="access-status">' + esc(accessStatusText(a)) + '</p>' +
      (a.custodyEnabled === false
        ? '<p class="warn">目录代管当前已被运营关闭，无法新建或更新；你仍可撤回授权。</p>'
        : '') +
      '<div class="row"><input id="access-link" type="text" oninput="updateAccessButton()" autocomplete="off" spellcheck="false" aria-label="WorkBuddy 分享链接" placeholder="粘贴 WorkBuddy 分享链接">' +
      (firstConnect ? '<button class="act primary" onclick="stageAccessAndBegin()">授权并发起或继续连接</button>' : '<button id="access-submit" class="act primary" onclick="submitAccessLink()" disabled>提交或更新</button>') +
      '<button class="act" onclick="refreshAccess()">刷新状态</button>' +
      (a.consentGranted ? '<button id="access-revoke" class="act danger" onclick="revokeAccess()">撤回授权并撤销</button>' : '') + '</div>' +
      '<div class="row"><label class="consent-label"><input id="access-consent" type="checkbox" aria-label="同意分享码代管授权">' +
      ' <span>我同意 Kiwi 目录代管分享码，并按需向我已接受的采购方出示。</span></label> ' +
      '<details><summary>查看代管授权与使用说明</summary><p>分享码用于通过 WorkBuddy 网关，不是商家身份或业务授权；本页不会显示分享码。目录仅向你已接受的采购方按需出示，并按买家限流。你可随时撤回，撤回后目录会清空已保存的分享码。</p>' +
      '<p>关闭「发布为网站」后链接立即失效；删除源任务或源文件不会使分享链接失效，需要主动下线。平台不承诺分享码的固定有效期或自动轮换；换码后请重新提交。</p>' +
      '<p>分享码等价于访问凭据，平台未提供机器专用入口，网关不透传 Authorization，也不适合大规模机器自动分发。如不希望依赖此方式，可使用自托管公网入口。</p></details></div>' +
      (a.recentFaults > 0
        ? '<p class="warn">最近 24 小时有 ' + a.recentFaults +
          ' 次采购方报告门禁失败' + (a.recentFaultsLastAt ? '（最后一次 ' + esc(a.recentFaultsLastAt) + '）' : '') +
          '。请核对分享码是否已在平台侧更换或失效，必要时重新粘贴分享链接。</p>'
        : '') +
      (a.consentGranted && a.status === "active" ? '<p class="muted">目录代管授权已生效' + (a.consentTermsVersion ? '（条款 ' + esc(a.consentTermsVersion) + '）' : '') + '</p>' : '') +
      (a.authMode ? '<p class="muted">业务认证：' + esc(a.authMode) + ' · 适配版本：' + esc(a.adapterVersion || "-") + '</p>' : '') +
      '</div>' +
      '<div class="card"><h2>开放询价</h2>' +
      '<p id="public-inquiry-status" class="muted">请查询当前授权状态。</p>' +
      '<div class="row"><label class="consent-label"><input id="public-inquiry-consent" type="checkbox" aria-label="同意开放询价"> <span>我同意买家无需注册或事先批准即可通过 Kiwi 目录询价。</span></label> <details><summary>查看开放询价授权与使用说明</summary><p>允许买家无需注册、关注或商家逐个批准，通过 Kiwi 目录主动询价。询价与报价报文会经 Kiwi 目录转发给商家；目录不裁决条款、不保存磋商内容，但能读到报文明文。Kiwi 负责通过平台门禁；商家后台仍仅供管理员登录。需先完成目录连接与分享码代管。本项为单独授权，可随时关闭；关闭后停止新的开放询价。</p></details></div>' +
      '<div class="row"><button id="inquiry-submit" class="act primary" onclick="setPublicInquiry(true)" disabled>授权开放询价</button> ' +
      '<button class="act" onclick="refreshPublicInquiry()">查询授权状态</button> ' +
      '<button class="act danger" onclick="setPublicInquiry(false)">关闭开放询价</button></div></div>';
  }).catch(function () {
    return html + '<div class="card"><h2>WorkBuddy 分享码（平台门禁）</h2><p>暂时无法读取访问配置状态，请稍后刷新。</p></div>';
  });
}
function showPublicInquiryStatus(consent, notify) {
  var target = $("public-inquiry-status");
  var text = !consent || !consent.granted ? "尚未授权开放询价" :
    consent.policyActive && consent.localEnabled ? "已授权；买家接入仍需完成实际验证" : "已授权，当前尚未就绪；请检查目录连接和分享码";
  if (target) target.textContent = text;
  var button = $("inquiry-submit");
  if (button) button.disabled = !!(consent && consent.granted);
  // 后台刷新不得覆盖全局状态条（例如“已撤销”）。只有显式查询/操作才写 bar。
  if (notify !== false) bar(text, false);
}
function refreshPublicInquiry(notify) {
  var button = $("inquiry-submit"); if (button) button.disabled = true;
  return call("POST", "/catalog/public-inquiry/status", {}).then(function (result) {
    showPublicInquiryStatus(result.consent, notify);
  }).catch(function (error) {
    // 后台刷新失败同样不得覆盖全局状态条。
    if (notify !== false) bar(error && error.message ? error.message : "无法查询开放询价状态", true);
  });
}
function setPublicInquiry(granted) {
  var button = $("inquiry-submit");
  if (granted && button && button.disabled) return;
  var checkbox = $("public-inquiry-consent");
  if (granted && (!checkbox || !checkbox.checked)) { bar("请先勾选开放询价授权。", true); return; }
  if (!granted && !window.confirm("关闭后，新的买家将不能通过 Kiwi 目录向本店发起开放询价。确定关闭？")) return;
  if (button) button.disabled = true;
  return call("POST", "/catalog/public-inquiry/consent", { granted: granted, terms_version: "open-inquiry-v1" }).then(function (result) {
    if (checkbox) checkbox.checked = false;
    showPublicInquiryStatus(result.consent);
  }).catch(function () { bar("开放询价状态尚未确认，请先查询授权状态后再决定是否重试。", true); });
}
function accessSummaryBar(a, verb) {
  var target = $("access-status"); if (target) target.textContent = accessStatusText(a);
  bar(verb + "：" + accessStatusText(a), a && a.status === "invalid");
}
var accessSubmitPending = false;
function updateAccessButton() {
  var button = $("access-submit"), input = $("access-link");
  if (button) button.disabled = accessSubmitPending || !input || !String(input.value || "").trim();
}
function submitAccessLink() {
  var button = $("access-submit");
  if (button && button.disabled) return;
  var input = $("access-link");
  var consent = $("access-consent");
  var link = input ? String(input.value || "").trim() : "";
  if (!link) { bar("请先粘贴 WorkBuddy 分享链接。", true); return; }
  if (!consent || !consent.checked) {
    bar("请先勾选并同意《分享码代管授权》。", true);
    return;
  }
  accessSubmitPending = true;
  if (button) button.disabled = true;
  return call("POST", "/catalog/access/share-link", {
    link: link,
    consent_terms_version: ACCESS_CONSENT_TERMS
  }).then(function (result) {
    catalogAccessState = result.access;
    if (input) input.value = "";
    accessSubmitPending = false;
    updateAccessButton();
    if (consent) consent.checked = false;
    accessSummaryBar(result.access, "已提交");
  }).catch(function (e) {
    // 错误文本由服务端给自有码说明；不把链接回显到页面。
    // 审查 C-11：失败时保留输入框内容，允许用户核对后直接重试。
    accessSubmitPending = false;
    updateAccessButton();
    bar(e && e.message ? e.message : "提交未完成，请先刷新状态后再试。", true);
  });
}
function stageAccessAndBegin() {
  if (catalogBeginPending) return;
  var input = $("access-link");
  var consent = $("access-consent");
  var link = input ? String(input.value || "").trim() : "";
  var staged = catalogAccessState && catalogAccessState.status === "pending" && catalogAccessState.statusReason === "local_staged";
  if (!link && staged) return beginCatalogConnect();
  if (!link) { bar("请先粘贴 WorkBuddy 分享链接。", true); return; }
  if (!consent || !consent.checked) { bar("请先勾选并同意《分享码代管授权》。", true); return; }
  catalogBeginPending = true;
  return call("POST", "/catalog/access/share-link", { link: link, consent_terms_version: ACCESS_CONSENT_TERMS })
    .then(function (result) {
      catalogAccessState = result.access;
      if (input) input.value = "";
      if (consent) consent.checked = false;
      // Only a successful owner-authorized stage may advance to enrollment.
      catalogBeginPending = false;
      return beginCatalogConnect();
    }).catch(function () {
      bar("分享链接暂存未确认，请先刷新状态；确认已暂存后可继续连接。", true);
    }).finally(function () { catalogBeginPending = false; });
}
function refreshAccess() {
  call("POST", "/catalog/access/refresh", {}).then(function (result) {
    catalogAccessState = result.access;
    accessSummaryBar(result.access, "已刷新");
  }).catch(function () { bar("刷新访问配置状态失败。", true); });
}
function revokeAccess() {
  if (!window.confirm("撤回授权后：采购方将无法经 WorkBuddy 访问本店，目录会清空已保存的分享码。确定撤回？")) return;
  call("POST", "/catalog/access/revoke", {}).then(function (result) {
    catalogAccessState = result.access;
    accessSummaryBar(result.access, "已撤销");
    var button = $("access-revoke"); if (button) button.disabled = true;
    refreshPublicInquiry(false);
    refresh();
  }).catch(function () { bar("撤销未完成，请稍后重试。", true); });
}
function beginCatalogConnect() {
  if (catalogBeginPending) return;
  catalogBeginPending = true;
  try { if (!catalogBeginKey) catalogBeginKey = sessionStorage.getItem("kiwi-catalog-connect-key") || ""; } catch (_) {}
  if (!catalogBeginKey) catalogBeginKey = key("catalog-connect");
  try { sessionStorage.setItem("kiwi-catalog-connect-key", catalogBeginKey); } catch (_) {}
  return call("POST", "/catalog/connect/begin", { idempotency_key: catalogBeginKey }).then(function (receipt) {
    if (receipt.status === "succeeded") { catalogBeginKey = ""; try { sessionStorage.removeItem("kiwi-catalog-connect-key"); } catch (_) {} }
    bar(receipt.status === "succeeded" ? "连接申请已准备，请本人查看配对信息并确认公开资料。" : "连接结果尚未确认，请先查看状态，不要重复提交。");
    refresh();
  }).catch(function (error) { bar(error && error.message ? error.message : "连接申请暂未完成，请先刷新状态后再试。", true); })
    .finally(function () { catalogBeginPending = false; });
}
function showCatalogPairing() {
  return call("GET", "/catalog/connect/pairing").then(function (result) {
    var box = $("catalog-pairing");
    if (!box) return;
    var p = result.pairing;
    if (!p) { box.textContent = "当前没有待确认的配对信息，请先发起连接或刷新状态。"; return; }
    var url = new URL(p.verification_uri);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid link");
    box.innerHTML = '<p>请在目录授权页核对相同配对码：<strong>' + esc(p.user_code) + '</strong></p>' +
      '<p class="muted">有效期至 ' + esc(p.expires_at) + '。配对码请自行核对，不要发送给助手。</p>' +
      '<a target="_blank" rel="noopener noreferrer" href="' + esc(url.href) + '">前往 Kiwi 目录核对并授权</a>';
  }).catch(function () { bar("无法读取配对信息，请刷新连接状态。", true); });
}

/** 发布选择表：直接勾选已导入/已有商品并填分类，无需再手输 SKU。 */
function publicationCard(items) {
  var rows = (items || []).map(function (it) {
    var sku = esc(it.sku);
    return '<tr data-sku="' + sku + '">' +
      '<td><input type="checkbox" class="pub-pick" aria-label="选择商品 ' + sku + '"></td>' +
      '<td>' + sku + '</td><td>' + esc(it.title) + '</td><td>' + esc(it.status || "-") + '</td>' +
      '<td><input type="text" class="pub-category" maxlength="120" placeholder="填写分类" aria-label="' + sku + ' 的分类"></td></tr>';
  }).join("");
  var body = rows
    ? '<div class="row"><input type="text" id="pub-category-all" maxlength="120" placeholder="统一分类（可选）" aria-label="统一分类">' +
      '<button class="act" id="pub-apply" onclick="applyPublicationCategory()">应用到已勾选</button>' +
      '<button class="act" id="pub-clear" onclick="clearPublicationPicks()">清空选择</button></div>' +
      '<div class="table-scroll"><table id="pub-table"><tr><th>选择</th><th>SKU</th><th>名称</th><th>状态</th><th>分类（必填）</th></tr>' +
      '<tbody id="pub-rows">' + rows + '</tbody></table></div>' +
      '<p class="muted">公开名称、SKU、分类、商品页链接与其余公开字段；价格、库存及私有规则不会发布。' +
      '可发布已导入或已有商品，不涉及下架其他商品。预览后选择会锁定，修改需先「重新选择」。</p>' +
      '<button class="act" id="pub-preview" onclick="previewPublication()">预览公开内容</button>'
    : '<p class="muted">暂无商品，请先在上方导入商品后再选择发布。</p>';
  return '<div class="card"><h2>发布商品到 Kiwi 目录</h2>' +
    '<p class="muted">先完成目录连接，再勾选要公开的商品并填写分类；预览确认后才发布。</p>' + body +
    '<div id="publication-result"></div></div>';
}
function applyPublicationCategory() {
  if (publicationDraft !== null) { bar("预览已生成，选择已锁定；如需修改请先点「重新选择」", true); return; }
  var all = $("pub-category-all");
  var category = all ? String(all.value || "").trim() : "";
  if (!category) { bar("请先填写统一分类", true); return; }
  var rows = document.querySelectorAll("#pub-rows tr");
  for (var i = 0; i < rows.length; i++) {
    var box = rows[i].querySelector("input.pub-pick");
    var input = rows[i].querySelector("input.pub-category");
    if (box && box.checked && input) input.value = category;
  }
}
function clearPublicationPicks() {
  if (publicationDraft !== null) { bar("预览已生成，选择已锁定；如需修改请先点「重新选择」", true); return; }
  var rows = document.querySelectorAll("#pub-rows tr");
  for (var i = 0; i < rows.length; i++) {
    var box = rows[i].querySelector("input.pub-pick");
    var input = rows[i].querySelector("input.pub-category");
    if (box) box.checked = false;
    if (input) input.value = "";
  }
}
function lockPublicationSelection(locked) {
  var rows = document.querySelectorAll("#pub-rows tr");
  for (var i = 0; i < rows.length; i++) {
    var box = rows[i].querySelector("input.pub-pick");
    var input = rows[i].querySelector("input.pub-category");
    if (box) box.disabled = locked;
    if (input) input.disabled = locked;
  }
  var all = $("pub-category-all");
  if (all) all.disabled = locked;
  var apply = $("pub-apply");
  if (apply) apply.disabled = locked;
  var clear = $("pub-clear");
  if (clear) clear.disabled = locked;
}
function samePublicationPicks(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].sku !== b[i].sku || a[i].category !== b[i].category) return false;
  }
  return true;
}
function resetPublication() {
  publicationDraft = null;
  publicationPicks = null;
  lockPublicationSelection(false);
  var result = $("publication-result");
  if (result) result.innerHTML = "";
  bar("已作废本次预览，可重新选择商品与分类");
}
/** 只接受 http(s)、无凭据的公开链接；文本与 href 都转义。 */
function publicLink(value) {
  if (typeof value !== "string" || value === "") return "-";
  var url;
  try { url = new URL(value); } catch (e) { return "-"; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return "-";
  return '<a href="' + esc(url.href) + '" target="_blank" rel="noopener noreferrer">查看商品页</a>';
}
/** 其余公开字段白名单（不渲染 owner/merchant 等内部标识）。 */
function publicFieldText(listing) {
  var parts = [];
  if (listing.summary) parts.push("摘要：" + listing.summary);
  if (listing.brand) parts.push("品牌：" + listing.brand);
  if (Array.isArray(listing.regions) && listing.regions.length) parts.push("区域：" + listing.regions.join("、"));
  if (Array.isArray(listing.tags) && listing.tags.length) parts.push("标签：" + listing.tags.join("、"));
  var hints = listing.commercial_hints;
  if (hints && typeof hints === "object") {
    if (hints.moq != null) parts.push("起订量：" + hints.moq);
    if (hints.price_range_hint) parts.push("价格区间提示：" + hints.price_range_hint);
    if (hints.availability_hint) parts.push("可供货提示：" + hints.availability_hint);
    if (hints.lead_time_hint) parts.push("交期提示：" + hints.lead_time_hint);
    if (hints.supports_bulk_quote === true) parts.push("支持批量报价");
    if (hints.supports_customization === true) parts.push("支持定制");
    if (Array.isArray(hints.fulfillment_regions) && hints.fulfillment_regions.length) parts.push("履约区域：" + hints.fulfillment_regions.join("、"));
  }
  if (Array.isArray(listing.handoff_destination_types) && listing.handoff_destination_types.length) {
    parts.push("交易方式：" + listing.handoff_destination_types.join("、"));
  }
  if (!parts.length) return "-";
  return parts.map(function (part) { return esc(part); }).join("<br>");
}
function publicationSelections() {
  var rows = document.querySelectorAll("#pub-rows tr");
  var selections = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var box = row.querySelector("input.pub-pick");
    if (!box || !box.checked) continue;
    var sku = String(row.getAttribute("data-sku") || "").trim();
    var input = row.querySelector("input.pub-category");
    var category = input ? String(input.value || "").trim() : "";
    if (!sku) { bar("商品行缺少 SKU，请刷新页面后重试", true); return null; }
    if (!category) { bar("请为已勾选的商品填写分类：" + sku, true); return null; }
    selections.push({ sku: sku, category: category });
  }
  if (!selections.length) { bar("请先勾选要公开的商品", true); return null; }
  return selections;
}
function renderPublicationReceipts(receipts, heading, counts) {
  var rows = (receipts || []).map(function (r) {
    var label = r.status === "succeeded" ? "已确认" : r.status === "pending" ? "待确认" : "失败";
    return "<tr><td>" + esc(r.sku) + "</td><td>" + esc(label) + "</td><td>" + esc(r.code || r.listing_id || "-") + "</td></tr>";
  }).join("");
  return "<h3>" + esc(heading) + "</h3>" + (counts ? "<p>" + esc(counts) + "</p>" : "") +
    '<div class="table-scroll"><table><tr><th>SKU</th><th>结果</th><th>说明</th></tr>' + rows + "</table></div>";
}
/** 商品页统一渲染：全部已加载商品（含分页）与准确数量。 */
function renderProducts(items) {
  var list = items || [];
  var rows = list.map(function (it) {
    if (FILE_PRODUCTS) {
      return "<tr><td>" + esc(it.sku) + "</td><td>" + esc(it.title) + "</td><td>" +
        esc(it.currency) + " " + esc(it.price) + " / " + esc(it.price_unit) + "</td><td>" +
        esc(it.min_order_qty == null ? "-" : it.min_order_qty) + "</td><td>" +
        esc(it.valid_until) + "</td><td>" + esc(it.status) + "</td><td>" +
        esc(({jd:"京东",taobao:"淘宝",tmall:"天猫"})[it.trade_platform] || "-") + "</td><td>" +
        esc(it.platform_product_id || "-") + "</td><td>" + marketplaceLink(it) + "</td></tr>";
    }
    var money = it.money || {};
    return "<tr><td>" + esc(it.sku) + "</td><td>" + esc(it.title) + "</td><td>" +
      esc(money.currency || "-") + " " + esc(money.amount_minor == null ? "-" : money.amount_minor) +
      "（最小币单位）</td><td>" + esc(it.stock == null ? "-" : it.stock) + "</td><td>" +
      esc(it.authority_version == null ? "-" : it.authority_version) + "</td></tr>";
  }).join("");
  return '<div class="card"><h2>当前商品（' + list.length + "）</h2>" +
    (rows ? (FILE_PRODUCTS
      ? "<table><tr><th>SKU</th><th>名称</th><th>单价</th><th>起订量</th><th>有效期至</th><th>状态</th><th>交易平台</th><th>平台商品ID</th><th>平台商品页链接</th></tr>"
      : "<table><tr><th>SKU</th><th>名称</th><th>价格（最小币单位）</th><th>库存</th><th>版本</th></tr>") + rows + "</table>"
          : '<p class="muted">暂无商品，请先导入商品。没有商品时服务不会报价或发布名片。</p>') + "</div>" +
    '<div class="card"><h2>导入商品表（整表替换）</h2>' +
    '<p class="muted">交易链接仅为平台商品页；是否成交、实际价格与付款结果由交易平台确认。</p>' +
    '<p class="muted">支持 CSV、Excel（.xlsx）与商品表 JSON：先转换校验、预览增/改/留/删，确认后整批生效（不成功的批次不改动现有商品）。</p>' +
    '<p class="muted">模板：<a href="/merchant/api/v1/products/import-template?format=csv" download="kiwi-product-import-template.csv">下载 CSV 模板</a> · <a href="/merchant/api/v1/products/import-template?format=xlsx" download="kiwi-product-import-template.xlsx">下载 Excel 模板</a>（中文表头与示例行；中英文常见列名会自动识别）。</p>' +
    '<div class="row"><input type="file" id="pfile" aria-label="选择商品导入文件" accept=".json,.csv,.xlsx">' +
    '<button class="act" onclick="previewImport()">校验预览</button></div><div id="presult"></div></div>' +
    (FILE_PRODUCTS && CATALOG_CONNECT && ROLE === "owner" ? publicationCard(list) : '');
}
var views = {
  status: function () {
    return call("GET", "/runtime/status").then(function (s) {
      var failed = s.readiness && s.readiness.failed_checks || [];
      var html = '<div class="card"><h2>运行状态</h2><table>' +
        "<tr><th>商家显示名</th><td>" + esc(s.merchant_name || "-") + "</td></tr>" +
        "<tr><th>服务状态</th><td>" + statePill(s.service_state) + "</td></tr>" +
        "<tr><th>部署代次</th><td>" + esc(s.generation) + "</td></tr>" +
        "<tr><th>Runtime</th><td>" + esc(s.runtime_version) + "（管理 API v" + esc(s.api_version) + "）</td></tr>" +
        "<tr><th>就绪</th><td>" + (s.readiness && s.readiness.ready
          ? '<span class="pill ok">就绪</span>'
          : '<span class="pill bad">未就绪</span> ' + esc(failed.join("、"))) + "</td></tr>" +
        "<tr><th>能力</th><td>管理页 " + (s.capabilities.management_page ? "✓" : "✗") +
        "；对话工具 " + (s.capabilities.dialog_tools ? "✓" : "未启用") + "</td></tr>" +
        '</table><p class="muted">更新于 ' + esc(s.observed_at) + "</p>";
      if (s.merchant_name_needs_update) {
        html += '<p class="muted">请设置商家显示名；该名称会用于 Catalog 公开资料。</p>';
      }
      if (failed.indexOf("PRODUCTS_NOT_CONFIGURED") >= 0) {
        html += '<p class="muted">请先导入商品。商品导入后会自动继续服务检查；当前不会报价或发布名片。</p>';
      }
      if (s.service_state === "OPERATING") {
        html += '<div class="row"><button class="act danger" onclick="pauseService()">暂停接待</button>' +
          '<span class="muted">暂停后拒新询价；既有会话不受影响。</span></div>';
      } else if (s.service_state === "PAUSED") {
        if (ROLE === "owner") {
          html += '<div class="row"><button class="act primary" onclick="resumeService()">恢复接待</button>' +
            '<span class="muted">恢复需通过就绪检查（owner）。</span></div>';
        } else {
          html += '<p class="muted">恢复接待需要 owner 角色。</p>';
        }
      }
      return appendCatalogConnection(html + "</div>").then(appendCatalogAccess);
    });
  },
  products: function () {
    // 云端导入表与 exact 商品库是不同权威源；按装配选择，不能把空 exact 库当作导入失败。
    // 商品可能超过 100 件：跟随 next_cursor 拉全量，保证全部可选、计数准确。
    var base = FILE_PRODUCTS ? "/merchant/api" : API;
    var items = [];
    function loadPage(cursor, page) {
      var path = "/products?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      return call("GET", path, undefined, base).then(function (p) {
        items = items.concat(p.items || []);
        var next = p.next_cursor;
        if (typeof next === "string" && next !== "" && page < 50) return loadPage(next, page + 1);
        return renderProducts(items);
      });
    }
    return loadPage("", 0);
  },
  approvals: function () {
    return call("GET", "/approvals").then(function (p) {
      var rows = (p.items || []).map(function (it) {
        return "<tr><td>" + esc(it.candidate_id) + "</td><td>" + esc(it.summary) + "</td><td>" +
          '<span class="pill warn">' + esc(it.status) + "</span></td><td>" + esc(it.expires_at) + "</td>" +
          '<td><pre class="digest">' + esc(it.arguments_hash) + "</pre></td>" +
          '<td><button class="act primary" onclick="decide(\\'' + esc(it.candidate_id) + '\\',true)">批准</button> ' +
          '<button class="act danger" onclick="decide(\\'' + esc(it.candidate_id) + '\\',false)">拒绝</button></td></tr>';
      }).join("");
      return '<div class="card"><h2>待审批（' + (p.items || []).length + "）</h2>" +
        (rows ? "<table><tr><th>候选</th><th>内容</th><th>状态</th><th>有效期</th><th>参数摘要</th><th>操作</th></tr>" + rows + "</table>"
              : '<p class="muted">暂无待审批请求。</p>') +
        '<p class="muted">批准/拒绝只在本页完成；对话里的“同意”不构成批准。</p></div>';
    });
  },
  negotiations: function () {
    var qs = "/negotiations?limit=20&status=" + encodeURIComponent(NEG_STATUS) +
      (NEG_CURSOR ? "&cursor=" + encodeURIComponent(NEG_CURSOR) : "");
    return call("GET", qs).then(function (page) {
      if (NEG_OPEN) return negotiationDetail(NEG_OPEN);
      var filters = [["all", "全部"], ["active", "进行中"], ["agreement", "已达成"]].map(function (f) {
        return '<button class="act' + (NEG_STATUS === f[0] ? " primary" : "") + '" onclick="setNegStatus(\\'' + f[0] + '\\')">' + f[1] + "</button>";
      }).join(" ");
      var rows = (page.items || []).map(function (it) {
        return "<tr><td>" + esc(it.recorded_at) + "</td><td>" + esc(it.negotiation_id) + "</td>" +
          "<td>" + phasePill(it.phase, it.agreement) + "</td><td>" + esc(it.sku || "-") + "</td>" +
          "<td>" + esc(it.quantity == null ? "-" : it.quantity) + "</td>" +
          "<td>" + esc(it.price_minor == null ? "-" : it.price_minor) + "</td>" +
          "<td>" + (it.needs_attention ? '<span class="pill warn">待回应</span>' : '<span class="muted">—</span>') + "</td>" +
          '<td><button class="act" onclick="openNegotiation(\\'' + esc(it.negotiation_id) + '\\')">查看时间线</button></td></tr>';
      }).join("");
      var pager = '<div class="row" style="margin-top:8px">' +
        (NEG_CURSOR ? '<button class="act" onclick="negPage(\\'\\')">上一页</button>' : "") +
        (page.next_cursor ? '<button class="act" onclick="negPage(\\'' + esc(page.next_cursor) + '\\')">下一页</button>' : "") +
        '<span class="muted">共 ' + (page.total == null ? "-" : page.total) + " 条</span></div>";
      return '<div class="card"><h2>会话旁观（只读）</h2>' +
        '<div class="row" style="margin-bottom:8px">' + filters + "</div>" +
        (rows ? "<table><tr><th>最近活动</th><th>磋商</th><th>相位</th><th>SKU</th><th>数量</th><th>单价（最小币单位）</th><th>待回应</th><th>操作</th></tr>" + rows + "</table>"
              : '<p class="muted">当前过滤条件下没有磋商记录。</p>') + pager +
        '<p class="muted">本页仅旁观：不能在这里向买家发送消息；回复都在接待会话内完成。买家只以协议身份出现，不展示私密联系方式。</p></div>';
    });
  },
  reports: function () {
    var periods = [["day", "今日"], ["week", "本周"], ["month", "本月"]].map(function (p) {
      return '<button class="act' + (REP_PERIOD === p[0] ? " primary" : "") + '" onclick="setRepPeriod(\\'' + p[0] + '\\')">' + p[1] + "</button>";
    }).join(" ");
    return call("GET", "/reports?period=" + encodeURIComponent(REP_PERIOD)).then(function (r) {
      var names = {
        distinct_buyers: "去重买家数",
        contact_events: "询价/触达事件",
        negotiations: "磋商数",
        agreements_reached: "达成非绑定协议",
        human_escalations: "进入人工处理",
      };
      var rows = Object.keys(names).map(function (key) {
        var m = (r.metrics || {})[key] || {};
        if (!m.available) {
          return "<tr><th>" + names[key] + "</th><td>" + esc(UNAVAILABLE_LABEL) +
            '</td><td class="muted">' + esc(unavailableReason(m.reason)) + "</td><td>-</td></tr>";
        }
        var pct = m.change_pct == null ? "-" : (m.change_pct > 0 ? "+" : "") + m.change_pct + "%";
        var delta = m.delta > 0 ? "+" + m.delta : String(m.delta);
        return "<tr><th>" + names[key] + "</th><td>" + esc(m.value) + "</td><td>" + esc(m.previous) +
          "</td><td>" + esc(delta) + "（" + esc(pct) + "）</td></tr>";
      }).join("");
      var skuRows = (r.top_skus || []).map(function (s) {
        return "<tr><td>" + esc(s.sku) + "</td><td>" + esc(s.contact_events) + "</td><td>" +
          esc(s.distinct_buyers) + "</td><td>" + esc(s.negotiations) + "</td></tr>";
      }).join("");
      var terms = (r.recent_inquiry_terms || []).map(function (t) {
        return "<tr><td>" + esc(t.token) + "</td><td>" + esc(t.count) + "</td></tr>";
      }).join("");
      var trend = (r.series || []).map(function (p) {
        var max = 1;
        (r.series || []).forEach(function (q) { if (q.contact_events > max) max = q.contact_events; });
        var w = Math.round((p.contact_events / max) * 100);
        return '<div class="trendrow"><span class="muted">' + esc(p.day.slice(5)) + "</span>" +
          '<div class="trendbar"><div class="trendfill" style="width:' + w + '%"></div></div>' +
          "<span>" + esc(p.contact_events) + "</span></div>";
      }).join("");
      return '<div class="card"><h2>运营报告</h2><div class="row" style="margin-bottom:8px">' + periods + "</div>" +
        '<p class="muted">窗口 ' + esc(r.window && r.window.since) + " 至 " + esc(r.window && r.window.until_exclusive) +
        "（UTC）；对比上一周期 " + esc(r.previous_window && r.previous_window.since) + " 至 " +
        esc(r.previous_window && r.previous_window.until_exclusive) + "。</p>" +
        "<table><tr><th>指标</th><th>本周期</th><th>上一周期</th><th>变化</th></tr>" + rows + "</table>" +
        '<p class="muted">「进入人工处理」= 磋商进入澄清等待或生成人工交接候选；非绑定协议按账本 AGREEMENT_REACHED 事实统计。</p></div>' +
        '<div class="card"><h2>SKU 热度 Top 10</h2>' +
        (skuRows ? "<table><tr><th>SKU</th><th>触达</th><th>去重买家</th><th>磋商</th></tr>" + skuRows + "</table>"
                 : '<p class="muted">' + esc(UNAVAILABLE_LABEL) + "（没有触达统计数据）</p>") + "</div>" +
        '<div class="card"><h2>最近询价关键词（原文计数）</h2>' +
        (terms ? "<table><tr><th>问题 code</th><th>次数</th></tr>" + terms + "</table>"
               : '<p class="muted">当前窗口没有询价问题记录。</p>') +
        '<p class="muted">仅统计买家询价问题 code 原文出现次数；主题归纳（LLM）属后续工作。</p></div>' +
        '<div class="card"><h2>触达趋势（按日）</h2>' +
        (trend || '<p class="muted">' + esc(UNAVAILABLE_LABEL) + "</p>") + "</div>";
    });
  },
  policy: function () {
    return call("GET", "/policy").then(function (pol) {
      return '<div class="card"><h2>当前报价规则</h2><table>' +
        "<tr><th>规则版本</th><td>" + esc(pol.policy_revision) + "</td></tr>" +
        '<tr><th>内容摘要</th><td><pre class="digest">' + esc(pol.digest) + "</pre></td></tr></table>" +
        '<p class="muted">底价等敏感值不出现在本页接口；提交草稿后由系统校验并原子生效。</p></div>' +
        (ROLE === "owner" || ROLE === "operator"
          ? '<div class="card"><h2>常用规则表单</h2>' +
            '<p class="muted">留空的字段不会写进补丁（不修改现有值）；当前值因隐私不回显。提交后生成规则变更草稿，再确认才生效。</p>' +
            '<table>' +
            '<tr><th>自动应价</th><td><select id="pf-auto"><option value="">不修改</option><option value="on">开启</option><option value="off">关闭</option></select>' +
            '<span class="muted">关闭后新询价转人工处理</span></td></tr>' +
            '<tr><th>全局最低单价（元）</th><td><input type="text" id="pf-floor" placeholder="留空不修改"></td></tr>' +
            '<tr><th>最大自动折扣（%）</th><td><input type="text" id="pf-discount" placeholder="0–100，留空不修改"></td></tr>' +
            '<tr><th>交期承诺（天）</th><td><input type="text" id="pf-lead" placeholder="正数，留空不修改"></td></tr>' +
            '<tr><th>报价有效期（秒）</th><td><input type="text" id="pf-ttl" placeholder="正数，留空不修改"></td></tr>' +
            '<tr><th>SKU 规则</th><td>' +
            '<table id="pf-sku-rules"><thead><tr><th>SKU</th><th>常态折扣（%）</th><th>私有底价（元）</th><th></th></tr></thead><tbody></tbody></table>' +
            '<button class="act" type="button" onclick="addSkuRuleRow()">添加 SKU 规则</button>' +
            '<span class="muted">提交时与现有 SKU 规则合并，不会清掉未列出的 SKU。</span></td></tr>' +
            '<tr><th>超出范围转人工</th><td><span class="row">' +
            '<label><input type="checkbox" id="pf-hr-below" checked> 低于底价</label>' +
            '<label><input type="checkbox" id="pf-hr-warranty"> 特殊售后条款</label>' +
            '<label><input type="checkbox" id="pf-hr-suspicious"> 可疑内容</label></span>' +
            '<select id="pf-hr"><option value="">不修改</option><option value="set">按左侧勾选设置</option></select></td></tr>' +
            "</table>" +
            '<div class="row" style="margin-top:8px"><button class="act primary" onclick="draftPolicyForm()">生成规则草稿</button>' +
            '<span class="muted">SKU 规则可在上方表格填写；促销与库存来源仍用下方高级模式。</span></div><div id="polformresult"></div></div>' +
            '<div class="card"><h2>高级：JSON patch 模式</h2>' +
            '<p class="muted">适合 per-SKU 底价/折扣映射、促销与库存来源等完整 patch；字段名以策略 schema 文档为准，不在页面枚举。</p>' +
            '<textarea id="patch" rows="8" aria-label="高级规则 JSON patch"></textarea>' +
            '<div class="row" style="margin-top:8px"><button class="act" onclick="draftPolicy()">保存草稿</button>' +
            '<span class="muted">保存后生成草稿摘要，再点提交才生效。</span></div><div id="polresult"></div></div>'
          : '<div class="card"><p class="muted">规则调整需要 operator/owner 角色。</p></div>');
    });
  },
  operating: function () {
    return call("GET", "/operating-plans").then(function (p) {
      var plans = p.plans || [];
      var rows = plans.map(function (plan) {
        return "<tr><td>" + esc(plan.sku) + "</td><td>" + esc(plan.source) + " / " + esc(plan.source_account_id) + "</td><td>" +
          '<span class="pill ' + (plan.status === "ACTIVE" ? "ok" : "warn") + '">' + esc(plan.status) + "</span></td><td>" +
          esc(plan.effective_from) + " ~ " + esc(plan.effective_to || "长期") + "</td><td>" +
          esc(plan.authorization && plan.authorization.owner || "-") + "</td><td>" + esc(plan.revision) + "</td></tr>";
      }).join("");
      return '<div class="card"><h2>商品经营（' + plans.length + '）</h2>' +
        '<p class="muted">经营计划绑定商品、适用条件、授权与生效区间；暂停只撤销执行资格，不释放区间。</p>' +
        (rows ? "<table><tr><th>SKU</th><th>来源 / 账户</th><th>状态</th><th>生效区间</th><th>负责人</th><th>版本</th></tr>" + rows + "</table>"
          : '<p class="muted">暂无经营计划。先在 API 创建计划，再开始接收该商品的需求。</p>') + "</div>" +
        (ROLE === "owner" ? '<div class="card"><h2>新建经营计划</h2>' +
          '<p class="muted">首版表单只覆盖计划身份与生效区间；条件/动作/授权以 JSON 提交，字段在 M0 冻结。</p>' +
          '<textarea id="plan-json" rows="6" aria-label="经营计划 JSON"></textarea>' +
          '<div class="row" style="margin-top:8px"><button class="act primary" onclick="createPlan()">创建计划</button></div><div id="plan-result"></div></div>' : "");
    });
  },
  sales: function () {
    return Promise.all([call("GET", "/opportunities"), call("GET", "/followups")]).then(function (r) {
      var opportunities = r[0].opportunities || [];
      var followups = r[1].followups || [];
      var oppRows = opportunities.map(function (o) {
        return "<tr><td>" + esc(o.opportunity_id) + "</td><td>" + esc(o.status) + "</td><td>" +
          esc(o.owner) + "</td><td>" + esc(o.next_action || "—") + "</td><td>" +
          esc(o.next_action_due_at || "—") + "</td><td>" + esc(o.waiting_reason || "—") + "</td></tr>";
      }).join("");
      var fuRows = followups.map(function (f) {
        return "<tr><td>" + esc(f.task_id) + "</td><td>" + esc(f.action_type) + "</td><td>" +
          esc(f.status) + "</td><td>" + esc(f.due_at || "—") + "</td><td>" +
          esc(f.attempts + " / " + f.max_attempts) + "</td></tr>";
      }).join("");
      return '<div class="card"><h2>待处理机会（' + opportunities.length + '）</h2>' +
        (oppRows ? "<table><tr><th>机会</th><th>状态</th><th>负责人</th><th>下一动作</th><th>到期</th><th>等待原因</th></tr>" + oppRows + "</table>"
          : '<p class="muted">暂无机会。人工录入或真实入口进入后会出现在这里。</p>') + "</div>" +
        '<div class="card"><h2>跟进任务（' + followups.length + '）</h2>' +
        '<p class="muted">P0 产物是商家待办与草稿；没有可靠客户通道时不会自动外发。</p>' +
        (fuRows ? "<table><tr><th>任务</th><th>动作</th><th>状态</th><th>到期</th><th>尝试</th></tr>" + fuRows + "</table>"
          : '<p class="muted">暂无跟进任务。</p>') + "</div>";
    });
  },
  outcomes: function () {
    return call("GET", "/orders").then(function (p) {
      var orders = p.orders || [];
      var rows = orders.map(function (o) {
        return "<tr><td>" + esc(o.record_id) + "</td><td>" + esc(o.source_namespace) + " / " + esc(o.external_order_id) + "</td><td>" +
          '<span class="pill ' + (o.evidence_source === "external_verified" ? "ok" : "warn") + '">' + esc(o.evidence_source) + "</span></td><td>" +
          esc(o.payment_status || "—") + "</td><td>" + esc(o.fulfillment_status || "—") + "</td><td>" +
          esc(o.observed_at || "—") + "</td></tr>";
      }).join("");
      return '<div class="card"><h2>经营结果（' + orders.length + '）</h2>' +
        '<p class="muted">订单存在、证据来源、归因与贡献分开呈现；人工申报不会自动升级为外部已核实。</p>' +
        (rows ? "<table><tr><th>订单</th><th>来源 / 外部ID</th><th>证据</th><th>支付</th><th>履约</th><th>观察时间</th></tr>" + rows + "</table>"
          : '<div class="empty-state"><p>尚未记录订单。</p><p class="muted">人工/CSV 申报可用；真实外部订单源需 M0 冻结 SourceContract 后接入。</p></div>') +
        "</div>" +
        (ROLE === "owner" || ROLE === "operator"
          ? '<div class="card"><h2>记录人工订单申报</h2>' +
            '<p class="muted">申报只写人工证据；外部核验需受信来源返回有效事实。</p>' +
            '<textarea id="order-json" rows="6" aria-label="订单申报 JSON"></textarea>' +
            '<div class="row" style="margin-top:8px"><button class="act primary" onclick="submitOrderReport()">记录申报</button></div><div id="order-result"></div></div>'
          : "");
    });
  },
};

</script>
<script>
/* 暂停/恢复与规则/导入/审批的命令实现。 */
function currentRevision(cb) {
  call("GET", "/runtime/status").then(cb).catch(function (e) { bar(e.message, true); });
}
/* 商品经营：首版只接受完整 JSON；字段枚举在 M0 冻结，页面不替商家猜。 */
function submitOrderReport() {
  var raw = $("order-json").value;
  var body;
  try { body = JSON.parse(raw); } catch (e) { bar("订单申报 JSON 无效", true); return; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { bar("订单申报必须是 JSON 对象", true); return; }
  call("POST", "/orders/reports", body).then(function (order) {
    $("order-result").innerHTML = '<pre class="digest">' + esc(order.record_id) + " · " + esc(order.evidence_source) + "</pre>";
    bar("订单申报已记录（人工证据）");
    refresh();
  }).catch(function (e) { bar(e.message, true); });
}
function createPlan() {
  var raw = $("plan-json").value;
  var body;
  try { body = JSON.parse(raw); } catch (e) { bar("经营计划 JSON 无效", true); return; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { bar("经营计划必须是 JSON 对象", true); return; }
  body.idempotency_key = key("plan");
  call("POST", "/operating-plans", body).then(function (plan) {
    $("plan-result").innerHTML = '<pre class="digest">' + esc(plan.plan_id) + "</pre>";
    bar("经营计划已创建");
    refresh();
  }).catch(function (e) { bar(e.message, true); });
}
/* 会话旁观 / 运营报告的视图状态（只读；不能从这里发消息）。 */
var NEG_STATUS = "all";
var NEG_CURSOR = "";
var NEG_OPEN = null;
var REP_PERIOD = "day";
var UNAVAILABLE_LABEL = "不可得";
function unavailableReason(reason) {
  return {
    merchant_stats_unavailable: "没有买家触达统计数据（stats.sqlite 不存在）",
    negotiation_ledger_unavailable: "磋商账本不可读",
  }[reason] || "数据源未配置";
}
function phasePill(phase, agreement) {
  if (agreement) return '<span class="pill ok">已达成</span>';
  var map = {
    OPEN: ["", "开放"], AWAITING_CLARIFICATION: ["warn", "澄清等待"],
    OFFER_OPEN: ["", "报价中"], DECLINED: ["bad", "已婉拒"],
    WITHDRAWN: ["bad", "已撤回"], CANCELLED: ["bad", "已取消"], EXPIRED: ["warn", "已过期"],
  };
  var it = map[phase] || ["warn", phase];
  return it[0] ? '<span class="pill ' + it[0] + '">' + esc(it[1]) + "</span>" : '<span class="pill">' + esc(it[1]) + "</span>";
}
function setNegStatus(status) { NEG_STATUS = status; NEG_CURSOR = ""; NEG_OPEN = null; refresh(); }
function negPage(cursor) { NEG_CURSOR = cursor; refresh(); }
function openNegotiation(id) { NEG_OPEN = id; refresh(); }
function closeNegotiation() { NEG_OPEN = null; refresh(); }
function negotiationDetail(id) {
  return call("GET", "/negotiations/" + encodeURIComponent(id)).then(function (d) {
    var entries = (d.timeline || []).map(function (e) {
      var who = e.direction === "buyer" ? '<span class="pill">买家</span>'
        : e.direction === "merchant" ? '<span class="pill">商家</span>'
        : '<span class="muted">系统</span>';
      var rule = e.rule_summary ? esc(e.rule_summary) : '<span class="muted">' + UNAVAILABLE_LABEL + "</span>";
      return "<tr><td>" + esc(e.at) + "</td><td>" + who + "</td><td>" + esc(e.action) + "</td>" +
        "<td>" + esc(e.summary) + "</td><td>" + rule + "</td>" +
        "<td>" + (e.manual_review ? '<span class="pill warn">转人工</span>' : "—") + "</td></tr>";
    }).join("");
    return '<div class="card"><h2>磋商 ' + esc(d.negotiation_id) + "（时间线）</h2>" +
      '<button class="act" onclick="closeNegotiation()">← 返回列表</button>' +
      "<table><tr><th>相位</th><td>" + phasePill(d.phase, d.agreement) + "</td></tr>" +
      "<tr><th>SKU</th><td>" + esc(d.sku || "-") + "</td></tr>" +
      "<tr><th>数量</th><td>" + esc(d.quantity == null ? "-" : d.quantity) + "</td></tr>" +
      "<tr><th>最新单价（最小币单位）</th><td>" + esc(d.price_minor == null ? "-" : d.price_minor) + "</td></tr>" +
      "<tr><th>买家（协议身份）</th><td>" + esc(d.buyer_ref) + "</td></tr>" +
      "<tr><th>最近活动</th><td>" + esc(d.recorded_at) + "</td></tr></table>" +
      (entries
        ? "<table style=\\"margin-top:10px\\"><tr><th>时间</th><th>方向</th><th>动作</th><th>内容</th><th>规则依据</th><th>人工</th></tr>" + entries + "</table>"
        : '<p class="muted">账本中没有消息事件。</p>') +
      '<p class="muted">「规则依据」不可得 = 账本未记录该步的规则事实；规则数值属私有数据，不在旁观视图展示。本页只读。</p></div>';
  });
}
function setRepPeriod(period) { REP_PERIOD = period; refresh(); }
function numberOrUndefined(raw) {
  var trimmed = String(raw == null ? "" : raw).trim();
  if (trimmed === "") return undefined;
  var value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}
function addSkuRuleRow() {
  var body = document.querySelector("#pf-sku-rules tbody");
  if (!body) return;
  var tr = document.createElement("tr");
  function addInput(cls, placeholder) {
    var input = document.createElement("input");
    input.type = "text";
    input.className = cls;
    input.placeholder = placeholder;
    var td = document.createElement("td");
    td.appendChild(input);
    tr.appendChild(td);
  }
  addInput("sku-rule-sku", "SKU");
  addInput("sku-rule-discount", "0–100");
  addInput("sku-rule-floor", "元");
  var td = document.createElement("td");
  var remove = document.createElement("button");
  remove.className = "act";
  remove.type = "button";
  remove.textContent = "删除";
  remove.addEventListener("click", function () { tr.remove(); });
  td.appendChild(remove);
  tr.appendChild(td);
  body.appendChild(tr);
}
function readSkuRules() {
  var rows = document.querySelectorAll("#pf-sku-rules tbody tr");
  var rules = [];
  var seen = {};
  for (var i = 0; i < rows.length; i += 1) {
    var skuEl = rows[i].querySelector(".sku-rule-sku");
    var discountEl = rows[i].querySelector(".sku-rule-discount");
    var floorEl = rows[i].querySelector(".sku-rule-floor");
    var sku = skuEl ? String(skuEl.value || "").trim() : "";
    var discountRaw = discountEl ? String(discountEl.value || "").trim() : "";
    var floorRaw = floorEl ? String(floorEl.value || "").trim() : "";
    if (sku === "" && discountRaw === "" && floorRaw === "") continue;
    if (sku === "") { bar("SKU 规则：SKU 不能为空", true); return null; }
    if (seen[sku]) { bar("SKU 规则：SKU 重复：" + sku, true); return null; }
    seen[sku] = true;
    var rule = { sku: sku };
    if (discountRaw !== "") {
      var discount = Number(discountRaw);
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
        bar("SKU 规则：" + sku + " 的常态折扣须在 0–100 之间", true);
        return null;
      }
      rule.discount = discount;
    }
    if (floorRaw !== "") {
      var floor = Number(floorRaw);
      if (!Number.isFinite(floor) || floor < 0) {
        bar("SKU 规则：" + sku + " 的底价须为非负数字（元）", true);
        return null;
      }
      rule.floor = floor;
    }
    if (rule.discount === undefined && rule.floor === undefined) {
      bar("SKU 规则：" + sku + " 至少填写折扣或底价", true);
      return null;
    }
    rules.push(rule);
  }
  return rules;
}
function draftPolicyForm() {
  var form = {};
  var auto = $("pf-auto") ? $("pf-auto").value : "";
  if (auto === "on" || auto === "off") form.auto = auto;
  var floor = numberOrUndefined($("pf-floor") && $("pf-floor").value);
  if (floor !== undefined) {
    if (Number.isNaN(floor) || floor < 0) { bar("最低单价须为非负数字（元）", true); return; }
    form.floor = floor;
  }
  var discount = numberOrUndefined($("pf-discount") && $("pf-discount").value);
  if (discount !== undefined) {
    if (Number.isNaN(discount) || discount < 0 || discount > 100) { bar("最大折扣须在 0–100 之间", true); return; }
    form.discount = discount;
  }
  var lead = numberOrUndefined($("pf-lead") && $("pf-lead").value);
  if (lead !== undefined) {
    if (Number.isNaN(lead) || lead <= 0) { bar("交期承诺须为正数（天）", true); return; }
    form.lead_days = lead;
  }
  var ttl = numberOrUndefined($("pf-ttl") && $("pf-ttl").value);
  if (ttl !== undefined) {
    if (Number.isNaN(ttl) || ttl <= 0 || !Number.isInteger(ttl)) { bar("报价有效期须为正整数（秒）", true); return; }
    form.ttl_seconds = ttl;
  }
  var hrMode = $("pf-hr") ? $("pf-hr").value : "";
  if (hrMode === "set") {
    var triggers = [];
    if ($("pf-hr-below") && $("pf-hr-below").checked) triggers.push("below_floor");
    if ($("pf-hr-warranty") && $("pf-hr-warranty").checked) triggers.push("exceptional_warranty");
    if ($("pf-hr-suspicious") && $("pf-hr-suspicious").checked) triggers.push("suspicious_content");
    form.human_review = triggers;
  }
  var skuRules = readSkuRules();
  if (skuRules === null) return;
  if (skuRules.length > 0) form.sku_rules = skuRules;
  if (Object.keys(form).length === 0) { bar("所有字段都留空：没有可提交的修改", true); return; }
  call("POST", "/policy/form-drafts", form)
    .then(function (draft) {
      $("polformresult").innerHTML = '<div class="card" style="margin-top:10px;background:#fbfcfd">' +
        "本次涉及字段：<b>" + esc((draft.applied_keys || []).join("、")) + "</b>；草稿 <b>" + esc(draft.draft_id) + "</b>" +
        '<pre class="digest">' + esc(draft.digest) + "</pre>" +
        '<button class="act primary" id="pfd-commit" data-draft-id="' + esc(draft.draft_id) + '" data-digest="' + esc(draft.digest) + '">确认提交生效</button>' +
        '<p class="muted">提交后由服务端按策略 schema 校验并原子生效（与高级模式同一确认流程）。</p></div>';
      bindPolicyCommit("pfd-commit");
    })
    .catch(function (e) { bar("表单草稿未保存：" + e.message, true); });
}
function pauseService() {
  currentRevision(function (s) {
    call("POST", "/runtime/safety-stops", {
      expected_revision: s.service_revision,
      reason: "商家在工作台暂停",
      idempotency_key: key("pause"),
    }).then(function () { bar("已暂停接待"); refresh(); })
      .catch(function (e) { bar("暂停失败：" + e.message, true); });
  });
}
function resumeService() {
  currentRevision(function (s) {
    call("POST", "/runtime/mode-drafts", {
      target_state: "OPERATING",
      expected_revision: s.service_revision,
      reason: "商家在工作台申请恢复接待",
    }).then(function (draft) {
      return trustedDecision(draft.candidate.candidate_id, "approve");
    }).then(function () { bar("已准备可信确认，请在确认页完成恢复接待"); })
      .catch(function (e) { bar("恢复失败：" + e.message, true); });
  });
}
function trustedDecision(candidateId, decision) {
  return call("POST", "/confirmations", { candidate_id: candidateId, decision: decision })
    .then(function (confirmation) {
      window.location.assign("/merchant/trusted/confirm?ref=" + encodeURIComponent(confirmation.request_ref));
    });
}
function decide(candidateId, approve) {
  trustedDecision(candidateId, approve ? "approve" : "reject")
    .catch(function (e) { bar("操作失败：" + e.message, true); });
}
var pendingImport = null;
var parsedTable = null;
function previewPublication() {
  if (publicationBusy) return;
  if (publicationDraft !== null) { bar("已生成预览；如需修改选择，请先点「重新选择」", true); return; }
  var selections = publicationSelections();
  if (selections === null) return;  // 输入校验失败：不触碰已有状态
  var previousDraft = publicationDraft;
  publicationBusy = true;
  return call("POST", "/products/publication-drafts", { selections: selections }).then(function (draft) {
    publicationDraft = draft;
    publicationPicks = selections.slice();
    var items = draft.items || [];
    var rows = items.map(function (it) {
      var listing = it.listing || {};
      return "<tr><td>" + esc(listing.title || "-") + "</td><td>" +
        esc(listing.source_product_ref || it.sku) + "</td><td>" +
        esc(listing.category || it.category) + "</td><td>" +
        publicLink(listing.handoff_destination_ref) + "</td><td>" +
        esc(listing.fresh_until || "-") + "</td><td>" +
        publicFieldText(listing) + "</td></tr>";
    }).join("");
    lockPublicationSelection(true);
    $("publication-result").innerHTML = "<h3>将公开 " + esc(items.length) + " 件商品</h3>" +
      '<p class="muted">「预览有效期至」是草稿到期时间，不是商品新鲜期；商品新鲜期以下方每行「新鲜期至」为准。</p>' +
      '<div class="table-scroll"><table><tr><th>名称</th><th>SKU</th><th>分类</th><th>商品页链接</th><th>新鲜期至</th><th>其余公开字段</th></tr>' +
      rows + "</table></div>" +
      '<p class="muted">预览有效期至 ' + esc(draft.expires_at) +
      '（草稿到期时间）；价格、库存与私有规则不在公开内容中。整表替换只影响商品导入，不会改动本次未勾选的其他公开商品。</p>' +
      '<button class="act primary" onclick="commitPublication()">确认公开这 ' + esc(items.length) + ' 件商品</button> ' +
      '<button class="act" onclick="resetPublication()">重新选择（作废本次预览）</button>';
  }).catch(function (err) {
    publicationDraft = previousDraft;  // 网络失败不丢旧草稿引用
    bar(err.message, true);
  }).finally(function () { publicationBusy = false; });
}
function commitPublication() {
  if (publicationBusy || !publicationDraft) return;
  var current = publicationSelections();
  if (current === null || !samePublicationPicks(current, publicationPicks)) {
    publicationDraft = null;
    publicationPicks = null;
    lockPublicationSelection(false);
    bar("预览后选择或分类已变化，本次预览已作废，请重新预览后再确认", true);
    return;
  }
  publicationBusy = true;
  var draft = publicationDraft;
  return call("POST", "/products/publication-drafts/" + encodeURIComponent(draft.draft_id) + "/commit", {
    expected_digest: draft.digest, confirm_publication: true,
  }).then(function (receipt) {
    var total = receipt.succeeded + receipt.failed + receipt.pending;
    var counts = "共 " + total + " 件：成功 " + receipt.succeeded + "，失败 " + receipt.failed + "，待确认 " + receipt.pending;
    $("publication-result").innerHTML = renderPublicationReceipts(receipt.results, "发布结果", counts) +
      (receipt.status !== "succeeded" ? '<button class="act" onclick="checkPublication()">查看原草稿回执</button><button class="act" onclick="commitPublication()">按原草稿继续确认</button>' : '');
    if (receipt.status === "succeeded") {
      publicationDraft = null;
      publicationPicks = null;
      lockPublicationSelection(false);
    }
  }).catch(function (err) { bar(err.message + " 请保留本页，查看原草稿回执。", true); })
    .finally(function () { publicationBusy = false; });
}
function checkPublication() {
  if (!publicationDraft) return;
  return call("GET", "/products/publication-drafts/" + encodeURIComponent(publicationDraft.draft_id)).then(function (result) {
    var receipts = result.receipts || [];
    var pending = receipts.filter(function (r) { return r.status === "pending"; }).length;
    $("publication-result").innerHTML = renderPublicationReceipts(receipts, "原草稿回执") +
      (pending > 0 ? '<p class="muted">还有 ' + esc(pending) + ' 件结果待确认；可按原草稿继续确认（幂等，不会重复发布）。</p>' +
        '<button class="act primary" onclick="commitPublication()">按原草稿继续确认</button> ' : "") +
      '<button class="act" onclick="resetPublication()">重新选择（作废本次预览）</button>';
  }).catch(function (err) { bar(err.message, true); });
}
function previewImport() {
  var f = $("pfile").files[0];
  if (!f) { bar("请先选择 CSV / Excel / JSON 商品表文件", true); return; }
  var name = String(f.name || "").toLowerCase();
  if (name.endsWith(".csv") || f.type === "text/csv") { parseTabularFile(f, "csv"); return; }
  if (name.endsWith(".xlsx")) { parseTabularFile(f, "xlsx"); return; }
  var reader = new FileReader();
  reader.onload = function () {
    var table;
    try { table = JSON.parse(reader.result); }
    catch (e) { bar("文件不是合法 JSON", true); return; }
    submitImportTable(table);
  };
  reader.readAsText(f);
}
function sendUpload(format, content, again) {
  return fetch(API + "/products/import-parse?format=" + format, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": format === "csv" ? "text/csv" : "application/octet-stream",
      "x-csrf-token": CSRF,
    },
    body: content,
  }).then(function (res) {
    if (!res.ok) {
      if (res.status === 401) { showLogin(); throw new Error("需要登录"); }
      return apiError(res).then(function (error) {
        return csrfRetry(error, function () { return sendUpload(format, content, false); }, again);
      });
    }
    return res.json();
  });
}
function parseTabularFile(f, format) {
  var done = function (content) {
    sendUpload(format, content, true).then(function (r) {
      if (!r.ok) { renderParseErrors(r); return; }
      renderParseReport(r);
    }).catch(function (e) { bar("表格解析未通过：" + e.message, true); });
  };
  if (format === "csv") {
    var tr = new FileReader();
    tr.onload = function () { done(tr.result); };
    tr.readAsText(f);
  } else {
    var ar = new FileReader();
    ar.onload = function () { done(ar.result); };
    ar.readAsArrayBuffer(f);
  }
}
function renderParseErrors(r) {
  var errors = r.errors || [];
  var rows = errors.slice(0, 50).map(function (e) {
    return "<tr><td>" + esc(e.row == null ? "-" : e.row) + "</td><td>" +
      esc(e.column || e.field || "-") + "</td><td>" + esc(e.message) + "</td></tr>";
  }).join("");
  var more = errors.length > 50 ? '<p class="muted">仅显示前 50 条，共 ' + errors.length + " 条。</p>" : "";
  $("presult").innerHTML = '<div class="card" style="margin-top:10px;background:#fbfcfd">' +
    '<h2 style="color:#b3261e">表格未通过检查，未导入任何数据</h2>' +
    (rows ? "<table><tr><th>行</th><th>列/字段</th><th>问题</th></tr>" + rows + "</table>" : "") + more +
    '<p class="muted">请修正后重新上传；可先下载模板核对列名与格式。疑似底价/成本/进价列请整列删除——它们属于报价私密策略，不能进入公开商品表。</p></div>';
}
function renderParseReport(r) {
  var rep = r.report || {};
  parsedTable = r.table;
  var unrec = (rep.unrecognized_columns || []).map(esc).join("、");
  var defaulted = (rep.defaulted_fields || []).join("、");
  $("presult").innerHTML = '<div class="card" style="margin-top:10px;background:#fbfcfd">' +
    "<div>表格读取成功：识别 " + esc(rep.rows || 0) + " 行商品（" +
    esc(rep.format === "xlsx" ? "Excel" : "CSV") + "）。</div>" +
    (unrec ? '<p class="muted" style="color:#9a6b0f">未识别的列（内容不会导入）：' + unrec +
      "。若其中有需要导入的信息，请改用模板列名后重新上传。</p>" : "") +
    (defaulted ? '<p class="muted">未提供、按默认值处理的列：' + esc(defaulted) +
      "（状态默认「在售」；更新时间默认取导入时刻）。</p>" : "") +
    '<p class="muted">确认列映射无误后继续；下一步做整表严格校验与替换预览。' +
    '<b style="color:#b3261e">整表替换：表里没有的 SKU 提交后会被移除下架。</b></p>' +
    '<button class="act primary" id="pcontinue">已确认列映射，继续校验预览</button></div>';
  var btn = $("pcontinue");
  if (btn) btn.addEventListener("click", function () {
    if (!parsedTable) { bar("请先上传表格", true); return; }
    submitImportTable(parsedTable);
  });
}
function submitImportTable(table) {
  call("POST", "/products/import-drafts", { table: table })
    .then(function (draft) {
      pendingImport = draft;
      var pv = draft.preview;
      $("presult").innerHTML = '<div class="card" style="margin-top:10px;background:#fbfcfd">' +
        "<div>草稿 <b>" + esc(draft.draft_id) + "</b>：新增 " + pv.added + "，更新 " + pv.updated +
        "，不变 " + pv.unchanged + "，<b style=\\"color:#b3261e\\">移除 " + pv.removed + "</b>（共 " + pv.rows_total + " 行）</div>" +
        '<pre class="digest">' + esc(draft.digest) + "</pre>" +
        (pv.removed > 0 ? '<p class="muted" style="color:#b3261e">注意：整表替换会移除上表未包含的 SKU。</p>' : "") +
        '<button class="act primary" onclick="commitImport()">确认导入（整批生效）</button></div>';
    })
    .catch(function (e) { bar("校验未通过：" + e.message, true); });
}
function commitImport() {
  if (!pendingImport) { bar("请先校验预览", true); return; }
  call("POST", "/products/import-drafts/" + encodeURIComponent(pendingImport.draft_id) + "/commit", {
    expected_draft_digest: pendingImport.digest,
    idempotency_key: key("import"),
  }).then(function (receipt) {
    pendingImport = null;
    bar("导入完成（回执 " + receipt.operation_id + "）");
    refresh();
  }).catch(function (e) { bar("导入失败：" + e.message, true); });
}
function draftPolicy() {
  var patch;
  try { patch = JSON.parse($("patch").value); }
  catch (e) { bar("补丁不是合法 JSON", true); return; }
  call("POST", "/policy/drafts", { patch: patch })
    .then(function (draft) {
      $("polresult").innerHTML = '<div class="card" style="margin-top:10px;background:#fbfcfd">' +
        "草稿 <b>" + esc(draft.draft_id) + "</b>（摘要 <pre class=\\"digest\\">" + esc(draft.digest) + "</pre>）" +
        '<button class="act primary" id="pd-commit" data-draft-id="' + esc(draft.draft_id) + '" data-digest="' + esc(draft.digest) + '">提交生效</button></div>';
      bindPolicyCommit("pd-commit");
    })
    .catch(function (e) { bar("草稿未保存：" + e.message, true); });
}
function bindPolicyCommit(btnId) {
  var btn = $(btnId);
  if (!btn) return;
  btn.addEventListener("click", function () {
    commitPolicy(btn.getAttribute("data-draft-id"), btn.getAttribute("data-digest"));
  });
}
function commitPolicy(draftId, digest) {
  call("POST", "/policy/drafts/" + encodeURIComponent(draftId) + "/commit", {
    expected_draft_digest: digest,
    idempotency_key: key("policy"),
  }).then(function (receipt) {
    bar("规则已生效（版本 " + receipt.result_revision + "）");
    refresh();
  }).catch(function (e) { bar("提交失败：" + e.message, true); });
}
var current = "status";
var VIEW_COPY = {
  status: ["服务状态", "掌握接待状态，管理店铺与目录连接。"],
  products: ["商品与导入", "维护商品资料，先预览，再确认变更。"],
  approvals: ["待审批", "核对每一项变更，重要决定由你确认。"],
  negotiations: ["会话旁观", "查看询价与磋商进展，掌握需要关注的会话。"],
  reports: ["运营报告", "了解买家触达与接待表现。"],
  policy: ["报价规则", "管理自动报价边界，规则确认后生效。"],
  operating: ["商品经营", "选择商品、设定条件与授权，控制生效区间。"],
  sales: ["销售工作台", "处理待办、下一动作与持久跟进。"],
  outcomes: ["经营结果", "分开查看订单证据、归因与贡献。"]
};
function decorateView() {
  var view = $("view");
  Array.prototype.forEach.call(view.querySelectorAll("table"), function (table) {
    if (table.parentElement.classList.contains("table-scroll")) return;
    if (table.rows.length && table.rows[0].cells.length <= 2) table.classList.add("detail-table");
    var wrap = document.createElement("div");
    wrap.className = "table-scroll";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    var card = table.closest(".card");
    var heading = card && card.querySelector("h2");
    wrap.setAttribute("aria-label", (heading ? heading.textContent : "工作台") + "表格，可横向滚动");
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
  Array.prototype.forEach.call(view.querySelectorAll("input[type=text], select"), function (control) {
    if (control.getAttribute("aria-label")) return;
    var row = control.closest("tr");
    var heading = row && row.querySelector("th");
    if (heading) control.setAttribute("aria-label", heading.textContent);
  });
  Array.prototype.forEach.call(view.querySelectorAll(".card > p.muted"), function (p) {
    if (/^(暂无|当前过滤条件下没有)/.test(p.textContent)) p.classList.add("empty-state");
  });
}
// 导入预览与可信确认内容动态插入后同样获得局部表格滚动。
if (typeof MutationObserver !== "undefined") {
  new MutationObserver(decorateView).observe($("view"), { childList: true, subtree: true });
}
function refresh() {
  var copy = VIEW_COPY[current];
  $("page-title").textContent = copy[0];
  $("page-description").textContent = copy[1];
  $("view").setAttribute("data-view", current);
  views[current]().then(function (html) {
    $("view").innerHTML = html; decorateView();
    if (current === "status" && CATALOG_CONNECT && ROLE === "owner") {
      if (catalogConnectionState && catalogConnectionState.bindingId) {
        call("GET", "/catalog/bound-account").then(function (result) {
          var target = $("bound-account"); if (target) target.textContent = result.email || "无法确定，请到 Kiwi 商家门户核对";
        }).catch(function () { var target = $("bound-account"); if (target) target.textContent = "暂时无法读取，请稍后刷新"; });
        // 后台刷新只更新局部状态，不覆盖全局提示条。
        refreshPublicInquiry(false);
      }
    }
  })
  .catch(function (e) { if (e.message !== "需要登录") bar(e.message, true); }); }
Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (btn) {
  btn.addEventListener("click", function () {
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) { b.className = ""; b.removeAttribute("aria-current"); });
    btn.className = "on";
    btn.setAttribute("aria-current", "page");
    current = btn.getAttribute("data-v");
    refresh();
  });
});
fetch("/merchant/api/session", { credentials: "same-origin" }).then(function (res) {
  if (res.status === 401) { showLogin(); return null; }
  return res.json();
}).then(function (session) {
  if (!session) return;
  CSRF = session.csrf_token || "";
  ROLE = session.role || "";
  $("who").textContent = "商家 " + session.merchant_id + " · " + ROLE;
  refresh();
});
</script>
</body>
</html>`;
}
