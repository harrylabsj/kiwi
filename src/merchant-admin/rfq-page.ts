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
 * RFQ 管理页（设计 v0.1.1 §9.4、§11.4、§14.1）。
 *
 *   - 批准/拒绝只在认证的管理页 HTTP 路由执行，绝不作为模型可调用的
 *     RFQ MCP 工具；GET 无副作用；POST 需会话；发布类 POST 另需一次性
 *     确认凭证（复用 oauth.sqlite 确认凭证，与 /admin/pending 同机制）。
 *   - 认证主体的成功产物下载（摘要校验通过）是 EXPORTED 的唯一触发通道；
 *     MCP 资源读取不经过本面。
 *   - 具名 SKU 确认（独立表单写入）与 case 取消/关闭的管理页入口。
 */

import type { MerchantCoreService } from "../merchant-core/service.js";
import { RfqError } from "../merchant-core/rfq/types.js";
import type { RfqCallContext, RfqCaseView } from "../merchant-core/rfq/service.js";
import type { PublicQuoteView } from "../merchant-core/rfq/types.js";

export interface RfqAdminReleaseDetail {
  release_id: string;
  status: string;
  candidate_id: string;
  quote_id: string;
  quote_revision: number;
  recipient_ref: string;
  artifact_id: string;
  artifact_sha256: string;
  case_id: string | null;
  quote_status: string | null;
  projection: PublicQuoteView | null;
}

export interface RfqAdminSurface {
  listCases(principalId: string, limit?: number): RfqCaseView[];
  getCase(caseId: string, principalId: string): RfqCaseView;
  confirmLines(input: {
    caseId: string;
    expectedRevision: number;
    selections: Array<{ line_id: string; sku: string; quantity?: number; unit?: string }>;
    principalId: string;
  }): { case_id: string; revision: number; stage: string; blockers: Array<{ field: string; reason: string }> };
  closeCase(input: {
    caseId: string;
    expectedRevision: number;
    outcome: "CANCELLED" | "CLOSED";
    principalId: string;
  }): { case_id: string; stage: string };
  releaseDetail(releaseId: string, principalId: string): RfqAdminReleaseDetail;
  approveRelease(commandId: string, principalId: string, confirmationToken?: string): Promise<unknown>;
  rejectRelease(commandId: string, principalId: string, confirmationToken?: string): Promise<unknown>;
  candidateFor(candidateId: string): { candidate_id: string; arguments: Record<string, unknown>; preconditions: Record<string, unknown> } | undefined;
  downloadArtifact(artifactId: string, principalId: string): { content: string; content_type: string; filename: string };
  markHandoffOwnerRecorded(handoffId: string, principalId: string): unknown;
}

/** 构造 RFQ 管理面（core 未配置 RFQ 子服务时各方法 fail-closed）。 */
export function rfqAdminSurface(core: MerchantCoreService): RfqAdminSurface {
  const rfq = (): NonNullable<MerchantCoreService["rfqService"]> => {
    const service = core.rfqService;
    if (service === undefined) {
      throw new RfqError("unavailable", "询报价工作台未配置（rfq_core 未启用）；不可得");
    }
    return service;
  };
  const ctx = (principalId: string): RfqCallContext => ({
    principalId,
    actor: principalId,
    traceId: `admin-${principalId}-${Date.now()}`,
  });
  return {
    listCases: (principalId, limit) => rfq().listCases(ctx(principalId), limit),
    getCase: (caseId, principalId) => rfq().getCase(ctx(principalId), caseId),
    confirmLines: (input) =>
      rfq().confirmLines(ctx(input.principalId), {
        caseId: input.caseId,
        expectedRevision: input.expectedRevision,
        selections: input.selections,
      }),
    closeCase: (input) =>
      rfq().closeCase(ctx(input.principalId), {
        caseId: input.caseId,
        expectedRevision: input.expectedRevision,
        outcome: input.outcome,
        idempotencyKey: `admin-close-${input.caseId}-${input.expectedRevision}-${input.outcome}`,
      }),
    releaseDetail: (releaseId, principalId) => {
      const detail = rfq().adminReleaseDetail(ctx(principalId), releaseId);
      return {
        release_id: detail.release.release_id,
        status: detail.release.status,
        candidate_id: detail.release.candidate_id,
        quote_id: detail.release.quote_id,
        quote_revision: detail.release.quote_revision,
        recipient_ref: detail.release.recipient_ref,
        artifact_id: detail.release.artifact_id,
        artifact_sha256: detail.release.artifact_sha256,
        case_id: detail.quote?.case_id ?? null,
        quote_status: detail.quote?.status ?? null,
        projection: detail.quote?.projection ?? null,
      };
    },
    approveRelease: (commandId, principalId, token) =>
      core.commands.executeApproved(commandId, principalId, token),
    rejectRelease: (commandId, principalId, token) =>
      core.commands.reject(commandId, principalId, token),
    candidateFor: (candidateId) => {
      const candidate = core.listPendingCommands().find((c) => c.candidate_id === candidateId);
      return candidate === undefined
        ? undefined
        : {
            candidate_id: candidate.candidate_id,
            arguments: candidate.arguments,
            preconditions: candidate.preconditions,
          };
    },
    downloadArtifact: (artifactId, principalId) =>
      rfq().downloadArtifact(ctx(principalId), artifactId),
    markHandoffOwnerRecorded: (handoffId, principalId) =>
      rfq().markHandoffOwnerRecorded(ctx(principalId), handoffId),
  };
}

// ---------------------------------------------------------------------------
// HTML 渲染（与 renderPendingPage 同风格：转义全部外部内容；表单 POST）
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 仪表盘行（渲染只依赖这几个字段；完整 RfqCaseView 可直接传入）。 */
export interface RfqDashboardRow {
  case: { case_id: string; stage: string; current_quote_id?: string | null };
  revision: number;
  blockers?: Array<{ field: string; reason: string }>;
}

export function renderRfqDashboard(
  merchantName: string,
  cases: RfqDashboardRow[],
): string {
  const rows = cases.length
    ? cases
        .map(
          (v) =>
            `<tr><td>${escapeHtml(v.case.case_id)}</td><td>${escapeHtml(v.case.stage)}</td><td>v${v.revision}</td><td>${v.blockers?.length ?? 0}</td><td>${escapeHtml(v.case.current_quote_id ?? "—")}</td><td><a href="/admin/rfq/cases/${encodeURIComponent(v.case.case_id)}">查看</a></td></tr>`,
        )
        .join("\n")
    : "<tr><td colspan=\"6\">当前没有询盘。</td></tr>";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>询报价工作台 — ${escapeHtml(merchantName)}</title></head>
<body>
<h1>${escapeHtml(merchantName)}：询报价工作台</h1>
<p>确认/批准只在可信管理页执行；导出状态 ≠ 发送状态。待批准命令见 <a href="/admin/pending">待批准列表</a>。</p>
<table border="1" cellpadding="6">
<tr><th>case_id</th><th>阶段</th><th>需求版本</th><th>阻断项</th><th>当前报价</th><th>操作</th></tr>
${rows}
</table>
</body></html>`;
}

export function renderRfqCasePage(merchantName: string, view: RfqCaseView): string {
  const lines = view.fields.lines
    .map(
      (l) => `<tr>
  <td>${escapeHtml(l.line_id)}</td>
  <td><pre>${escapeHtml(l.query.slice(0, 200))}</pre></td>
  <td>${escapeHtml(l.sku ?? "—")}</td>
  <td>${escapeHtml(String(l.quantity ?? "—"))}</td>
  <td>${escapeHtml(l.unit ?? "—")}</td>
  <td>${escapeHtml(l.confirmation)}</td>
  <td><form method="post" action="/admin/rfq/cases/${encodeURIComponent(view.case.case_id)}/confirm" style="display:inline">
    <input type="hidden" name="line_id" value="${escapeHtml(l.line_id)}">
    <input type="hidden" name="sku" value="${escapeHtml(l.sku ?? "")}">
    <input type="hidden" name="expected_revision" value="${view.revision}">
    <button type="submit">确认该行</button>
  </form></td>
</tr>`,
    )
    .join("\n");
  const quoteRows = view.quotes
    .map(
      (q) =>
        `<tr><td>${escapeHtml(q.quote_id)}</td><td>v${q.revision}</td><td>${escapeHtml(q.status)}</td><td>${escapeHtml(q.invalid_reason ?? "")}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>询盘 ${escapeHtml(view.case.case_id)} — ${escapeHtml(merchantName)}</title></head>
<body>
<h1>询盘 ${escapeHtml(view.case.case_id)}（阶段 ${escapeHtml(view.case.stage)}，需求 v${view.revision}）</h1>
<p><a href="/admin/rfq">返回总览</a></p>
<h2>需求行（确认 = 商家具名动作；模型自报确认不作数）</h2>
<table border="1" cellpadding="6">
<tr><th>行</th><th>需求</th><th>SKU</th><th>数量</th><th>单位</th><th>确认状态</th><th>操作</th></tr>
${lines}
</table>
<h2>阻断项（${view.blockers.length}）</h2>
<ul>${view.blockers.map((b) => `<li>${escapeHtml(b.field)}：${escapeHtml(b.reason)}</li>`).join("")}</ul>
<h2>报价版本</h2>
<table border="1" cellpadding="6"><tr><th>quote</th><th>版本</th><th>状态</th><th>说明</th></tr>${quoteRows}</table>
<h2>关闭（操作者显式；终态后拒绝新计价与发布）</h2>
<form method="post" action="/admin/rfq/cases/${encodeURIComponent(view.case.case_id)}/close">
  <input type="hidden" name="expected_revision" value="${view.case.version}">
  <button type="submit" name="outcome" value="CANCELLED">取消询盘</button>
  <button type="submit" name="outcome" value="CLOSED">正常关闭</button>
</form>
</body></html>`;
}

export function renderRfqReleasePage(
  merchantName: string,
  detail: RfqAdminReleaseDetail,
  tokenFor: (candidateId: string, action: "approve" | "reject") => string,
): string {
  const projectionText =
    detail.projection === null
      ? "（投影不可得）"
      : JSON.stringify(detail.projection, null, 2);
  const buttons =
    detail.status !== "PENDING_APPROVAL"
      ? `<p>当前状态：${escapeHtml(detail.status)}（非待批准；不可重复批准）</p>`
      : `<form method="post" action="/admin/rfq/releases/${encodeURIComponent(detail.release_id)}/approve" style="display:inline">
    <input type="hidden" name="confirmation" value="${escapeHtml(tokenFor(detail.candidate_id, "approve"))}">
    <button type="submit">批准并激活发布</button>
  </form>
  <form method="post" action="/admin/rfq/releases/${encodeURIComponent(detail.release_id)}/reject" style="display:inline">
    <input type="hidden" name="confirmation" value="${escapeHtml(tokenFor(detail.candidate_id, "reject"))}">
    <button type="submit">拒绝</button>
  </form>
  <p>批准 = 消费一次性确认凭证 + 前置重验（事实指纹/策略版本/需求 revision）+ 原子激活。</p>`;
  const download =
    detail.status === "APPROVED"
      ? `<p><a href="/admin/rfq/artifacts/${encodeURIComponent(detail.artifact_id)}">下载正式文件（成功取走即记 EXPORTED）</a></p>`
      : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>发布 ${escapeHtml(detail.release_id)} — ${escapeHtml(merchantName)}</title></head>
<body>
<h1>发布 ${escapeHtml(detail.release_id)}（状态 ${escapeHtml(detail.status)}）</h1>
<p><a href="/admin/pending">返回待批准列表</a> ｜ <a href="/admin/rfq">询报价总览</a></p>
<h2>即将导出的固定内容（客户投影）</h2>
<pre>${escapeHtml(projectionText)}</pre>
<p>产物摘要：${escapeHtml(detail.artifact_sha256)} ｜ 收件对象：${escapeHtml(detail.recipient_ref)}</p>
${buttons}
${download}
</body></html>`;
}
