/**
 * Merchant Workbench MCP Server tests（WorkBuddy Buddy 应用开发计划 阶段二）：
 * 用官方 SDK 客户端（StreamableHTTPClientTransport）对真实启动的 server
 * （ephemeral 端口）测 initialize / tools/list / tools/call：
 * 7 个 MVP 工具的 schema 稳定、正常路径与错误路径（isError）、limit clamp、
 * draft 只产审批候选不执行、超长响应截断。
 *
 * Deterministic: in-memory SQLite, FakeMerchantClient, 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import type { MerchantIntelligenceBackend } from "../src/agent/merchant/intelligence/backend.js";
import type { MerchantBusinessSnapshot } from "../src/agent/merchant/intelligence/types.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../src/mcp/merchant-server.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-08-05T12:00:00+08:00";
const PRINCIPAL = "merchant-agent:merchant-001";

const EXPECTED_TOOL_NAMES = [
  "merchant_list_products",
  "merchant_get_product",
  "merchant_get_inventory",
  "merchant_list_a2a_negotiations",
  "merchant_list_human_reviews",
  "merchant_get_analytics",
  "merchant_draft_product_change",
];

interface McpHarness {
  handle: MerchantMcpServerHandle;
  url: string;
  merchantClient: FakeMerchantClient;
  approvals: WriteApprovalCandidateStore;
  cleanup: () => void;
}

async function setupMcpServer(
  options: {
    a2aLedgerDir?: string;
    intelligence?: MerchantIntelligenceBackend;
    maxChars?: number;
  } = {},
): Promise<McpHarness> {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const merchantClient = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
  const service = new MerchantWorkbenchService({
    profile: testProfile(),
    merchantClient,
    approvals,
    mode: () => "supervised",
    now: () => T0,
    ...(options.a2aLedgerDir !== undefined ? { a2aLedgerDir: options.a2aLedgerDir } : {}),
    ...(options.intelligence !== undefined ? { intelligence: options.intelligence } : {}),
  });
  const handle = await startMerchantMcpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
  });
  return {
    handle,
    url: handle.url,
    merchantClient,
    approvals,
    cleanup: () => db.close(),
  };
}

async function connectClient(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

const handles: MerchantMcpServerHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h !== undefined) await h.close();
  }
});

/** 写一条进行中磋商到临时 ledger，供 merchant_list_a2a_negotiations 测试。 */
function writeLedgerFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "merchant-mcp-ledger-"));
  const ledger = new LedgerStore({ dir, now: () => T0 });
  const identity = {
    sender_identity: "mkt_veyquo",
    counterparty_identity: "buyer:*",
    actor: "merchant",
  } as const;
  const capability = {
    capability: "com.harrylabsj.kiwi.shopping.negotiation",
    protocol_version: "1.0",
  } as const;
  ledger.append({
    event_kind: "message_sent",
    negotiation_id: "neg_mcp_001",
    identity,
    capability,
    wire_payload: {
      action: "conditional_offer",
      payload: {
        type: "conditional_offer",
        terms: {
          items: [
            {
              sku: "sku-001",
              quantity: { value: 2, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 18800 },
            },
          ],
        },
      },
    },
    outcome: { kind: "ok" },
    occurred_at: T0,
  });
  return dir;
}

describe("merchant MCP server", () => {
  it("initialize + tools/list：恰好 7 个 MVP 工具，schema 稳定", async () => {
    const h = await setupMcpServer();
    handles.push(h.handle);
    const client = await connectClient(h.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    const getProduct = tools.find((t) => t.name === "merchant_get_product");
    expect(getProduct?.inputSchema).toMatchObject({ required: ["sku"] });
    const listA2a = tools.find((t) => t.name === "merchant_list_a2a_negotiations");
    expect(listA2a?.inputSchema).toMatchObject({
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    });
    await client.close();
    h.cleanup();
  });

  it("merchant_list_products / get_product / get_inventory 正常路径返回 structuredContent", async () => {
    const h = await setupMcpServer();
    handles.push(h.handle);
    const client = await connectClient(h.url);

    const list = await client.callTool({ name: "merchant_list_products", arguments: {} });
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent).toMatchObject({ count: 1, source: "merchant_client" });
    const items = (list.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(items[0]).toMatchObject({ sku: "sku-001", title: "手写陶瓷杯", price: 99 });
    expect(JSON.stringify(items)).not.toContain("floor_price");

    const get = await client.callTool({
      name: "merchant_get_product",
      arguments: { sku: "sku-001" },
    });
    expect(get.isError).toBeUndefined();
    expect((get.structuredContent as { product: Record<string, unknown> }).product).toMatchObject({
      sku: "sku-001",
      merchant_id: "merchant-001",
    });

    const inv = await client.callTool({
      name: "merchant_get_inventory",
      arguments: { sku: "sku-001" },
    });
    expect(inv.isError).toBeUndefined();
    expect((inv.structuredContent as { snapshot: Record<string, unknown> }).snapshot).toMatchObject(
      {
        sku: "sku-001",
        stock: 12,
      },
    );
    await client.close();
    h.cleanup();
  });

  it("错误路径：not_found / validation 映射为 isError 带中文标签", async () => {
    const h = await setupMcpServer();
    handles.push(h.handle);
    const client = await connectClient(h.url);

    const notFound = await client.callTool({
      name: "merchant_get_product",
      arguments: { sku: "no-such" },
    });
    expect(notFound.isError).toBe(true);
    expect((notFound.content as Array<{ text: string }>)[0]?.text).toContain(
      "商家操作失败（未找到）",
    );

    const validation = await client.callTool({
      name: "merchant_get_product",
      arguments: { sku: "sku-001", merchant_id: "merchant-999" },
    });
    expect(validation.isError).toBe(true);
    expect((validation.content as Array<{ text: string }>)[0]?.text).toContain(
      "商家操作失败（参数或服务校验失败）",
    );
    await client.close();
    h.cleanup();
  });

  it("merchant_list_a2a_negotiations：结构化返回 + limit clamp；未配置 ledger 时 fail-closed", async () => {
    const dir = writeLedgerFixture();
    try {
      const h = await setupMcpServer({ a2aLedgerDir: dir });
      handles.push(h.handle);
      const client = await connectClient(h.url);
      const res = await client.callTool({ name: "merchant_list_a2a_negotiations", arguments: {} });
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toMatchObject({ total: 1, count: 1 });
      const items = (res.structuredContent as { items: Array<Record<string, unknown>> }).items;
      expect(items[0]).toMatchObject({
        negotiation_id: "neg_mcp_001",
        last_action: "conditional_offer",
        sku: "sku-001",
        quantity: 2,
        price_minor: 18800,
        agreement: false,
      });
      // limit clamp：0 / 999 都被夹住，不报错
      const clamped = await client.callTool({
        name: "merchant_list_a2a_negotiations",
        arguments: { limit: 0 },
      });
      expect(clamped.isError).toBeUndefined();
      await client.close();
      h.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const noLedger = await setupMcpServer();
    handles.push(noLedger.handle);
    const client2 = await connectClient(noLedger.url);
    const res2 = await client2.callTool({ name: "merchant_list_a2a_negotiations", arguments: {} });
    expect(res2.isError).toBe(true);
    expect((res2.content as Array<{ text: string }>)[0]?.text).toContain("暂时性错误");
    await client2.close();
    noLedger.cleanup();
  });

  it("merchant_list_human_reviews 空队列返回 count 0", async () => {
    const h = await setupMcpServer();
    handles.push(h.handle);
    const client = await connectClient(h.url);
    const res = await client.callTool({ name: "merchant_list_human_reviews", arguments: {} });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ count: 0, items: [] });
    await client.close();
    h.cleanup();
  });

  it("merchant_get_analytics：有 intelligence 正常返回；未配置时 fail-closed", async () => {
    const snapshot = {
      merchant_id: "merchant-001",
      period: "7d",
      generated_at: T0,
      metrics: [],
      alerts: { active_negotiations: 0, human_reviews: 0, pending_actions: 0, low_stock: null },
      limitations: [],
    } as MerchantBusinessSnapshot;
    const intelligence = {
      getBusinessSnapshot: vi.fn(async () => snapshot),
    } as unknown as MerchantIntelligenceBackend;

    const h = await setupMcpServer({ intelligence });
    handles.push(h.handle);
    const client = await connectClient(h.url);
    const res = await client.callTool({
      name: "merchant_get_analytics",
      arguments: { period: "7d" },
    });
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { snapshot: Record<string, unknown> }).snapshot).toMatchObject(
      {
        merchant_id: "merchant-001",
        period: "7d",
      },
    );
    const badPeriod = await client.callTool({
      name: "merchant_get_analytics",
      arguments: { period: "0d" },
    });
    expect(badPeriod.isError).toBe(true);
    await client.close();
    h.cleanup();

    const noInt = await setupMcpServer();
    handles.push(noInt.handle);
    const client2 = await connectClient(noInt.url);
    const res2 = await client2.callTool({ name: "merchant_get_analytics", arguments: {} });
    expect(res2.isError).toBe(true);
    expect((res2.content as Array<{ text: string }>)[0]?.text).toContain("暂时性错误");
    await client2.close();
    noInt.cleanup();
  });

  it("merchant_draft_product_change：只产审批候选元数据，绝不执行 updateProduct", async () => {
    const h = await setupMcpServer();
    handles.push(h.handle);
    const spy = vi.spyOn(h.merchantClient, "updateProduct");
    const client = await connectClient(h.url);
    const res = await client.callTool({
      name: "merchant_draft_product_change",
      arguments: { sku: "sku-001", changes: { price: 88 }, reason: "促销调价" },
    });
    expect(res.isError).toBeUndefined();
    const payload = res.structuredContent as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "pending_approval",
      tool: "draft_product_change",
      status: "pending_approval",
      risk: "write_catalog",
    });
    expect(typeof payload.candidate_id).toBe("string");
    expect(payload.product).toMatchObject({ sku: "sku-001", price: 99 });
    expect(spy).not.toHaveBeenCalled();
    // 候选确实落库
    expect(h.approvals.get(String(payload.candidate_id))?.status).toBe("pending_approval");
    await client.close();
    h.cleanup();
  });

  it("超长响应截断并注明（structuredContent.truncated）", async () => {
    const h = await setupMcpServer({ maxChars: 50 });
    handles.push(h.handle);
    const client = await connectClient(h.url);
    const res = await client.callTool({ name: "merchant_list_products", arguments: {} });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ truncated: true });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("响应过大已截断");
    await client.close();
    h.cleanup();
  });

  it("未知工具名返回 isError", async () => {
    const h = await setupMcpServer();
    handles.push(h.handle);
    const client = await connectClient(h.url);
    const res = await client.callTool({ name: "merchant_no_such_tool", arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
    h.cleanup();
  });
});
