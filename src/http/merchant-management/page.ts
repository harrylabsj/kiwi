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
</style>
</head>
<body>
<header><h1>商家工作台</h1><span class="who" id="who"></span></header>
<nav id="tabs">
  <button data-v="status" class="on">服务状态</button>
  <button data-v="products">商品与导入</button>
  <button data-v="approvals">待审批</button>
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
        '<p class="muted">选择商品表 JSON 文件：先校验预览，确认后整批生效（不成功的批次不改动现有商品）。</p>' +
        '<div class="row"><input type="file" id="pfile" accept=".json,application/json">' +
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
  policy: function () {
    return call("GET", "/policy").then(function (pol) {
      return '<div class="card"><h2>当前报价规则</h2><table>' +
        "<tr><th>规则版本</th><td>" + esc(pol.policy_revision) + "</td></tr>" +
        '<tr><th>内容摘要</th><td><pre class="digest">' + esc(pol.digest) + "</pre></td></tr></table>" +
        '<p class="muted">底价等敏感值不出现在本页接口；提交草稿后由系统校验并原子生效。</p></div>' +
        (ROLE === "owner" || ROLE === "operator"
          ? '<div class="card"><h2>提交规则调整草稿（JSON patch）</h2>' +
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
function previewImport() {
  var f = $("pfile").files[0];
  if (!f) { bar("请先选择商品表 JSON 文件", true); return; }
  var reader = new FileReader();
  reader.onload = function () {
    var table;
    try { table = JSON.parse(reader.result); }
    catch (e) { bar("文件不是合法 JSON", true); return; }
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
  };
  reader.readAsText(f);
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
        '<button class="act primary" onclick="commitPolicy(\\'' + esc(draft.draft_id) + '\\',\\'' + esc(draft.digest) + '\\')">提交生效</button></div>';
    })
    .catch(function (e) { bar("草稿未保存：" + e.message, true); });
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
