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
 * 报价发布三阶段（设计 v0.1.1 §9）与移交执行器（§16.3）。
 *
 * A. prepare：读取当前 quote/需求/事实 → 重验指纹与策略版本 → 渲染正式
 *    文件到私有产物库（未激活不提供下载）→ 登记候选 + ReleaseRequest。
 * B. confirm：既有命令审批闭环（管理页会话 + 一次性确认凭证；模型自报
 *    「已批准」不是证据）——复用 MerchantCommandLog.executeApproved，
 *    不新建第二套批准数据库（§9.1）。
 * C. activate：固定执行器在批准后触发——重验报价状态/有效期/事实指纹/
 *    需求 revision，同一写事务内记录审批结果与可下载状态。
 *
 * 风险语义：报价发布/移交执行器声明 risk = release_quote（§9.1：不冒充
 * 商品修改 write_catalog）。恢复语义与既有命令记录一致：崩溃时 executing
 * 的候选 superseded；结果不明先查询 release 状态与文件摘要，不盲重试。
 */

import { randomUUID } from "node:crypto";
import type { CommandExecutor } from "../executor.js";
import { publicProjectionDigest } from "./quote-revisions.js";
import { rfqContentDigest, RfqError, type FactField, type PublicQuoteView } from "./types.js";
import type { RfqArtifactStore } from "./artifacts.js";
import type { RfqRepository } from "./repository.js";
import { buildHandoffPacket, type HandoffPacket } from "./handoff.js";
import { evaluateFreshness } from "./fact-resolver.js";
import { validateQuotePolicy, type RfqPolicyConfig, type RfqPolicyContext } from "./policy.js";

export const RELEASE_TOOL = "kiwi_merchant_prepare_quote_release";
export const HANDOFF_TOOL = "kiwi_merchant_prepare_quote_handoff";
/** 报价发布类写操作的风险语义（v0.1.1 §9.1；不冒充 write_catalog）。 */
export const RELEASE_RISK = "release_quote";

export interface RfqReleaseCoordinatorDeps {
  repo: RfqRepository;
  artifacts: RfqArtifactStore;
  now: () => string;
  /** 当前生效策略（§7.3：策略版本变化必须重新生成报价/候选）。 */
  currentPolicy: () => { version: string; config: RfqPolicyConfig | undefined };
}

export interface PreparedRelease {
  release_id: string;
  candidate_id: string;
  quote_id: string;
  quote_revision: number;
  artifact_id: string;
  artifact_sha256: string;
  public_projection_digest: string;
  recipient_ref: string;
  warnings: string[];
}

export class RfqReleaseCoordinator {
  private readonly deps: RfqReleaseCoordinatorDeps;

  constructor(deps: RfqReleaseCoordinatorDeps) {
    this.deps = deps;
  }

  private assertActiveCase(caseId: string): { caseVersion: number; recipientRef: string } {
    const kase = this.deps.repo.getCase(caseId);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${caseId}`);
    if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
      throw new RfqError("case_closed", `询盘 ${caseId} 已是终态 ${kase.stage}，不能发布报价`);
    }
    const revision = this.deps.repo.getCaseRevision(caseId, kase.current_revision);
    if (revision === undefined) {
      throw new RfqError("not_found", `询盘 ${caseId} 缺少需求 revision ${kase.current_revision}`);
    }
    if (revision.fields.recipient_ref === null) {
      throw new RfqError("needs_clarification", "收件对象未确认，不能发布报价");
    }
    return { caseVersion: kase.version, recipientRef: revision.fields.recipient_ref };
  }

  /**
   * 阶段 A（prepare）：渲染最终客户文件但暂不开放下载，绑定报价内容、
   * 文件哈希、模板版本、收件对象、策略版本与事实指纹，登记审批候选。
   */
  async prepareRelease(input: {
    caseId: string;
    quoteId: string;
    revision: number;
    recipientRef?: string;
    actor: string;
    /** prepare 候选登记接缝（service 注入命令日志；未注入 fail-closed）。 */
    prepareCandidate: (args: { releaseId: string }) => Promise<string>;
  }): Promise<PreparedRelease> {
    const kase = this.assertActiveCase(input.caseId);
    const quote = this.deps.repo.getQuote(input.quoteId, input.revision);
    if (quote === undefined) {
      throw new RfqError("not_found", `未知报价 ${input.quoteId}@${input.revision}`);
    }
    if (quote.case_id !== input.caseId) {
      throw new RfqError("tenant_mismatch", "报价不属于该询盘");
    }
    // 事实指纹前置重验：源值或源版本变化即失效（§6.3）——刷新事实并生成新版本。
    const snapshot = this.deps.repo.getSnapshot(quote.snapshot_id);
    if (snapshot === undefined || snapshot.content_fingerprint !== quote.fact_fingerprint) {
      throw new RfqError("fact_stale", "事实快照已变化（指纹不匹配）；请刷新事实并重新生成报价版本");
    }
    // 策略版本重验：策略变化 → 重新计价（不得在批准动作中隐藏策略修改，§7.3）。
    const policy = this.deps.currentPolicy();
    if (policy.version !== quote.policy_version) {
      throw new RfqError("policy_requires_review", "策略版本已变化；请重新计价并生成新报价版本");
    }
    if (quote.status !== "VALIDATED") {
      throw new RfqError("approval_stale", `报价状态为 ${quote.status}，只有 VALIDATED 报价可准备发布`);
    }
    const projectionInput = JSON.parse(quote.projection_json) as Omit<PublicQuoteView, "status">;
    const projection: PublicQuoteView = { ...projectionInput, status: quote.status };
    const recipientRef = input.recipientRef ?? kase.recipientRef;
    if (recipientRef !== projection.recipient_ref) {
      throw new RfqError(
        "approval_stale",
        "收件对象与报价投影不一致；请重新生成报价版本（旧批准不能换收件人复用）",
      );
    }
    // 渲染正式文件（文本为主；PDF 渲染器未配置/内容含非 ASCII 时显式告警，
    // 不静默降级——v0.1.1 §14.3、§21.2 中文字体渲染为待确认项）。
    const warnings: string[] = [];
    const now = this.deps.now();
    const artifactId = `art_${randomUUID()}`;
    const written = this.deps.artifacts.write({
      artifactId,
      quoteId: quote.quote_id,
      format: "text",
      projection,
    });
    const releaseId = `rel_${randomUUID()}`;
    this.deps.repo.saveArtifact({
      artifact_id: artifactId,
      merchant_id: this.deps.repo.merchantId,
      quote_id: quote.quote_id,
      quote_revision: quote.revision,
      content_sha256: written.content_sha256,
      template_version: written.template_version,
      content_type: written.content_type,
      relative_path: written.relative_path,
      activated: false,
      created_at: now,
    });
    this.deps.repo.createRelease({
      release_id: releaseId,
      merchant_id: this.deps.repo.merchantId,
      quote_id: quote.quote_id,
      quote_revision: quote.revision,
      candidate_id: "",
      artifact_id: artifactId,
      artifact_sha256: written.content_sha256,
      public_projection_digest: publicProjectionDigest(projection),
      recipient_ref: recipientRef,
      policy_version: quote.policy_version,
      fact_fingerprint: quote.fact_fingerprint,
      status: "PENDING_APPROVAL",
      created_at: now,
      updated_at: now,
    });
    const candidateId = await input.prepareCandidate({ releaseId });
    this.deps.repo.updateReleaseCandidate(releaseId, candidateId);
    // VALIDATED → PENDING_APPROVAL（§8.1：正式产物已渲染、摘要固定、审批候选落盘）。
    this.deps.repo.transitionQuote({
      quoteId: quote.quote_id,
      revision: quote.revision,
      from: ["VALIDATED"],
      to: "PENDING_APPROVAL",
      actor: input.actor,
      reason: `发布候选 ${candidateId} 已登记（产物摘要已冻结）`,
    });
    this.deps.repo.appendAudit({
      actor: input.actor,
      operation: "rfq.prepare_release",
      objectDigest: `release:${releaseId}`,
      result: "PENDING_APPROVAL",
      traceId: randomUUID(),
    });
    return {
      release_id: releaseId,
      candidate_id: candidateId,
      quote_id: quote.quote_id,
      quote_revision: quote.revision,
      artifact_id: artifactId,
      artifact_sha256: written.content_sha256,
      public_projection_digest: publicProjectionDigest(projection),
      recipient_ref: recipientRef,
      warnings,
    };
  }

  /** 阶段 C（activate）：批准后的固定执行器入口（同一写事务）。 */
  activateRelease(input: { releaseId: string; actor: string }): {
    release_id: string;
    quote_id: string;
    revision: number;
    status: string;
  } {
    const release = this.deps.repo.getRelease(input.releaseId);
    if (release === undefined) throw new RfqError("not_found", `未知发布 ${input.releaseId}`);
    const quote = this.deps.repo.getQuote(release.quote_id, release.quote_revision);
    if (quote === undefined) throw new RfqError("not_found", `未知报价 ${release.quote_id}@${release.quote_revision}`);
    const kase = this.deps.repo.getCase(quote.case_id);
    if (kase === undefined) throw new RfqError("not_found", `未知询盘 ${quote.case_id}`);
    if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
      throw new RfqError("case_closed", `询盘 ${quote.case_id} 已是终态 ${kase.stage}；批准失效`);
    }
    if (kase.current_revision !== quote.case_revision) {
      throw new RfqError("approval_stale", "需求已更新（case_revision 变化）；旧批准失效，请重新准备发布");
    }
    // 前置重验：事实值指纹与新鲜度（§9.2 C）——快照被替换/指纹不匹配或
    // 关键事实超期（服务端时钟）均阻断，不能带着过期事实激活正式文件。
    const snapshot = this.deps.repo.getSnapshot(quote.snapshot_id);
    if (snapshot === undefined || snapshot.case_id !== quote.case_id || snapshot.content_fingerprint !== quote.fact_fingerprint) {
      throw new RfqError("fact_stale", "事实快照缺失或指纹不匹配；请刷新事实并重新生成报价版本");
    }
    const freshness = evaluateFreshness(JSON.parse(snapshot.fields_json) as FactField[], this.deps.now());
    if (freshness.stale.length > 0 || freshness.missing_verification.length > 0) {
      throw new RfqError("fact_stale", "关键事实已过期或缺少验证信息；请刷新事实并重新生成报价版本");
    }
    const { release: after } = this.deps.repo.activateReleaseAtomic({
      releaseId: input.releaseId,
      actor: input.actor,
      caseExpectedVersion: kase.version,
    });
    return {
      release_id: after.release_id,
      quote_id: after.quote_id,
      revision: after.quote_revision,
      status: after.status,
    };
  }

  /** 审批时前置重读（执行器 readPreconditions；内容/指纹/收件人绑定核对）。 */
  readReleasePreconditions(releaseId: string): Record<string, unknown> {
    const release = this.deps.repo.getRelease(releaseId);
    if (release === undefined) throw new RfqError("not_found", `未知发布 ${releaseId}`);
    const artifact = this.deps.repo.getArtifact(release.artifact_id);
    if (artifact === undefined) throw new RfqError("not_found", `发布 ${releaseId} 的产物缺失`);
    return {
      quote_id: release.quote_id,
      quote_revision: release.quote_revision,
      quote_content_digest: this.deps.repo.getQuote(release.quote_id, release.quote_revision)?.content_digest ?? "",
      fact_fingerprint: release.fact_fingerprint,
      artifact_sha256: artifact.content_sha256,
      public_projection_digest: release.public_projection_digest,
      recipient_ref: release.recipient_ref,
      policy_version: release.policy_version,
    };
  }

  // ---- 移交（§16.3：审批先于正式报价移交；先有已批准发布） -----------------

  async prepareHandoff(input: {
    quoteId: string;
    revision: number;
    targetRef: string;
    intentEvidenceRef: string;
    actor: string;
    prepareCandidate: (args: { handoffId: string; packetJson: string; packetDigest: string }) => Promise<string>;
  }): Promise<{ handoff_id: string; candidate_id: string; packet_digest: string }> {
    const quote = this.deps.repo.getQuote(input.quoteId, input.revision);
    if (quote === undefined) {
      throw new RfqError("not_found", `未知报价 ${input.quoteId}@${input.revision}`);
    }
    if (quote.status !== "APPROVED" && quote.status !== "EXPORTED") {
      throw new RfqError("approval_stale", "只有已批准/已导出的报价可以准备移交（审批先于正式报价移交）");
    }
    const releases = this.deps.repo.listReleasesForQuote(input.quoteId, input.revision);
    const activated = releases.find((r) => r.status === "APPROVED" || r.status === "EXPORTED");
    if (activated === undefined) {
      throw new RfqError("not_found", "该报价版本没有已批准的发布记录；先完成发布再移交");
    }
    const kase = this.deps.repo.getCase(quote.case_id);
    const revision = kase === undefined ? undefined : this.deps.repo.getCaseRevision(quote.case_id, kase.current_revision);
    if (kase === undefined || revision === undefined) {
      throw new RfqError("not_found", `询盘 ${quote.case_id} 状态不可得`);
    }
    // 终态询盘拒绝新的工作成果（§8.1：CASE_CLOSED；已批准文件与审计保留）。
    if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
      throw new RfqError("case_closed", `询盘 ${quote.case_id} 已是终态 ${kase.stage}；不能准备移交`);
    }
    const projectionInput = JSON.parse(quote.projection_json) as Omit<PublicQuoteView, "status">;
    const { packet, digest } = buildHandoffPacket({
      quoteId: quote.quote_id,
      revision: quote.revision,
      releaseId: activated.release_id,
      targetRef: input.targetRef,
      intentEvidenceRef: input.intentEvidenceRef,
      quote: { ...projectionInput, status: quote.status },
      requirements: revision.fields,
      evidenceCatalog: revision.source_ids,
      nowIso: this.deps.now(),
    });
    const packetJson = JSON.stringify(packet);
    const candidateId = await input.prepareCandidate({
      handoffId: packet.handoff_id,
      packetJson,
      packetDigest: digest,
    });
    this.deps.repo.appendAudit({
      actor: input.actor,
      operation: "rfq.prepare_handoff",
      objectDigest: `handoff:${packet.handoff_id}`,
      result: "PENDING_APPROVAL",
      traceId: randomUUID(),
    });
    return { handoff_id: packet.handoff_id, candidate_id: candidateId, packet_digest: digest };
  }

  /**
   * 固定执行器（风险语义 release_quote；注册进 MerchantExecutorRegistry）。
   * 只执行候选里存储的参数（packet_json 来自批准内容，绝不重渲染）。
   */
  buildExecutors(): CommandExecutor[] {
    return [
      {
        tool: RELEASE_TOOL,
        risk: RELEASE_RISK,
        readPreconditions: async (args) => this.readReleasePreconditions(String(args.release_id ?? "")),
        execute: async (args, ctx) => {
          return this.activateRelease({
            releaseId: String(args.release_id ?? ""),
            actor: ctx.ownerId,
          });
        },
      },
      {
        tool: HANDOFF_TOOL,
        risk: RELEASE_RISK,
        readPreconditions: async (args) => {
          const handoffId = String(args.handoff_id ?? "");
          const existing = this.deps.repo.getHandoff(handoffId);
          return {
            handoff_id: handoffId,
            packet_digest: String(args.packet_digest ?? existing?.packet_digest ?? ""),
          };
        },
        execute: async (args, ctx) => {
          const handoffId = String(args.handoff_id ?? "");
          const packetJson = String(args.packet_json ?? "");
          const digest = String(args.packet_digest ?? "");
          if (handoffId === "" || packetJson === "" || digest === "") {
            throw new RfqError("validation", "移交候选参数不完整（handoff_id/packet_json/packet_digest）");
          }
          const parsed = JSON.parse(packetJson) as HandoffPacket;
          if (rfqContentDigest(parsed) !== digest) {
            throw new RfqError("validation", "移交包摘要与批准内容不一致（拒绝写入）");
          }
          // 幂等：已登记同包直接返回（不重复写）。
          const existing = this.deps.repo.getHandoff(handoffId);
          if (existing !== undefined) {
            if (existing.packet_digest !== digest) {
              throw new RfqError("validation", "移交包摘要与已登记内容不一致");
            }
            return { handoff_id: existing.handoff_id, status: existing.status };
          }
          this.deps.repo.saveHandoffPacket({
            handoffId,
            packetJson,
            digest,
            actor: ctx.ownerId,
          });
          return { handoff_id: handoffId, status: "PACKET_READY" };
        },
      },
    ];
  }

  /** 策略校验（service 计价路径复用同一配置来源；不透出阈值数值）。 */
  validateWithCurrentPolicy(ctx: RfqPolicyContext): void {
    const verdict = validateQuotePolicy(ctx, this.deps.currentPolicy().config);
    if (!verdict.ok) {
      throw new RfqError("policy_requires_review", verdict.message);
    }
  }
}
