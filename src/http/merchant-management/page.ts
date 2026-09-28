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
export function renderMerchantManagementPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>商家工作台 — Kiwi</title>
<style>
  :root { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; }
  body { margin: 0; background: #f6f7f9; color: #1c2330; }
  header { background: #16324f; color: #fff; padding: 12px 20px; display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .who { font-size: 12px; opacity: .8; }
  nav { display: flex; gap: 4px; padding: 8px 20px 0; background: #16324f; }
  nav button { border: 0; padding: 8px 14px; border-radius: 6px 6px 0 0; background: #1e4066; color: #cdd8e4; cursor: pointer; font-size: 13px; }
  nav button.on { background: #f6f7f9; color: #16324f; font-weight: 600; }
  main { padding: 16px 20px 40px; max-width: 980px; margin: 0 auto; }
  .card { background: #fff; border: 1px solid #e3e7ec; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; color: #3a4a5e; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef1f4; vertical-align: top; }
  th { color: #6b7a8c; font-weight: 500; white-space: nowrap; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; }
  .ok { background: #e5f5ea; color: #1d7a3d; } .warn { background: #fdf1dc; color: #9a6b0f; } .bad { background: #fde8e8; color: #b3261e; }
  button.act { border: 1px solid #c9d3dd; background: #fff; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  button.act.primary { background: #16324f; color: #fff; border-color: #16324f; }
  button.act.danger { color: #b3261e; border-color: #e5b4b1; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 8px 20px; font-size: 13px; background: #101826; color: #dfe6ee; display: none; }
  #bar.err { background: #5c1a16; }
  textarea, input[type=text] { width: 100%; box-sizing: border-box; border: 1px solid #c9d3dd; border-radius: 6px; padding: 8px; font: 12px ui-monospace, monospace; }
  .muted { color: #6b7a8c; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  pre.digest { font: 11px ui-monospace, monospace; color: #6b7a8c; word-break: break-all; margin: 4px 0; }
  label { font-weight: 400; font-size: 12px; }
  select { border: 1px solid #c9d3dd; border-radius: 6px; padding: 4px 6px; font-size: 12px; background: #fff; }
  .trendrow { display: flex; align-items: center; gap: 8px; margin: 3px 0; font-size: 12px; }
  .trendrow > span:first-child { width: 44px; color: #6b7a8c; }
  .trendbar { flex: 1; height: 10px; background: #eef1f4; border-radius: 5px; overflow: hidden; }
  .trendfill { height: 100%; background: #1e4066; }
</style>
</head>
<body>
<header><h1>商家工作台</h1><span class="who" id="who"></span></header>
<nav id="tabs">
  <button data-v="status" class="on">服务状态</button>
  <button data-v="products">商品与导入</button>
  <button data-v="approvals">待审批</button>
  <button data-v="negotiations">会话旁观</button>
  <button data-v="reports">运营报告</button>
  <button data-v="policy">报价规则</button>
</nav>
<main id="view"><div class="card">加载中…</div></main>
<div id="bar"></div>
<script>
"use strict";
var CSRF = "";
var ROLE = "";
var API = "/merchant/api/v1";
var $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
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
    return new Error(text + " " + recoveryHint(problem.recovery_action));
  }
  var fallback = await res.json().catch(function () { return {}; });
  return new Error((fallback.message || fallback.detail || fallback.code || ("HTTP " + res.status)) + "。请勿自动重复提交。");
}
function call(method, path, body) {
  var headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    if (CSRF) headers["x-csrf-token"] = CSRF;
  }
  return fetch(API + path, {
    method: method,
    credentials: "same-origin",
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(function (res) {
    if (!res.ok) {
      if (res.status === 401) { showLogin(); throw new Error("需要登录"); }
      return apiError(res).then(function (error) { throw error; });
    }
    return res.json();
  });
}
function showLogin() {
  $("view").innerHTML = '<div class="card"><h2>需要登录</h2>' +
    '<p class="muted">请使用商家管理员口令登录后回到本页。</p>' +
    '<p><a class="act" href="/admin/login?next=%2Fmerchant%2F"><button class="act primary">去登录</button></a></p></div>';
}
function key(p) { return p + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
function statePill(state) {
  var map = { OPERATING: ["ok", "营业中"], PAUSED: ["warn", "已暂停"], WITHDRAWN: ["bad", "已撤回"], DEGRADED: ["warn", "降级"] };
  var it = map[state] || ["warn", state];
  return '<span class="pill ' + it[0] + '">' + esc(it[1]) + "</span>";
}

var views = {
  status: function () {
    return call("GET", "/runtime/status").then(function (s) {
      var failed = s.readiness && s.readiness.failed_checks || [];
      var html = '<div class="card"><h2>运行状态</h2><table>' +
        "<tr><th>服务状态</th><td>" + statePill(s.service_state) + "</td></tr>" +
        "<tr><th>部署代次</th><td>" + esc(s.generation) + "</td></tr>" +
        "<tr><th>Runtime</th><td>" + esc(s.runtime_version) + "（管理 API v" + esc(s.api_version) + "）</td></tr>" +
        "<tr><th>就绪</th><td>" + (s.readiness && s.readiness.ready
          ? '<span class="pill ok">就绪</span>'
          : '<span class="pill bad">未就绪</span> ' + esc(failed.join("、"))) + "</td></tr>" +
        "<tr><th>能力</th><td>管理页 " + (s.capabilities.management_page ? "✓" : "✗") +
        "；对话工具 " + (s.capabilities.dialog_tools ? "✓" : "未启用") + "</td></tr>" +
        '</table><p class="muted">更新于 ' + esc(s.observed_at) + "</p>";
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
      return html + "</div>";
    });
  },
  products: function () {
    return call("GET", "/products?limit=100").then(function (p) {
      var rows = (p.items || []).map(function (it) {
        var money = it.money || {};
        return "<tr><td>" + esc(it.sku) + "</td><td>" + esc(it.title) + "</td><td>" +
          esc(money.currency || "-") + " " + esc(money.amount_minor == null ? "-" : money.amount_minor) +
          "（最小币单位）</td><td>" + esc(it.stock == null ? "-" : it.stock) + "</td><td>" +
          esc(it.authority_version == null ? "-" : it.authority_version) + "</td></tr>";
      }).join("");
      return '<div class="card"><h2>当前商品（' + (p.items || []).length + "）</h2>" +
        (rows ? "<table><tr><th>SKU</th><th>名称</th><th>价格（最小币单位）</th><th>库存</th><th>版本</th></tr>" + rows + "</table>"
              : '<p class="muted">暂无商品。</p>') + "</div>" +
        '<div class="card"><h2>导入商品表（整表替换）</h2>' +
        '<p class="muted">支持 CSV、Excel（.xlsx）与商品表 JSON：先转换校验、预览增/改/留/删，确认后整批生效（不成功的批次不改动现有商品）。</p>' +
        '<p class="muted">模板：<a href="/merchant/api/v1/products/import-template?format=csv" download="kiwi-product-import-template.csv">下载 CSV 模板</a> · <a href="/merchant/api/v1/products/import-template?format=xlsx" download="kiwi-product-import-template.xlsx">下载 Excel 模板</a>（中文表头与示例行；中英文常见列名会自动识别）。</p>' +
        '<div class="row"><input type="file" id="pfile" accept=".json,.csv,.xlsx">' +
        '<button class="act" onclick="previewImport()">校验预览</button></div><div id="presult"></div></div>';
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
            '<tr><th>超出范围转人工</th><td><span class="row">' +
            '<label><input type="checkbox" id="pf-hr-below" checked> 低于底价</label>' +
            '<label><input type="checkbox" id="pf-hr-warranty"> 特殊售后条款</label>' +
            '<label><input type="checkbox" id="pf-hr-suspicious"> 可疑内容</label></span>' +
            '<select id="pf-hr"><option value="">不修改</option><option value="set">按左侧勾选设置</option></select></td></tr>' +
            "</table>" +
            '<div class="row" style="margin-top:8px"><button class="act primary" onclick="draftPolicyForm()">生成规则草稿</button>' +
            '<span class="muted">per-SKU 底价/折扣、促销与库存来源请用下方高级模式。</span></div><div id="polformresult"></div></div>' +
            '<div class="card"><h2>高级：JSON patch 模式</h2>' +
            '<p class="muted">适合 per-SKU 底价/折扣映射、促销与库存来源等完整 patch；字段名以策略 schema 文档为准，不在页面枚举。</p>' +
            '<textarea id="patch" rows="8"></textarea>' +
            '<div class="row" style="margin-top:8px"><button class="act" onclick="draftPolicy()">保存草稿</button>' +
            '<span class="muted">保存后生成草稿摘要，再点提交才生效。</span></div><div id="polresult"></div></div>'
          : '<div class="card"><p class="muted">规则调整需要 operator/owner 角色。</p></div>');
    });
  },
};

</script>
<script>
/* 暂停/恢复与规则/导入/审批的命令实现。 */
function currentRevision(cb) {
  call("GET", "/runtime/status").then(cb).catch(function (e) { bar(e.message, true); });
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
function parseTabularFile(f, format) {
  var done = function (content) {
    fetch(API + "/products/import-parse?format=" + format, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": format === "csv" ? "text/csv" : "application/octet-stream",
        "x-csrf-token": CSRF,
      },
      body: content,
    }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error("需要登录"); }
      if (!res.ok) return apiError(res).then(function (error) { throw error; });
      return res.json();
    }).then(function (r) {
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
function refresh() { views[current]().then(function (html) { $("view").innerHTML = html; })
  .catch(function (e) { if (e.message !== "需要登录") bar(e.message, true); }); }
Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (btn) {
  btn.addEventListener("click", function () {
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) { b.className = ""; });
    btn.className = "on";
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
