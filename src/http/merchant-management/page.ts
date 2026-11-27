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

import type { PublicProductField } from "../../commerce/data-source.js";

const PUBLIC_DETAIL_LABELS = {
  features: "特点", capacity: "容量", material: "材质", dimensions: "尺寸",
  weight: "重量", color: "颜色", customization: "定制说明",
} satisfies Record<Exclude<PublicProductField, "title" | "overview">, string>;

export const MERCHANT_PRODUCT_HELP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>商品导入与发布使用说明</title>
  <style>
    body { max-width: 44rem; margin: 3rem auto; padding: 0 1rem; color: #203329; font: 1rem/1.7 system-ui, sans-serif; }
    a { color: #176044; }
    h2 { margin-top: 1.8rem; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <a href="/merchant/">返回商家工作台</a>
    <h1>商品导入与发布使用说明</h1>
    <h2>导入文件</h2>
    <p>支持 CSV、Excel（.xlsx）和商品表 JSON。选择文件后点「导入文件」，核对新增、更新和未导入的列，再确认导入。商品名、价格、库存为必填，暂无库存请填 0。</p>
    <p><a href="/merchant/api/v1/products/import-template?format=csv" download="kiwi-product-import-template.csv">下载 CSV 模板</a> ·
      <a href="/merchant/api/v1/products/import-template?format=xlsx" download="kiwi-product-import-template.xlsx">下载 Excel 模板</a></p>
    <p>导入按 SKU 新增或更新商品，文件未包含的商品会保留。请勿在表格中填写底价、进价或成本。</p>
    <h2>在页面修改</h2>
    <p>在商品行点击「修改」，调整商品名称、库存、介绍或规格，然后点击「保存」。</p>
    <p>也可以在商品表 JSON 中填写 <code>"public_details": {"overview": "商品简介", "capacity": "450 mL"}</code>。
      支持 overview、${Object.keys(PUBLIC_DETAIL_LABELS).join("、")}，每项最多 360 字。省略此对象会保留已有介绍与规格，填入空对象会清空这些资料。</p>
    <h2>发布商品</h2>
    <p>首次发布请填写商品分类。点击列表下方的「发布商品」，系统会比较已发布记录，只提交新增或已修改的商品。</p>
    <p>商品名称、类目、交易平台和上架状态会出现在目录中。价格、库存、介绍、规格和交易链接留在工作台。实际成交条件和付款结果由交易平台确认。</p>
  </main>
</body>
</html>`;

/** 页面按 owner 视角展示管理动作；角色由服务端权限逐次裁决，前端只是提示。 */
export function renderMerchantManagementPage(options: {
  productAuthority?: "file" | "exact";
  catalogConnection?: boolean;
  workbuddyAccess?: boolean;
  weixinChannel?: boolean;
  weixinOnly?: boolean;
  manualSupport?: boolean;
  buyerFollowups?: boolean;
} = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.weixinOnly ? "连接店主微信" : "商家工作台"} — Kiwi</title>
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
  #page-description:empty { display: none; }
  .product-name { width: 12em; overflow-wrap: anywhere; }
  .product-name-preview { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .product-name summary .product-name-collapse,
  .product-name[open] summary .product-name-expand,
  .product-name[open] .product-name-preview { display: none; }
  .product-name[open] summary .product-name-collapse { display: inline; }
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
  .act[hidden] { display: none; }
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
  .catalog-settings { margin-block: 12px; }
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
  .collection-form { display: grid; gap: 12px; }
  .collection-form input:not([type=checkbox]) { display: block; max-width: 100%; }
  .collection-form img { display: block; max-width: min(100%, 280px); height: auto; }
  .collection-form [hidden] { display: none; }
  @media (prefers-reduced-motion: no-preference) { .act, nav button { transition: background-color .15s, border-color .15s; } }
  body.weixin-only { grid-template-columns: minmax(0, 1fr); }
  body.weixin-only .workspace { grid-column: 1; width: 100%; max-width: 760px; margin: 0 auto; }
.product-edit-grid{max-width:1000px;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:16px}.product-edit-grid label{display:flex;flex-direction:column;gap:6px}.product-edit-grid input,.product-edit-grid select{width:100%;box-sizing:border-box}.product-edit-grid input[type=checkbox]{width:auto;align-self:flex-start}#pub-table td{vertical-align:top}#pub-table td:nth-child(2){min-width:220px}
</style>
</head>
<body${options.weixinOnly ? ' class="weixin-only"' : ""}>
<a href="#view" class="skip-link">跳至工作区</a>
<header><div class="brand"><span class="brand-name" aria-label="Kiwi">kiwi</span><span class="brand-title">${options.weixinOnly ? "连接店主微信" : "商家工作台"}</span></div><span class="who" id="who"></span></header>
${options.weixinOnly ? "" : `<nav id="tabs" aria-label="工作台导航">
  <p class="nav-label">工作空间</p>
  <button data-v="status" class="on" aria-current="page">服务状态</button>
  <button data-v="products">商品与导入</button>
  <button data-v="approvals">待审批</button>
  <button data-v="negotiations">会话旁观</button>
  ${options.buyerFollowups ? '<button data-v="buyerFollowups" id="buyer-followups-tab" hidden>买家待确认</button>' : ""}
  <button data-v="reports">运营报告</button>
  <button data-v="policy">报价规则</button>
  <button data-v="collection" id="collection-tab" hidden>收款方式</button>
  <button data-v="operating">商品经营</button>
  <button data-v="sales">销售工作台</button>
  <button data-v="outcomes">经营结果</button>
  <button data-v="weixin" id="weixin-tab" hidden>微信通道</button>
  <button data-v="support" id="support-tab" hidden>售后工单</button>
  <p class="nav-foot">日常经营，井然有序。<br>Kiwi Merchant</p>
</nav>`}
<div class="workspace">
  <section class="page-head" aria-labelledby="page-title"><p class="eyebrow">${options.weixinOnly ? "KIWI WEIXIN" : "MERCHANT WORKSPACE"}</p><h1 id="page-title">${options.weixinOnly ? "连接店主微信" : "服务状态"}</h1><p id="page-description">${options.weixinOnly ? "扫码连接、授权对话或恢复连接。" : "掌握接待状态，管理店铺与名片发布。"}</p></section>
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
var WEIXIN_ONLY = ${options.weixinOnly === true};
var WEIXIN_CHANNEL = ${options.weixinChannel === true || options.weixinOnly === true};
var MANUAL_SUPPORT = ${options.manualSupport === true};
var viewSequence = 0;
// 与 cloud/access/workbuddy-share-link 的 WORKBUDDY_CUSTODY_TERMS_VERSION 同值；
// 浏览器产物必须自包含（verify:browser-artifact 禁止模块导入），所以这里是字面量，
// 由 tests/merchant-management-api 断言两者一致。
var ACCESS_CONSENT_TERMS = "workbuddy-share-v1-2026-10-27";
var catalogBeginKey = "";
var catalogBeginPending = false;
var catalogConnectionState = null;
var publicationDraft = null;
var publicationResult = "";
var publicationBusy = false;
var POLICY_SUMMARY = null;
var POLICY_PRODUCTS = [];
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
    if (url.protocol !== "https:" || url.username || url.password) return "-";
    // 链接由服务端按运营配置的模板生成；这里仍拒绝仿冒已知平台的域名
    // （如 item.jd.com.evil.example），避免页面为冒名站点背书。
    var labels = url.hostname.split(".");
    var knownDomains = [["jd", "com"], ["taobao", "com"], ["tmall", "com"]];
    var allowedHosts = ["item.jd.com", "item.taobao.com", "detail.tmall.com"];
    var looksLikeKnown = knownDomains.some(function (d) {
      for (var i = 0; i + 1 < labels.length; i += 1) {
        if (labels[i] === d[0] && labels[i + 1] === d[1]) return true;
      }
      return false;
    });
    if (looksLikeKnown && allowedHosts.indexOf(url.hostname) < 0) return "-";
    return '<a href="' + esc(value) + '" target="_blank" rel="noopener noreferrer">' + esc(value) + '</a>';
  } catch (_) { return "-"; }
}
var barTimer = null;
function dismissBar() {
  if (barTimer !== null) {
    clearTimeout(barTimer);
    barTimer = null;
  }
  var b = $("bar");
  b.style.display = "none";
  b.textContent = "";
  b.className = "";
}
function bar(msg, isErr) {
  dismissBar();
  var b = $("bar");
  b.textContent = msg;
  b.className = isErr ? "err" : "";
  b.style.display = "block";
  barTimer = setTimeout(dismissBar, isErr ? 6000 : 4000);
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
    error.status = res.status;
    error.code = problem.code;
    error.csrf = problem.detail === "missing or invalid CSRF token";
    return error;
  }
  var fallback = await res.json().catch(function () { return {}; });
  var fallbackError = new Error((fallback.message || fallback.detail || fallback.code || ("HTTP " + res.status)) + "。请勿自动重复提交。");
  fallbackError.status = res.status; fallbackError.code = fallback.code;
  return fallbackError;
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
  viewSequence++;
  if (WEIXIN_CHANNEL && !WEIXIN_ONLY) $("weixin-tab").hidden = true;
  if (MANUAL_SUPPORT && !WEIXIN_ONLY) $("support-tab").hidden = true;
  $("view").innerHTML = '<div class="card login-card"><h2>' + (WEIXIN_ONLY ? '登录后连接店主微信' : '登录你的商家工作台') + '</h2>' +
    '<p class="muted">请使用商家管理员口令登录后回到本页。</p>' +
    '<p><a class="act primary" href="/admin/login?next=' + (WEIXIN_ONLY ? '%2Fmerchant%2Fweixin' : '%2Fmerchant%2F') + '">去登录</a></p></div>';
}
function key(p) { return p + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
function statePill(state) {
  var map = { OPERATING: ["ok", "营业中"], PAUSED: ["warn", "已暂停"], WITHDRAWN: ["bad", "已撤回"], DEGRADED: ["warn", "降级"] };
  var it = map[state] || ["warn", state];
  return '<span class="pill ' + it[0] + '">' + esc(it[1]) + "</span>";
}

var PAIRING_CODE_HINTS = {
  PAIRING_WINDOW_EXPIRED: "上次授权已过期：请重新发起，并在 10 分钟内到Kiwi网关完成确认",
  BIND_REJECTED: "Kiwi网关拒绝了本次绑定请求：请重新发起，反复出现请联系管理员",
  BIND_CLAIM_CARD_URL_MISMATCH: "Kiwi网关名片地址与已确认的公开预览不一致：请重新核对后再发起",
  BIND_CLAIM_FIELD_MISMATCH: "Kiwi网关绑定材料与预览不一致：请重新发起",
  BIND_CLAIM_INVALID: "Kiwi网关签名材料未通过本机校验：请重新发起",
  CARD_PUBLISH_REJECTED: "名片发布被Kiwi网关拒绝：请稍后重试或联系管理员",
  CARD_PUBLISH_INVALID: "名片发布回执不完整：请刷新后重试",
  PRODUCT_TABLE_INVALID: "商品表无法校验或与当前商家不匹配，请先修复原实例的商品表",
  MERCHANT_DISPLAY_NAME_REQUIRED: "请先在原实例配置商家显示名，无需在聊天里重填",
  CATALOG_RUNTIME_NOT_READY: "名片发布前的运行时检查未通过，请核对实例状态",
  PAIRING_COMMUNICATION_FAILED: "与Kiwi网关通信暂时失败：请稍后刷新重试"
};

function catalogStatusText(s) {
  if (s.published) return "名片已发布";
  var labels = { idle: "待发布名片", preparing: "待确认", pending: "待确认", awaiting_confirmation: "待确认",
    authorized: "发布中", bound: "发布中", expired: "发布失败：授权已过期，请重新发起",
    blocked: "发布失败", paused: "Kiwi网关服务已暂停", revoked: "授权已撤销" };
  if (s.errorCode && (s.status === "authorized" || s.status === "bound")) return "发布失败，可刷新续办";
  return labels[s.status] || "名片尚未发布";
}
function waitingForCatalogConfirmation(s) {
  return !s.bindingId && ["preparing", "pending", "awaiting_confirmation"].indexOf(s.status) >= 0;
}
function appendCatalogSetup(html) {
  if (!CATALOG_CONNECT || ROLE !== "owner") return Promise.resolve(html);
  var sequence = viewSequence;
  catalogConnectionState = null;
  return call("GET", "/catalog/connect").then(function (s) {
    return call("GET", "/catalog/access").then(function (result) {
      return result.access || null;
    }).catch(function () { return null; }).then(function (a) {
      if (sequence === viewSequence) catalogConnectionState = s;
      return html + renderCatalogSetup(s, a);
    });
  }).catch(function () {
    return html + '<div class="card"><h2>Kiwi网关</h2><p>暂时无法读取连接状态。</p>' +
      '<button class="act" onclick="refresh()">刷新状态</button></div>';
  });
}
function renderCatalogSetup(s, a) {
  var waiting = waitingForCatalogConfirmation(s);
  var canBegin = !s.published && !s.bindingId && !waiting && s.status !== "authorized";
  var shareForm = a ? renderShareSettings(a, WORKBUDDY_ACCESS && canBegin) : "";
  return '<div class="card"><h2>Kiwi网关</h2><p id="catalog-status">' + esc(catalogStatusText(s)) + '</p>' +
    (s.bindingId ? '<p>Kiwi 账户 <span id="bound-account">正在核对…</span></p>' : '') +
    (s.errorCode ? '<p class="muted">' + (PAIRING_CODE_HINTS[s.errorCode] ? esc(PAIRING_CODE_HINTS[s.errorCode]) + ' ' : '') +
      '[' + esc(s.errorCode) + ']</p>' : '') +
    (s.published ? '<p id="public-inquiry-status" class="muted" aria-live="polite">正在读取开放询价状态…</p>' :
      '<p class="muted">' + (WORKBUDDY_ACCESS
        ? '首次发布后将尝试开启开放询价；商品发布后，请在买家端实测。可在高级设置暂停。'
        : '发布后，采购方可在Kiwi网关发现本店。') + '</p>') +
    (waiting ? '<div id="catalog-pairing" aria-live="polite">正在读取配对信息…</div>' : '') +
    (WORKBUDDY_ACCESS && canBegin ? shareForm : '') +
    '<div class="row">' +
    (canBegin ? '<button id="catalog-begin" class="act primary" onclick="connectCatalog()">发布名片</button>' : '') +
    '<button class="act" onclick="refreshCatalogSetup()">刷新状态</button></div>' +
    (WORKBUDDY_ACCESS && !canBegin ? shareForm : '') +
    (a || s.published ? '<details class="catalog-settings"><summary>高级设置</summary>' +
      (a ? renderAccessSettings(a) : '<p class="muted">暂时无法读取接入设置。</p>') +
      (!WORKBUDDY_ACCESS ? shareForm : '') +
      (s.published ? '<div class="catalog-settings"><h3>开放询价</h3>' +
        '<p class="muted">买家可通过Kiwi网关询价，无需注册或逐个审批。Kiwi网关转发询价与报价，可读取报文，不保存磋商内容。</p>' +
        '<button id="inquiry-toggle" class="act" onclick="togglePublicInquiry()" disabled>正在读取状态…</button></div>' : '') +
      '</details>' : '') + '</div>';
}
function accessModeLabel(mode) {
  return { auto: "自动检测（默认）", share_code: "使用分享码", no_share_code: "无分享码（直连）" }[mode] || "自动检测（默认）";
}
function safeAccessMode(mode) {
  return ["auto", "share_code", "no_share_code"].indexOf(mode) >= 0 ? mode : "auto";
}
function detectionText(d) {
  if (!d) return "";
  if (d.status === "direct_ok") return "本次可直接访问公开名片。平台白名单需由 WorkBuddy 确认。";
  if (d.status === "share_code_ok") return "本次分享码可通过平台门禁。";
  return d.guidance || "暂时无法确认接入方式，请检查公网服务或分享链接。";
}
function showAccessDetection(d) {
  var target = $("access-detection");
  if (target) target.textContent = detectionText(d);
}
function accessStatusText(a) {
  if (!a) return "分享链接状态暂不可用。";
  if (a.statusReason === "catalog_access_exists") return "Kiwi网关保留了原分享码。更换请粘贴新链接并保存。";
  if (a.statusReason === "local_saved_not_used" || (a.status === "active" && a.mode === "no_share_code")) {
    return "分享码已保存，当前接入方式为无分享码。";
  }
  if (a.status === "active") return "分享码已生效。";
  if (a.status === "pending" && a.statusReason === "local_staged") return "分享码已加密保存，发布时由Kiwi网关校验。";
  if (a.status === "pending") return "分享码等待平台校验。";
  if (a.status === "invalid") return "分享码校验未通过，请更新分享链接。";
  if (a.status === "revoked") return "分享码已撤销。";
  return "平台要求分享码时，请填写本应用的分享链接。";
}
function accessSyncText(a) {
  var state = a && a.catalogSync;
  if (state === "synced") return "Kiwi网关路由已同步。";
  var retryHint = "接入方式已保存在本机。买家仍按Kiwi网关原有设置接入，可刷新重试。";
  if (state === "failed") return "同步失败（" + (a.catalogSyncError || "SYNC_FAILED") + "）。" + retryHint;
  if (state === "pending") return retryHint;
  if (state === "unsupported") return "当前Kiwi网关暂不支持同步接入方式。";
  if (state === "unbound") return "接入方式将在完成名片发布后同步。";
  return "";
}
function renderAccessSettings(a) {
  var mode = safeAccessMode(a.mode);
  var options = ["auto", "share_code", "no_share_code"].map(function (value) {
    return '<option value="' + value + '"' + (mode === value ? ' selected' : '') + '>' + accessModeLabel(value) + '</option>';
  }).join("");
  return '<h3>接入方式</h3><div class="row"><label for="access-mode">买家接入</label>' +
    '<select id="access-mode">' + options + '</select>' +
    '<button class="act" onclick="saveAccessMode()">保存</button>' +
    '<button class="act" onclick="detectAccessMode()">检测</button></div>' +
    '<p id="access-detection" class="muted">' + esc(a.detection ? detectionText(a.detection) : "") + '</p>' +
    '<p id="access-sync" class="muted">' + esc(accessSyncText(a)) + '</p>' +
    '<p class="muted">自动检测优先尝试直接访问。切换接入方式会保留分享码；撤销代管可清除。平台白名单需由 WorkBuddy 确认。</p>' +
    (a.modeInvalid ? '<p class="warn">已将无法识别的接入方式恢复为自动检测。</p>' : '');
}
function renderShareSettings(a, connectUsesLink) {
  var needsLink = a.status === "invalid" || (a.mode === "share_code" && !a.consentGranted);
  return '<details class="catalog-settings" id="access-share-settings"' + (needsLink ? ' open' : '') + '>' +
    '<summary>WorkBuddy 分享链接' + (a.statusReason === "local_staged" ? '（已保存）' : connectUsesLink ? '（按需填写）' : '') + '</summary>' +
    '<p id="access-status" class="muted">' + esc(accessStatusText(a)) + '</p>' +
    (a.custodyEnabled === false ? '<p class="warn">分享码代管暂不可用。</p>' : '') +
    '<input id="access-link" type="text" oninput="updateAccessButton()" autocomplete="off" spellcheck="false" aria-label="WorkBuddy 分享链接" placeholder="粘贴本应用的 WorkBuddy 分享链接">' +
    '<p><label class="consent-label"><input id="access-consent" type="checkbox" aria-label="同意分享码代管授权">' +
    '<span>我同意Kiwi网关代管分享码，用于通过平台门禁转发询价，并按需向已接受的采购方出示。</span></label></p>' +
    '<details class="catalog-settings"><summary>查看代管授权与使用说明</summary>' +
    '<p class="muted">WorkBuddy 要求分享码时，请填写本应用的分享链接。链接失效或换码后，请在此更新。撤销代管会清除已保存的分享码。</p></details>' +
    '<div class="row">' +
    (connectUsesLink ? '<p class="muted">填写后，点击下方「发布名片」。</p>' : '<button id="access-submit" class="act" onclick="submitAccessLink()" disabled>保存分享链接</button>') +
    '<button id="access-revoke" class="act danger" onclick="revokeAccess()"' + (a.consentGranted ? '' : ' hidden') + '>撤销代管</button>' +
    '</div>' +
    (a.recentFaults > 0 ? '<p class="warn">最近 24 小时有 ' + esc(a.recentFaults) + ' 次门禁失败，请检查分享链接。</p>' : '') +
    '</details>';
}
var publicInquiryConsent = null;
function showPublicInquiryStatus(consent) {
  publicInquiryConsent = consent || null;
  var target = $("public-inquiry-status"), button = $("inquiry-toggle");
  var text = !consent ? "开放询价状态暂不可用" :
    consent.pending && consent.granted && !consent.policyActive ? "开放询价暂未生效，请检查接入方式和分享链接" :
    consent.pending ? "开放询价正在开通或待同步，请稍后刷新" :
    !consent.granted ? "开放询价已暂停" :
    consent.policyActive && consent.localEnabled ? "开放询价已开启" : "开放询价暂不可用，请检查接入方式和分享链接";
  if (target) target.textContent = text;
  if (button) {
    button.textContent = consent && (consent.granted || consent.pending) ? "暂停开放询价" : "开启开放询价";
    button.disabled = !consent;
  }
}
function refreshPublicInquiry(sequence) {
  var button = $("inquiry-toggle"); if (button) button.disabled = true;
  return call("POST", "/catalog/public-inquiry/status", {}).then(function (result) {
    if (sequence === viewSequence) showPublicInquiryStatus(result.consent);
  }).catch(function () {
    if (sequence === viewSequence) showPublicInquiryStatus(null);
  });
}
function togglePublicInquiry() {
  var button = $("inquiry-toggle");
  if (!button || button.disabled || !publicInquiryConsent) return;
  var granted = !publicInquiryConsent.granted && !publicInquiryConsent.pending;
  button.disabled = true;
  var sequence = viewSequence;
  return call("POST", "/catalog/public-inquiry/consent", { granted: granted, terms_version: "open-inquiry-v1" }).then(function (result) {
    if (sequence === viewSequence) showPublicInquiryStatus(result.consent);
  }).catch(function () {
    bar("开放询价状态尚未确认，请刷新状态。", true);
    if (sequence === viewSequence) showPublicInquiryStatus(null);
  });
}
function accessSummaryBar(a, verb) {
  var target = $("access-status"); if (target) target.textContent = accessStatusText(a);
  var sync = $("access-sync"); if (sync) sync.textContent = accessSyncText(a);
  if (a && a.detection !== undefined) showAccessDetection(a.detection);
  var revoke = $("access-revoke"); if (revoke && a) revoke.hidden = !a.consentGranted;
  bar(verb + "：" + accessStatusText(a) + " " + accessSyncText(a), a && (a.status === "invalid" || (a.catalogSync && a.catalogSync !== "synced")));
}
function saveAccessMode() {
  var select = $("access-mode");
  var mode = select ? String(select.value || "") : "";
  if (["auto", "share_code", "no_share_code"].indexOf(mode) < 0) {
    bar("请选择自动检测、使用分享码或无分享码。", true);
    return;
  }
  return call("POST", "/catalog/access/mode", { mode: mode }).then(function (result) {
    var a = result.access || {};
    var status = $("access-status"); if (status) status.textContent = accessStatusText(a);
    var sync = $("access-sync"); if (sync) sync.textContent = accessSyncText(a);
    showAccessDetection(a.detection);
    bar("已保存接入方式。" + accessSyncText(a));
    if (catalogConnectionState && catalogConnectionState.published) refreshPublicInquiry(viewSequence);
  }).catch(function (error) {
    bar(error && error.message ? error.message : "接入方式未保存，请刷新后重试。", true);
  });
}
function detectAccessMode() {
  return call("POST", "/catalog/access/detect", {}).then(function (result) {
    showAccessDetection(result.detection);
    bar(detectionText(result.detection), !!(result.detection && result.detection.status === "uncertain"));
  }).catch(function () {
    var target = $("access-detection");
    if (target) target.textContent = "检测结果：不确定。单次 401/403、网络错误或不完整响应不能判定实例未加白。请确认服务已启动、公网入口与 TLS 正常后重试；如平台门禁拦截，可提交分享链接。已保存的分享码不会被删除。";
    bar("接入方式检测未完成，请按页面提示核对后重试。", true);
  });
}
var accessSubmitPending = false;
function updateAccessButton() {
  var button = $("access-submit"), input = $("access-link");
  if (button) button.disabled = accessSubmitPending || !input || !input.value.trim();
}
function saveShareLink(link) {
  var input = $("access-link"), consent = $("access-consent");
  return call("POST", "/catalog/access/share-link", { link: link, consent_terms_version: ACCESS_CONSENT_TERMS }).then(function (result) {
    if (input) input.value = "";
    if (consent) consent.checked = false;
    return result.access;
  });
}
function submitAccessLink() {
  if (accessSubmitPending) return;
  var input = $("access-link"), consent = $("access-consent");
  var link = input ? input.value.trim() : "";
  if (!link) return;
  if (!consent || !consent.checked) { bar("请先勾选并同意分享码代管。", true); return; }
  accessSubmitPending = true;
  updateAccessButton();
  return saveShareLink(link).then(function (a) {
    accessSummaryBar(a, "已保存");
    if (catalogConnectionState && catalogConnectionState.published) refreshPublicInquiry(viewSequence);
  }).catch(function (error) {
    bar(error.message || "保存未完成，请重试。", true);
  }).finally(function () {
    accessSubmitPending = false;
    updateAccessButton();
  });
}
function refreshCatalogSetup() {
  if (!catalogConnectionState || !catalogConnectionState.bindingId) return refresh();
  return call("POST", "/catalog/access/refresh", {}).catch(function () {
    bar("暂时无法同步接入设置。", true);
  }).then(refresh);
}
function revokeAccess() {
  if (!window.confirm("撤回授权后：采购方将无法经 WorkBuddy 访问本店，Kiwi网关会清空已保存的分享码。确定撤回？")) return;
  call("POST", "/catalog/access/revoke", {}).then(function (result) {
    accessSummaryBar(result.access, "已撤销");
    var button = $("access-revoke"); if (button) button.disabled = true;
    refresh();
  }).catch(function () { bar("撤销未完成，请稍后重试。", true); });
}
function connectCatalog() {
  if (catalogBeginPending) return;
  var input = $("access-link"), consent = $("access-consent"), button = $("catalog-begin");
  var link = WORKBUDDY_ACCESS && input ? input.value.trim() : "";
  if (link && (!consent || !consent.checked)) { bar("请先勾选并同意分享码代管。", true); return; }
  catalogBeginPending = true;
  if (button) button.disabled = true;
  var stage = link ? saveShareLink(link).then(function (a) { accessSummaryBar(a, "已保存"); }) : Promise.resolve();
  return stage.then(beginCatalogConnect).catch(function (error) {
    bar(error.message || "分享链接保存未确认，请重试。", true);
  }).finally(function () {
    catalogBeginPending = false;
    if (button) button.disabled = false;
  });
}
function beginCatalogConnect() {
  try { if (!catalogBeginKey) catalogBeginKey = sessionStorage.getItem("kiwi-catalog-connect-key") || ""; } catch (_) {}
  if (!catalogBeginKey) catalogBeginKey = key("catalog-connect");
  try { sessionStorage.setItem("kiwi-catalog-connect-key", catalogBeginKey); } catch (_) {}
  return call("POST", "/catalog/connect/begin", { idempotency_key: catalogBeginKey }).then(function (receipt) {
    if (receipt.status === "succeeded") { catalogBeginKey = ""; try { sessionStorage.removeItem("kiwi-catalog-connect-key"); } catch (_) {} }
    bar(receipt.status === "succeeded" ? "连接申请已准备，请核对配对码和公开资料，并在Kiwi网关确认发布。" : "连接结果尚未确认，请先查看状态，不要重复提交。");
    refresh();
  }).catch(function (error) {
    var message = error && error.message ? error.message : "连接申请暂未完成，请先刷新状态后再试。";
    // 连接时的公开探测失败同样只能呈现“不确定”，不能把单次失败说成未加白。
    if (/接入方式|公开名片|公网入口|商家服务|分享码|不确定|超时/.test(message)) {
      var share = $("access-share-settings"); if (share) share.open = true;
      showAccessDetection({
        status: "uncertain",
        guidance: message + " 单次失败不能判定实例未加白；已保存的分享码不会被删除。"
      });
    }
    bar(message, true);
  });
}
function showCatalogPairing(sequence) {
  return call("GET", "/catalog/connect/pairing").then(function (result) {
    if (sequence !== viewSequence) return;
    var box = $("catalog-pairing");
    if (!box) return;
    var p = result.pairing;
    if (!p) { box.textContent = "当前没有待确认的配对信息，请先发起连接或刷新状态。"; return; }
    var url = new URL(p.verification_uri);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid link");
    box.innerHTML = '<p>请在Kiwi网关核对配对码 <strong>' + esc(p.user_code) + '</strong></p>' +
      '<p class="muted">有效期至 ' + esc(new Date(p.expires_at).toLocaleString()) + '。请勿转发配对码。</p>' +
      '<p><a class="act primary" target="_blank" rel="noopener noreferrer" href="' + esc(url.href) + '">前往Kiwi网关确认发布</a></p>';
  }).catch(function () {
    var box = $("catalog-pairing");
    if (sequence === viewSequence && box) box.textContent = "无法读取配对信息，请刷新状态。";
  });
}

/** 商品状态文案：报价有效期不影响上架状态。 */
function productStatusLabel(it) {
  var status = String((it && it.status) || "").toLowerCase();
  if (status === "paused") return "已下架";
  if (status === "active" || status === "" || status === "expired") return "上架";
  return status;
}
/** 目录发布状态文案：known=false 时不把“读不到”说成“未发布”。 */
function publicationStateLabel(state, known) {
  if (!known) return "待核验";
  var normalized = String(state || "").toLowerCase();
  if (normalized === "active") return "商品已发布";
  if (normalized === "paused" || normalized === "suspended") return "已暂停";
  return "已导入，待发布";
}
function lockPublicationSelection(locked) {
  var batch = $("pub-submit");
  if (batch) batch.disabled = locked;
}
function showPublicationResult(html) {
  publicationResult = html;
  var result = $("publication-result");
  if (result) result.innerHTML = html;
}
function resetPublication() {
  if (publicationBusy) return;
  publicationDraft = null;
  lockPublicationSelection(false);
  showPublicationResult("");
}
function renderPublicationReceipts(receipts, heading, counts) {
  var rows = (receipts || []).map(function (r) {
    var label = r.status === "succeeded" ? "已确认" : r.status === "pending" ? "待确认" : "失败";
    return "<tr><td>" + esc(r.sku) + "</td><td>" + esc(label) + "</td><td>" + esc(r.code || r.listing_id || "-") + "</td></tr>";
  }).join("");
  return "<h3>" + esc(heading) + "</h3>" + (counts ? "<p>" + esc(counts) + "</p>" : "") +
    '<div class="table-scroll"><table><tr><th>SKU</th><th>结果</th><th>说明</th></tr>' + rows + "</table></div>";
}

// SKU is the persistent product identity; public links and source revisions are derived.
var productRows = [];
var productPublication = {};
var productEdit = null;
var productPendingPublication = Object.create(null);
var productFields = [
  ["title", "名称", "text", true], ["category", "类目（发布必填）", "text"], ["currency", "币种", "text", true],
  ["unit", "计价单位", "text", true], ["price", "单价（按所选币种）", "number", true],
  ["moq", "起订量", "integer"], ["stock", "库存", "integer", true],
  ["supply_note", "供货说明", "text"], ["updated_at", "更新时间（ISO）", "text", true],
  ["valid_until", "数据有效期（ISO）", "text", true], ["status", "状态", "status", true],
  ["trade_platform", "交易平台", "platform"], ["platform_product_id", "平台商品ID", "text"],
  ["test", "测试商品", "boolean"]
];
function productValue(value) { return value == null || value === "" ? "未填写" : esc(value); }
function productDetailCells(details) {
  var labels = ${JSON.stringify({ overview: "商品简介", ...PUBLIC_DETAIL_LABELS })};
  return Object.keys(labels).map(function (key) {
    return '<div><strong>' + esc(labels[key]) + '：</strong>' + productValue((details || {})[key]) + '</div>';
  }).join("");
}
function productNameCell(title) {
  var name = String(title == null ? "" : title);
  var characters = Array.from(name);
  if (characters.length <= 12) return "<td>" + productValue(name) + "</td>";
  return '<td><details class="product-name"><summary>' +
    '<span class="product-name-preview">' + esc(characters.slice(0, 12).join("")) + '…</span>' +
    '<span class="product-name-expand">查看全名</span><span class="product-name-collapse">收起</span>' +
    '</summary><div>' + esc(name) + '</div></details></td>';
}
function fileProductRow(it, index, canPublish, published, known) {
  var sku = esc(it.sku);
  if (productEdit && productEdit.sku === it.sku) return renderProductEditor();
  var row = '<tr data-sku="' + sku + '">';
  row += '<td>' + sku + '</td>' + productNameCell(it.title);
  if (!canPublish) row += '<td>' + productValue(it.category) + '</td>';
  var price = productValue(it.currency) + ' ' + productValue(it.price) + ' / ' + productValue(it.price_unit);
  var platform = it.trade_platform_label || ({jd:"京东",taobao:"淘宝",tmall:"天猫"})[it.trade_platform] || it.trade_platform;
  if (canPublish) row += '<td>' + esc(productStatusLabel(it)) + '</td><td class="pub-state">' + esc(productPendingPublication[it.sku] ? "修改待发布" : publicationStateLabel(published[it.sku], known)) + '</td>' +
    '<td>' + productValue(it.category || (productPublication.categories || {})[it.sku]) + '</td>';
  row += '<td>' + price + '</td><td>' + productValue(it.min_order_qty) + '</td><td>' + productValue(it.valid_until) + '</td>';
  if (!canPublish) row += '<td>' + esc(productStatusLabel(it)) + '</td>';
  row += '<td>' + productValue(platform) + '</td><td>' + productValue(it.platform_product_id) + '</td><td>' +
    (it.platform_product_url ? marketplaceLink(it) : '未填写') + '</td><td>' +
    (it.stock == null || it.stock === 0 ? '0' : esc(it.stock) + ' ' + productValue(it.price_unit)) + '</td><td>' +
    productValue(it.supply_note) + '</td><td>' + productValue(it.updated_at) + '</td><td>' + (it.test ? '是' : '否') + '</td><td>' +
    productDetailCells(it.public_details) + '</td><td>' +
    ((ROLE === 'owner' || ROLE === 'operator') ? '<button type="button" class="act" onclick="editProduct(' + index + ')">修改</button>' : '只读') + '</td></tr>';
  return row;
}
function renderProductEditor() {
  var record = productEdit.table.products[0];
  var frozen = productEdit.commit != null;
  var fields = productFields.map(function (field) {
    var key = field[0], type = field[2], value = record[key];
    var common = ' id="product-edit-' + key + '"' + (frozen ? ' disabled' : '') + (field[3] ? ' required' : '');
    var platforms = productEdit.platforms || [];
    var platformOptions = '<option value="">未填写</option>' + platforms.map(function (platform) {
      return '<option value="' + esc(platform.id) + '"' + (value === platform.id ? ' selected' : '') + '>' + esc(platform.label) + '</option>';
    }).join('');
    if (type === 'platform' && value && !platforms.some(function (platform) { return platform.id === value; })) {
      platformOptions += '<option value="' + esc(value) + '" selected disabled>' + esc(value) + '（已停用，请重新选择）</option>';
    }
    var input = type === 'platform' ? '<select' + common + '>' + platformOptions + '</select>' : type === 'status' ? '<select' + common + '><option value="active"' + (value === 'active' ? ' selected' : '') + '>在售</option><option value="paused"' + (value === 'paused' ? ' selected' : '') + '>暂停</option></select>'
      : type === 'boolean' ? '<input type="checkbox"' + common + (value ? ' checked' : '') + '>'
      : '<input type="' + (type === 'integer' ? 'number' : type) + '"' + common + (type === 'number' ? ' min="0" step="0.01"' : type === 'integer' ? ' min="' + (key === 'moq' ? '1' : '0') + '" step="1"' : '') + ' value="' + esc(value == null ? '' : value) + '">';
    return '<label>' + esc(field[1]) + input + '</label>';
  }).join('');
  var labels = ${JSON.stringify({ overview: "商品简介", ...PUBLIC_DETAIL_LABELS })};
  fields += Object.keys(labels).map(function (key) {
    return '<label>' + esc(labels[key]) + '<input type="text" maxlength="360" id="product-detail-' + key + '" value="' + esc((record.public_details || {})[key] || '') + '"' + (frozen ? ' disabled' : '') + '></label>';
  }).join('');
  return '<tr data-sku="' + esc(record.sku) + '"><td colspan="' + (productPublication.canPublish ? 17 : 16) + '"><div class="card"><h3>修改商品 · ' + esc(record.sku) + '</h3>' +
    '<p class="muted">SKU 是商品唯一编号，不可修改。商品页链接由交易平台与商品ID生成。商品名、价格、库存为必填；0 表示无库存。</p>' +
    '<div class="product-edit-grid">' + fields + '</div><div class="row">' +
    '<button type="button" class="act primary" id="product-edit-save" onclick="saveProduct()"' + (productEdit.stale ? ' disabled' : '') + '>' + (frozen ? '重试原保存' : '保存') + '</button> ' +
    '<button type="button" class="act" onclick="cancelProductEdit()"' + (frozen ? ' disabled' : '') + '>取消</button></div>' +
    '<p id="product-edit-message" role="status">' + (frozen ? '保存结果待确认，请重试原保存；不会重复生成变更。' : '保存后可在下方发布商品。') + '</p></div></td></tr>';
}
function repaintProducts() { $("view").innerHTML = renderProducts(productRows, productPublication); }
async function editProduct(index) {
  if (productEdit || publicationBusy || publicationDraft) { bar('请先完成当前修改或发布', true); return; }
  var item = productRows[index]; if (!item) return;
  try {
    var state = await call('GET', '/products/edit-state?sku=' + encodeURIComponent(item.sku));
    if (productEdit || publicationBusy || publicationDraft || current !== 'products') return;
    if (!state.table.products[0].category) state.table.products[0].category = (productPublication.categories || {})[item.sku];
    productEdit = { sku: item.sku, table: state.table, platforms: state.platforms, base_digest: state.base_digest, commit: null, busy: false };
    repaintProducts();
  } catch (error) { bar(error.message, true); }
}
function cancelProductEdit() {
  if (!productEdit || productEdit.busy || productEdit.commit) return;
  productEdit = null; repaintProducts();
}
async function saveProduct() {
  var edit = productEdit; if (!edit || edit.busy) return;
  if (edit.stale) { bar('商品已被更新，请取消后重新修改', true); return; }
  edit.busy = true;
  try {
    if (!edit.commit) {
      var record = Object.assign({}, edit.table.products[0]);
      productFields.forEach(function (field) {
        var key = field[0], input = $('product-edit-' + key), type = field[2];
        var raw = String(input.value || '').trim();
        if (type === 'boolean') { record[key] = input.checked; return; }
        if (raw === '') { if (field[3]) throw new Error(field[1] + '不能为空'); delete record[key]; return; }
        if (type === 'number' || type === 'integer') {
          var value = Number(raw);
          if (!Number.isFinite(value) || value < 0 || (type === 'integer' && !Number.isSafeInteger(value)) || (key === 'moq' && value < 1)) throw new Error(field[1] + '格式不正确');
          record[key] = value;
        } else record[key] = raw;
      });
      var details = {}; var labels = ${JSON.stringify({ overview: "商品简介", ...PUBLIC_DETAIL_LABELS })};
      Object.keys(labels).forEach(function (key) { var value = String($('product-detail-' + key).value || '').trim(); if (value) details[key] = value; });
      record.public_details = details;
      var table = Object.assign({}, edit.table, { products: [record] });
      edit.table = table;
        var draft = await call('POST', '/products/import-drafts', { table: table, base_digest: edit.base_digest });
      edit.table = table;
      edit.commit = { path: '/products/import-drafts/' + encodeURIComponent(draft.draft_id) + '/commit', body: { expected_draft_digest: draft.digest, idempotency_key: key('product-edit') } };
      repaintProducts();
    }
    var receipt = await call('POST', edit.commit.path, edit.commit.body);
    if (receipt.status !== 'succeeded') throw new Error('保存结果待确认，请重试原保存');
      productPendingPublication[edit.sku] = true;
    productEdit = null;
    if (current === 'products') $("view").innerHTML = await views.products();
    bar('商品已保存，请点击下方「发布商品」更新公开资料');
  } catch (error) {
    if (error.status === 409) { edit.commit = null; edit.stale = true; if (current === 'products') repaintProducts(); }
    if (productEdit === edit) {
      $('product-edit-message').textContent = error.message + (edit.stale ? '；请取消后重新修改以读取最新商品。' : edit.commit ? '；请重试原保存确认结果。' : '；未保存，请修正后重试；资料已变化时请取消并重新修改。');
    }
    bar(error.message, true);
  } finally { edit.busy = false; }
}
/** 商品页统一渲染：一张表同时承载商品信息、目录发布状态与发布选择。 */
function renderProducts(items, publication) {
  var list = items || [];
  var pub = publication || {};
  productRows = list; productPublication = pub;
  var canPublish = pub.canPublish === true;
  var known = pub.known === true;
  var published = pub.published || {};
  var publishedCount = 0;
  for (var n = 0; n < list.length; n++) {
    if (published[list[n].sku]) publishedCount += 1;
  }
  var rows = list.map(function (it) {
    var sku = esc(it.sku);
    if (FILE_PRODUCTS) return fileProductRow(it, list.indexOf(it), canPublish, published, known);
    var money = it.money || {};
    return "<tr><td>" + sku + "</td><td>" + esc(it.title) + "</td><td>" +
      esc(money.currency || "-") + " " + esc(money.amount_minor == null ? "-" : money.amount_minor) +
      "（最小币单位）</td><td>" + esc(it.stock == null ? 0 : it.stock) + "</td><td>" +
      esc(it.authority_version == null ? "-" : it.authority_version) + "</td></tr>";
  }).join("");
  var summary = canPublish
    ? '<p class="muted" id="pub-summary">已发布到Kiwi网关 ' + publishedCount + " 件，未发布 " + (list.length - publishedCount) + " 件。" +
      (known ? "" : "Kiwi网关发布状态暂不可读取，刷新后重试。") + "</p>"
    : "";
  var header = canPublish
    ? "<tr><th>SKU</th><th>名称</th><th>状态</th><th>Kiwi网关状态</th><th>分类（必填）</th><th>单价</th><th>起订量</th><th>数据有效期</th><th>交易平台</th><th>平台商品ID</th><th>平台商品页链接</th><th>库存</th><th>供货说明</th><th>更新时间</th><th>测试商品</th><th>商品介绍与规格</th><th>操作</th></tr>"
    : (FILE_PRODUCTS
      ? "<tr><th>SKU</th><th>名称</th><th>类目</th><th>单价</th><th>起订量</th><th>数据有效期</th><th>状态</th><th>交易平台</th><th>平台商品ID</th><th>平台商品页链接</th><th>库存</th><th>供货说明</th><th>更新时间</th><th>测试商品</th><th>商品介绍与规格</th><th>操作</th></tr>"
      : "<tr><th>SKU</th><th>名称</th><th>价格（最小币单位）</th><th>库存</th><th>版本</th></tr>");
  var table = '<div class="table-scroll"><table' + (canPublish ? ' id="pub-table"' : '') + ">" + header +
    (FILE_PRODUCTS ? '<tbody id="pub-rows">' + rows + "</tbody>" : rows) + "</table></div>";
  var importControls = '<div class="row"><input type="file" id="pfile" aria-label="选择商品导入文件" accept=".json,.csv,.xlsx">' +
    '<button type="button" class="act" onclick="previewImport()">导入文件</button> ' +
    '<a href="/merchant/product-help.html" target="_blank" rel="noopener">使用说明</a></div><div id="presult"></div>';
  var publishControls = canPublish && list.length > 0
    ? '<button type="button" class="act primary" id="pub-submit" onclick="publishProducts()">发布商品</button>' +
      '<div id="publication-result" role="status">' + publicationResult + '</div>'
    : "";
  return '<section class="card">' + importControls + '<h2>商品列表（' + list.length + '）</h2>' + summary +
    (rows ? table : '<p class="muted">暂无商品，请导入文件。</p>') + publishControls + '</section>';
}

var ALIPAY_COLLECTION = "/collection/alipay";
function renderAlipayCollection(config) {
  return '<section class="card"><h2>支付宝收款</h2>' +
    '<p>状态：<strong>' + (config.enabled ? "已启用" : "已关闭") + '</strong> · 收款主体：' + esc(config.recipient_masked || "未设置") +
    ' · 账号：' + esc(config.account_masked || "未设置") + ' · 收款码：' + (config.has_qr ? "已设置" : "未设置") + '</p>' +
    '<p class="muted">只向符合条件的已确认交易提供收款指引。买家在支付宝自行付款，你在支付宝核对到账；Kiwi 不执行支付、不确认到账。</p>' +
    (config.enabled ? '<p><button type="button" class="act" id="alipay-disable">停用收款方式</button></p>' : '') +
    '<form class="collection-form" id="alipay-form" autocomplete="off" data-version="' + esc(config.version || "") + '">' +
    '<label>收款主体名称<input id="alipay-recipient" type="text" required maxlength="80" autocomplete="off"></label>' +
    '<label>支付宝账号（手机号或邮箱）<input id="alipay-account" type="text" maxlength="128" autocomplete="off"></label>' +
    '<label>支付宝官方静态收款码（PNG，最多 256 KiB）<input id="alipay-qr" type="file" accept="image/png,.png"></label>' +
    '<p class="muted">账号和收款码至少填一项。保存会替换现有收款资料，未填写的项目不会保留。Kiwi 不验证账号归属或二维码内容，请自行核对。</p>' +
    '<label><input id="alipay-enabled" type="checkbox"' + (config.enabled ? " checked" : "") + '> 启用收款方式</label>' +
    '<div><button type="submit" class="act" id="alipay-preview">预览收款设置</button></div>' +
    '<div id="alipay-review" class="card" hidden><h3>确认收款设置</h3><p id="alipay-review-text"></p>' +
    '<img id="alipay-review-qr" alt="待保存的支付宝收款码" hidden>' +
    '<p><label><input id="alipay-rights" type="checkbox"> 我已核对预览，并确认有权使用该收款主体、账号或收款码。</label></p>' +
    '<button type="button" class="act primary" id="alipay-save" disabled>确认保存</button></div></form></section>';
}
function readAlipayPng(file) {
  if (!file) return Promise.resolve(undefined);
  if (file.size > 256 * 1024 || file.type !== "image/png") return Promise.reject(new Error("请选择不超过 256 KiB 的 PNG 文件"));
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function () { reject(new Error("PNG 文件无法读取")); };
    reader.onload = function () { resolve(String(reader.result).split(",", 2)[1]); };
    reader.readAsDataURL(file);
  });
}
function bindAlipayCollection() {
  var form = $("alipay-form");
  if (!form) return;
  var version = form.getAttribute("data-version") || null;
  var review = $("alipay-review"), text = $("alipay-review-text"), qr = $("alipay-review-qr");
  var rights = $("alipay-rights"), save = $("alipay-save"), preview = $("alipay-preview"), disable = $("alipay-disable");
  var pending = null, imageReady = false, busy = false, edits = 0;
  function syncButtons() {
    save.disabled = busy || !pending || !imageReady || !rights.checked;
    preview.disabled = busy;
    if (disable) disable.disabled = busy;
  }
  function clearPreview() {
    pending = null;
    imageReady = false;
    qr.onload = qr.onerror = null;
    qr.removeAttribute("src");
    qr.hidden = review.hidden = true;
    text.textContent = "";
    rights.checked = false;
    syncButtons();
  }
  form.oninput = function (event) { if (event.target !== rights) { edits += 1; clearPreview(); } };
  rights.onchange = syncButtons;
  form.onsubmit = async function (event) {
    event.preventDefault();
    if (busy) return;
    var edit = edits;
    var draft = { expected_version: version, enabled: $("alipay-enabled").checked, recipient: $("alipay-recipient").value.trim() };
    var account = $("alipay-account").value.trim(), file = $("alipay-qr").files[0];
    if (account) draft.account = account;
    busy = true;
    clearPreview();
    try {
      var png = await readAlipayPng(file);
      if (!form.isConnected || edits !== edit) return;
      if (png) draft.qr_png_base64 = png;
      var result = await call("POST", ALIPAY_COLLECTION + "/preview", draft);
      if (!form.isConnected || edits !== edit) return;
      pending = { draft: draft, confirmation: result.confirmation_ref };
      text.textContent = (draft.enabled ? "启用 · " : "保存但保持关闭 · ") + draft.recipient + (account ? " · " + account : "");
      review.hidden = false;
      imageReady = !png;
      if (png) {
        qr.onload = function () { imageReady = true; syncButtons(); };
        qr.onerror = function () { clearPreview(); bar("收款码无法显示，请更换有效的 PNG 文件。", true); };
        qr.hidden = false;
        qr.src = "data:image/png;base64," + png;
      }
    } catch (error) {
      if (form.isConnected) bar(error.message, true);
    } finally { busy = false; syncButtons(); }
  };
  async function apply(path, body, message) {
    busy = true;
    syncButtons();
    try {
      await call("POST", path, body);
      if (form.isConnected) { form.reset(); clearPreview(); bar(message); refresh(); }
    } catch (error) {
      if (form.isConnected) { clearPreview(); bar(error.message, true); }
    } finally { busy = false; syncButtons(); }
  }
  save.onclick = function () {
    if (busy || !pending || !imageReady || !rights.checked) return;
    apply(ALIPAY_COLLECTION, Object.assign({}, pending.draft, { confirmation_ref: pending.confirmation, confirm_owner_rights: true }), "收款设置已保存");
  };
  if (disable) disable.onclick = function () {
    if (busy || !window.confirm("停用后，旧的 Kiwi 收款入口将无法打开；买家已保存的账号或静态码无法撤回。确认停用？")) return;
    apply(ALIPAY_COLLECTION + "/disable", { expected_version: version, confirm_disable: true }, "支付宝收款方式已停用");
  };
}

function renderAlipayApprovals(items, version) {
  var rows = items.map(function (item) {
    var heading = item.sku + " · " + item.quantity + (item.unit ? " " + item.unit : "");
    return '<form class="collection-form card" data-alipay-approval="' + esc(item.approval_id) + '" data-version="' + esc(version) + '" data-buyer-offer="' + esc(item.buyer_offer_minor) + '">' +
      '<h3>' + esc(heading) + '</h3><p>磋商：' + esc(item.negotiation_id) + ' · 买家还价单价：' + esc(item.buyer_offer_minor) + ' 分</p>' +
      (item.expires_at ? '<p>待批截止：' + esc(item.expires_at) + '</p>' : '') +
      '<label>批准单价（人民币分）<input name="approved_minor" type="number" inputmode="numeric" required min="1" step="1"></label>' +
      '<label>最终应付总额（人民币分，包括适用的运费、税费及其他费用）<input name="alipay_total_minor" type="number" inputmode="numeric" required min="1" step="1"></label>' +
      '<label><input name="confirm_final_total" type="checkbox" required> 我已核对该商品、数量及费用，并确认这是买家应付的完整人民币总额。</label>' +
      '<div><button type="submit" class="act primary">批准该报价金额</button></div></form>';
  }).join("");
  return '<section class="card"><h2>待确认支付宝报价</h2>' +
    '<p class="muted">仅列出等待人工审批的人民币报价。批准后，符合条件的报价可在买家确认交接时提供支付宝收款指引；这里不会执行支付。</p>' +
    (rows || '<p class="muted">暂无待确认的人民币报价。</p>') + '</section>';
}
function bindAlipayApprovals() {
  Array.prototype.forEach.call($("view").querySelectorAll("[data-alipay-approval]"), function (form) {
    var button = form.querySelector("button");
    form.onsubmit = async function (event) {
      event.preventDefault();
      if (button.disabled || !form.elements.confirm_final_total.checked) return;
      var single = form.elements.approved_minor.valueAsNumber, total = form.elements.alipay_total_minor.valueAsNumber;
      if (!Number.isSafeInteger(single) || !Number.isSafeInteger(total) || single < 1 || total < 1) {
        bar("单价和最终应付总额都必须是正整数分。", true);
        return;
      }
      var aboveBuyerOffer = single > Number(form.getAttribute("data-buyer-offer"));
      var warning = aboveBuyerOffer ? "注意：批准单价高于买家原还价，这是给买家的新报价，并不代表买家已同意。 " : "";
      if (!window.confirm(warning + "确认 " + form.querySelector("h3").textContent + "：单价 " + single + " 分，最终应付总额 " + total + " 分？")) return;
      button.disabled = true;
      try {
        await call("POST", ALIPAY_COLLECTION + "/approvals", {
          approval_id: form.getAttribute("data-alipay-approval"), expected_version: form.getAttribute("data-version"),
          approved_minor: single, alipay_total_minor: total, confirm_final_total: true,
        });
        if (form.isConnected) { bar("报价金额已批准"); refresh(); }
      } catch (error) {
        if (form.isConnected) { form.elements.confirm_final_total.checked = false; bar(error.message, true); }
      } finally { button.disabled = false; }
    };
  });
}

function mountSupport(sequence) {
  var root = $("support-content");
  var idPattern = /^CS-[0-9a-f-]{36}$/;
  var labels = { WAITING_MERCHANT: "等待领取", IN_PROGRESS: "人工处理中", RESOLVED: "本地工单已解决" };
  var selection = 0;
  function visible() { return current === "support" && sequence === viewSequence; }
  function problem(error) { if (visible()) bar(error.message, true); }
  function text(parent, tag, value) {
    var node = document.createElement(tag); node.textContent = value; parent.appendChild(node); return node;
  }
  function button(parent, title, action) {
    var node = text(parent, "button", title);
    node.type = "button"; node.className = "act"; node.onclick = action; return node;
  }
  function detail(id) {
    if (!idPattern.test(id)) return;
    var selected = ++selection;
    var panel = $("support-detail"); panel.textContent = "";
    call("GET", "/support/cases/" + id).then(function (item) {
      if (!visible() || selection !== selected) return;
      text(panel, "h3", item.case_id + " · " + labels[item.state]);
      if (item.sku) text(panel, "p", "SKU：" + item.sku);
      text(panel, "p", item.description);
      item.replies.forEach(function (entry) {
        text(panel, "p", (entry.kind === "resolved" ? "解决说明：" : "已保存：") + entry.text);
      });
      if (!item.access_active) { text(panel, "p", "买家原会话不可继续，不代表工单已关闭。"); return; }
      function change(action, payload) {
        var controls = Array.from(panel.querySelectorAll("button"));
        controls.forEach(function (control) { control.disabled = true; });
        payload.expected_revision = item.revision;
        call("POST", "/support/cases/" + id + "/" + action, payload).then(function () {
          if (!visible() || selection !== selected) return;
          bar(action === "reply" ? "已保存，可供原会话查看；未核实交付。" : "工单已更新。", false);
          load(); detail(id);
        }).catch(function (error) {
          if (selection === selected) problem(error);
        }).finally(function () { controls.forEach(function (control) { control.disabled = false; }); });
      }
      if (item.state === "WAITING_MERCHANT") {
        button(panel, "领取工单", function () { change("claim", {}); });
      } else if (item.state === "IN_PROGRESS" && item.held_by_me) {
        var label = text(panel, "label", "人工说明 ");
        var field = document.createElement("textarea"); field.maxLength = 2000; label.appendChild(field);
        function save(action) {
          if (!field.value.trim()) { bar("请先填写人工说明。", true); return; }
          if (!window.confirm(action === "reply" ? "将说明保存为买家在原会话可见的人工回复？" : "标记本地工单已解决并保存处理说明？")) return;
          change(action, { text: field.value });
        }
        button(panel, "保存给买家查看", function () { save("reply"); });
        button(panel, "记录解决", function () { save("resolve"); });
      }
      button(panel, "撤销买家会话访问", function () {
        if (window.confirm("使同一浏览器会话无法继续查看所有关联工单？此操作不会关闭工单。")) change("revoke", {});
      });
    }).catch(function (error) { if (selection === selected) problem(error); });
  }
  function load() {
    call("GET", "/support/cases").then(function (data) {
      if (!visible()) return;
      root.textContent = "";
      if (!data.cases.length) text(root, "p", "没有已登记的工单。");
      data.cases.forEach(function (item) {
        button(root, item.case_id + " · " + labels[item.state], function () { detail(item.case_id); });
      });
    }).catch(problem);
  }
  $("support-refresh").onclick = load;
  load();
}

function mountBuyerFollowups(sequence) {
  var root = $("buyer-followups-content");
  if (!root) return;
  call("GET", "/buyer-followups").then(function (data) {
    if (sequence !== viewSequence) return;
    root.textContent = "";
    var cases = data.cases || [];
    if (!cases.length) { root.textContent = "暂无待确认事项。"; return; }
    cases.forEach(function (item) {
      var section = document.createElement("section"); section.className = "card";
      var title = document.createElement("p");
      var topics = { customization: "定制", capacity: "容量", features: "特点", overview: "简介", material: "材质", dimensions: "尺寸", weight: "重量", color: "颜色", delivery: "交期", stock: "备货", title: "名称" };
      var states = { pending: "待认领", in_progress: "处理中", answered: "已确认", closed_without_answer: "已关闭" };
      title.textContent = item.sku + " · " + (topics[item.topic] || item.topic) + " · " + (states[item.status] || item.status) + (item.quantity == null ? "" : " · 数量 " + item.quantity);
      section.appendChild(title);
      var ref = document.createElement("p"); ref.className = "muted";
      ref.textContent = item.case_ref + " · " + item.negotiation_id; section.appendChild(ref);
      var draft;
      function act(kind, label) {
        var button = document.createElement("button"); button.type = "button"; button.className = "act"; button.textContent = label;
        button.onclick = function () {
          var body = { version: item.version };
          if (kind === "answer") { body.answer = draft.value.trim(); if (!body.answer) { bar("请输入确认内容", true); return; } }
          button.disabled = true;
          call("POST", "/buyer-followups/" + encodeURIComponent(item.case_ref) + "/" + kind, body)
            .then(function () { if (sequence === viewSequence) mountBuyerFollowups(sequence); })
            .catch(function (e) { if (sequence === viewSequence) { bar(e.message, true); button.disabled = false; } });
        };
        section.appendChild(button);
      }
      if (item.status === "pending") act("claim", "认领");
      if (item.status === "in_progress") {
        draft = document.createElement("textarea"); draft.maxLength = 600;
        draft.setAttribute("aria-label", "对买家的事实答复"); draft.placeholder = "仅填写本问题的事实答复，不要填写报价、隐私或内部条款。";
        section.appendChild(draft); act("answer", "确认供原买家查阅");
      }
      if (item.status === "pending" || item.status === "in_progress") act("close", "关闭（无答案）");
      if (item.status === "answered") act("close", "撤回已确认答案");
      root.appendChild(section);
    });
  }).catch(function (e) { if (sequence === viewSequence) root.textContent = e.message; });
}
var views = {
  buyerFollowups: function () {
    return Promise.resolve('<section class="card"><h2>买家待确认</h2><p>确认后只供原买家主动查询，不发微信、不改变报价。</p><div id="buyer-followups-content">加载中…</div></section>');
  },
  support: function () {
    return Promise.resolve('<section class="card"><h2>人工售后</h2><p>仅本地预览：不验证订单，不代表外部平台处理。</p>' +
      '<button class="act" type="button" id="support-refresh">刷新待办</button><div id="support-content"></div><div id="support-detail"></div></section>');
  },
  weixin: function () {
    return Promise.resolve('<div class="card"><h2>个人微信连接</h2>' +
      '<p class="muted">扫码确认后，只有配对的店主可以与 Kiwi 对话。微信不发送买家消息，也不批准正式操作。</p>' +
      (WEIXIN_ONLY ? '' : '<p><a href="/merchant/weixin">打开手机配对与授权页</a></p>') +
      '<div id="weixin-panel"><p role="status">正在读取连接状态…</p></div></div>' +
      (WEIXIN_ONLY ? '' : '<section class="card" id="weixin-model-settings"><h2>店主微信对话模型</h2>' +
        '<div id="weixin-model-form-area"><p role="status">正在读取模型配置…</p></div></section>') +
      (WEIXIN_ONLY ? '<section class="card" id="weixin-mobile-drafts" hidden><h2>草稿</h2>' +
        '<p>只有登录后的店主能在本页查看草稿。保存或放弃都不会向买家发送消息。</p>' +
        '<button type="button" class="act" id="weixin-draft-refresh">刷新草稿</button>' +
        '<div id="weixin-draft-list"></div><div id="weixin-draft-editor"></div></section>' : ''));
  },
  collection: async function () {
    var config = await call("GET", ALIPAY_COLLECTION);
    var html = renderAlipayCollection(config);
    if (!config.enabled) return html;
    try {
      var approvals = await call("GET", ALIPAY_COLLECTION + "/approvals");
      return html + renderAlipayApprovals(approvals.items, config.version);
    } catch (error) {
      if (error.message === "需要登录") throw error;
      return html + '<section class="card"><h2>待确认支付宝报价</h2><p>暂时无法读取待审批列表。</p></section>';
    }
  },
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
        html += '<p class="muted">名片可先发布。请在「商品与导入」准备首个可报价 SKU；导入与商品发布是两次确认。</p>';
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
      return appendCatalogSetup(html + "</div>");
    });
  },
  products: function () {
    // 云端导入表与 exact 商品库是不同权威源；按装配选择，不能把空 exact 库当作导入失败。
    // 商品可能超过 100 件：跟随 next_cursor 拉全量，保证全部可选、计数准确。
    var base = FILE_PRODUCTS ? "/merchant/api" : API;
    var items = [];
    var canPublish = FILE_PRODUCTS && CATALOG_CONNECT && ROLE === "owner";
    var published = Object.create(null);
    var categories = Object.create(null);
    var known = false;
    function loadPage(cursor, page) {
      var path = "/products?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      return call("GET", path, undefined, base).then(function (p) {
        items = items.concat(p.items || []);
        var next = p.next_cursor;
        if (typeof next === "string" && next !== "" && page < 50) return loadPage(next, page + 1);
      });
    }
    var statusPromise = canPublish
      ? call("GET", "/products/publication-status").then(function (result) {
          var rows = (result && result.results) || [];
          for (var i = 0; i < rows.length; i++) {
            var sku = String(rows[i].sku || "");
            if (!sku) continue;
            var state = String(rows[i].publication_state || "");
            if (!published[sku] || state.toLowerCase() === "active") {
              published[sku] = state;
              categories[sku] = rows[i].category || "";
            }
          }
          known = true;
        }).catch(function () { known = false; })
      : Promise.resolve();
    return Promise.all([loadPage("", 0), statusPromise]).then(function () {
      return renderProducts(items, { canPublish: canPublish, known: known, published: published, categories: categories });
    });
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
    return Promise.all([
      call("GET", "/policy"),
      // 商品源不可读时仍保留高级 JSON 模式；规则页不应整体 503。
      call("GET", "/products?limit=100").catch(function () { return { items: [] }; }),
    ]).then(function (results) {
      var pol = results[0] || {};
      var products = (results[1] && results[1].items) || [];
      POLICY_SUMMARY = pol;
      POLICY_PRODUCTS = products;
      var autoOn = pol.auto_quote !== false;
      var productRows = products.map(function (it) {
        var sku = String(it.sku || "");
        var currentDiscount = pol.sku_discounts && pol.sku_discounts[sku] != null
          ? String(pol.sku_discounts[sku]) : "";
        var floorConfigured = (pol.sku_floors_configured || []).indexOf(sku) !== -1;
        var price = it.money && it.money.amount_minor != null
          ? esc(it.money.currency || "") + " " + (Number(it.money.amount_minor) / 100).toFixed(2)
          : (it.currency ? esc(it.currency) + " " + esc(it.price) : "-");
        return '<tr data-sku="' + esc(sku) + '" data-current-discount="' + esc(currentDiscount) +
          '" data-floor-configured="' + (floorConfigured ? "1" : "0") + '">' +
          '<td class="mono">' + esc(sku) + '<input type="hidden" class="sku-rule-sku" value="' + esc(sku) + '"></td>' +
          '<td>' + esc(it.title || "-") + '<div class="muted">' + esc(productStatusLabel(it)) + "</div></td>" +
          '<td>' + price + "</td>" +
          '<td>' + esc(currentDiscount === "" ? "继承全局 " + (pol.global_discount == null ? 0 : pol.global_discount) + "%" : currentDiscount + "%") + "</td>" +
          '<td><input type="text" class="sku-rule-discount" inputmode="decimal" placeholder="新折扣 %" aria-label="' + esc(sku) + ' 新折扣"></td>' +
          '<td>' + esc(floorConfigured ? "已设置（不显示）" : "未设置") + "</td>" +
          '<td><input type="text" class="sku-rule-floor" inputmode="decimal" placeholder="新底价（元）" aria-label="' + esc(sku) + ' 新底价"></td>' +
          '<td><label class="consent-label"><input type="checkbox" class="sku-rule-clear-floor"' + (floorConfigured ? "" : " disabled") + "> 清除</label></td>" +
          '<td><label class="consent-label"><input type="checkbox" class="sku-rule-clear-discount"' + (currentDiscount === "" ? " disabled" : "") + "> 清除</label></td>" +
          "</tr>";
      }).join("");
      var skuTable = products.length
        ? '<div class="table-scroll"><table id="pf-sku-rules"><thead><tr><th>SKU</th><th>商品</th><th>当前价</th><th>当前折扣</th><th>新折扣</th><th>当前底价</th><th>新底价</th><th>清除底价</th><th>清除折扣</th></tr></thead><tbody>' +
          productRows + "</tbody></table></div>" +
          '<button class="act" type="button" onclick="addSkuRuleRow()">添加未列出的 SKU</button>'
        : '<p class="muted">商品源暂不可读；仍可用下方高级 JSON 模式。恢复商品源后这里会按商品逐行显示。</p>';
      return '<div class="card"><h2>当前报价规则</h2><table>' +
        "<tr><th>规则版本</th><td>" + esc(pol.policy_revision) + "</td></tr>" +
        '<tr><th>内容摘要</th><td><pre class="digest">' + esc(pol.digest) + "</pre></td></tr></table>" +
        '<p class="muted">底价等敏感值不出现在本页接口；提交草稿后由系统校验并原子生效。' +
        "上架/下架在Kiwi网关商家后台设置；商品上架后长期有效。数据有效期只影响自动报价，不改变上架状态。</p></div>" +
        (ROLE === "owner" || ROLE === "operator"
          ? '<div class="card"><h2>常用规则表单</h2>' +
            '<p class="muted">留空的全局字段不会写进补丁；按商品规则只提交你填写或勾选清除的行。提交后生成规则变更草稿，再确认才生效。</p>' +
            '<table>' +
            '<tr><th>自动应价</th><td><select id="pf-auto">' +
            '<option value="on"' + (autoOn ? " selected" : "") + ">开启</option>" +
            '<option value="off"' + (autoOn ? "" : " selected") + ">关闭</option></select>" +
            '<span class="muted">默认开启；关闭后新询价转人工处理</span></td></tr>' +
            '<tr><th>全局最低单价（元）</th><td><input type="text" id="pf-floor" placeholder="留空不修改"></td></tr>' +
            '<tr><th>最大自动折扣（%）</th><td><input type="text" id="pf-discount" placeholder="0–100，留空不修改"></td></tr>' +
            '<tr><th>交期承诺（天）</th><td><input type="text" id="pf-lead" placeholder="正数，留空不修改"></td></tr>' +
            '<tr><th>报价有效期（秒）</th><td><input type="text" id="pf-ttl" placeholder="正数，留空不修改"></td></tr>' +
            '<tr><th>按商品规则</th><td>' + skuTable +
            '<span class="muted">为每件商品单独设置常态折扣与私有底价；未填写的行保持原值。当前底价金额不回显（隐私），只显示是否已设置。</span></td></tr>' +
            '<tr><th>超出范围转人工</th><td><span class="row">' +
            '<label><input type="checkbox" id="pf-hr-below" checked> 低于底价</label>' +
            '<label><input type="checkbox" id="pf-hr-warranty"> 特殊售后条款</label>' +
            '<label><input type="checkbox" id="pf-hr-suspicious"> 可疑内容</label></span>' +
            '<select id="pf-hr"><option value="">不修改</option><option value="set">按左侧勾选设置</option></select></td></tr>' +
            "</table>" +
            '<div class="row" style="margin-top:8px"><button class="act primary" onclick="draftPolicyForm()">生成规则草稿</button>' +
            '<span class="muted">促销与库存来源等复杂字段仍用下方高级模式。</span></div><div id="polformresult"></div></div>' +
            '<div class="card"><h2>高级：JSON patch 模式</h2>' +
            '<p class="muted">仅用于促销、库存来源等无法用上表表达的完整 patch；字段名以策略 schema 文档为准，不在页面枚举。</p>' +
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
    var clearDiscount = rows[i].querySelector(".sku-rule-clear-discount");
    var clearFloor = rows[i].querySelector(".sku-rule-clear-floor");
    var sku = skuEl ? String(skuEl.value || "").trim() : "";
    var discountRaw = discountEl ? String(discountEl.value || "").trim() : "";
    var floorRaw = floorEl ? String(floorEl.value || "").trim() : "";
    var clearingDiscount = !!(clearDiscount && clearDiscount.checked);
    var clearingFloor = !!(clearFloor && clearFloor.checked);
    var hasChange = discountRaw !== "" || floorRaw !== "" || clearingDiscount || clearingFloor;
    if (!hasChange) continue;
    if (sku === "") continue;
    if (seen[sku]) { bar("SKU 规则：SKU 重复：" + sku, true); return null; }
    seen[sku] = true;
    var rule = { sku: sku };
    if (discountRaw !== "" && clearingDiscount) {
      bar("SKU 规则：" + sku + " 不能同时填写并清除折扣", true);
      return null;
    }
    if (floorRaw !== "" && clearingFloor) {
      bar("SKU 规则：" + sku + " 不能同时填写并清除底价", true);
      return null;
    }
    if (clearingDiscount) rule.discount = null;
    if (clearingFloor) rule.floor = null;
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
  // 自动应价没有“不修改”：默认开启，提交时始终带上当前选择。
  var auto = $("pf-auto") ? $("pf-auto").value : "on";
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
function publishProducts() {
  if (publicationBusy) return;
  if (publicationDraft !== null) { bar("请先处理上次发布的回执", true); return; }
  if (productEdit) {
    bar("请先保存或取消商品修改，再发布", true);
    return;
  }
  publicationBusy = true;
  lockPublicationSelection(true);
  showPublicationResult("<p>正在检查商品变更…</p>");
  return call("POST", "/products/publication-drafts", { changes_only: true, selections: [] }).then(function (plan) {
    var missing = plan.missing_categories || [];
    if (missing.length || !plan.draft) {
      showPublicationResult(missing.length
        ? "<p>请点击「修改」，为这些商品填写类目并保存：" + missing.map(esc).join("、") + "</p>"
        : "<p>没有需要发布的商品变更。</p>");
      lockPublicationSelection(false);
      return;
    }
    publicationDraft = plan.draft;
    return submitPublication();
  }).catch(function (err) {
    showPublicationResult("<p>未能准备发布：" + esc(err.message) + "</p>");
    lockPublicationSelection(false);
  }).finally(function () { publicationBusy = false; });
}
/** 发布/续办后只刷新目录状态列与摘要，不覆盖发布回执。 */
function refreshPublicationStatus() {
  if (!(FILE_PRODUCTS && CATALOG_CONNECT && ROLE === "owner")) return Promise.resolve();
  return call("GET", "/products/publication-status").then(function (result) {
    var published = Object.create(null);
    var rows = (result && result.results) || [];
    for (var i = 0; i < rows.length; i++) {
      var sku = String(rows[i].sku || "");
      if (!sku) continue;
      var state = String(rows[i].publication_state || "");
      if (!published[sku] || state.toLowerCase() === "active") {
        published[sku] = state;
      }
    }
    var trs = document.querySelectorAll("#pub-rows tr");
    var publishedCount = 0;
    for (var j = 0; j < trs.length; j++) {
      var rowSku = String(trs[j].getAttribute("data-sku") || "");
      var current = published[rowSku];
      if (String(current || "").toLowerCase() === "active") publishedCount += 1;
      var cell = trs[j].querySelector(".pub-state");
      if (cell) cell.textContent = productPendingPublication[rowSku] ? "修改待发布" : publicationStateLabel(current, true);

    }
    var summary = $("pub-summary");
    if (summary) {
      summary.textContent = "已发布到Kiwi网关 " + publishedCount + " 件，未发布 " + Math.max(0, trs.length - publishedCount) + " 件。";
    }
  }).catch(function () {
    document.querySelectorAll("#pub-rows .pub-state").forEach(function (cell) { cell.textContent = "待核验"; });
    var summary = $("pub-summary");
    if (summary) summary.textContent = "Kiwi网关商品发布状态待核验。";
    bar("Kiwi网关发布状态暂不可读取，请稍后刷新。", true);
  });
}
function publicationRecoveryControls() {
  return '<button type="button" class="act" onclick="checkPublication()">查看发布回执</button> ' +
    '<button type="button" class="act primary" onclick="commitPublication()">继续本次发布</button> ' +
    '<button type="button" class="act" onclick="resetPublication()">返回商品列表</button>';
}
function submitPublication() {
  var draft = publicationDraft;
  return call("POST", "/products/publication-drafts/" + encodeURIComponent(draft.draft_id) + "/commit", {
    expected_digest: draft.digest, confirm_publication: true,
  }).then(function (receipt) {
    var total = receipt.succeeded + receipt.failed + receipt.pending;
    var counts = "共 " + total + " 件：成功 " + receipt.succeeded + "，失败 " + receipt.failed + "，待确认 " + receipt.pending;
    showPublicationResult(renderPublicationReceipts(receipt.results, "发布结果", counts) +
      (receipt.status !== "succeeded" ? publicationRecoveryControls() : ""));
    (receipt.results || []).forEach(function (result) { if (result.status === "succeeded") { delete productPendingPublication[result.sku]; } });
    if (receipt.status === "succeeded") {
      publicationDraft = null;
      lockPublicationSelection(false);
    }
    return refreshPublicationStatus();
  }).catch(function (err) {
    showPublicationResult("<p>" + esc(err.message) + "</p>" + publicationRecoveryControls());
  });
}
function commitPublication() {
  if (publicationBusy || !publicationDraft) return;
  publicationBusy = true;
  return submitPublication().finally(function () { publicationBusy = false; });
}
function checkPublication() {
  if (publicationBusy || !publicationDraft) return;
  publicationBusy = true;
  return call("GET", "/products/publication-drafts/" + encodeURIComponent(publicationDraft.draft_id)).then(function (result) {
    showPublicationResult(renderPublicationReceipts(result.receipts, "发布回执") + publicationRecoveryControls());
  }).catch(function (err) { bar(err.message, true); })
    .finally(function () { publicationBusy = false; });
}
function previewImport() {
  pendingImport = null;
  $("presult").innerHTML = "";
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
      return submitImportTable(r.table, r.report);
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
    '<p class="muted">请修正后重新导入。模板和字段说明见「使用说明」。</p></div>';
}
function submitImportTable(table, report) {
  return call("POST", "/products/import-drafts", { table: table })
    .then(function (draft) {
      pendingImport = draft;
      var pv = draft.preview;
      var mapping = report || {};
      var skipped = (mapping.unrecognized_columns || []).map(esc).join("、");
      var defaulted = (mapping.defaulted_fields || []).map(esc).join("、");
      $("presult").innerHTML = '<p>新增 ' + esc(pv.added) + ' 件，更新 ' + esc(pv.updated) + ' 件，不变 ' + esc(pv.unchanged) + ' 件。</p>' +
        (skipped ? '<p>未导入的列：' + skipped + '</p>' : '') +
        (defaulted ? '<p>使用默认值的字段：' + defaulted + '</p>' : '') +
        '<button type="button" class="act" onclick="commitImport()">确认导入</button>';
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
function mountWeixin(sequence) {
  var panel = $("weixin-panel");
  var endpoint = "/channels/weixin";
  var pairingNotice = '<p class="muted">在手机微信确认绑定，即授权 Kiwi 仅回复这个店主账号的私聊。不会调用模型或向买家发送消息。</p>';
  var qr = null;
  var expiryTimer;
  var statusTimer;
  var previousState = "";
  var busy = false;
  var selectedDraft = WEIXIN_ONLY ? "" : new URLSearchParams(window.location.search).get("weixin_draft") || "";
  var draftsLoaded = false;
  var latestPreview;
  var latestProposal;
  var rulesLoaded = false;
  function active() { return current === "weixin" && sequence === viewSequence; }
  function problem(e) { if (active()) bar(e.message, true); }
  function renderModelSettings(settings) {
    if (!active()) return;
    var area = $("weixin-model-form-area");
    if (!area) return;
    area.innerHTML = '<p>通过 Pi 调用所选服务商。测试使用两条合成消息，可能消耗模型额度。</p>' +
      (settings.provider ? '<p>当前模型：' + esc(settings.provider) + ' / ' + esc(settings.model) +
        (settings.active ? '（已装配）' : '（未启用或缺少密钥）') + '</p>' : '<p>当前未配置模型。</p>') +
      (!settings.editable ? '<p>部署设置已停用此功能。</p>' : '<form id="weixin-model-form">' +
        '<p><label>服务商 <select id="weixin-model-provider" required>' + settings.providers.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === settings.provider ? ' selected' : '') +
            '>' + esc(p.label) + '</option>';
        }).join("") + '</select></label></p>' +
        '<p>访问地址（Base URL）：<code id="weixin-model-endpoint"></code></p>' +
        '<p><label>模型 ID <input id="weixin-model-id" type="text" required maxlength="128" value="' +
        esc(settings.model || "") + '"></label></p>' +
        '<p><label id="weixin-model-credential-label">API Key </label></p>' +
        '<p id="weixin-model-key" class="muted"></p>' +
        '<button id="weixin-model-save" class="act primary" type="submit">测试并保存</button>' +
        '<p id="weixin-model-result" role="status"></p></form>');
    if (!settings.editable) return;
    var form = $("weixin-model-form");
    var provider = $("weixin-model-provider");
    var model = $("weixin-model-id");
    var key = document.createElement("input");
    key.id = "weixin-model-credential";
    key.type = "password";
    key.maxLength = 2048;
    key.autocomplete = "new-password";
    $("weixin-model-credential-label").appendChild(key);
    var save = $("weixin-model-save");
    var result = $("weixin-model-result");
    function updateProviderFields() {
      var service = settings.providers.find(function (p) { return p.id === provider.value; });
      $("weixin-model-endpoint").textContent = service ? service.endpoint : "—";
      var alreadySaved = settings.credential_saved && provider.value === settings.provider;
      key.required = !alreadySaved;
      key.placeholder = alreadySaved ? "*****" : "";
      $("weixin-model-key").textContent = alreadySaved ? "已保存本商家的密钥，留空可继续使用。" :
        "请填写本商家在所选服务商申请的密钥。密钥将加密保存在当前实例。";
    }
    provider.onchange = function () {
      model.value = provider.value === settings.provider ? settings.model || "" : "";
      key.value = "";
      updateProviderFields();
    };
    updateProviderFields();
    form.onsubmit = function (event) {
      event.preventDefault();
      if (save.disabled) return;
      var input = { provider: provider.value, model: model.value.trim() };
      if (!input.model || (key.required && !key.value.trim())) return;
      if (key.value.trim()) input.credential = key.value.trim();
      key.value = "";
      save.disabled = true;
      provider.disabled = true;
      model.disabled = true;
      key.disabled = true;
      result.textContent = "正在通过 Pi 测试模型…";
      call("POST", endpoint + "/model", input).then(function (next) {
        if (!active()) return;
        renderModelSettings(next);
        $("weixin-model-result").textContent = "测试通过，配置已保存。可在上方核对微信模型授权。";
        if (!qr && !busy) reset();
      }).catch(function (error) {
        if (!active()) return;
        result.textContent = error.message;
        provider.disabled = false;
        model.disabled = false;
        key.disabled = false;
        save.disabled = false;
        updateProviderFields();
      });
    };
  }
  function ownerAction(action, prompt, fields) {
    if (prompt && !window.confirm(prompt)) return;
    call("POST", endpoint + "/" + action, fields || {}).then(function () {
      if (!active()) return;
      draftsLoaded = false;
      reset();
    }).catch(problem);
  }
  function renderModelConsent(controls, modelService, consent) {
    var notice = document.createElement("p");
    notice.id = "weixin-model-consent-notice";
    notice.className = "muted";
    notice.textContent = "授权后，Kiwi 可向当前店主回信，并将你发送的微信私聊正文及最近最多 4 轮对话文本提交给 " + modelService +
      " 处理。Kiwi 不会自动附上买家原文、身份或商家查询明细。请勿发送密码、密钥或客户隐私。";
    controls.appendChild(notice);
    var button = document.createElement("button");
    button.id = "weixin-model-consent-submit";
    button.type = "button";
    button.className = "act";
    button.textContent = "同意并开启 Kiwi 模型对话";
    button.setAttribute("aria-describedby", notice.id);
    button.onclick = function () {
      if (!active() || busy) return;
      busy = true;
      clearTimeout(statusTimer);
      button.disabled = true;
      button.textContent = "正在提交模型授权…";
      call("POST", endpoint + "/confirm-conversation", { model_consent: consent }).catch(problem).finally(function () {
        busy = false;
        reset();
      });
    };
    controls.appendChild(button);
  }
  function renderMobileCapabilities(connection) {
    var target = $("weixin-mobile-capabilities");
    if (!WEIXIN_ONLY || !target) return;
    var conversation = connection.conversation;
    var direct = conversation && conversation.enabled && conversation.delivery === "paired_owner";
    var replies = Boolean(connection.configured && direct && conversation.authorized === true && !conversation.unavailable);
    var agent = conversation && conversation.agent;
    var model = !direct ? "未启用" : conversation.unavailable ? "状态不可用" :
      !agent ? "未启用或未配置" : agent.state === "unavailable" ? "配置不可用" :
      agent.state !== "configured" ? "状态未知" : !replies || conversation.model_authorized !== true ? "已配置，未授权" :
      "已配置并授权；未在此页验证推理连通性";
    var owner = !connection.configured ? "未绑定" : conversation && conversation.unavailable ? "回信授权状态不可用" :
      !direct ? "已绑定，未启用店主回信" : replies ? "已绑定，已授权店主回信" : "已绑定，待授权店主回信";
    target.innerHTML = '<dt>店主绑定</dt><dd>' + owner + '</dd><dt>对话模型</dt><dd>' + model +
      '</dd><dt>业务工具</dt><dd>' + (replies ? '支持待跟进询价、清单追问和起草；结果以业务数据源为准。' : '微信内未启用。') +
      ' 不会向买家发送。</dd>';
  }
  function renderConversation(conversation, configured, operationsAvailable) {
    var area = $("weixin-owner-preview");
    if (!area || !conversation || !conversation.enabled) return;
    var direct = conversation.delivery === "paired_owner";
    var agent = conversation.agent;
    var modelReady = agent && agent.state === "configured";
    var modelUnavailable = agent && agent.state === "unavailable";
    var modelAuthorized = modelReady && conversation.model_authorized === true;
    var modelService = modelReady ? agent.provider + " / " + agent.model + "（" + agent.endpoint + "）" : "";
    var title = $("weixin-conversation-title");
    if (title) title.textContent = modelAuthorized ? "店主微信对话 · Kiwi 智能体" : direct ? "店主微信对话" : "店主对话 · 工作台预览";
    var preview = $("weixin-preview-text");
    if (preview) preview.textContent = conversation.unavailable ? "店主对话暂不可用。" :
      modelAuthorized ? "打开微信与 Kiwi 自然对话。模型服务：" + modelService +
        (conversation.unknown_count > 0 ? " 有回信结果无法确认，系统不会自动重发。" : "") :
      direct ? (conversation.authorized
        ? "可在微信查询待跟进询价或起草回复；当前不调用模型。" + (modelUnavailable ? " 对话模型配置不可用。" : "") +
          (conversation.unknown_count > 0 ? " 有回信结果无法确认，系统不会自动重发。" : "")
        : (configured ? "当前绑定未启用微信回信，可在这里重新开启。" : "请扫码绑定店主微信。") + (modelUnavailable ? " 对话模型配置不可用。" : "")) :
      conversation.preview || (conversation.authorized
        ? "可发送：今天哪三笔询价最该跟？或查库存 SKU-001。结果仅在本工作台显示。"
        : "当前绑定未授权业务预览。");
    if (WEIXIN_ONLY && preview && !direct && !conversation.unavailable) {
      preview.textContent = "当前实例仅支持工作台预览，未启用微信回信。";
    }
    var controls = $("weixin-conversation-controls");
    if (controls) {
      controls.innerHTML = "";
      function action(label, name, confirmation, fields) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "act"; b.textContent = label;
        b.onclick = function () { ownerAction(name, confirmation, fields); };
        controls.appendChild(b);
      }
      if (WEIXIN_ONLY && !direct) return;
      if (conversation.authorized) {
        action("清空对话", "clear-conversation", "清空对话和未出站结果？已落库草稿保留。");
        action(direct ? "停止微信对话" : "停止预览", "revoke-conversation", "停止店主对话？微信 /ping 继续可用。");
      } else if (configured && !conversation.unavailable) {
        action(direct ? "授权微信回信（不使用模型）" : "确认店主归属", direct ? "confirm-replies" : "confirm-conversation", direct
          ? "仅允许向当前扫码绑定的店主账号回复本人的私聊，不会将消息提交给模型。确认开启？" : undefined);
      }
      if (configured && !conversation.unavailable && modelReady) {
        if (modelAuthorized) action("停止模型对话", "stop-model", "停止向模型提交私聊消息？本地查询仍可在微信使用。");
        else renderModelConsent(controls, modelService, agent.consent);
      }
    }
    if (WEIXIN_ONLY) return;
    if ((!draftsLoaded || latestPreview !== conversation.preview) && (configured || selectedDraft)) {
      var first = !draftsLoaded;
      latestPreview = conversation.preview;
      loadDrafts();
      if (first && selectedDraft) loadDraft(selectedDraft);
    }
    renderDigest(conversation.rule_proposal, operationsAvailable);
  }
  function renderDigest(proposal, available) {
    var target = $("weixin-digest-proposal");
    if (!target) return;
    var key = proposal ? JSON.stringify(proposal) : "";
    if (latestProposal !== key) {
      latestProposal = key;
      target.textContent = "";
      if (proposal) {
        var stamp = proposal.prepare.trigger_spec;
        var detail = document.createElement("p");
        detail.textContent = "待回复询价日报 · 周一至周五 " + stamp.local_time + "（" + stamp.timezone +
          "） · 经营投影 · 仅工作台 · 起草时预计下次 " + proposal.next_due_at;
        target.appendChild(detail);
        if (available) {
          var button = document.createElement("button");
          button.type = "button"; button.className = "act"; button.textContent = "确认启用日报";
          button.onclick = function () {
            if (!window.confirm("启用这个规则？日报只出现在工作台。")) return;
            button.disabled = true;
            call("POST", "/automation/rules/prepare", proposal.prepare).then(function (candidate) {
              return call("POST", "/automation/rules/activate", { candidate_ref: candidate.candidate_ref });
            }).then(function () { if (active()) { bar("日报规则已启用。", false); loadRules(); } }).catch(problem);
          };
          target.appendChild(button);
        } else {
          var hint = document.createElement("p"); hint.textContent = "此实例未装配经营调度，规则不能启用。";
          target.appendChild(hint);
        }
      }
    }
    if (!rulesLoaded && available) loadRules();
  }
  function loadRules() {
    rulesLoaded = true;
    call("GET", "/automation/rules").then(function (data) {
      var list = $("weixin-digest-rules");
      if (!active() || !list) return;
      list.textContent = "";
      var rules = data.rules.filter(function (rule) {
        return rule.template === "unfinished_inquiry_digest" && rule.action_type === "internal_summary" && rule.trigger_spec.day_filter === "weekdays";
      });
      rules.slice(0, 20).forEach(function (rule) {
        var paused = rule.state === "PAUSED";
        var row = document.createElement("p");
        row.textContent = rule.trigger_spec.local_time + "（" + rule.timezone + "） · " +
          (paused ? "已暂停" : "下次：" + (rule.next_due_at || "无")) + " ";
        var action = document.createElement("button");
        action.type = "button"; action.className = "act"; action.textContent = paused ? "恢复" : "暂停";
        action.onclick = function () {
          if (!window.confirm(paused ? "按新的有效时间恢复日报？" : "暂停日报规则？")) return;
          action.disabled = true;
          call("POST", "/automation/rules/" + encodeURIComponent(rule.rule_id) + "/" + (paused ? "resume" : "pause"), paused
            ? { expected_version: rule.version, expected_enable_epoch: rule.enable_epoch }
            : { expected_version: rule.version, reason: "owner_workbench" }).then(loadRules).catch(problem);
        };
        row.appendChild(action); list.appendChild(row);
      });
      var digestIds = new Set(rules.map(function (rule) { return rule.rule_id; }));
      return call("GET", "/automation/artifacts").then(function (result) {
        var results = $("weixin-digest-results");
        if (!active() || !results) return;
        results.textContent = "";
        result.artifacts.filter(function (artifact) { return digestIds.has(artifact.rule_id); }).slice(0, 5)
          .forEach(function (artifact) {
            var advice = artifact.payload.advice || {};
            var row = document.createElement("p");
            row.textContent = artifact.created_at + " · " + (advice.summary || artifact.payload.summary || "已记录经营任务结果") + " · " + artifact.receipt_ref;
            results.appendChild(row);
          });
      });
    }).catch(problem);
  }
  function loadPreference() {
    var target = $("weixin-followup-preference");
    if (!target) return;
    call("GET", endpoint + "/followup-preference").then(function (preference) {
      if (!active() || target !== $("weixin-followup-preference")) return;
      target.innerHTML = '<label>普通跟进语气 <select id="weixin-style"><option value="">默认（撤回偏好）</option>' +
        '<option value="concise">简洁</option><option value="warm">友好</option></select></label> ' +
        '<button type="button" class="act" id="weixin-style-save">确认偏好</button>';
      var style = $("weixin-style");
      var save = $("weixin-style-save");
      style.value = preference.style || "";
      save.onclick = function () {
        save.disabled = true;
        call("POST", endpoint + "/followup-preference", { version: preference.version, style: style.value || null })
          .then(function () { if (active()) { bar("偏好已更新。正式报价规则未更改。", false); loadPreference(); } })
          .catch(problem).finally(function () { save.disabled = false; });
      };
    }).catch(problem);
  }
  function loadDrafts() {
    draftsLoaded = true;
    return call("GET", endpoint + "/reply-drafts").then(function (data) {
      if (!active() || !$("weixin-draft-list")) return;
      var list = $("weixin-draft-list");
      list.textContent = data.items.length ? "" : "没有已保存的回复草稿。";
      data.items.forEach(function (draft) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "act"; b.textContent = draft.inquiry + " · v" + draft.version;
        b.onclick = function () { loadDraft(draft.id); };
        list.appendChild(b);
      });
    }).catch(problem);
  }
  function loadDraft(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return;
    selectedDraft = id;
    call("GET", endpoint + "/reply-drafts/" + id).then(function (draft) {
      var target = $("weixin-draft-editor");
      if (!active() || !target || selectedDraft !== id) return;
      target.innerHTML = '<p>询价：' + esc(draft.inquiry) + ' · 草稿 v' + esc(draft.version) + '</p>' +
        '<p>仅保存在本实例。正式发布未接通，不会发送给买家。' +
        (draft.current ? '' : ' 询价已变化或无法核实，此稿不可编辑。') + '</p>' +
        '<form id="weixin-draft-form"><label>回复正文 <textarea id="weixin-draft-body" maxlength="600" required></textarea></label> ' +
        '<button class="act" type="submit">保存草稿</button> ' +
        '<button class="act" type="button" id="weixin-draft-discard">放弃草稿</button></form>';
      var body = $("weixin-draft-body");
      body.value = draft.body;
      var form = $("weixin-draft-form");
      var save = form.querySelector('button[type="submit"]');
      var discard = $("weixin-draft-discard");
      var draftPath = endpoint + "/reply-drafts/" + id;
      function saving(value) {
        save.disabled = value || !draft.current;
        discard.disabled = value;
      }
      body.readOnly = !draft.current;
      saving(false);
      form.onsubmit = function (event) {
        event.preventDefault();
        if (save.disabled) return;
        saving(true);
        call("POST", draftPath, { version: draft.version, body: body.value }).then(function () {
          if (!active()) return;
          bar("草稿已保存，未发送。", false);
          loadDrafts();
          if (selectedDraft === id) loadDraft(id);
        }).catch(problem).finally(function () { saving(false); });
      };
      discard.onclick = function () {
        if (discard.disabled || !window.confirm("放弃这份草稿？它将从列表移除，不会发送给买家。")) return;
        saving(true);
        call("POST", draftPath + "/discard", { version: draft.version }).then(function () {
          if (!active()) return;
          if (selectedDraft === id) { selectedDraft = ""; target.textContent = ""; }
          bar("已放弃草稿，未发送。", false);
          loadDrafts();
        }).catch(problem).finally(function () { saving(false); });
      };
    }).catch(problem);
  }
  function reset() {
    clearTimeout(expiryTimer);
    clearTimeout(statusTimer);
    qr = null;
    previousState = "";
    if (!active()) return;
    panel.innerHTML = '<p role="status">正在读取连接状态…</p>';
    updateStatus();
  }
  function updateStatus() {
    if (!active() || qr || busy) return;
    call("GET", endpoint).then(function (connection) {
      if (!active() || qr || busy) return;
      var state = connection.status;
      var conversation = connection.conversation;
      var displayState = state + ":" + Boolean(conversation && conversation.enabled);
      if (displayState !== previousState) {
        previousState = displayState;
        var labels = {
          disconnected: "未连接", checking: "扫码已确认，正在检查微信连接…",
          connected: "已连接。可以在微信里向机器人发送 /ping 验证收发。",
          retrying: "微信暂不可用，正在重试…", reconnect_required: "微信会话已失效，请断开后重新扫码。",
          unavailable: "微信通道暂不可用，请稍后刷新。"
        };
        var replyOnPairing = conversation && conversation.enabled && conversation.delivery === "paired_owner";
        panel.innerHTML = '<p role="status">微信连接：' + esc(labels[state] || "状态未知") + '</p>' +
          (!connection.configured && replyOnPairing ? pairingNotice : '') +
          (WEIXIN_ONLY ? '<dl id="weixin-mobile-capabilities"></dl>' : '') +
          (WEIXIN_ONLY && (!conversation || !conversation.enabled)
            ? '<p class="muted">此实例未启用店主对话，连接后仅支持 /ping，不会调用模型。</p>' : '') +
          (connection.configured
            ? '<button type="button" class="act" id="weixin-disconnect">断开连接</button>'
            : '<button type="button" class="act primary" id="weixin-begin">生成微信二维码</button>') +
          (connection.conversation && connection.conversation.enabled
            ? '<section id="weixin-owner-preview"><h3 id="weixin-conversation-title">店主对话</h3>' +
              '<pre id="weixin-preview-text" style="white-space:pre-wrap"></pre><div id="weixin-conversation-controls"></div>' +
              (WEIXIN_ONLY ? '' : '<h3>普通跟进草稿</h3><div id="weixin-draft-list"></div><div id="weixin-draft-editor"></div>' +
                '<div id="weixin-followup-preference"></div>' +
                '<div id="weixin-digest-proposal"></div><div id="weixin-digest-rules"></div><div id="weixin-digest-results"></div>') + '</section>'
            : '');
        if (connection.configured) $("weixin-disconnect").onclick = disconnect;
        else $("weixin-begin").onclick = function () { begin(replyOnPairing); };
        draftsLoaded = false;
        rulesLoaded = false;
        latestProposal = undefined;
        if (connection.configured && connection.conversation && connection.conversation.enabled) loadPreference();
      }
      var mobileDrafts = $("weixin-mobile-drafts");
      if (mobileDrafts) {
        mobileDrafts.hidden = !conversation || !conversation.enabled || conversation.unavailable === true;
        if (!mobileDrafts.hidden && !draftsLoaded) {
          $("weixin-draft-refresh").onclick = loadDrafts;
          loadDrafts();
        }
      }
      renderMobileCapabilities(connection);
      renderConversation(connection.conversation, connection.configured, connection.operations_available);
      if (state === "checking" || state === "retrying" || state === "connected") statusTimer = setTimeout(updateStatus, 4000);
    }).catch(function (e) {
      if (!active()) return;
      panel.innerHTML = '<p role="status">无法读取连接状态。</p><button type="button" class="act" id="weixin-refresh">刷新</button>';
      $("weixin-refresh").onclick = reset;
      problem(e);
    });
  }
  function disconnect() {
        if (busy || !window.confirm("断开后，Kiwi 将停止收取并回复店主微信消息。确定断开？")) return;
    busy = true;
    $("weixin-disconnect").disabled = true;
    call("POST", endpoint + "/disconnect", {}).catch(problem).finally(function () { busy = false; reset(); });
  }
  function drawQr(rows) {
    var canvas = $("weixin-qr");
    var module = Math.floor(280 / (rows.length + 8));
    canvas.width = canvas.height = module * (rows.length + 8);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    rows.forEach(function (row, y) {
      for (var x = 0; x < row.length; x++) if (row[x] === "1") ctx.fillRect((x + 4) * module, (y + 4) * module, module, module);
    });
  }
  function begin(replyOnPairing) {
    if (busy) return;
    busy = true;
    clearTimeout(statusTimer);
    $("weixin-begin").disabled = true;
    call("POST", endpoint + "/begin", {}).then(function (attempt) {
      if (!active()) return;
      qr = attempt.attempt_id;
      panel.innerHTML = '<p id="weixin-scan-state" role="status"></p>' +
        (replyOnPairing ? pairingNotice : '') +
        '<canvas id="weixin-qr" role="img" aria-label="微信绑定二维码" style="max-width:100%;height:auto"></canvas>' +
        '<form id="weixin-verify" hidden><label>手机微信配对码 <input id="weixin-code" type="text" inputmode="numeric" pattern="[0-9]{1,12}" maxlength="12" autocomplete="off" required></label> ' +
        '<button class="act" id="weixin-submit-code">提交配对码</button></form>' +
        '<p><button type="button" class="act" id="weixin-cancel">取消扫码</button></p>';
      drawQr(attempt.qr_rows);
      $("weixin-verify").onsubmit = function (e) {
        e.preventDefault();
        var code = $("weixin-code").value;
        $("weixin-code").value = "";
        poll(code);
      };
      $("weixin-cancel").onclick = function () {
        this.disabled = true;
        var id = qr;
        qr = null;
        clearTimeout(expiryTimer);
        panel.innerHTML = '<p role="status">正在取消扫码…</p>';
        call("POST", endpoint + "/cancel", { attempt_id: id }).catch(problem).finally(reset);
      };
      expiryTimer = setTimeout(function () {
        if (active() && qr === attempt.attempt_id) { bar("微信二维码已过期，请重新生成。", true); reset(); }
      }, Math.max(0, Date.parse(attempt.expires_at) - Date.now()));
      showScanState(attempt.status);
    }).catch(function (e) { problem(e); reset(); }).finally(function () {
      busy = false;
      if (!qr) updateStatus();
    });
  }
  function showScanState(state) {
    var needsCode = state === "verification_required";
    $("weixin-scan-state").textContent = needsCode ? "请输入手机微信显示的数字配对码。" :
      state === "scanned" ? "已扫码，请在手机微信上确认。" : "请使用手机微信扫一扫。";
    $("weixin-verify").hidden = !needsCode;
    var id = qr;
    if (!needsCode) setTimeout(function () { if (qr === id) poll(); }, 1600);
  }
  function poll(code) {
    if (!active() || !qr) return;
    var id = qr;
    var body = { attempt_id: id };
    if (typeof code === "string") {
      body.verify_code = code;
      $("weixin-submit-code").disabled = true;
    }
    call("POST", endpoint + "/poll", body).then(function (result) {
      if (!active() || qr !== id) return;
      $("weixin-submit-code").disabled = false;
      if (result.status === "confirmed") {
        reset();
      } else if (result.status === "expired" || result.status === "verify_code_blocked" || result.status === "binded_redirect") {
        var messages = {
          expired: "微信二维码已过期，请重新生成。",
          verify_code_blocked: "配对码错误次数过多，请重新生成二维码。",
          binded_redirect: "该微信已有绑定，请在手机微信上解除原绑定后重试。"
        };
        bar(messages[result.status], true);
        reset();
      } else {
        if (body.verify_code && result.status === "verification_required") bar("配对码尚未通过，请核对手机上的数字后再试。", true);
        showScanState(result.status);
      }
    }).catch(function (e) {
      if (!active() || qr !== id) return;
      problem(e);
      if (body.verify_code) $("weixin-submit-code").disabled = false;
      else reset();
    });
  }
  if (!WEIXIN_ONLY) {
    call("GET", endpoint + "/model").then(renderModelSettings).catch(function (error) {
      if (active()) $("weixin-model-form-area").textContent = error.message;
    });
  }
  updateStatus();
}
var current = WEIXIN_ONLY ? "weixin" : "status";
var VIEW_COPY = {
  status: ["服务状态", "掌握接待状态，管理店铺与名片发布。"],
  products: ["商品与导入", ""],
  approvals: ["待审批", "核对每一项变更，重要决定由你确认。"],
  buyerFollowups: ["买家待确认", "处理商品问题，买家凭原身份查询答复。"],
  negotiations: ["会话旁观", "查看询价与磋商进展，掌握需要关注的会话。"],
  reports: ["运营报告", "了解买家触达与接待表现。"],
  policy: ["报价规则", "管理自动报价边界，规则确认后生效。"],
  collection: ["收款方式", "管理只向符合条件的买家提供的收款指引。"],
  operating: ["商品经营", "选择商品、设定条件与授权，控制生效区间。"],
  sales: ["销售工作台", "处理待办、下一动作与持久跟进。"],
  outcomes: ["经营结果", "分开查看订单证据、归因与贡献。"],
  weixin: ["微信通道", "连接店主的个人微信，查看连接状态。"],
  support: ["售后工单", "领取本地售后工单并保存人工回访。"]
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
var previousView = "";
function refresh() {
  if (previousView && previousView !== current) dismissBar();
  var sequence = ++viewSequence;
  var copy = VIEW_COPY[current];
  var view = $("view");
  if (previousView === "collection" || current === "collection" || previousView === "weixin" || current === "weixin" ||
      previousView === "support" || current === "support") {
    view.innerHTML = '<div class="card">加载中…</div>';
  }
  previousView = current;
  $("page-title").textContent = copy[0];
  $("page-description").textContent = copy[1];
  view.setAttribute("data-view", current);
  views[current]().then(function (html) {
    if (sequence !== viewSequence) return;
    view.innerHTML = html; decorateView();
    if (current === "products" && (publicationBusy || publicationDraft !== null)) lockPublicationSelection(true);
    if (current === "weixin") mountWeixin(sequence);
    if (current === "collection") { bindAlipayCollection(); bindAlipayApprovals(); }
    if (current === "support") mountSupport(sequence);
    if (current === "buyerFollowups") mountBuyerFollowups(sequence);
    if (current === "status" && CATALOG_CONNECT && ROLE === "owner") {
      if (catalogConnectionState && waitingForCatalogConfirmation(catalogConnectionState)) showCatalogPairing(sequence);
      if (catalogConnectionState && catalogConnectionState.bindingId) {
        call("GET", "/catalog/bound-account").then(function (result) {
          var target = $("bound-account"); if (sequence === viewSequence && target) target.textContent = result.email || "请到 Kiwi 商家门户核对";
        }).catch(function () { var target = $("bound-account"); if (sequence === viewSequence && target) target.textContent = "暂时无法读取，请稍后刷新"; });
        if (catalogConnectionState.published) refreshPublicInquiry(sequence);
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
  if (!res.ok) throw new Error("暂时无法读取登录状态，请刷新页面重试。");
  return res.json();
}).then(function (session) {
  if (!session) return;
  CSRF = session.csrf_token || "";
  ROLE = session.role || "";
  $("who").textContent = "商家 " + session.merchant_id + " · " + ROLE;
  if (WEIXIN_ONLY) {
    if (ROLE !== "owner") {
      $("view").innerHTML = '<div class="card" role="status">只有本实例的店主才能管理微信连接。请使用店主账号登录。</div>';
      return;
    }
    refresh();
    return;
  }
  $("collection-tab").hidden = session.can_manage_alipay_collection !== true;
  if (MANUAL_SUPPORT && ROLE === "owner") $("support-tab").hidden = false;
  if ($("buyer-followups-tab")) $("buyer-followups-tab").hidden = ROLE !== "owner";
  if (WEIXIN_CHANNEL && ROLE === "owner") {
    $("weixin-tab").hidden = false;
    if (new URLSearchParams(window.location.search).has("weixin_draft")) {
      $("weixin-tab").click();
      return;
    }
  }
  refresh();
}).catch(function () {
  $("view").innerHTML = '<div class="card" role="status">暂时无法读取登录状态，请刷新页面重试。</div>';
});
</script>
</body>
</html>`;
}
