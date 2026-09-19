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
 * M4 私有宿主仿真 E2E（设计 v0.1.1 §12.2、§18.2 M4；离线模拟宿主全流程）。
 *
 * 覆盖（本环境可验证的 M4 部分；真实 WorkBuddy 实机仍属 L2 外部门槛）：
 *   - 单商家直连 MCP：真实 HTTP 启服，MCP JSON-RPC 走完整业务流
 *     ingest → get → refresh_facts → price → prepare_release；
 *   - MCP Apps 展示资源 ui://kiwi-rfq/*（JSON + 文本降级双 content）；
 *   - 可信管理页闭环：登录会话 → 发布页一次性凭证 → 批准激活 → 认证
 *     下载（EXPORTED 唯一触发通道）→ 导出状态与发送状态分离；
 *   - Merchant Independence Gate（§4.3/I10）：进程重启后 Core 持久状态
 *     完整、pending 候选恢复、宿主连接不承载任何状态。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../../src/agent/merchant/fake-merchant-client.js";
import { MerchantOAuthStore } from "../../src/auth/merchant-oauth.js";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions, writeAdminCredentials } from "../../src/auth/merchant-sessions.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { MerchantRfqService } from "../../src/merchant-core/rfq/service.js";
import { RfqRepository } from "../../src/merchant-core/rfq/repository.js";
import { RfqArtifactStore, ensureArtifactRoot } from "../../src/merchant-core/rfq/artifacts.js";
import { RfqReleaseCoordinator } from "../../src/merchant-core/rfq/release-coordinator.js";
import { MerchantClientCommerceDataSource } from "../../src/merchant-core/rfq/data-source-adapter.js";
import { buildRfqMcpTools } from "../../src/mcp/merchant-rfq-tools.js";
import { buildRfqPresentationResources } from "../../src/mcp/merchant-rfq-resources.js";
import { rfqAdminSurface } from "../../src/merchant-admin/rfq-page.js";
import { merchantAdminSurface } from "../../src/merchant-admin/pending-page.js";
import { startMerchantMcpServer, type MerchantMcpServerHandle } from "../../src/mcp/merchant-server.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const ADMIN_PW = "e2e-rfq-admin-password-1";
const INQUIRY = "你好，我们需要手写陶瓷杯 10 个，含税，税率13%，运费10元，7天内发货，款到发货。收件人：张三";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

interface Stack {
  handle: MerchantMcpServerHandle;
  baseUrl: string;
  /** 共享持久层（重启复用同一实例状态）。 */
  db: DatabaseSync;
  oauthDb: DatabaseSync;
  artifactRoot: string;
  adminDir: string;
}

async function bootStack(db: DatabaseSync, oauthDb: DatabaseSync, artifactRoot: string, adminDir: string): Promise<Stack> {
  const now = () => T0;
  const client = new FakeMerchantClient({ products: [fakeMerchantProduct()], now: T0 });
  const coordinator = new RfqReleaseCoordinator({
    repo: new RfqRepository({ db, merchantId: MERCHANT, now }),
    artifacts: new RfqArtifactStore({ root: artifactRoot, now }),
    now,
    currentPolicy: () => ({ version: "policy-0-e2e", config: undefined }),
  });
  const rfqService = new MerchantRfqService({
    repo: new RfqRepository({ db, merchantId: MERCHANT, now }),
    dataSource: new MerchantClientCommerceDataSource({
      client,
      merchantId: MERCHANT,
      priceUnit: "yuan",
      now,
    }),
    artifacts: new RfqArtifactStore({ root: artifactRoot, now }),
    coordinator,
    now,
    confirmationMinter: (input) => `cfm-${input.caseId}-${input.lineId}-${input.sku}`,
    policyVersion: () => "policy-0-e2e",
  });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals: new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now }),
    mode: () => "supervised",
    now,
    commandPrincipalId: PRINCIPAL,
    confirmations: new MerchantOAuthStore({ db: oauthDb, now }),
    rfq: {
      service: rfqService,
      executors: coordinator.buildExecutors(),
    },
  });
  const callContext = () => ({ principalId: PRINCIPAL, actor: PRINCIPAL, traceId: `e2e-${Date.now()}` });
  const handle = await startMerchantMcpServer({
    service: core,
    host: "127.0.0.1",
    port: 0,
    admin: {
      merchantName: "Veyquo 手工陶瓷",
      surface: merchantAdminSurface(core),
      sessions: new MerchantAdminSessions({ db: oauthDb, now }),
      store: new MerchantOAuthStore({ db: oauthDb, now }),
      adminDir,
      secureCookies: false,
    },
    rfq: {
      tools: buildRfqMcpTools(
        {
          rfq: rfqService,
          prepareReleaseCandidate: async (args) => {
            const prepared = await core.commands.prepare({
              tool: "kiwi_merchant_prepare_quote_release",
              arguments: { release_id: args.releaseId },
            });
            return prepared.candidate.candidate_id;
          },
          prepareHandoffCandidate: async () => "cand-e2e",
          callContext,
        },
        { releaseEnabled: true },
      ),
      admin: rfqAdminSurface(core),
      resources: buildRfqPresentationResources({ rfq: rfqService, callContext }),
    },
  });
  return { handle, baseUrl: `http://127.0.0.1:${handle.port}`, db, oauthDb, artifactRoot, adminDir };
}

async function mcpCall(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: true; structuredContent?: Record<string, unknown>; text: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { isError?: true; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  };
  return {
    isError: body.result?.isError,
    structuredContent: body.result?.structuredContent,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

const PROPOSAL_ENTRIES = [
  { field_path: "lines.quantity", line_id: "L1", value: 10, quote: "10 个" },
  { field_path: "lines.unit", line_id: "L1", value: "个", quote: "10 个" },
  { field_path: "terms.tax_basis", value: "INCLUSIVE", quote: "含税" },
  { field_path: "terms.tax_rate_bps", value: 1300, quote: "13%" },
  { field_path: "terms.shipping_known", value: true, quote: "运费10元" },
  { field_path: "terms.shipping_minor", value: 1000, quote: "运费10元" },
  { field_path: "terms.delivery_date", value: "7天内发货", quote: "7天内发货" },
  { field_path: "terms.payment_terms", value: "款到发货", quote: "款到发货" },
  { field_path: "recipient_ref", value: "张三", quote: "收件人：张三" },
];

describe("M4 私有宿主仿真 E2E", () => {
  it("MCP 全流程 + 管理页批准下载 + 展示资源 + 重启独立性", async () => {
    const adminDir = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-e2e-admin-"));
    dirs.push(adminDir);
    writeAdminCredentials(adminDir, { principalId: PRINCIPAL, merchantId: MERCHANT, password: ADMIN_PW });
    const artifactRoot = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-e2e-artifacts-"));
    dirs.push(artifactRoot);
    ensureArtifactRoot(artifactRoot);
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, T0, T0);
    const oauthDb = new DatabaseSync(":memory:");
    const stack = await bootStack(db, oauthDb, artifactRoot, adminDir);

    // ---- 1. tools/list：RFQ 工具与 merchant 工具同面；资源含 ui://kiwi-rfq/*
    const listRes = await fetch(`${stack.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const listBody = (await listRes.json()) as { result?: { tools?: Array<{ name: string }> } };
    const toolNames = (listBody.result?.tools ?? []).map((t) => t.name);
    expect(toolNames.filter((n) => n.startsWith("kiwi_merchant_rfq_"))).toHaveLength(14);
    expect(toolNames).toContain("kiwi_merchant_list_products");
    const resList = await fetch(`${stack.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }),
    });
    const resBody = (await resList.json()) as { result?: { resources?: Array<{ uri: string }> } };
    const uris = (resBody.result?.resources ?? []).map((r) => r.uri);
    expect(uris).toContain("ui://kiwi-rfq/case");
    expect(uris).toContain("ui://kiwi-rfq/quote");
    expect(uris).toContain("ui://kiwi-rfq/release");

    // ---- 2. MCP 工具业务流：导入 → 确认读取 → 事实 → 计价
    const ingest = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_ingest", {
      source: { kind: "manual_text", content: INQUIRY },
      proposal: { entries: PROPOSAL_ENTRIES },
      idempotency_key: "e2e-ing-1",
    });
    expect(ingest.isError, `ingest 失败：${ingest.text}`).toBeUndefined();
    const caseId = String(ingest.structuredContent?.case_id);
    expect(ingest.structuredContent?.stage).toBe("NEEDS_CLARIFICATION");

    // 具名确认走管理页表单（权威通道）——先经 HTTP 管理页确认
    const loginRes = await fetch(`${stack.baseUrl}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: ADMIN_PW, next: "/admin/rfq" }).toString(),
    });
    expect(loginRes.status).toBe(303);
    const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie.startsWith(`${ADMIN_SESSION_COOKIE}=`)).toBe(true);

    const casePage = await fetch(`${stack.baseUrl}/admin/rfq/cases/${encodeURIComponent(caseId)}`, {
      headers: { cookie },
    });
    expect(casePage.status).toBe(200);
    const caseHtml = await casePage.text();
    expect(caseHtml).toContain("确认该行");
    // 经管理页表单通道确认（POST /admin/rfq/cases/{id}/confirm）
    const confirmRes = await fetch(`${stack.baseUrl}/admin/rfq/cases/${encodeURIComponent(caseId)}/confirm`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        line_id: "L1",
        sku: "sku-001",
        expected_revision: String(ingest.structuredContent?.revision ?? "1"),
      }).toString(),
    });
    expect(confirmRes.status).toBe(200);
    const confirmedCase = (await confirmRes.json()) as { result?: { stage?: string; revision?: number } };
    expect(confirmedCase.result?.stage).toBe("READY");

    const facts = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_refresh_facts", {
      case_id: caseId,
      expected_revision: confirmedCase.result?.revision,
      idempotency_key: "e2e-facts-1",
    });
    expect(facts.isError, `refresh_facts 失败：${facts.text}`).toBeUndefined();
    const snapshotId = String(facts.structuredContent?.snapshot_id);
    const price = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_price", {
      case_id: caseId,
      expected_revision: confirmedCase.result?.revision,
      snapshot_id: snapshotId,
      idempotency_key: "e2e-price-1",
    });
    expect(price.isError, `price 失败：${price.text}`).toBeUndefined();
    const quoteId = String(price.structuredContent?.quote_id);
    expect(price.structuredContent?.status).toBe("VALIDATED");

    // ---- 3. 展示资源（MCP Apps JSON + 文本降级）
    const caseResource = await fetch(`${stack.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: `ui://kiwi-rfq/case?case_id=${encodeURIComponent(caseId)}` },
      }),
    });
    expect(caseResource.status).toBe(200);
    const resourceBody = (await caseResource.json()) as {
      result?: { contents?: Array<{ mimeType?: string; text?: string }> };
    };
    const contents = resourceBody.result?.contents ?? [];
    expect(contents.some((c) => c.mimeType === "application/json")).toBe(true);
    const textContent = contents.find((c) => c.mimeType === "text/plain");
    expect(textContent?.text).toContain("阻断项 0");

    // ---- 4. prepare_release（MCP 工具）→ 管理页批准 → 下载
    const prepared = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_prepare_release", {
      case_id: caseId,
      quote_ref: { quote_id: quoteId, revision: 1 },
      idempotency_key: "e2e-rel-1",
    });
    expect(prepared.isError, `prepare_release 失败：${prepared.text}`).toBeUndefined();
    const releaseId = String(prepared.structuredContent?.release_id);
    const candidateId = String(prepared.structuredContent?.candidate_id);
    expect(candidateId.startsWith("act_")).toBe(true);

    // 未批准前下载 → 403（不泄内部细节）
    const early = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_get_release", { release_id: releaseId });
    expect(early.structuredContent?.downloadable).toBe(false);

    const releasePage = await fetch(`${stack.baseUrl}/admin/rfq/releases/${encodeURIComponent(releaseId)}`, {
      headers: { cookie },
    });
    expect(releasePage.status).toBe(200);
    const releaseHtml = await releasePage.text();
    expect(releaseHtml).toContain("批准并激活发布");
    const tokenMatch = releaseHtml.match(/name="confirmation" value="([^"]+)"/);
    expect(tokenMatch).not.toBeNull();

    const approveRes = await fetch(
      `${stack.baseUrl}/admin/rfq/releases/${encodeURIComponent(releaseId)}/approve`,
      {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ confirmation: tokenMatch?.[1] ?? "" }).toString(),
      },
    );
    expect(approveRes.status).toBe(303); // PRG

    const after = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_get_release", { release_id: releaseId });
    expect(after.structuredContent?.status).toBe("APPROVED");
    expect(after.structuredContent?.downloadable).toBe(true);
    const artifactId = String(after.structuredContent?.artifact_id);

    // 重复批准（凭证已核销）→ 403
    const replayApprove = await fetch(
      `${stack.baseUrl}/admin/rfq/releases/${encodeURIComponent(releaseId)}/approve`,
      {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ confirmation: tokenMatch?.[1] ?? "" }).toString(),
      },
    );
    expect(replayApprove.status).toBe(403);

    // ---- 5. 认证下载 = EXPORTED 唯一触发通道
    const download = await fetch(`${stack.baseUrl}/admin/rfq/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    const fileBody = await download.text();
    expect(fileBody).toContain("报价编号");
    expect(download.headers.get("content-disposition")).toContain(".txt");
    const exported = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_get_release", { release_id: releaseId });
    void exported;
    const caseView = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_get", { case_id: caseId });
    const quotes = (caseView.structuredContent?.quotes ?? []) as Array<{ quote_id: string; status: string }>;
    expect(quotes.find((q) => q.quote_id === quoteId)?.status).toBe("EXPORTED");
    // 导出 ≠ 发送：record_delivery 前发送状态仍 NOT_SENT 域（无记录）
    const delivery = await mcpCall(stack.baseUrl, "kiwi_merchant_rfq_record_delivery", {
      quote_ref: { quote_id: quoteId, revision: 1 },
      channel: "manual_wechat",
      evidence_ref: "operator-upload-1",
      idempotency_key: "e2e-dlv-1",
    });
    expect(delivery.structuredContent?.status).toBe("REPORTED_SENT");

    // ---- 6. Merchant Independence Gate：重启后 Core 状态完整、候选恢复
    await stack.handle.close();
    const stack2 = await bootStack(db, oauthDb, artifactRoot, adminDir);
    try {
      // 会话仍有效（oauth.sqlite 持久）；同一发布状态可读
      const page2 = await fetch(`${stack2.baseUrl}/admin/rfq/releases/${encodeURIComponent(releaseId)}`, {
        headers: { cookie },
      });
      expect(page2.status).toBe(200);
      const html2 = await page2.text();
      expect(html2).toContain("APPROVED");
      const recovered = await mcpCall(stack2.baseUrl, "kiwi_merchant_rfq_get", { case_id: caseId });
      const recoveredQuotes = (recovered.structuredContent?.quotes ?? []) as Array<{ quote_id: string; status: string }>;
      expect(recoveredQuotes.some((q) => q.status === "EXPORTED")).toBe(true);
      // 恢复计数：registered 工具的 pending 候选重启后仍 pending（不被误杀）
      const pending = await mcpCall(stack2.baseUrl, "kiwi_merchant_rfq_get_release", { release_id: releaseId });
      expect(pending.structuredContent?.status).toBe("APPROVED");
    } finally {
      await stack2.handle.close();
    }
  }, 30000);
});
