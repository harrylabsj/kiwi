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
 * Merchant RFQ 服务面（设计 v0.1.1 §11.1；Merchant Core 内的 RFQ 子服务）。
 *
 *   - 一次编排只调用一个确定性业务核心：本服务不启动自由聊天模型重复
 *     理解请求；提取建议由宿主模型提出、本服务做类型/范围/引用校验。
 *   - WorkBuddy 是操作入口不是状态权威：失去宿主连接后，本服务的持久
 *     状态（询盘/报价/审批/审计）仍可经管理页/CLI 读取（Merchant
 *     Independence Gate 的本次具体化，§4.3）。
 *   - 计价、权限与状态转移由确定性代码处理；模型输出不是审批凭证（I03）。
 *   - 金额只接受服务端快照/操作者确认来源；模型提交的最终金额一律拒绝。
 */

import { randomUUID } from "node:crypto";
import type { CommerceDataSource, ProductFact } from "../../commerce/data-source.js";
import { RfqError } from "./types.js";
import type {
  PricingInput,
  PricingResult,
  PublicQuoteView,
  QuoteDiff,
  QuoteStatus,
  RfqBlocker,
  RfqCaseFields,
  RfqStage,
} from "./types.js";
import { calculatePricing } from "./pricing.js";
import { RfqRepository, type RfqCaseRow, type RfqReleaseRow } from "./repository.js";
import {
  applyExtractionProposal,
  computeBlockers,
  parseCsvInquiry,
  sha256Hex,
  type ExtractionProposalEntry,
  type SourceRecordKind,
} from "./source-records.js";
import {
  evaluateFreshness,
  resolveFactSnapshot,
  type FactSnapshotDraft,
} from "./fact-resolver.js";
import type { RfqPolicyContext } from "./policy.js";
import { RfqArtifactStore } from "./artifacts.js";
import { RfqReleaseCoordinator } from "./release-coordinator.js";
import { recordReportedDelivery, DELIVERY_CHANNELS } from "./delivery.js";
import { recordOwnerRecorded } from "./handoff.js";
import { diffQuotes, invalidReasonOf, buildPublicProjection } from "./quote-revisions.js";

/** ingest / revise / price 的结果形状（幂等重放反序列化目标）。 */
export interface RfqIngestResult {
  case_id: string;
  revision: number;
  stage: RfqStage;
  blockers: RfqBlocker[];
  source_id: string;
  warnings: string[];
}
export interface RfqReviseResult {
  case_id: string;
  revision: number;
  stage: RfqStage;
  blockers: RfqBlocker[];
  superseded_quote: string | null;
}
export interface RfqPriceResult {
  quote_id: string;
  revision: number;
  status: QuoteStatus;
  totals: PricingResult["totals"];
  valid_until: string;
  blockers: string[];
}

/** 调用上下文（传输层验证后注入；未经验证的模型字段不能构造）。 */
export interface RfqCallContext {
  /** 已认证主体（OAuth subject / 管理页会话主体）。 */
  principalId: string;
  /** 真实会话 actor（与命令授权 principal 分开审计，§9.3）。 */
  actor: string;
  traceId: string;
  scopes?: string[];
}

export interface RfqServiceDeps {
  repo: RfqRepository;
  dataSource: CommerceDataSource;
  artifacts: RfqArtifactStore;
  coordinator: RfqReleaseCoordinator;
  now: () => string;
  /** 确认写入通道（管理页/CLI 具名交互）；缺省时确认 fail-closed。 */
  confirmationMinter?: (input: { caseId: string; revision: number; lineId: string; sku: string; actor: string }) => string;
  /** 审批候选状态查询（恢复同步用；来自审批 store）。 */
  candidateStatus?: (candidateId: string) => string | undefined;
  policyVersion: () => string;
}

export interface RfqCaseView {
  case: RfqCaseRow;
  revision: number;
  fields: RfqCaseFields;
  blockers: RfqBlocker[];
  quotes: Array<{ quote_id: string; revision: number; status: QuoteStatus; totals: unknown; valid_until: string; invalid_reason?: string }>;
  releases: RfqReleaseRow[];
  current_quote_id: string | null;
  current_quote_revision: number | null;
}

export class MerchantRfqService {
  private readonly deps: RfqServiceDeps;

  constructor(deps: RfqServiceDeps) {
    this.deps = deps;
  }

  private repo(): RfqRepository {
    return this.deps.repo;
  }

  private assertActor(ctx: RfqCallContext): void {
    if (ctx.principalId.trim() === "" || ctx.actor.trim() === "") {
      throw new RfqError("auth", "缺少已认证主体（AuthContext 必须由传输层注入）");
    }
  }

  private audit(ctx: RfqCallContext, operation: string, objectDigest: string, result: string): void {
    this.repo().appendAudit({
      actor: ctx.actor,
      operation,
      objectDigest,
      result,
      traceId: ctx.traceId,
    });
  }

  // ---- 步骤一/二：导入与提取（§5.1） --------------------------------------

  /** 导入询盘：保存原始材料摘要 + 应用提取 proposal（全部保持未确认）。 */
  ingest(ctx: RfqCallContext, cmd: {
    kind: SourceRecordKind;
    content: string;
    displayName?: string;
    externalRef?: string;
    proposal?: { entries: ExtractionProposalEntry[] };
    idempotencyKey: string;
  }): { case_id: string; revision: number; stage: RfqStage; blockers: RfqBlocker[]; source_id: string; warnings: string[]; replayed: boolean } {
    this.assertActor(ctx);
    if (cmd.kind !== "manual_text" && cmd.kind !== "csv") {
      throw new RfqError("validation", 'ingest 的 kind 必须是 "manual_text" 或 "csv"');
    }
    if (typeof cmd.content !== "string" || cmd.content.trim() === "") {
      throw new RfqError("source_invalid", "询盘内容不能为空");
    }
    if (cmd.content.length > 100 * 1024) {
      throw new RfqError("source_invalid", "单个粘贴文本上限 100 KB（超限拒绝，不截断）");
    }
    const { result, replayed } = this.repo().withIdempotency({
      principalId: ctx.principalId,
      operation: "rfq.ingest",
      key: cmd.idempotencyKey,
      request: { kind: cmd.kind, content_sha256: sha256Hex(cmd.content), proposal: cmd.proposal ?? null },
      run: () => this.ingestOnce(ctx, cmd),
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as RfqIngestResult,
    });
    return { ...result, replayed };
  }

  private ingestOnce(ctx: RfqCallContext, cmd: {
    kind: SourceRecordKind;
    content: string;
    displayName?: string;
    externalRef?: string;
    proposal?: { entries: ExtractionProposalEntry[] };
  }): RfqIngestResult {
    // 客户显示名/外部引用为操作者提供元数据；原始客户文字始终按不可信内容处理。
    void cmd.displayName;
    void cmd.externalRef;
    const kase = this.repo().createCase();
    const { source } = this.repo().createSource({
      caseId: kase.case_id,
      kind: cmd.kind,
      content: cmd.content,
      receivedAt: this.deps.now(),
      submittedBy: ctx.actor,
      synthetic: false,
    });
    let fields: RfqCaseFields;
    let warnings: string[] = [];
    if (cmd.kind === "csv") {
      const parsed = parseCsvInquiry(cmd.content);
      fields = {
        client_ref: "rfq",
        recipient_ref: null,
        terms: {
          currency: "CNY",
          tax_basis: "UNKNOWN",
          tax_rate_bps: null,
          shipping_known: false,
          shipping_minor: null,
          delivery_date: null,
          payment_terms: null,
        },
        lines: parsed.lines.map((l) => ({
          ...l,
          confirmation: "unconfirmed" as const,
          confirmation_ref: null,
          evidence_source_ids: [source.source_id],
        })),
      };
    } else {
      fields = {
        client_ref: "rfq",
        recipient_ref: null,
        terms: {
          currency: "CNY",
          tax_basis: "UNKNOWN",
          tax_rate_bps: null,
          shipping_known: false,
          shipping_minor: null,
          delivery_date: null,
          payment_terms: null,
        },
        lines: [
          {
            line_id: "L1",
            query: cmd.content,
            sku: null,
            quantity: null,
            unit: null,
            confirmation: "unconfirmed",
            confirmation_ref: null,
            evidence_source_ids: [source.source_id],
          },
        ],
      };
    }
    if (cmd.proposal !== undefined && cmd.proposal.entries.length > 0) {
      const outcome = applyExtractionProposal({
        fields,
        entries: cmd.proposal.entries,
        sourceContent: cmd.content,
        sourceId: source.source_id,
        span: cmd.content,
      });
      fields = outcome.fields;
      warnings = outcome.warnings;
    }
    const blockers = computeBlockers(fields);
    const { case: updated, revision } = this.repo().createCaseRevision({
      caseId: kase.case_id,
      expectedVersion: kase.version,
      fields,
      blockers,
      sourceIds: [source.source_id],
    });
    this.audit(ctx, "rfq.ingest", `case:${kase.case_id}`, `revision:${revision.revision}`);
    return {
      case_id: updated.case_id,
      revision: revision.revision,
      stage: updated.stage,
      blockers,
      source_id: source.source_id,
      warnings,
    };
  }

  // ---- 需求修订与关闭 -------------------------------------------------------

  /** 客户修改条件/操作者修订：新 revision + 旧报价替代（§5.2、§8.2）。 */
  revise(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    changes: ExtractionProposalEntry[];
    idempotencyKey: string;
  }): { case_id: string; revision: number; stage: RfqStage; blockers: RfqBlocker[]; superseded_quote: string | null; replayed: boolean } {
    this.assertActor(ctx);
    const { result, replayed } = this.repo().withIdempotency({
      principalId: ctx.principalId,
      operation: "rfq.revise",
      key: cmd.idempotencyKey,
      request: { case_id: cmd.caseId, expected_revision: cmd.expectedRevision, changes: cmd.changes },
      run: () => this.reviseOnce(ctx, cmd),
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as RfqReviseResult,
    });
    return { ...result, replayed };
  }

  private reviseOnce(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    changes: ExtractionProposalEntry[];
  }): RfqReviseResult {
    const kase = this.repo().getCase(cmd.caseId);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${cmd.caseId}`);
    if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
      throw new RfqError("case_closed", `询盘 ${cmd.caseId} 已是终态，不能修订`);
    }
    const current = this.repo().getCaseRevision(cmd.caseId, kase.current_revision);
    if (current === undefined) throw new RfqError("not_found", `询盘 ${cmd.caseId} 缺少当前 revision`);
    const sources = current.source_ids;
    const primarySource = sources.length === 1 ? sources[0] : undefined;
    const spanSource = primarySource !== undefined ? (this.repo().getSource(primarySource)?.content ?? "") : "";
    const outcome = applyExtractionProposal({
      fields: current.fields,
      entries: cmd.changes,
      sourceContent: spanSource === "" ? (cmd.changes[0]?.quote ?? " ") : spanSource,
      sourceId: primarySource ?? "operator",
      span: spanSource === "" ? (cmd.changes[0]?.quote ?? " ") : spanSource,
    });
    const blockers = computeBlockers(outcome.fields);
    // 关键需求更新 → 先建新 revision，再使旧审批失效（§8.2）。
    const { case: updated, revision } = this.repo().createCaseRevision({
      caseId: cmd.caseId,
      expectedVersion: kase.version,
      fields: outcome.fields,
      blockers,
      sourceIds: sources,
    });
    let superseded: string | null = null;
    if (kase.current_quote_id !== null) {
      superseded = kase.current_quote_id;
      this.repo().supersedeCurrentQuote({
        caseId: cmd.caseId,
        expectedVersion: updated.version,
        actor: ctx.actor,
        reason: `需求更新至 revision ${revision.revision}；旧版本审批失效`,
        stage: updated.stage,
      });
    }
    this.audit(ctx, "rfq.revise", `case:${cmd.caseId}`, `revision:${revision.revision}`);
    return {
      case_id: updated.case_id,
      revision: revision.revision,
      stage: updated.stage,
      blockers,
      superseded_quote: superseded,
    };
  }

  /** 操作者显式取消/关闭（唯一进入 CANCELLED/CLOSED 的通道；§8.1 v0.1.1）。 */
  closeCase(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    outcome: "CANCELLED" | "CLOSED";
    reason?: string;
    idempotencyKey: string;
  }): { case_id: string; stage: RfqStage; replayed: boolean } {
    this.assertActor(ctx);
    const { result, replayed } = this.repo().withIdempotency({
      principalId: ctx.principalId,
      operation: "rfq.close",
      key: cmd.idempotencyKey,
      request: { case_id: cmd.caseId, expected_revision: cmd.expectedRevision, outcome: cmd.outcome, reason: cmd.reason ?? null },
      run: () => {
        const kase = this.repo().getCase(cmd.caseId);
        if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${cmd.caseId}`);
        if (kase.version !== cmd.expectedRevision) {
          throw new RfqError("version_conflict", `询盘版本已变化（${kase.version} ≠ ${cmd.expectedRevision}）`);
        }
        const updated = this.repo().closeCase({
          caseId: cmd.caseId,
          expectedVersion: cmd.expectedRevision,
          stage: cmd.outcome,
        });
        this.audit(ctx, "rfq.close", `case:${cmd.caseId}`, cmd.outcome);
        return { case_id: updated.case_id, stage: updated.stage };
      },
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as { case_id: string; stage: RfqStage },
    });
    return { ...result, replayed };
  }

  // ---- 读取 -----------------------------------------------------------------

  getCase(ctx: RfqCallContext, caseId: string): RfqCaseView {
    this.assertActor(ctx);
    const kase = this.repo().getCase(caseId);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${caseId}`);
    const revision = this.repo().getCaseRevision(caseId, kase.current_revision);
    if (revision === undefined) throw new RfqError("not_found", `询盘 ${caseId} 缺少当前 revision`);
    const now = this.deps.now();
    const quotes = this.repo().listQuotesForCase(caseId).map((q) => ({
      quote_id: q.quote_id,
      revision: q.revision,
      status: q.status,
      totals: JSON.parse(q.pricing_output_json) as unknown,
      valid_until: q.valid_until,
      ...(invalidReasonOf(q.status, q.valid_until, now) !== undefined
        ? { invalid_reason: invalidReasonOf(q.status, q.valid_until, now) }
        : {}),
    }));
    return {
      case: kase,
      revision: kase.current_revision,
      fields: revision.fields,
      blockers: computeBlockers(revision.fields),
      quotes,
      releases: this.repo().listReleasesForQuote(
        kase.current_quote_id ?? "",
        kase.current_quote_revision ?? 0,
      ),
      current_quote_id: kase.current_quote_id,
      current_quote_revision: kase.current_quote_revision,
    };
  }

  /** 报价只读视图（MCP 资源/compare 用；只含授权投影与事件投影）。 */
  getQuoteView(ctx: RfqCallContext, quoteId: string, revision: number): {
    quote_id: string;
    revision: number;
    case_id: string;
    case_revision: number;
    status: QuoteStatus;
    valid_until: string;
    projection: PublicQuoteView;
    invalid_reason?: string;
    events: Array<{ event: string; actor: string; at: string; reason: string | null }>;
  } {
    this.assertActor(ctx);
    const quote = this.repo().getQuote(quoteId, revision);
    if (quote === undefined) throw new RfqError("not_found", `未知报价 ${quoteId}@${revision}`);
    const now = this.deps.now();
    const invalid = invalidReasonOf(quote.status, quote.valid_until, now);
    return {
      quote_id: quote.quote_id,
      revision: quote.revision,
      case_id: quote.case_id,
      case_revision: quote.case_revision,
      status: quote.status,
      valid_until: quote.valid_until,
      projection: { ...(JSON.parse(quote.projection_json) as Omit<PublicQuoteView, "status">), status: quote.status },
      ...(invalid !== undefined ? { invalid_reason: invalid } : {}),
      events: this.repo()
        .listQuoteEvents(quoteId, revision)
        .map((e) => ({ event: e.event, actor: e.actor, at: e.at, reason: e.reason })),
    };
  }

  /** 管理页列表（案例级摘要）。 */
  listCases(ctx: RfqCallContext, limit = 50): RfqCaseView[] {
    this.assertActor(ctx);
    return this.repo()
      .listCases(Math.min(Math.max(limit, 1), 200))
      .map((c) => {
        try {
          return this.getCase(ctx, c.case_id);
        } catch {
          return null;
        }
      })
      .filter((v): v is RfqCaseView => v !== null);
  }

  /** 管理页发布详情（含投影与候选状态；批准走命令日志）。 */
  adminReleaseDetail(ctx: RfqCallContext, releaseId: string): {
    release: { release_id: string; status: string; candidate_id: string; quote_id: string; quote_revision: number; recipient_ref: string; artifact_id: string; artifact_sha256: string };
    quote: { case_id: string; case_revision: number; status: QuoteStatus; projection: PublicQuoteView } | null;
  } {
    this.assertActor(ctx);
    const release = this.repo().getRelease(releaseId);
    if (release === undefined) throw new RfqError("not_found", `未知发布 ${releaseId}`);
    const quote = this.repo().getQuote(release.quote_id, release.quote_revision);
    return {
      release: {
        release_id: release.release_id,
        status: release.status,
        candidate_id: release.candidate_id,
        quote_id: release.quote_id,
        quote_revision: release.quote_revision,
        recipient_ref: release.recipient_ref,
        artifact_id: release.artifact_id,
        artifact_sha256: release.artifact_sha256,
      },
      quote:
        quote === undefined
          ? null
          : {
              case_id: quote.case_id,
              case_revision: quote.case_revision,
              status: quote.status,
              projection: {
                ...(JSON.parse(quote.projection_json) as Omit<PublicQuoteView, "status">),
                status: quote.status,
              },
            },
    };
  }

  /** 商品搜索（§6.4：完整性显式；「当前页无匹配」≠「全库不存在」）。 */
  async searchProducts(ctx: RfqCallContext, q: { query: string; limit?: number }): Promise<{
    items: ProductFact[];
    next_cursor: string | null;
    complete: boolean;
    snapshot_at: string;
    source_version: string | null;
  }> {
    this.assertActor(ctx);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const items = await this.deps.dataSource.getProducts({ query: q.query, limit });
    // 上游单页 limit 能力不构成完整目录保证（§6.4；cursor 契约与
    // shopping-cli 联合实现——首版单页，complete 按「是否触顶」显式标注）。
    const complete = items.length < limit;
    return {
      items,
      next_cursor: null,
      complete,
      snapshot_at: this.deps.now(),
      source_version: null,
    };
  }

  /**
   * 具名人工确认（权威写入通道：管理页表单/CLI 具名交互；§11.2）。
   * 模型工具只能读取确认结果，不能自报 human_confirmed。
   */
  confirmLines(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    selections: Array<{ line_id: string; sku: string; quantity?: number; unit?: string }>;
  }): { case_id: string; revision: number; stage: RfqStage; blockers: RfqBlocker[] } {
    this.assertActor(ctx);
    if (this.deps.confirmationMinter === undefined) {
      throw new RfqError("unavailable", "具名确认通道未配置（只能通过可信管理页/CLI 确认）");
    }
    const kase = this.repo().getCase(cmd.caseId);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${cmd.caseId}`);
    if (kase.current_revision !== cmd.expectedRevision) {
      throw new RfqError("version_conflict", `询盘 revision 已变化（${kase.current_revision} ≠ ${cmd.expectedRevision}）`);
    }
    const current = this.repo().getCaseRevision(cmd.caseId, kase.current_revision);
    if (current === undefined) throw new RfqError("not_found", `询盘 ${cmd.caseId} 缺少当前 revision`);
    const fields: RfqCaseFields = structuredClone(current.fields);
    for (const sel of cmd.selections) {
      const line = fields.lines.find((l) => l.line_id === sel.line_id);
      if (line === undefined) throw new RfqError("validation", `未知 line_id：${sel.line_id}`);
      line.sku = sel.sku;
      if (sel.quantity !== undefined) line.quantity = sel.quantity;
      if (sel.unit !== undefined) line.unit = sel.unit;
      line.confirmation = "confirmed";
      line.confirmation_ref = this.deps.confirmationMinter({
        caseId: cmd.caseId,
        revision: kase.current_revision,
        lineId: sel.line_id,
        sku: sel.sku,
        actor: ctx.actor,
      });
    }
    const blockers = computeBlockers(fields);
    const { case: updated, revision } = this.repo().createCaseRevision({
      caseId: cmd.caseId,
      expectedVersion: kase.version,
      fields,
      blockers,
      sourceIds: current.source_ids,
    });
    if (kase.current_quote_id !== null) {
      this.repo().supersedeCurrentQuote({
        caseId: cmd.caseId,
        expectedVersion: updated.version,
        actor: ctx.actor,
        reason: `确认更新至 revision ${revision.revision}`,
        stage: updated.stage,
      });
    }
    this.audit(ctx, "rfq.confirm_items", `case:${cmd.caseId}`, `revision:${revision.revision}`);
    return { case_id: updated.case_id, revision: revision.revision, stage: updated.stage, blockers };
  }

  /** MCP 侧确认读取：只核对已确认状态与引用存在性（不自报确认，§11.2）。 */
  readConfirmations(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    selections: Array<{ line_id: string; sku: string; confirmation_ref: string }>;
  }): { confirmed: string[]; missing: string[] } {
    this.assertActor(ctx);
    const kase = this.repo().getCase(cmd.caseId);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${cmd.caseId}`);
    if (kase.current_revision !== cmd.expectedRevision) {
      throw new RfqError("version_conflict", `询盘 revision 已变化`);
    }
    const revision = this.repo().getCaseRevision(cmd.caseId, kase.current_revision);
    if (revision === undefined) throw new RfqError("not_found", `缺少当前 revision`);
    const confirmed: string[] = [];
    const missing: string[] = [];
    for (const sel of cmd.selections) {
      const line = revision.fields.lines.find((l) => l.line_id === sel.line_id);
      const ok =
        line !== undefined &&
        line.confirmation === "confirmed" &&
        line.confirmation_ref !== null &&
        line.sku === sel.sku &&
        line.confirmation_ref === sel.confirmation_ref;
      if (ok) confirmed.push(sel.line_id);
      else missing.push(sel.line_id);
    }
    return { confirmed, missing };
  }

  // ---- 事实与计价（§5.1 步骤四/五） -----------------------------------------

  /** 建立新事实快照；指纹变化时旧报价/候选失效（§6.3）。 */
  async refreshFacts(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    idempotencyKey: string;
  }): Promise<{ snapshot_id: string; fingerprint: string; fields: number; stale: string[]; missing_verification: string[]; superseded_quote: string | null; replayed: boolean }> {
    this.assertActor(ctx);
    const { result, replayed } = await this.repo().withIdempotencyAsync({
      principalId: ctx.principalId,
      operation: "rfq.refresh_facts",
      key: cmd.idempotencyKey,
      request: { case_id: cmd.caseId, expected_revision: cmd.expectedRevision },
      run: async () => {
        const kase = this.repo().getCase(cmd.caseId);
        if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${cmd.caseId}`);
        if (kase.current_revision !== cmd.expectedRevision) {
          throw new RfqError("version_conflict", `询盘 revision 已变化`);
        }
        if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
          throw new RfqError("case_closed", "终态询盘不能刷新事实");
        }
        const revision = this.repo().getCaseRevision(cmd.caseId, kase.current_revision);
        if (revision === undefined) throw new RfqError("not_found", `缺少当前 revision`);
        const skus = revision.fields.lines.filter((l) => l.sku !== null).map((l) => l.sku as string);
        const snapshotId = `snap_${randomUUID()}`;
        const snapshot: FactSnapshotDraft = await resolveFactSnapshot({
          dataSource: this.deps.dataSource,
          merchantId: this.repo().merchantId,
          caseId: cmd.caseId,
          caseRevision: kase.current_revision,
          skus,
          snapshotId,
          nowIso: this.deps.now(),
        });
        this.repo().saveSnapshot({
          snapshotId,
          caseId: cmd.caseId,
          caseRevision: kase.current_revision,
          fields: snapshot.fields,
          contentFingerprint: snapshot.content_fingerprint,
          complete: snapshot.complete,
          fetchedAt: snapshot.fetched_at,
          synthetic: snapshot.synthetic,
        });
        // 指纹变化 → 旧报价失效（新 revision 不需要：事实不是需求字段）。
        let superseded: string | null = null;
        const previous = this.repo().getLatestSnapshotForCase(cmd.caseId, snapshotId);
        if (
          previous !== undefined &&
          previous.content_fingerprint !== snapshot.content_fingerprint &&
          kase.current_quote_id !== null
        ) {
          superseded = kase.current_quote_id;
          this.repo().supersedeCurrentQuote({
            caseId: cmd.caseId,
            expectedVersion: kase.version,
            actor: ctx.actor,
            reason: "事实指纹变化；旧报价失效（源值或源版本变化即失效）",
            stage: "READY",
          });
        }
        const freshness = evaluateFreshness(snapshot.fields, this.deps.now());
        this.audit(ctx, "rfq.refresh_facts", `case:${cmd.caseId}`, snapshotId);
        return {
          snapshot_id: snapshotId,
          fingerprint: snapshot.content_fingerprint,
          fields: snapshot.fields.length,
          stale: freshness.stale,
          missing_verification: freshness.missing_verification,
          superseded_quote: superseded,
        };
      },
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as { snapshot_id: string; fingerprint: string; fields: number; stale: string[]; missing_verification: string[]; superseded_quote: string | null },
    });
    return { ...result, replayed };
  }

  /** 确定性计价（Core 计算；不接受模型最终金额，§5.1 步骤五）。 */
  price(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    snapshotId: string;
    idempotencyKey: string;
  }): { quote_id: string; revision: number; status: QuoteStatus; totals: PricingResult["totals"]; valid_until: string; blockers: string[]; replayed: boolean } {
    this.assertActor(ctx);
    const { result, replayed } = this.repo().withIdempotency({
      principalId: ctx.principalId,
      operation: "rfq.price",
      key: cmd.idempotencyKey,
      request: { case_id: cmd.caseId, expected_revision: cmd.expectedRevision, snapshot_id: cmd.snapshotId },
      run: () => this.priceOnce(ctx, cmd),
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as RfqPriceResult,
    });
    return { ...result, replayed };
  }

  private priceOnce(ctx: RfqCallContext, cmd: {
    caseId: string;
    expectedRevision: number;
    snapshotId: string;
  }): RfqPriceResult {
    const kase = this.repo().getCase(cmd.caseId);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${cmd.caseId}`);
    if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
      throw new RfqError("case_closed", "终态询盘不能计价");
    }
    if (kase.current_revision !== cmd.expectedRevision) {
      throw new RfqError("version_conflict", `询盘 revision 已变化（${kase.current_revision} ≠ ${cmd.expectedRevision}）`);
    }
    const revision = this.repo().getCaseRevision(cmd.caseId, kase.current_revision);
    if (revision === undefined) throw new RfqError("not_found", `缺少当前 revision`);
    const blockers = computeBlockers(revision.fields);
    if (blockers.length > 0) {
      throw new RfqError("needs_clarification", `关键字段未确认（${blockers.length} 项）：先补齐再计价`);
    }
    const snapshot = this.repo().getSnapshot(cmd.snapshotId);
    if (snapshot === undefined || snapshot.case_id !== cmd.caseId) {
      throw new RfqError("not_found", `未知事实快照 ${cmd.snapshotId}`);
    }
    const factFields = JSON.parse(snapshot.fields_json) as Parameters<typeof evaluateFreshness>[0];
    const priceBySku = new Map<string, number | null>();
    for (const f of factFields) {
      if (f.field_path.endsWith(".price_minor")) {
        priceBySku.set(f.field_path.slice("products.".length, -".price_minor".length), f.value as number | null);
      }
    }
    // 计价输入：单价只来自已授权快照（经授权的价格规则）；优惠为操作者
    // 确认字段（首版固定 0 —— 优惠输入开放属于版本化扩展，§7.4）。
    const pricingLines = revision.fields.lines.map((line) => {
      const sku = line.sku as string;
      const unitPrice = priceBySku.get(sku);
      if (unitPrice === undefined || unitPrice === null) {
        throw new RfqError("source_unavailable", `SKU ${sku} 的授权价格缺失（价格缺失不降级为演示价）`);
      }
      return {
        line_id: line.line_id,
        sku,
        unit: line.unit ?? "",
        quantity: line.quantity as number,
        unit_price_minor: unitPrice,
        discount_minor: 0,
        tax_basis: revision.fields.terms.tax_basis as "EXCLUSIVE" | "INCLUSIVE",
        tax_rate_bps: revision.fields.terms.tax_rate_bps as number,
      };
    });
    const pricingInput: PricingInput = {
      schema_version: "0.1.0",
      currency: "CNY",
      rounding: "HALF_UP_LINE",
      lines: pricingLines,
      shipping: {
        amount_minor: revision.fields.terms.shipping_minor as number,
        tax_basis: revision.fields.terms.tax_basis as "EXCLUSIVE" | "INCLUSIVE",
        tax_rate_bps: revision.fields.terms.tax_rate_bps as number,
      },
    };
    const output = calculatePricing(pricingInput);
    // 硬策略（含底价兜底；拒绝只返回理由码）。报价有效期缺省 7 天（模型
    // 不可改变有效期——工具面不暴露该参数；调整走策略配置，§13.1）。
    const validUntil = new Date(Date.parse(this.deps.now()) + 7 * 86_400_000).toISOString();
    const policyCtx: RfqPolicyContext = {
      merchantId: this.repo().merchantId,
      lines: pricingLines.map((l) => ({ sku: l.sku, quantity: l.quantity, unit: l.unit, unit_price_minor: l.unit_price_minor })),
      validUntil,
      paymentTerms: revision.fields.terms.payment_terms ?? "",
      facts: factFields,
      nowIso: this.deps.now(),
    };
    this.deps.coordinator.validateWithCurrentPolicy(policyCtx);
    const projection = buildPublicProjection({
      quoteId: "",
      revision: 1,
      caseId: cmd.caseId,
      caseRevision: kase.current_revision,
      clientRef: revision.fields.client_ref,
      recipientRef: revision.fields.recipient_ref ?? "",
      pricingInput,
      pricingOutput: output,
      deliveryTerms: revision.fields.terms.delivery_date ?? "",
      paymentTerms: revision.fields.terms.payment_terms ?? "",
      validUntil,
      dataAsOf: snapshot.fetched_at,
    });
    const quoteId = `qt_${randomUUID()}`;
    const projectionFinal = { ...projection, quote_id: quoteId };
    const quote = this.repo().createQuote({
      quoteId,
      revision: 1,
      caseId: cmd.caseId,
      caseRevision: kase.current_revision,
      snapshotId: cmd.snapshotId,
      factFingerprint: snapshot.content_fingerprint,
      pricingInput,
      pricingOutput: output,
      projection: projectionFinal,
      policyVersion: this.deps.policyVersion(),
      validUntil: policyCtx.validUntil,
      actor: ctx.actor,
    });
    // 新版本替代旧指针（一份 RFQ 同时只有一个 current_quote_revision）。
    if (kase.current_quote_id !== null) {
      this.repo().supersedeCurrentQuote({
        caseId: cmd.caseId,
        expectedVersion: kase.version,
        actor: ctx.actor,
        reason: `新报价 ${quoteId} 替代旧版本`,
        stage: "PRICED",
      });
    }
    this.repo().updateCurrentQuote({
      caseId: cmd.caseId,
      expectedVersion: this.repo().getCase(cmd.caseId)?.version ?? kase.version,
      quoteId,
      quoteRevision: 1,
      stage: "PRICED",
    });
    this.audit(ctx, "rfq.price", `quote:${quoteId}`, `totals:${output.totals.gross_minor}`);
    return {
      quote_id: quote.quote_id,
      revision: quote.revision,
      status: quote.status,
      totals: output.totals,
      valid_until: quote.valid_until,
      blockers: [],
    };
  }

  /** 版本差异（§11.1 compare；旧版失效原因显式）。 */
  compare(ctx: RfqCallContext, a: { quote_id: string; revision: number }, b: { quote_id: string; revision: number }): QuoteDiff {
    this.assertActor(ctx);
    const qa = this.repo().getQuote(a.quote_id, a.revision);
    const qb = this.repo().getQuote(b.quote_id, b.revision);
    if (qa === undefined || qb === undefined) {
      throw new RfqError("not_found", `未知报价 ${qa === undefined ? a.quote_id : b.quote_id}`);
    }
    const va = { ...(JSON.parse(qa.projection_json) as Omit<PublicQuoteView, "status">), status: qa.status };
    const vb = { ...(JSON.parse(qb.projection_json) as Omit<PublicQuoteView, "status">), status: qb.status };
    const now = this.deps.now();
    return diffQuotes(
      { view: va, ...(invalidReasonOf(qa.status, qa.valid_until, now) !== undefined ? { invalidReason: invalidReasonOf(qa.status, qa.valid_until, now) } : {}) },
      { view: vb, ...(invalidReasonOf(qb.status, qb.valid_until, now) !== undefined ? { invalidReason: invalidReasonOf(qb.status, qb.valid_until, now) } : {}) },
    );
  }

  // ---- 发布（三阶段）与导出 --------------------------------------------------

  async prepareRelease(ctx: RfqCallContext, cmd: {
    caseId: string;
    quoteId: string;
    revision: number;
    recipientRef?: string;
    idempotencyKey: string;
    prepareCandidate: (args: { releaseId: string }) => Promise<string>;
  }): Promise<{ release_id: string; candidate_id: string; artifact_id: string; artifact_sha256: string; public_projection_digest: string; warnings: string[]; replayed: boolean }> {
    this.assertActor(ctx);
    // async：prepareRelease 含命令日志登记（异步）。

    const { result, replayed } = await this.repo().withIdempotencyAsync({
      principalId: ctx.principalId,
      operation: "rfq.prepare_release",
      key: cmd.idempotencyKey,
      request: { case_id: cmd.caseId, quote_id: cmd.quoteId, revision: cmd.revision, recipient: cmd.recipientRef ?? null },
      run: async () => {
        const prepared = await this.deps.coordinator.prepareRelease({
          caseId: cmd.caseId,
          quoteId: cmd.quoteId,
          revision: cmd.revision,
          ...(cmd.recipientRef !== undefined ? { recipientRef: cmd.recipientRef } : {}),
          actor: ctx.actor,
          prepareCandidate: cmd.prepareCandidate,
        });
        return {
          release_id: prepared.release_id,
          candidate_id: prepared.candidate_id,
          artifact_id: prepared.artifact_id,
          artifact_sha256: prepared.artifact_sha256,
          public_projection_digest: prepared.public_projection_digest,
          warnings: prepared.warnings,
        };
      },
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as { release_id: string; candidate_id: string; artifact_id: string; artifact_sha256: string; public_projection_digest: string; warnings: string[] },
    });
    return { ...result, replayed };
  }

  getRelease(ctx: RfqCallContext, releaseId: string): {
    release_id: string;
    status: RfqReleaseRow["status"];
    quote_id: string;
    quote_revision: number;
    candidate_id: string;
    artifact_id: string;
    recipient_ref: string;
    downloadable: boolean;
  } {
    this.assertActor(ctx);
    const release = this.repo().getRelease(releaseId);
    if (release === undefined) throw new RfqError("not_found", `未知发布 ${releaseId}`);
    const quote = this.repo().getQuote(release.quote_id, release.quote_revision);
    const downloadable =
      release.status === "APPROVED" &&
      quote !== undefined &&
      quote.status === "APPROVED";
    return {
      release_id: release.release_id,
      status: release.status,
      quote_id: release.quote_id,
      quote_revision: release.quote_revision,
      candidate_id: release.candidate_id,
      artifact_id: release.artifact_id,
      recipient_ref: release.recipient_ref,
      downloadable,
    };
  }

  /**
   * 权限下载（管理页专用；EXPORTED 唯一触发通道，v0.1.1 §8.2/§11.4）。
   * 调用前必须完成管理页会话认证与归属校验；MCP 资源读取不经过本方法。
   */
  downloadArtifact(ctx: RfqCallContext, artifactId: string): { content: string; content_type: string; filename: string } {
    this.assertActor(ctx);
    const artifact = this.repo().getArtifact(artifactId);
    if (artifact === undefined) throw new RfqError("not_found", `未知产物 ${artifactId}`);
    if (!artifact.activated) {
      throw new RfqError("forbidden", "产物未激活（批准前不提供下载）");
    }
    const quote = this.repo().getQuote(artifact.quote_id, artifact.quote_revision);
    if (quote === undefined || (quote.status !== "APPROVED" && quote.status !== "EXPORTED")) {
      throw new RfqError("forbidden", "产物对应的报价不是已批准状态");
    }
    const content = this.deps.artifacts.read(artifact);
    if (quote.status === "APPROVED") {
      this.repo().markQuoteExported({ quoteId: quote.quote_id, revision: quote.revision, actor: ctx.actor });
    }
    this.audit(ctx, "rfq.download_artifact", `artifact:${artifactId}`, "ok");
    return {
      content,
      content_type: artifact.content_type,
      filename: `quote-${artifact.quote_id}-v${artifact.quote_revision}.${artifact.content_type === "application/pdf" ? "pdf" : "txt"}`,
    };
  }

  // ---- 发送与移交 -----------------------------------------------------------

  recordDelivery(ctx: RfqCallContext, cmd: {
    quoteId: string;
    revision: number;
    channel: (typeof DELIVERY_CHANNELS)[number];
    evidenceRef: string;
    releaseId?: string;
    idempotencyKey: string;
  }): { delivery_id: string; status: "REPORTED_SENT"; replayed: boolean } {
    this.assertActor(ctx);
    const { result, replayed } = this.repo().withIdempotency({
      principalId: ctx.principalId,
      operation: "rfq.record_delivery",
      key: cmd.idempotencyKey,
      request: { quote_id: cmd.quoteId, revision: cmd.revision, channel: cmd.channel, evidence: cmd.evidenceRef },
      run: () => {
        const quote = this.repo().getQuote(cmd.quoteId, cmd.revision);
        if (quote === undefined) throw new RfqError("not_found", `未知报价 ${cmd.quoteId}`);
        if (quote.status !== "APPROVED" && quote.status !== "EXPORTED") {
          throw new RfqError("approval_stale", "只有已批准/已导出的报价可以记录发送（导出状态不冒充发送状态）");
        }
        if (!DELIVERY_CHANNELS.includes(cmd.channel)) {
          throw new RfqError("validation", "channel 必须是 manual_wechat/manual_email/manual_other/integrated_channel");
        }
        const row = recordReportedDelivery(this.repo(), {
          quoteId: cmd.quoteId,
          quoteRevision: cmd.revision,
          ...(cmd.releaseId !== undefined ? { releaseId: cmd.releaseId } : {}),
          channel: cmd.channel,
          evidenceRef: cmd.evidenceRef,
          actor: ctx.actor,
        });
        this.audit(ctx, "rfq.record_delivery", `delivery:${row.delivery_id}`, "REPORTED_SENT");
        return { delivery_id: row.delivery_id, status: "REPORTED_SENT" as const };
      },
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as { delivery_id: string; status: "REPORTED_SENT" },
    });
    return { ...result, replayed };
  }

  async prepareHandoff(ctx: RfqCallContext, cmd: {
    quoteId: string;
    revision: number;
    targetRef: string;
    intentEvidenceRef: string;
    idempotencyKey: string;
    prepareCandidate: (args: { handoffId: string; packetJson: string; packetDigest: string }) => Promise<string>;
  }): Promise<{ handoff_id: string; candidate_id: string; packet_digest: string; replayed: boolean }> {
    this.assertActor(ctx);
    const { result, replayed } = await this.repo().withIdempotencyAsync({
      principalId: ctx.principalId,
      operation: "rfq.prepare_handoff",
      key: cmd.idempotencyKey,
      request: { quote_id: cmd.quoteId, revision: cmd.revision, target: cmd.targetRef, intent: cmd.intentEvidenceRef },
      run: async () => {
        const prepared = await this.deps.coordinator.prepareHandoff({
          quoteId: cmd.quoteId,
          revision: cmd.revision,
          targetRef: cmd.targetRef,
          intentEvidenceRef: cmd.intentEvidenceRef,
          actor: ctx.actor,
          prepareCandidate: cmd.prepareCandidate,
        });
        return {
          handoff_id: prepared.handoff_id,
          candidate_id: prepared.candidate_id,
          packet_digest: prepared.packet_digest,
        };
      },
      serialize: (r) => r,
      deserialize: (stored) => JSON.parse(stored) as { handoff_id: string; candidate_id: string; packet_digest: string },
    });
    return { ...result, replayed };
  }

  getHandoff(ctx: RfqCallContext, handoffId: string): { handoff_id: string; status: string; packet_digest: string; origin_kind: string } {
    this.assertActor(ctx);
    const handoff = this.repo().getHandoff(handoffId);
    if (handoff === undefined) throw new RfqError("not_found", `未知移交 ${handoffId}`);
    return {
      handoff_id: handoff.handoff_id,
      status: handoff.status,
      packet_digest: handoff.packet_digest,
      origin_kind: handoff.origin_kind,
    };
  }

  /** OWNER_RECORDED（操作者自述已提交目标系统；管理页/CLI 通道）。 */
  markHandoffOwnerRecorded(ctx: RfqCallContext, handoffId: string): { handoff_id: string; status: string } {
    this.assertActor(ctx);
    recordOwnerRecorded(this.repo(), handoffId, ctx.actor);
    this.audit(ctx, "rfq.handoff_owner_recorded", `handoff:${handoffId}`, "OWNER_RECORDED");
    return { handoff_id: handoffId, status: "OWNER_RECORDED" };
  }

  // ---- 恢复（§9.5） -----------------------------------------------------------

  /** 作业查询（§11.2 get_job；首版长任务同步执行，作业机制为恢复/审计留痕）。 */
  getJob(ctx: RfqCallContext, jobId: string): { job_id: string; operation: string; status: string; progress: number; error_code: string | null } {
    this.assertActor(ctx);
    const job = this.repo().getJob(jobId);
    if (job === undefined) throw new RfqError("not_found", `未知作业 ${jobId}`);
    return {
      job_id: job.job_id,
      operation: job.operation,
      status: job.status,
      progress: job.progress,
      error_code: job.error_code,
    };
  }

  /** 启动恢复同步：候选已死的发布标 SUPERSEDED（不冒充「外部操作已撤销」）。 */
  recoverReleases(): number {
    if (this.deps.candidateStatus === undefined) return 0;
    let recovered = 0;
    for (const release of this.repo().listReleasesByStatus("PENDING_APPROVAL")) {
      const status = this.deps.candidateStatus(release.candidate_id);
      if (status === undefined || (status !== "pending_approval" && status !== "approved")) {
        this.repo().transitionRelease(release.release_id, ["PENDING_APPROVAL"], "SUPERSEDED");
        recovered += 1;
      }
    }
    return recovered;
  }
}
