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
 * M3 移交语义与事务边界（设计 v0.1.1 §16、§10.2–10.4、§7.3；验收矩阵
 * AP-06/07/09、ST-02/03/04/07/10、EX-03/09/10、KN-02..10 的 L1 证据）：
 *   - 审批绑定：收件人/策略/事实在批准执行时重验，变更即失效（AP-06/07）；
 *   - 并发与事务：CAS 认领最多一次激活（AP-09）；候选/release/幂等记录
 *     同事务全提交或全回滚（ST-02，§10.2）；超时先查询不盲重放（ST-04）；
 *   - 不可变与恢复：报价版本内容/文件哈希不变（ST-03）；孤儿文件 TTL 回收
 *     且不误删被引用文件（ST-07）；文件库备份恢复演练（ST-10）；
 *   - 导出边界：跨商家不可得（EX-03）；百行文件逐行完整（EX-09）；过期/
 *     停用后正式下载关闭（EX-10）；
 *   - 移交：手工移交只产文件包（KN-04）；内部记录 ≠ 外部受理（KN-05）；
 *     伪造回执 fail-closed（KN-06/07/08）；包内容无损（KN-09）；幂等重放
 *     安全（KN-10）；双轨状态不抹平、跨轨拒绝（KN-02/03）。
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { contentHash, WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../../src/agent/merchant/fake-merchant-client.js";
import type { IncomingConsultation } from "../../src/agent/merchant/types.js";
import { MerchantOAuthStore } from "../../src/auth/merchant-oauth.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import type { A2aNegotiationRow } from "../../src/merchant/workbench-service.js";
import { assertReviewRoute, fromA2aRow, fromShoppingConsultation, routeHumanReview } from "../../src/merchant-core/negotiation-adapters.js";
import { MerchantRfqService, type RfqCallContext } from "../../src/merchant-core/rfq/service.js";
import { RfqRepository } from "../../src/merchant-core/rfq/repository.js";
import { RfqArtifactStore, ensureArtifactRoot } from "../../src/merchant-core/rfq/artifacts.js";
import { RfqReleaseCoordinator } from "../../src/merchant-core/rfq/release-coordinator.js";
import type { CommerceDataSource } from "../../src/commerce/data-source.js";
import { verifyTargetReceipt, type HandoffPacket } from "../../src/merchant-core/rfq/handoff.js";
import { RfqError } from "../../src/merchant-core/rfq/types.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const INQUIRY = "你好，我们需要手写陶瓷杯 10 个，含税，税率13%，运费10元，7天内发货，款到发货。收件人：张三";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function stubDataSource(now: () => string): CommerceDataSource {
  return {
    getProduct: async (sku) =>
      sku === "sku-001" ? { sku, title: "手写陶瓷杯", currency: "CNY", availability_hint: "in_stock" } : undefined,
    getProducts: async () => [],
    getInventory: async () => ({
      value: 12,
      authority: "LOCAL_AUTHORITATIVE",
      source: "stub",
      verified_at: now(),
      source_version: `verified:${now()}`,
    }),
    getPrice: async () => ({
      value: { currency: "CNY", amount_minor: 9900 },
      authority: "LOCAL_AUTHORITATIVE",
      source: "stub",
      verified_at: now(),
      source_version: `verified:${now()}`,
    }),
    getPublicListing: async () => ({}),
    health: async () => ({ ok: true, service: "stub" }),
  };
}

function setup(options: { clock?: { value: string }; dbPath?: string } = {}) {
  const clock = options.clock ?? { value: T0 };
  const now = () => clock.value;
  const policyVersion = { value: "policy-0-test" };
  const db = new DatabaseSync(options.dbPath ?? ":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now });
  const confirmations = new MerchantOAuthStore({ db: new DatabaseSync(":memory:"), now });
  const client = new FakeMerchantClient({ products: [fakeMerchantProduct()], now: T0 });
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-m3-"));
  dirs.push(root);
  ensureArtifactRoot(root);
  const artifacts = new RfqArtifactStore({ root, now });
  const repo = new RfqRepository({ db, merchantId: MERCHANT, now });
  const coordinator = new RfqReleaseCoordinator({
    repo,
    artifacts,
    now,
    currentPolicy: () => ({ version: policyVersion.value, config: undefined }),
  });
  const service = new MerchantRfqService({
    repo,
    dataSource: stubDataSource(now),
    artifacts,
    coordinator,
    now,
    confirmationMinter: (input) => `cfm-${input.caseId}-${input.lineId}-${input.sku}`,
    candidateStatus: (candidateId) => approvals.get(candidateId)?.status,
    policyVersion: () => policyVersion.value,
  });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals,
    mode: () => "supervised",
    now,
    commandPrincipalId: PRINCIPAL,
    confirmations,
    rfq: { service, executors: coordinator.buildExecutors() },
  });
  const ctx: RfqCallContext = { principalId: PRINCIPAL, actor: PRINCIPAL, traceId: "t0" };
  const prepareReleaseCandidate = async (args: { releaseId: string }) => {
    const prepared = await core.commands.prepare({
      tool: "kiwi_merchant_prepare_quote_release",
      arguments: { release_id: args.releaseId },
    });
    return prepared.candidate.candidate_id;
  };
  const prepareHandoffCandidate = async (args: { handoffId: string; packetJson: string; packetDigest: string }) => {
    const prepared = await core.commands.prepare({
      tool: "kiwi_merchant_prepare_quote_handoff",
      arguments: { handoff_id: args.handoffId, packet_json: args.packetJson, packet_digest: args.packetDigest },
    });
    return prepared.candidate.candidate_id;
  };
  return {
    clock,
    policyVersion,
    db,
    approvals,
    confirmations,
    client,
    repo,
    artifacts,
    root,
    service,
    core,
    ctx,
    prepareReleaseCandidate,
    prepareHandoffCandidate,
  };
}

/** 幂等键带后缀：同一 setup 内可建多个独立询盘（同键同内容会幂等重放）。 */
async function pricedCase(s: ReturnType<typeof setup>, suffix = "1") {
  const ingest = await s.service.ingest(s.ctx, {
    kind: "manual_text",
    content: INQUIRY,
    idempotencyKey: `ing-${suffix}`,
    proposal: {
      entries: [
        { field_path: "lines.quantity", line_id: "L1", value: 10, quote: "10 个" },
        { field_path: "terms.tax_basis", value: "INCLUSIVE", quote: "含税" },
        { field_path: "terms.tax_rate_bps", value: 1300, quote: "13%" },
        { field_path: "terms.shipping_known", value: true, quote: "运费10元" },
        { field_path: "terms.shipping_minor", value: 1000, quote: "运费10元" },
        { field_path: "terms.delivery_date", value: "7天内发货", quote: "7天内发货" },
        { field_path: "terms.payment_terms", value: "款到发货", quote: "款到发货" },
        { field_path: "recipient_ref", value: "张三", quote: "收件人：张三" },
      ],
    },
  });
  const caseId = ingest.case_id;
  const confirmed = s.service.confirmLines(s.ctx, {
    caseId,
    expectedRevision: s.service.getCase(s.ctx, caseId).revision,
    selections: [{ line_id: "L1", sku: "sku-001", quantity: 10, unit: "个" }],
  });
  const facts = await s.service.refreshFacts(s.ctx, {
    caseId,
    expectedRevision: confirmed.revision,
    idempotencyKey: `facts-${suffix}`,
  });
  const quote = await s.service.price(s.ctx, {
    caseId,
    expectedRevision: confirmed.revision,
    snapshotId: facts.snapshot_id,
    idempotencyKey: `price-${suffix}`,
  });
  return { caseId, confirmed, facts, quote };
}

/** 报价当前 release 行（测试断言辅助；缺失即失败）。 */
function firstRelease(s: ReturnType<typeof setup>, quoteId: string) {
  const row = s.repo.listReleasesForQuote(quoteId, 1)[0];
  if (row === undefined) throw new Error(`报价 ${quoteId} 缺少 release`);
  return row;
}

async function approveAndExecute(
  s: ReturnType<typeof setup>,
  candidateId: string,
): Promise<{ kind: string; reason?: string }> {
  const candidate = s.core.listPendingCommands().find((c) => c.candidate_id === candidateId);
  if (candidate === undefined) throw new Error(`候选不存在：${candidateId}`);
  const token = s.confirmations.createConfirmation({
    candidateId,
    candidateDigest: contentHash({
      arguments: (candidate as NonNullable<typeof candidate>).arguments,
      preconditions: (candidate as NonNullable<typeof candidate>).preconditions,
    }),
    principalId: PRINCIPAL,
    merchantId: MERCHANT,
    action: "approve",
  });
  const outcome = await s.core.commands.executeApproved(candidateId, PRINCIPAL, token);
  return { kind: outcome.kind, ...(outcome.kind === "stale" ? { reason: outcome.reason } : {}) };
}

async function approvedRelease(s: ReturnType<typeof setup>, key: string) {
  const { caseId, quote } = await pricedCase(s, key);
  const release = await s.service.prepareRelease(s.ctx, {
    caseId,
    quoteId: quote.quote_id,
    revision: quote.revision,
    idempotencyKey: key,
    prepareCandidate: s.prepareReleaseCandidate,
  });
  const outcome = await approveAndExecute(s, release.candidate_id);
  expect(outcome.kind).toBe("executed");
  return { caseId, quote, release };
}

/** 已批准报价 → 移交包生成并批准落库（PACKET_READY）。 */
async function handoffReady(s: ReturnType<typeof setup>, key: string) {
  const { caseId, quote } = await approvedRelease(s, `rel-${key}`);
  const prepared = await s.service.prepareHandoff(s.ctx, {
    quoteId: quote.quote_id,
    revision: quote.revision,
    targetRef: "handoff_inbox:crm-001",
    intentEvidenceRef: "email-msg-42",
    idempotencyKey: `hnd-${key}`,
    prepareCandidate: s.prepareHandoffCandidate,
  });
  const outcome = await approveAndExecute(s, prepared.candidate_id);
  expect(outcome.kind).toBe("executed");
  const row = s.repo.getHandoff(prepared.handoff_id);
  expect(row).toBeDefined();
  return { caseId, quote, prepared, row: row as NonNullable<typeof row> };
}

// ---- 审批绑定与并发（AP-06/07/09） ----------------------------------------

describe("RFQ 审批绑定与并发", () => {
  it("收件人变更：换收件人被拒；需求修订后旧批准失效需新候选（AP-06）", async () => {
    const s = setup();
    const { caseId, quote, confirmed } = await pricedCase(s);
    // 报价绑定收件人 张三：携带其他收件人的发布准备直接拒绝（内容与收件人一起绑定）
    await expect(
      s.service.prepareRelease(s.ctx, {
        caseId,
        quoteId: quote.quote_id,
        revision: quote.revision,
        recipientRef: "李四",
        idempotencyKey: "rel-ap06",
        prepareCandidate: s.prepareReleaseCandidate,
      }),
    ).rejects.toThrow(/收件对象与报价投影不一致/u);
    // 收件人修订 → 新 revision → 旧候选批准执行失效（旧批准不跨收件人复用）
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-ap06-2",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    await s.service.revise(s.ctx, {
      caseId,
      expectedRevision: confirmed.revision,
      changes: [{ field_path: "recipient_ref", value: "李四", quote: "收件人：张三" }],
      idempotencyKey: "rev-ap06",
    });
    const outcome = await approveAndExecute(s, release.candidate_id);
    expect(outcome.kind).toBe("stale");
    expect(outcome.reason).toContain("需求已更新");
    s.db.close();
  });

  it("规则变化：批准前策略版本变化 → 执行重验失败，不沿用旧批准（AP-07）", async () => {
    const s = setup();
    const { caseId, quote } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-ap07",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    // 批准前策略热更新 → 激活时以当前策略重验（与 prepare 同源）
    s.policyVersion.value = "policy-1-changed";
    const outcome = await approveAndExecute(s, release.candidate_id);
    expect(outcome.kind).toBe("stale");
    expect(outcome.reason).toContain("策略版本已变化");
    s.db.close();
  });

  it("并发批准：CAS 认领保证最多一次激活；凭证一次性（AP-09）", async () => {
    const s = setup();
    const { caseId, quote } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-ap09",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    const candidate = s.core.listPendingCommands().find((c) => c.candidate_id === release.candidate_id);
    expect(candidate).toBeDefined();
    const mkToken = () =>
      s.confirmations.createConfirmation({
        candidateId: release.candidate_id,
        candidateDigest: contentHash({
          arguments: (candidate as NonNullable<typeof candidate>).arguments,
          preconditions: (candidate as NonNullable<typeof candidate>).preconditions,
        }),
        principalId: PRINCIPAL,
        merchantId: MERCHANT,
        action: "approve",
      });
    const token1 = mkToken();
    const token2 = mkToken();
    // 两个并发批准：CAS/唯一约束 → 最多一次激活，其余返回当前状态
    const outcomes = await Promise.all([
      s.core.commands.executeApproved(release.candidate_id, PRINCIPAL, token1),
      s.core.commands.executeApproved(release.candidate_id, PRINCIPAL, token2),
    ]);
    const kinds = outcomes.map((o) => o.kind).sort();
    expect(kinds).toEqual(["executed", "not_approvable"]);
    // 激活只发生一次：release 状态唯一推进
    expect(s.service.getRelease(s.ctx, release.release_id).status).toBe("APPROVED");
    // 已核销凭证重放 → 拒绝（一次性）
    await expect(s.core.commands.executeApproved(release.candidate_id, PRINCIPAL, token1)).rejects.toThrow(/凭证/u);
    s.db.close();
  });
});

// ---- 事务与恢复（ST-02/03/04/07/10） ---------------------------------------

describe("RFQ 事务与恢复", () => {
  it("跨对象一致事务：候选插入后数据库失败 → 候选/release/幂等全回滚，重试干净（ST-02）", async () => {
    const s = setup();
    const { caseId, quote } = await pricedCase(s);
    const pendingBefore = s.core.listPendingCommands().length;
    const releasesBefore = s.repo.listReleasesForQuote(quote.quote_id, quote.revision).length;
    // 候选真实插入后模拟数据库故障：整事务回滚（§10.2 不能两次独立提交假装原子）
    const failingCandidate = async (args: { releaseId: string }) => {
      const prepared = await s.core.commands.prepare({
        tool: "kiwi_merchant_prepare_quote_release",
        arguments: { release_id: args.releaseId },
      });
      void prepared;
      throw new Error("模拟候选插入后的数据库故障");
    };
    await expect(
      s.service.prepareRelease(s.ctx, {
        caseId,
        quoteId: quote.quote_id,
        revision: quote.revision,
        idempotencyKey: "rel-st02",
        prepareCandidate: failingCandidate,
      }),
    ).rejects.toThrow(/模拟候选插入后的数据库故障/u);
    // 全部回滚：无新候选、无 release、报价仍 VALIDATED、幂等键可重试
    expect(s.core.listPendingCommands().length).toBe(pendingBefore);
    expect(s.repo.listReleasesForQuote(quote.quote_id, quote.revision).length).toBe(releasesBefore);
    expect(s.service.getCase(s.ctx, caseId).quotes.find((q) => q.quote_id === quote.quote_id)?.status).toBe("VALIDATED");
    // 同幂等键重试（干净重跑，不产生重复 release）
    const retry = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-st02",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    expect(retry.replayed).toBe(false);
    expect(s.repo.listReleasesForQuote(quote.quote_id, quote.revision).length).toBe(1);
    s.db.close();
  });

  it("报价版本不可变：v2 生成后 v1 内容摘要与文件哈希不变，diff 完整（ST-03）", async () => {
    const s = setup();
    const { caseId, quote, confirmed } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-st03",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    const v1 = s.repo.getQuote(quote.quote_id, 1);
    const v1Artifact = s.repo.getArtifact(release.artifact_id);
    expect(v1).toBeDefined();
    expect(v1Artifact).toBeDefined();
    const v1Digest = (v1 as NonNullable<typeof v1>).content_digest;
    const v1Sha = (v1Artifact as NonNullable<typeof v1Artifact>).content_sha256;
    // 客户改数量 → v2
    const revised = await s.service.revise(s.ctx, {
      caseId,
      expectedRevision: confirmed.revision,
      changes: [{ field_path: "lines.quantity", line_id: "L1", value: 20, quote: "10 个" }],
      idempotencyKey: "rev-st03",
    });
    const facts2 = await s.service.refreshFacts(s.ctx, {
      caseId,
      expectedRevision: revised.revision,
      idempotencyKey: "facts-st03",
    });
    const quote2 = await s.service.price(s.ctx, {
      caseId,
      expectedRevision: revised.revision,
      snapshotId: facts2.snapshot_id,
      idempotencyKey: "price-st03",
    });
    // 新版本 = 新 quote_id（版本链推进；旧版本不再可变）
    expect(quote2.quote_id).not.toBe(quote.quote_id);
    // v1 不可变：内容摘要与投影不变
    const v1After = s.repo.getQuote(quote.quote_id, 1);
    expect((v1After as NonNullable<typeof v1After>).content_digest).toBe(v1Digest);
    expect((v1After as NonNullable<typeof v1After>).projection_json).toBe((v1 as NonNullable<typeof v1>).projection_json);
    // v1 产物文件哈希不变
    const artifactAfter = s.repo.getArtifact(release.artifact_id);
    expect((artifactAfter as NonNullable<typeof artifactAfter>).content_sha256).toBe(v1Sha);
    // 字段级 diff 可用
    const diff = s.service.compare(
      s.ctx,
      { quote_id: quote.quote_id, revision: 1 },
      { quote_id: quote2.quote_id, revision: quote2.revision },
    );
    expect(diff.changed.some((c) => c.field.endsWith(".quantity") && c.to === 20)).toBe(true);
    s.db.close();
  });

  it("超时后查询：同键进行中按 OPERATION_UNKNOWN 拒绝盲重放，完成后重放同结果（ST-04）", async () => {
    const s = setup();
    const { caseId, quote } = await pricedCase(s);
    // 第一个请求已登记幂等 tombstone（可能仍在执行/超时未知）
    const pending = s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-st04",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    // 相同 key 的第二个请求：先查询原作业，不盲重放生成重复候选
    await expect(
      s.service.prepareRelease(s.ctx, {
        caseId,
        quoteId: quote.quote_id,
        revision: quote.revision,
        idempotencyKey: "rel-st04",
        prepareCandidate: s.prepareReleaseCandidate,
      }),
    ).rejects.toThrow(/查询原作业.*禁止盲重放/u);
    const done = await pending;
    // 完成后同键重放：同一结果（同一 release/candidate），不重复建候选
    const replay = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-st04",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.release_id).toBe(done.release_id);
    expect(replay.candidate_id).toBe(done.candidate_id);
    expect(s.repo.listReleasesForQuote(quote.quote_id, quote.revision).length).toBe(1);
    s.db.close();
  });

  it("临时文件孤儿：回滚孤儿按 TTL 回收；被有效 release 引用的文件保留（ST-07）", async () => {
    const s = setup();
    const { quote } = await approvedRelease(s, "st07a");
    const releaseId = firstRelease(s, quote.quote_id).release_id;
    const validArtifact = s.repo.getArtifact(s.service.getRelease(s.ctx, releaseId).artifact_id);
    expect(validArtifact).toBeDefined();
    const validPath = (validArtifact as NonNullable<typeof validArtifact>).relative_path;
    // 第二个询价：文件已渲染但事务回滚 → 孤儿文件（无产物行）
    const { caseId: case2, quote: quote2 } = await pricedCase(s, "st07b");
    const failingCandidate = async () => {
      throw new Error("渲染后故障");
    };
    await expect(
      s.service.prepareRelease(s.ctx, {
        caseId: case2,
        quoteId: quote2.quote_id,
        revision: quote2.revision,
        idempotencyKey: "rel-st07-orphan",
        prepareCandidate: failingCandidate,
      }),
    ).rejects.toThrow(/渲染后故障/u);
    // 孤儿文件 = quote2 目录下未被引用的产物文件
    const orphanRelative = (() => {
      const dir = path.join(s.root, "rfq-artifacts", quote2.quote_id);
      for (const name of readdirSync(dir)) {
        const rel = path.join("rfq-artifacts", quote2.quote_id, name);
        if (rel !== validPath) return rel;
      }
      return undefined;
    })();
    expect(orphanRelative).toBeDefined();
    const orphanAbsolute = path.join(s.root, orphanRelative as string);
    expect(existsSync(orphanAbsolute)).toBe(true);
    // 时钟前推 + 孤儿与有效文件都回填旧 mtime（TTL 只应回收未引用者）
    s.clock.value = "2026-10-25T10:00:00.000Z";
    const old = new Date(Date.parse(s.clock.value) - 40 * 86_400_000);
    utimesSync(orphanAbsolute, old, old);
    utimesSync(path.join(s.root, validPath), old, old);
    // 行级孤儿：未激活、无有效 release 引用、超 TTL
    s.repo.saveArtifact({
      artifact_id: "art_orphan_row_0001",
      merchant_id: MERCHANT,
      quote_id: quote2.quote_id,
      quote_revision: 1,
      content_sha256: "sha256:deadbeef",
      template_version: "customer-quote-text-v1",
      content_type: "text/plain; charset=utf-8",
      relative_path: "rfq-artifacts/orphan-row/art_orphan_row_0001.bin",
      activated: false,
      created_at: T0,
    });
    const result = s.service.cleanupOrphanArtifacts({ ttlSeconds: 30 * 86_400 });
    expect(result.files_removed).toBe(1);
    expect(result.rows_removed).toBe(1);
    expect(existsSync(orphanAbsolute)).toBe(false);
    // 被有效 release 引用的文件保留且内容仍与批准摘要一致
    expect(existsSync(path.join(s.root, validPath))).toBe(true);
    expect(s.artifacts.read(validArtifact as NonNullable<typeof validArtifact>)).toContain("报价编号");
    s.db.close();
  });

  it("备份恢复演练：文件库复制恢复后报价/发布/产物状态完整（ST-10）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-m3-db-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "kiwi.db");
    const restoredPath = path.join(dir, "kiwi-restored.db");
    const s = setup({ dbPath });
    const { caseId, quote } = await approvedRelease(s, "rel-st10");
    const artifactId = s.service.getRelease(s.ctx, firstRelease(s, quote.quote_id).release_id).artifact_id;
    const beforeDownload = s.service.downloadArtifact(s.ctx, artifactId);
    s.db.close();
    // 备份 → 独立恢复环境（新连接打开备份副本）
    cpSync(dbPath, restoredPath);
    const restoredDb = new DatabaseSync(restoredPath);
    const now = () => T0;
    const repo = new RfqRepository({ db: restoredDb, merchantId: MERCHANT, now });
    const coordinator = new RfqReleaseCoordinator({
      repo,
      artifacts: s.artifacts,
      now,
      currentPolicy: () => ({ version: "policy-0-test", config: undefined }),
    });
    const service = new MerchantRfqService({
      repo,
      dataSource: stubDataSource(now),
      artifacts: s.artifacts,
      coordinator,
      now,
      policyVersion: () => "policy-0-test",
    });
    // 恢复后状态完整：询盘、报价（EXPORTED）、发布、产物可校验读回
    const view = service.getCase(s.ctx, caseId);
    expect(view.case.case_id).toBe(caseId);
    expect(view.quotes.find((q) => q.quote_id === quote.quote_id)?.status).toBe("EXPORTED");
    expect(repo.listReleasesForQuote(quote.quote_id, 1).length).toBe(1);
    const afterDownload = service.downloadArtifact(s.ctx, artifactId);
    expect(afterDownload.content).toBe(beforeDownload.content);
    restoredDb.close();
    // s.db 已在备份前关闭（保证副本一致）；文件副本即备份介质
  });
});

// ---- 导出边界（EX-03/09/10） -----------------------------------------------

describe("RFQ 导出边界", () => {
  it("跨商家下载：另一商家不可见、不可读，不泄露存在性（EX-03）", async () => {
    const s = setup();
    const { quote } = await approvedRelease(s, "rel-ex03");
    const releaseId = firstRelease(s, quote.quote_id).release_id;
    const artifactId = s.service.getRelease(s.ctx, releaseId).artifact_id;
    // 商家 002 的服务栈（同一 DB，仓库按 merchant_id 隔离）
    const otherRepo = new RfqRepository({ db: s.db, merchantId: "merchant-002", now: () => T0 });
    const otherCoordinator = new RfqReleaseCoordinator({
      repo: otherRepo,
      artifacts: s.artifacts,
      now: () => T0,
      currentPolicy: () => ({ version: "policy-0-test", config: undefined }),
    });
    const otherService = new MerchantRfqService({
      repo: otherRepo,
      dataSource: stubDataSource(() => T0),
      artifacts: s.artifacts,
      coordinator: otherCoordinator,
      now: () => T0,
      policyVersion: () => "policy-0-test",
    });
    const otherCtx: RfqCallContext = { principalId: "merchant-agent:merchant-002", actor: "merchant-agent:merchant-002", traceId: "t2" };
    expect(otherRepo.getQuote(quote.quote_id, 1)).toBeUndefined();
    expect(otherRepo.getRelease(releaseId)).toBeUndefined();
    // not_found：不泄露存在性、文件名或部分内容
    expect(() => otherService.downloadArtifact(otherCtx, artifactId)).toThrow(/未知产物/u);
    s.db.close();
  });

  it("分页长单：100 行文件逐行完整、金额与逐行证据无裁切（EX-09）", async () => {
    const s = setup();
    const lineCount = 100;
    // 多行询盘走 CSV 来源（每行一条 line_id）；terms 经 proposal 补齐
    // （引用必须落在来源原文内——放在首行 query 文本中）
    const csv = [
      "line_id,query,sku,quantity,unit",
      "L1,手写陶瓷杯样品第1款（含税，税率13%，运费10元，7天内发货，款到发货。收件人：张三）,sku-001,3,个",
      ...Array.from({ length: lineCount - 1 }, (_, i) => `L${i + 2},手写陶瓷杯样品第${i + 2}款,sku-001,3,个`),
    ].join("\n");
    const ingest = await s.service.ingest(s.ctx, {
      kind: "csv",
      content: csv,
      idempotencyKey: "ing-ex09",
      proposal: {
        entries: [
          { field_path: "terms.tax_basis", value: "INCLUSIVE", quote: "含税" },
          { field_path: "terms.tax_rate_bps", value: 1300, quote: "税率13%" },
          { field_path: "terms.shipping_known", value: true, quote: "运费10元" },
          { field_path: "terms.shipping_minor", value: 1000, quote: "运费10元" },
          { field_path: "terms.delivery_date", value: "7天内发货", quote: "7天内发货" },
          { field_path: "terms.payment_terms", value: "款到发货", quote: "款到发货" },
          { field_path: "recipient_ref", value: "张三", quote: "收件人：张三" },
        ],
      },
    });
    const confirmed = s.service.confirmLines(s.ctx, {
      caseId: ingest.case_id,
      expectedRevision: s.service.getCase(s.ctx, ingest.case_id).revision,
      selections: Array.from({ length: lineCount }, (_, i) => ({
        line_id: `L${i + 1}`,
        sku: "sku-001",
        quantity: 3,
        unit: "个",
      })),
    });
    const facts = await s.service.refreshFacts(s.ctx, {
      caseId: ingest.case_id,
      expectedRevision: confirmed.revision,
      idempotencyKey: "facts-ex09",
    });
    const quote = await s.service.price(s.ctx, {
      caseId: ingest.case_id,
      expectedRevision: confirmed.revision,
      snapshotId: facts.snapshot_id,
      idempotencyKey: "price-ex09",
    });
    const release = await s.service.prepareRelease(s.ctx, {
      caseId: ingest.case_id,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-ex09",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    expect((await approveAndExecute(s, release.candidate_id)).kind).toBe("executed");
    const file = s.service.downloadArtifact(s.ctx, release.artifact_id);
    // 逐行完整：100 行全部出现，每行带单价证据，无省略标记
    for (const line of Array.from({ length: lineCount }, (_, i) => `行 L${i + 1} `)) {
      expect(file.content).toContain(line);
    }
    expect(file.content.split("单价").length - 1).toBe(lineCount);
    expect(file.content).not.toMatch(/省略|截断|more lines/u);
    // 总额行完整
    expect(file.content).toContain("应付合计");
    s.db.close();
  });

  it("过期与停用：报价过期后正式下载关闭；发布停用不可下载（EX-10）", async () => {
    const s = setup();
    const { quote } = await approvedRelease(s, "rel-ex10a");
    const releaseId = firstRelease(s, quote.quote_id).release_id;
    const artifactId = s.service.getRelease(s.ctx, releaseId).artifact_id;
    // 有效期内可下载（首次下载即 EXPORTED）
    expect(s.service.downloadArtifact(s.ctx, artifactId).content).toContain("报价编号");
    // 报价有效期 7 天：过期后新正式下载关闭（不假称外部副本消失）
    s.clock.value = "2026-09-23T10:00:00.000Z";
    expect(() => s.service.downloadArtifact(s.ctx, artifactId)).toThrow(/有效期/u);
    // 停用：候选失效 → 发布 SUPERSEDED → 不可下载
    const { caseId: case2, quote: quote2 } = await pricedCase(s, "ex10b");
    const release2 = await s.service.prepareRelease(s.ctx, {
      caseId: case2,
      quoteId: quote2.quote_id,
      revision: quote2.revision,
      idempotencyKey: "rel-ex10b",
      prepareCandidate: s.prepareReleaseCandidate,
    });
    s.approvals.expireCandidate(release2.candidate_id);
    expect(s.service.recoverReleases()).toBe(1);
    const detail = s.service.getRelease(s.ctx, release2.release_id);
    expect(detail.status).toBe("SUPERSEDED");
    expect(detail.downloadable).toBe(false);
    s.db.close();
  });
});

// ---- 移交语义（KN-04..10） --------------------------------------------------

describe("RFQ 移交语义", () => {
  it("手工移交准备：只产待批准文件包 origin=manual_quote；无订单/付款/锁库存（KN-04/KN-08）", async () => {
    const s = setup();
    const { prepared, row } = await handoffReady(s, "kn04");
    expect(prepared.handoff_id).toBe(row.handoff_id);
    expect(row.status).toBe("PACKET_READY");
    expect(row.origin_kind).toBe("manual_quote");
    const packet = JSON.parse(row.packet_json) as HandoffPacket;
    // 包形状固定：文件包，不含任何订单/付款/库存动作字段
    expect(Object.keys(packet).sort()).toEqual(
      ["created_at", "evidence_catalog", "handoff_id", "intent_evidence_ref", "origin", "packet_version", "quote", "requirements", "target_ref"],
    );
    expect(packet.origin).toMatchObject({ kind: "manual_quote", quote_id: row.quote_id, revision: 1 });
    expect(packet.target_ref).toBe("handoff_inbox:crm-001");
    // 数据面无订单/结账通道（首版移交无目标适配器执行）
    const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(tables.filter((t) => t.startsWith("rfq_")).some((t) => /order|checkout|payment/i.test(t))).toBe(false);
    s.db.close();
  });

  it("内部记录不算外部受理：OWNER_RECORDED 之后无任何 TARGET_VERIFIED 通道（KN-05）", async () => {
    const s = setup();
    const { prepared } = await handoffReady(s, "kn05");
    s.service.markHandoffOwnerRecorded(s.ctx, prepared.handoff_id);
    expect(s.repo.getHandoff(prepared.handoff_id)?.status).toBe("OWNER_RECORDED");
    // 重复记录被拒（状态机单向）
    expect(() => s.service.markHandoffOwnerRecorded(s.ctx, prepared.handoff_id)).toThrow(RfqError);
    // 服务面没有可信回执写入通道：TARGET_VERIFIED 不可达
    expect(() => verifyTargetReceipt()).toThrow(RfqError);
    expect(s.repo.getHandoff(prepared.handoff_id)?.status).toBe("OWNER_RECORDED");
    expect(s.repo.getHandoff(prepared.handoff_id)?.receipt_json).toBeNull();
    s.db.close();
  });

  it("伪造目标回执与摘要绑定：自答回执整体拒绝（fail-closed）（KN-06/KN-07）", async () => {
    const s = setup();
    const { prepared, row } = await handoffReady(s, "kn06");
    // 模型或文件内附的自签回执没有提交通道：验证入口 fail-closed
    expect(() => verifyTargetReceipt()).toThrow(/TARGET_VERIFIED|issuer|packet_digest/u);
    // 伪造“目标已受理”后，状态与回执字段不被改写
    const forged = JSON.stringify({ issuer: "self", accepted: true, handoff_id: prepared.handoff_id });
    expect(s.repo.getHandoff(prepared.handoff_id)?.status).toBe(row.status);
    expect(s.repo.getHandoff(prepared.handoff_id)?.receipt_json).toBeNull();
    void forged;
    s.db.close();
  });

  it("条件无损映射：包内嵌完整需求与报价投影（条款不丢）（KN-09）", async () => {
    const s = setup();
    const { row } = await handoffReady(s, "kn09");
    const packet = JSON.parse(row.packet_json) as HandoffPacket;
    expect(packet.requirements.lines).toHaveLength(1);
    expect(packet.requirements.terms.tax_basis).toBe("INCLUSIVE");
    expect(packet.requirements.terms.tax_rate_bps).toBe(1300);
    expect(packet.requirements.terms.shipping_minor).toBe(1000);
    expect(packet.requirements.recipient_ref).toBe("张三");
    expect(packet.quote.lines).toHaveLength(1);
    expect(packet.quote.totals.gross_minor).toBeGreaterThan(0);
    expect(packet.evidence_catalog.length).toBeGreaterThan(0);
    s.db.close();
  });

  it("移交重放：同幂等键重放同一移交包，不重复登记（KN-10）", async () => {
    const s = setup();
    const { quote } = await approvedRelease(s, "rel-kn10");
    const args = {
      quoteId: quote.quote_id,
      revision: quote.revision,
      targetRef: "handoff_inbox:crm-001",
      intentEvidenceRef: "email-msg-42",
      idempotencyKey: "hnd-kn10",
    };
    const first = await s.service.prepareHandoff(s.ctx, { ...args, prepareCandidate: s.prepareHandoffCandidate });
    const second = await s.service.prepareHandoff(s.ctx, { ...args, prepareCandidate: s.prepareHandoffCandidate });
    expect(second.replayed).toBe(true);
    expect(second.handoff_id).toBe(first.handoff_id);
    expect(second.packet_digest).toBe(first.packet_digest);
    s.db.close();
  });
});

// ---- 双轨磋商适配（KN-02/03） ----------------------------------------------

describe("双轨磋商适配（KN-02/KN-03）", () => {
  it("协议状态不抹平：统一列表保留 source_protocol/source_id 与各自协议状态（KN-02）", () => {
    const a2a = fromA2aRow(
      { negotiation_id: "neg-1", phase: "OFFER_OPEN", last_action: "propose", sku: "sku-001", recorded_at: T0 } as A2aNegotiationRow,
      true,
    );
    expect(a2a.source_protocol).toBe("a2a");
    expect(a2a.source_id).toBe("neg-1");
    expect(a2a.status).toBe("OFFER_OPEN");
    expect(a2a.needs_human_review).toBe(true);
    const shopping = fromShoppingConsultation({
      conversation_id: "conv-1",
      status: "waiting_merchant",
      last_message: "请问可以便宜一点吗",
      last_message_at: T0,
    } as IncomingConsultation);
    expect(shopping.source_protocol).toBe("shopping");
    expect(shopping.source_id).toBe("conv-1");
    expect(shopping.status).toBe("waiting_merchant");
    // 路由按来源返回，不改写状态
    expect(routeHumanReview(a2a)).toBe("a2a");
    expect(routeHumanReview(shopping)).toBe("shopping");
  });

  it("跨轨执行拒绝：A2A 来源误调 shopping 通道 → 守卫与能力不可得（KN-03）", async () => {
    // 适配层守卫
    expect(() => assertReviewRoute("a2a", "shopping")).toThrow(/路由错误|不能走/u);
    expect(() => assertReviewRoute("shopping", "shopping")).not.toThrow();
    // 服务层：A2A 轨人工处理执行面未落地 → CAPABILITY_UNAVAILABLE（不可得）
    const s = setup();
    await expect(
      s.core.prepareReviewResolve({ source_protocol: "a2a", source_id: "neg-1", resolution: "accept" }),
    ).rejects.toThrow(/不可得/u);
    // shopping 轨正常登记候选
    const prepared = await s.core.prepareReviewResolve({
      source_protocol: "shopping",
      source_id: "conv-1",
      resolution: "reply:可以",
    });
    expect(prepared.candidate.candidate_id).toBeTruthy();
    s.db.close();
  });
});
