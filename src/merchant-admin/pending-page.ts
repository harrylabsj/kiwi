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
 * 配套商家确认页面（V2 阶段三：src/merchant-admin/）。
 *
 * 宿主（WorkBuddy）没有可验证确认接口时的确认通道：最小可用 HTML 页面，
 * 列出待批准命令（预览：tool、参数、前置版本、有效期）+ 批准/拒绝表单。
 * 批准/拒绝经 MCP server 的 Bearer 认证（OAuth access_token，write scope 由
 * 服务端强制）——模型自报「已批准」不作证据，approved 只能由本通道写入。
 */

import type { WriteApprovalCandidate } from "../agent/merchant/action-candidate.js";
import type { MerchantCoreService } from "../merchant-core/service.js";
import type {
  CommittedDecisionProof,
  CommittedDecisionVerifier,
} from "../merchant-core/commands.js";
import type { GrantAction, GrantResourceType } from "../merchant/grant-store.js";

export interface MerchantAdminSurface {
  listA2aNegotiations?(limit?: unknown): Promise<{
    total: number;
    items: import("../merchant/workbench-service.js").A2aNegotiationRow[];
  }>;
  getA2aNegotiation?(
    negotiationId: string,
  ): Promise<import("../merchant/workbench-service.js").A2aNegotiationRow>;
  listPending(): WriteApprovalCandidate[];
  /** 批准并执行（认证主体 + 一次性确认凭证逐次传入，执行层逐项核对）。 */
  executeApproved(
    commandId: string,
    principalId: string,
    confirmationToken?: string,
  ): Promise<unknown>;
  rejectCandidate(
    commandId: string,
    principalId: string,
    confirmationToken?: string,
  ): Promise<unknown>;
  executeCommittedDecision?(
    input: Omit<CommittedDecisionProof, "actionDigest">,
    verifier: CommittedDecisionVerifier,
  ): Promise<unknown>;
  getCandidate?(commandId: string): WriteApprovalCandidate | undefined;
  prepareInventoryUpdate?(input: {
    sku: string;
    stock: number;
    authorization: Record<string, unknown>;
    reason?: string;
  }): Promise<unknown> | unknown;
  prepareListingChange?(input: {
    sku: string;
    paused: boolean;
    authorization: Record<string, unknown>;
    reason?: string;
  }): Promise<unknown> | unknown;
  prepareBroadcastPublish?(input: {
    broadcast: Record<string, unknown>;
    authorization: Record<string, unknown>;
    workflowId?: string;
    reason?: string;
  }): Promise<unknown> | unknown;
  prepareBroadcastRevise?(input: {
    broadcastId: string;
    expectedRevision: number;
    broadcast: Record<string, unknown>;
    authorization: Record<string, unknown>;
    reason?: string;
  }): Promise<unknown> | unknown;
  prepareBroadcastWithdraw?(input: {
    broadcastId: string;
    expectedRevision: number;
    authorization: Record<string, unknown>;
    reason?: string;
  }): Promise<unknown> | unknown;
  prepareGrantCreate?(input: {
    ownerActorId: string;
    subjectId: string;
    action: GrantAction;
    resourceType: GrantResourceType;
    resourceSelector: "merchant" | "all_products" | readonly string[];
    expiresAt: string;
    reason?: string;
  }): Promise<unknown> | unknown;
  prepareGrantRevoke?(input: {
    ownerActorId: string;
    grantId: string;
    reason?: string;
  }): Promise<unknown> | unknown;
  preparePromotionPublish?(input: {
    promotionId: string;
    expectedRevision: number;
    workflowId?: string;
    broadcastAuthorization?: Record<string, unknown>;
    reason?: string;
  }): Promise<unknown> | unknown;
  preparePromotionWithdraw?(input: {
    promotionId: string;
    expectedRevision: number;
    reason?: string;
  }): Promise<unknown> | unknown;
}

/** 从 merchant-core 构造管理面（确认通道 = core 的命令日志）。 */
export function merchantAdminSurface(core: MerchantCoreService): MerchantAdminSurface {
  return {
    listA2aNegotiations: (limit) => core.listA2aNegotiations(limit),
    getA2aNegotiation: (negotiationId) => core.getA2aNegotiation(negotiationId),
    listPending: () => core.listPendingCommands(),
    executeApproved: (id, principalId, token) =>
      core.commands.executeApproved(id, principalId, token),
    rejectCandidate: (id, principalId, token) => core.commands.reject(id, principalId, token),
    executeCommittedDecision: (input, verifier) => core.executeCommittedDecision(input, verifier),
    getCandidate: (id) => core.getCommand(id),
    prepareInventoryUpdate: (input) => core.prepareInventoryUpdate(input),
    prepareListingChange: (input) => core.prepareListingChange(input),
    prepareBroadcastPublish: (input) => core.prepareBroadcastPublish(input),
    prepareBroadcastRevise: (input) => core.prepareBroadcastRevise(input),
    prepareBroadcastWithdraw: (input) => core.prepareBroadcastWithdraw(input),
    prepareGrantCreate: (input) => core.prepareGrantCreate(input),
    prepareGrantRevoke: (input) => core.prepareGrantRevoke(input),
    preparePromotionPublish: (input) => core.preparePromotionPublish(input),
    preparePromotionWithdraw: (input) => core.preparePromotionWithdraw(input),
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 待批准命令页（最小可用；与 OAuth 授权页同风格）。 */
export function renderPendingPage(
  merchantName: string,
  commands: WriteApprovalCandidate[],
  tokenFor?: (candidateId: string, action: "approve" | "reject") => string,
): string {
  const rows = commands
    .map(
      (c) => `<tr>
  <td>${escapeHtml(c.candidate_id)}</td>
  <td>${escapeHtml(c.tool)}</td>
  <td><pre>${escapeHtml(JSON.stringify(c.arguments, null, 2))}</pre></td>
  <td><pre>${escapeHtml(JSON.stringify(c.preconditions, null, 2))}</pre></td>
  <td>${escapeHtml(c.expires_at)}</td>
  <td>
    <form method="post" action="/admin/decision" style="display:inline">
      <input type="hidden" name="command_id" value="${escapeHtml(c.candidate_id)}">
      <input type="hidden" name="confirmation" value="${escapeHtml(tokenFor?.(c.candidate_id, "approve") ?? "")}">
      <button type="submit" name="decision" value="approve">批准并执行</button>
    </form>
    <form method="post" action="/admin/decision" style="display:inline">
      <input type="hidden" name="command_id" value="${escapeHtml(c.candidate_id)}">
      <input type="hidden" name="confirmation" value="${escapeHtml(tokenFor?.(c.candidate_id, "reject") ?? "")}">
      <button type="submit" name="decision" value="reject">拒绝</button>
    </form>
  </td>
</tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>待批准命令 — ${escapeHtml(merchantName)}</title></head>
<body>
  <h1>${escapeHtml(merchantName)}：待批准命令</h1>
  <p>展示预览 ≠ 批准；批准 ≠ 执行成功（执行前重校验前置版本与硬策略）。</p>
  ${
    commands.length === 0
      ? "<p>当前没有待批准命令。</p>"
      : `<table border="1" cellpadding="6">
<tr><th>command_id</th><th>工具</th><th>参数</th><th>前置版本</th><th>有效期至</th><th>操作</th></tr>
${rows}
</table>`
  }
</body>
</html>`;
}
