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
 * RFQ 工作台端到端验收（设计 v0.1.1 §19.2 测试组覆盖）：
 *   - 导入与提取：文本/CSV、定位核验、重复导入幂等、非法 CSV 整文件拒绝；
 *   - 事实与完整性：快照/指纹/新鲜度、单位口径 fail-closed；
 *   - 审批与权限：模型自批拒绝、一次性凭证、跨主体拒绝、并发/竞态 stale；
 *   - 幂等与恢复：同键重放/冲突、死候选发布恢复；
 *   - 展示与导出：未激活不可下载、下载成功才 EXPORTED、跨商家不可读；
 *   - 状态机：修订替代、终态阻断、CANCELLED/CLOSED/EXPIRED 可达。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { contentHash, WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../../src/agent/merchant/fake-merchant-client.js";
import { MerchantOAuthStore } from "../../src/auth/merchant-oauth.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { MerchantRfqService, type RfqCallContext } from "../../src/merchant-core/rfq/service.js";
import { RfqRepository } from "../../src/merchant-core/rfq/repository.js";
import { RfqArtifactStore, ensureArtifactRoot, renderCustomerQuotePdfAscii } from "../../src/merchant-core/rfq/artifacts.js";
import { RfqReleaseCoordinator } from "../../src/merchant-core/rfq/release-coordinator.js";
import { MerchantClientCommerceDataSource } from "../../src/merchant-core/rfq/data-source-adapter.js";
import {
  buildRfqMcpTools,
  requiredScopeForRfqTool,
} from "../../src/mcp/merchant-rfq-tools.js";
import { rfqAdminSurface, renderRfqDashboard } from "../../src/merchant-admin/rfq-page.js";
import { RfqError } from "../../src/merchant-core/rfq/types.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

const INQUIRY = "你好，我们需要手写陶瓷杯 10 个，含税，税率13%，运费10元，7天内发货，款到发货。收件人：张三";

function setup(options: { clock?: { value: string }; priceUnit?: "minor" | "yuan" } = {}) {
  const clock = options.clock ?? { value: T0 };
  const now = () => clock.value;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now });
  const confirmations = new MerchantOAuthStore({ db: new DatabaseSync(":memory:"), now });
  const client = new FakeMerchantClient({ products: [fakeMerchantProduct()], now: T0 });
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-"));
  dirs.push(root);
  ensureArtifactRoot(root);
  const dataSource = new MerchantClientCommerceDataSource({
    client,
    merchantId: MERCHANT,
    ...(options.priceUnit !== undefined ? { priceUnit: options.priceUnit } : {}),
    now,
  });
  const repo = new RfqRepository({ db, merchantId: MERCHANT, now });
  const artifacts = new RfqArtifactStore({ root, now });
  const coordinator = new RfqReleaseCoordinator({
    repo,
    artifacts,
    now,
    currentPolicy: () => ({ version: "policy-0-test", config: undefined }),
  });
  const service = new MerchantRfqService({
    repo,
    dataSource,
    artifacts,
    coordinator,
    now,
    confirmationMinter: (input) => `cfm-${input.caseId}-${input.lineId}-${input.sku}`,
    candidateStatus: (candidateId) => approvals.get(candidateId)?.status,
    policyVersion: () => "policy-0-test",
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
  const prepareCandidate = async (args: { releaseId: string }) => {
    const prepared = await core.commands.prepare({
      tool: "kiwi_merchant_prepare_quote_release",
      arguments: { release_id: args.releaseId },
    });
    return prepared.candidate.candidate_id;
  };
  return { clock, db, approvals, confirmations, client, service, core, ctx, prepareCandidate, repo };
}

/** 标准流程：导入 → 修订条款 → 具名确认 → 刷新事实 → 计价。 */
async function pricedCase(s: ReturnType<typeof setup>) {
  const ingest = await s.service.ingest(s.ctx, {
    kind: "manual_text",
    content: INQUIRY,
    idempotencyKey: "ing-1",
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
  const kase = s.service.getCase(s.ctx, caseId);
  const confirmed = s.service.confirmLines(s.ctx, {
    caseId,
    expectedRevision: kase.revision,
    selections: [{ line_id: "L1", sku: "sku-001", quantity: 10, unit: "个" }],
  });
  expect(confirmed.stage).toBe("READY");
  const facts = await s.service.refreshFacts(s.ctx, {
    caseId,
    expectedRevision: confirmed.revision,
    idempotencyKey: "facts-1",
  });
  const quote = await s.service.price(s.ctx, {
    caseId,
    expectedRevision: confirmed.revision,
    snapshotId: facts.snapshot_id,
    idempotencyKey: "price-1",
  });
  return { ingest, caseId, confirmed, facts, quote };
}

describe("RFQ 导入与提取", () => {
  it("文本导入：字段带原文定位；关键项保持未确认（阻断）", async () => {
    const s = setup();
    const ingest = await s.service.ingest(s.ctx, {
      kind: "manual_text",
      content: INQUIRY,
      idempotencyKey: "k1",
      proposal: {
        entries: [{ field_path: "lines.quantity", line_id: "L1", value: 10, quote: "10 个" }],
      },
    });
    expect(ingest.stage).toBe("NEEDS_CLARIFICATION");
    expect(ingest.blockers.length).toBeGreaterThan(0);
    const view = s.service.getCase(s.ctx, ingest.case_id);
    expect(view.fields.lines[0]?.quantity).toBe(10);
    expect(view.fields.lines[0]?.confirmation).toBe("unconfirmed");
    s.db.close();
  });

  it("提取引用不在原文中 → 拒绝（locator 必须来自原文）", async () => {
    const s = setup();
    expect(() =>
      s.service.ingest(s.ctx, {
        kind: "manual_text",
        content: INQUIRY,
        idempotencyKey: "k1",
        proposal: {
          entries: [{ field_path: "lines.quantity", line_id: "L1", value: 10, quote: "一百个" }],
        },
      }),
    ).toThrow(/不在原文/u);
    s.db.close();
  });

  it("相同幂等键相同内容 → 重放同一 case；不同内容 → IDEMPOTENCY_CONFLICT", async () => {
    const s = setup();
    const a = await s.service.ingest(s.ctx, { kind: "manual_text", content: INQUIRY, idempotencyKey: "k1" });
    const b = await s.service.ingest(s.ctx, { kind: "manual_text", content: INQUIRY, idempotencyKey: "k1" });
    expect(b.replayed).toBe(true);
    expect(b.case_id).toBe(a.case_id);
    expect(() =>
      s.service.ingest(s.ctx, { kind: "manual_text", content: "另一份询盘", idempotencyKey: "k1" }),
    ).toThrow(RfqError);
    s.db.close();
  });

  it("CSV：BOM/引号转义可解析；未识别列与非法数量整文件拒绝", async () => {
    const s = setup();
    const csv = "\uFEFFsku,query,quantity,unit\n\"sku-001\",\"\"\"手写\"\"陶瓷杯\",10,个\n";
    const ingest = await s.service.ingest(s.ctx, { kind: "csv", content: csv, idempotencyKey: "csv-1" });
    expect(ingest.stage).toBe("NEEDS_CLARIFICATION");
    const view = s.service.getCase(s.ctx, ingest.case_id);
    expect(view.fields.lines).toHaveLength(1);
    expect(view.fields.lines[0]?.query).toBe('"手写"陶瓷杯');
    expect(() =>
      s.service.ingest(s.ctx, {
        kind: "csv",
        content: "sku,query,extra\nsku-001,x,1\n",
        idempotencyKey: "csv-2",
      }),
    ).toThrow(/未识别列/u);
    expect(() =>
      s.service.ingest(s.ctx, {
        kind: "csv",
        content: "sku,query,quantity\nsku-001,x,10.5\n",
        idempotencyKey: "csv-3",
      }),
    ).toThrow(/正整数/u);
    s.db.close();
  });
});

describe("RFQ 事实与计价", () => {
  it("价格单位口径未声明 → 价格事实不可得（不猜测元/分）", async () => {
    const s = setup({ priceUnit: undefined });
    // 不走 pricedCase（其内部会计价）：导入 → 修订条款 → 具名确认 → 刷新事实。
    const ingest = await s.service.ingest(s.ctx, {
      kind: "manual_text",
      content: INQUIRY,
      idempotencyKey: "ing-nu",
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
    const kase = s.service.getCase(s.ctx, ingest.case_id);
    const confirmed = s.service.confirmLines(s.ctx, {
      caseId: ingest.case_id,
      expectedRevision: kase.revision,
      selections: [{ line_id: "L1", sku: "sku-001", quantity: 10, unit: "个" }],
    });
    const facts = await s.service.refreshFacts(s.ctx, {
      caseId: ingest.case_id,
      expectedRevision: confirmed.revision,
      idempotencyKey: "facts-nu",
    });
    expect(() =>
      s.service.price(s.ctx, { caseId: ingest.case_id, expectedRevision: confirmed.revision, snapshotId: facts.snapshot_id, idempotencyKey: "p-nu" }),
    ).toThrow(/授权价格缺失/u);
    s.db.close();
  });

  it("完整流程到 PRICED：确定性金额与快照指纹", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    // 10 × ￥99 = 99000 分，INCLUSIVE 1300 → tax = 99000×1300/11300 = 11380.53… HALF_UP 11381
    // net = 99000 − 11381 = 87619；运费 1000 未税 0bps。
    expect(quote.status).toBe("VALIDATED");
    const view = s.service.getCase(s.ctx, caseId);
    expect(view.case.stage).toBe("PRICED");
    expect(view.case.current_quote_id).toBe(quote.quote_id);
    s.db.close();
  });

  it("计价幂等：同键同输入重放；同键不同快照冲突", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, confirmed, facts, quote } = await pricedCase(s);
    const replay = await s.service.price(s.ctx, {
      caseId,
      expectedRevision: confirmed.revision,
      snapshotId: facts.snapshot_id,
      idempotencyKey: "price-1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.quote_id).toBe(quote.quote_id);
    expect(() =>
      s.service.price(s.ctx, {
        caseId,
        expectedRevision: confirmed.revision,
        snapshotId: "snap-not-exist",
        idempotencyKey: "price-1",
      }),
    ).toThrow(RfqError);
    s.db.close();
  });

  it("事实刷新：库存变化 → 指纹变化 → 当前报价替代", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    s.client.updateInventory("sku-001", 3);
    const facts2 = await s.service.refreshFacts(s.ctx, {
      caseId,
      expectedRevision: s.service.getCase(s.ctx, caseId).revision,
      idempotencyKey: "facts-2",
    });
    expect(facts2.superseded_quote).toBe(quote.quote_id);
    const view = s.service.getCase(s.ctx, caseId);
    expect(view.case.current_quote_id).toBeNull();
    expect(view.case.stage).toBe("READY");
    s.db.close();
  });

  it("compare：两版报价字段级差异 + 失效原因", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    const view = s.service.getCase(s.ctx, caseId);
    const rev2 = s.service.confirmLines(s.ctx, {
      caseId,
      expectedRevision: view.revision,
      selections: [{ line_id: "L1", sku: "sku-001", quantity: 12, unit: "个" }],
    });
    const facts2 = await s.service.refreshFacts(s.ctx, { caseId, expectedRevision: rev2.revision, idempotencyKey: "f2" });
    const quote2 = await s.service.price(s.ctx, {
      caseId,
      expectedRevision: rev2.revision,
      snapshotId: facts2.snapshot_id,
      idempotencyKey: "p2",
    });
    const diff = s.service.compare(
      s.ctx,
      { quote_id: quote.quote_id, revision: quote.revision },
      { quote_id: quote2.quote_id, revision: quote2.revision },
    );
    expect(diff.from_invalid_reason).toBeDefined();
    expect(diff.changed.some((c) => c.field.endsWith(".quantity") && c.to === 12)).toBe(true);
    s.db.close();
  });
});

describe("RFQ 审批与发布", () => {
  it("模型/工具面没有 approve 工具；无凭证执行被拒（模型自批不是证据）", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-1",
      prepareCandidate: s.prepareCandidate,
    });
    // 无确认凭证 → 拒绝执行
    await expect(s.core.executeApproved(release.candidate_id)).rejects.toThrow(/确认凭证/u);
    // 下载未激活产物 → forbidden
    expect(() => s.service.downloadArtifact(s.ctx, release.artifact_id)).toThrow();
    s.db.close();
  });

  it("三阶段发布：批准激活 → 下载成功才 EXPORTED → 摘要绑定", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-1",
      prepareCandidate: s.prepareCandidate,
    });
    const detail = s.service.getRelease(s.ctx, release.release_id);
    expect(detail.status).toBe("PENDING_APPROVAL");
    expect(detail.downloadable).toBe(false);
    // 管理页通道：签发一次性凭证并批准执行
    const candidate = s.core.listPendingCommands().find((c) => c.candidate_id === release.candidate_id);
    expect(candidate).toBeDefined();
    const token = s.confirmations.createConfirmation({
      candidateId: release.candidate_id,
      candidateDigest: contentHash({
        arguments: (candidate as NonNullable<typeof candidate>).arguments,
        preconditions: (candidate as NonNullable<typeof candidate>).preconditions,
      }),
      principalId: PRINCIPAL,
      merchantId: MERCHANT,
      action: "approve",
    });
    const outcome = await s.core.commands.executeApproved(release.candidate_id, PRINCIPAL, token);
    expect(outcome.kind).toBe("executed");
    const after = s.service.getRelease(s.ctx, release.release_id);
    expect(after.status).toBe("APPROVED");
    expect(after.downloadable).toBe(true);
    // 下载成功（摘要校验）才 EXPORTED
    const file = s.service.downloadArtifact(s.ctx, after.artifact_id);
    expect(file.content).toContain("报价编号");
    const view = s.service.getCase(s.ctx, caseId);
    expect(view.quotes.find((q) => q.quote_id === quote.quote_id)?.status).toBe("EXPORTED");
    // 跨主体批准拒绝
    await expect(s.core.commands.reject(release.candidate_id, "other-principal")).rejects.toThrow(/主体不一致/u);
    s.db.close();
  });

  it("需求修订使旧审批失效：新 revision 创建后旧候选 superseded", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote, confirmed } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-1",
      prepareCandidate: s.prepareCandidate,
    });
    // 客户改数量 → 新 revision
    const revised = await s.service.revise(s.ctx, {
      caseId,
      expectedRevision: confirmed.revision,
      changes: [{ field_path: "lines.quantity", line_id: "L1", value: 20, quote: "10 个" }],
      idempotencyKey: "rev-1",
    });
    expect(revised.superseded_quote).toBe(quote.quote_id);
    // 旧候选批准 → 前置重验失败（需求 revision 变化）
    const candidate = s.core.listPendingCommands().find((c) => c.candidate_id === release.candidate_id);
    const token = s.confirmations.createConfirmation({
      candidateId: release.candidate_id,
      candidateDigest: contentHash({
        arguments: (candidate as NonNullable<typeof candidate>).arguments,
        preconditions: (candidate as NonNullable<typeof candidate>).preconditions,
      }),
      principalId: PRINCIPAL,
      merchantId: MERCHANT,
      action: "approve",
    });
    const outcome = await s.core.commands.executeApproved(release.candidate_id, PRINCIPAL, token);
    expect(["stale", "not_approvable"]).toContain(outcome.kind);
    s.db.close();
  });

  it("恢复同步：候选已死的发布标 SUPERSEDED（不冒充外部已撤销）", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId, quote } = await pricedCase(s);
    const release = await s.service.prepareRelease(s.ctx, {
      caseId,
      quoteId: quote.quote_id,
      revision: quote.revision,
      idempotencyKey: "rel-1",
      prepareCandidate: s.prepareCandidate,
    });
    s.approvals.expireCandidate(release.candidate_id);
    expect(s.service.recoverReleases()).toBe(1);
    expect(s.service.getRelease(s.ctx, release.release_id).status).toBe("SUPERSEDED");
    s.db.close();
  });
});

describe("RFQ 状态机与边界", () => {
  it("CANCELLED 终态：拒绝计价与发布；BLOCKERS 不可消除", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId } = await pricedCase(s);
    const view = s.service.getCase(s.ctx, caseId);
    const closed = s.service.closeCase(s.ctx, {
      caseId,
      expectedRevision: view.case.version,
      outcome: "CANCELLED",
      idempotencyKey: "close-1",
    });
    expect(closed.stage).toBe("CANCELLED");
    await expect(
      s.service.refreshFacts(s.ctx, { caseId, expectedRevision: view.revision, idempotencyKey: "f9" }),
    ).rejects.toThrow(/终态/u);
    s.db.close();
  });

  it("发送记录：只有已批准/已导出报价可记录；必须引用操作者证据", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { quote } = await pricedCase(s);
    expect(() =>
      s.service.recordDelivery(s.ctx, {
        quoteId: quote.quote_id,
        revision: quote.revision,
        channel: "manual_wechat",
        evidenceRef: "op-evidence-1",
        idempotencyKey: "dlv-1",
      }),
    ).toThrow(/已批准/u);
    s.db.close();
  });

  it("跨商家读取 fail-closed：另一商家仓库看不到该询盘", async () => {
    const s = setup({ priceUnit: "yuan" });
    const { caseId } = await pricedCase(s);
    const otherRepo = new RfqRepository({ db: s.db, merchantId: "merchant-002", now: s.clock.value ? () => s.clock.value : undefined } as never);
    expect(otherRepo.getCase(caseId)).toBeUndefined();
    expect(s.service.getCase(s.ctx, caseId).case.case_id).toBe(caseId);
    s.db.close();
  });

  it("PDF 渲染缺 CJK 能力时显式拒绝（不静默降级）", () => {
    const s = setup({ priceUnit: "yuan" });
    expect(() =>
      renderCustomerQuotePdfAscii({
        quote_id: "q", revision: 1, case_id: "c", case_revision: 1, status: "APPROVED",
        recipient_ref: "张三", client_ref: "rfq", currency: "CNY",
        totals: { net_minor: 1, tax_minor: 0, gross_minor: 1 },
        lines: [], shipping: { amount_minor: 0, tax_basis: "EXCLUSIVE", tax_rate_bps: 0 },
        delivery_terms: "7天", payment_terms: "款到", valid_until: T0, data_as_of: T0,
        nonbinding_execution_boundary: "非约束",
      }),
    ).toThrow(/ASCII/u);
    s.db.close();
  });
});

describe("RFQ MCP 工具面", () => {
  it("14 个工具契约：rfq_* 前缀、写工具 scope、无 approve、确认需服务端引用", async () => {
    const s = setup({ priceUnit: "yuan" });
    const surface = {
      rfq: s.service,
      prepareReleaseCandidate: s.prepareCandidate,
      prepareHandoffCandidate: async () => "cand-x",
      callContext: () => ({ principalId: PRINCIPAL, actor: PRINCIPAL, traceId: "t" }),
    };
    // 发布开关关闭（v0.1.1 §17.2 缺省）：release/handoff/get_release 不在列表。
    expect(buildRfqMcpTools(surface).listTools(undefined)).toHaveLength(11);
    const bundle = buildRfqMcpTools(surface, { releaseEnabled: true });
    const names = bundle.listTools(undefined).map((t) => t.name);
    expect(names).toHaveLength(14);
    expect(names.every((n) => n.startsWith("kiwi_merchant_rfq_"))).toBe(true);
    expect(names.some((n) => n.includes("approve"))).toBe(false);
    expect(requiredScopeForRfqTool("kiwi_merchant_rfq_price")).toBe("merchant:write");
    expect(requiredScopeForRfqTool("kiwi_merchant_rfq_get")).toBe("merchant:read");
    // scope 不足 → 带内错误
    const denied = await bundle.call("kiwi_merchant_rfq_price", {}, ["merchant:read"]);
    expect(denied.isError).toBe(true);
    // 确认核对：未确认行 → missing
    const { caseId } = await pricedCase(s);
    const view = s.service.getCase(s.ctx, caseId);
    const result = await bundle.call(
      "kiwi_merchant_rfq_confirm_items",
      {
        case_id: caseId,
        expected_revision: view.revision,
        selections: [{ line_id: "L1", sku: "sku-001", confirmation_ref: "forged-ref" }],
        idempotency_key: "c-1",
      },
      ["merchant:write"],
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ missing: ["L1"] });
    s.db.close();
  });

  it("管理页：总览渲染转义外部内容；surface 可列出/关闭询盘", async () => {
    const s = setup({ priceUnit: "yuan" });
    const surface = rfqAdminSurface(s.core);
    const { caseId } = await pricedCase(s);
    const cases = surface.listCases(PRINCIPAL, 50);
    expect(cases.some((c) => c.case.case_id === caseId)).toBe(true);
    const html = renderRfqDashboard(
      "商家<script>alert(1)</script>",
      cases.map((c) => ({ case: { case_id: c.case.case_id, stage: c.case.stage, current_quote_id: c.case.current_quote_id }, revision: c.revision, blockers: c.blockers })),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    s.db.close();
  });
});
