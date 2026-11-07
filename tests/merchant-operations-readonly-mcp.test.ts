/**
 * WorkBuddy 直连阶段的只读运营查询（MCP 工具层）：
 *   - kiwi_merchant_get_operations_report：day/week/month UTC 窗口、上一周期、
 *     指标不可得时保留 available=false（不填 0）、未配置数据源 fail-closed；
 *   - kiwi_merchant_get_a2a_negotiation：真实 A2A ledger 的只读时间线，
 *     金额/私密策略数值不投影；
 *   - kiwi_merchant_list_active_consultations：只列非终态。
 *
 * 隔离与授权：工具 schema 不接受 merchant_id / 目标实例地址；merchant 身份
 * 由单实例装配与 OAuth 主体决定，不存在用参数切换商家的路径。
 *
 * Deterministic: 内存 SQLite、FakeMerchantClient、固定时钟与临时数据目录。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { buildMerchantMcpTools } from "../src/mcp/merchant-tools.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { createNegotiationObserver } from "../src/merchant/negotiation-observer.js";
import { createOperationsReportBuilder } from "../src/merchant/operations-report.js";
import { openMerchantStatsStore } from "../src/merchant/stats-store.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-11-07T06:03:00.000Z"; // 北京时间 2026-11-07 14:03
const NOW = new Date("2026-11-07T06:20:00.000Z");
const PRINCIPAL = "merchant-agent:merchant-001";
const SKU = "10225485016481";

const CAPABILITY = {
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
} as const;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-readonly-ops-"));
  dirs.push(dataDir);
  return dataDir;
}

function appendMessage(
  ledger: LedgerStore,
  id: string,
  direction: "buyer" | "merchant",
  at: string,
  action: string,
  quantity: number,
) {
  const incoming = direction === "buyer";
  ledger.append({
    event_kind: incoming ? "message_received" : "message_sent",
    negotiation_id: id,
    identity: {
      sender_identity: incoming ? "buyer:buyer-1" : "mkt_test",
      counterparty_identity: incoming ? "mkt_test" : "buyer:buyer-1",
      actor: direction,
    },
    capability: CAPABILITY,
    wire_payload: {
      action,
      payload: {
        type: action,
        terms: {
          items: [
            {
              sku: SKU,
              quantity: { value: quantity, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 9_999_00 },
            },
          ],
        },
      },
    },
    outcome: { kind: "ok" },
    occurred_at: at,
  });
}

function writeLedger(dataDir: string): string {
  const ledgerDir = path.join(dataDir, "a2a");
  const ledger = new LedgerStore({ dir: ledgerDir, now: () => T0 });
  // 三笔不同磋商（不是三个客户）：14:03 / 14:10 / 14:12。
  appendMessage(ledger, "neg-1403", "buyer", "2026-11-07T06:03:00.000Z", "rfq", 1);
  appendMessage(ledger, "neg-1410", "buyer", "2026-11-07T06:10:00.000Z", "rfq", 30);
  appendMessage(ledger, "neg-1412", "buyer", "2026-11-07T06:12:00.000Z", "rfq", 30);
  appendMessage(ledger, "neg-1412", "merchant", "2026-11-07T06:12:30.000Z", "offer", 30);
  ledger.append({
    event_kind: "state_transition",
    negotiation_id: "neg-1412",
    identity: {
      sender_identity: "mkt_test",
      counterparty_identity: "buyer:buyer-1",
      actor: "merchant",
    },
    capability: CAPABILITY,
    state_transition: { to_phase: "AGREEMENT_REACHED" },
    outcome: { kind: "ok" },
    occurred_at: "2026-11-07T06:12:40.000Z",
  });
  return ledgerDir;
}

function writeStats(dataDir: string): void {
  const store = openMerchantStatsStore({ dbPath: path.join(dataDir, "a2a", "stats.sqlite") });
  try {
    store.recordBuyerContact({
      message_id: "m1",
      buyer_identity: "buyer:buyer-1",
      negotiation_id: "neg-1412",
      exchange_id: "",
      action: "inquiry",
      skus: [SKU],
      occurred_at: "2026-11-07T06:12:00.000Z",
    });
  } finally {
    store.close();
  }
}

function buildService(
  dataDir: string,
  options: { report?: boolean; observer?: boolean } = {},
): MerchantWorkbenchService {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
  const ledgerDir = path.join(dataDir, "a2a");
  return new MerchantWorkbenchService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals,
    mode: () => "supervised",
    now: () => T0,
    a2aLedgerDir: ledgerDir,
    ...(options.report !== false
      ? { operationsReport: createOperationsReportBuilder({ dataDir, now: () => NOW }) }
      : {}),
    ...(options.observer !== false
      ? { negotiationObserver: createNegotiationObserver({ ledgerDir }) }
      : {}),
  });
}

describe("只读运营报告工具", () => {
  it("默认 day：UTC 窗口 + 上一周期 + 可得的真实指标", async () => {
    const dataDir = fixture();
    writeStats(dataDir);
    writeLedger(dataDir);
    const tools = buildMerchantMcpTools(buildService(dataDir));
    const result = await tools.call("kiwi_merchant_get_operations_report", {}, ["merchant:read"]);
    expect(result.isError).toBeUndefined();
    const report = (result.structuredContent as { report: Record<string, unknown> }).report;
    expect(report.period).toBe("day");
    expect(report.window).toEqual({
      since: "2026-11-07",
      until_exclusive: "2026-11-08",
      basis: "UTC",
    });
    expect(report.previous_window).toEqual({
      since: "2026-11-06",
      until_exclusive: "2026-11-07",
    });
    const metrics = report.metrics as Record<string, { available: boolean; value?: number }>;
    expect(metrics.distinct_buyers).toMatchObject({ available: true, value: 1 });
    expect(metrics.contact_events).toMatchObject({ available: true, value: 1 });
    expect(metrics.agreements_reached).toMatchObject({ available: true, value: 1 });
  });

  it("非法 period 明确 validation；未配置数据源 fail-closed（不伪造空报告）", async () => {
    const dataDir = fixture();
    writeLedger(dataDir);
    const withSource = buildMerchantMcpTools(buildService(dataDir));
    const invalid = await withSource.call(
      "kiwi_merchant_get_operations_report",
      { period: "quarter" },
      ["merchant:read"],
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.text).toContain("period 必须是 day、week 或 month");

    const withoutSource = buildMerchantMcpTools(buildService(dataDir, { report: false }));
    const missing = await withoutSource.call(
      "kiwi_merchant_get_operations_report",
      {},
      ["merchant:read"],
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("未配置运营报告数据源");
  });

  it("指标缺失时保留 available=false 与 reason，不用 0 代替", async () => {
    const dataDir = fixture();
    writeLedger(dataDir); // 只有账本，没有 stats.sqlite
    const tools = buildMerchantMcpTools(buildService(dataDir));
    const result = await tools.call("kiwi_merchant_get_operations_report", {}, ["merchant:read"]);
    const metrics = (
      result.structuredContent as {
        report: { metrics: Record<string, { available: boolean; reason?: string; value?: number }> };
      }
    ).report.metrics;
    expect(metrics.distinct_buyers).toEqual({
      available: false,
      reason: "merchant_stats_unavailable",
    });
    expect(metrics.contact_events).toEqual({
      available: false,
      reason: "merchant_stats_unavailable",
    });
    expect(metrics.contact_events?.value).toBeUndefined();
  });
});

describe("只读洽谈工具", () => {
  it("详情返回时间线与相位，金额/币种不投影", async () => {
    const dataDir = fixture();
    writeLedger(dataDir);
    const tools = buildMerchantMcpTools(buildService(dataDir));
    const result = await tools.call(
      "kiwi_merchant_get_a2a_negotiation",
      { negotiation_id: "neg-1412" },
      ["merchant:read"],
    );
    expect(result.isError).toBeUndefined();
    const negotiation = (
      result.structuredContent as {
        negotiation: {
          negotiation_id: string;
          phase: string;
          agreement: boolean;
          sku: string;
          quantity?: number;
          buyer_ref: string;
          timeline: Array<Record<string, unknown>>;
        };
      }
    ).negotiation;
    expect(negotiation).toMatchObject({
      negotiation_id: "neg-1412",
      phase: "AGREEMENT_REACHED",
      agreement: true,
      sku: SKU,
      quantity: 30,
      buyer_ref: "buyer:buyer-1",
    });
    expect(negotiation.timeline.length).toBeGreaterThan(0);
    // 隐私不变量：金额/币种不出现在任何投影字段或 JSON 文本里。
    expect(JSON.stringify(negotiation)).not.toContain("unit_price");
    expect(JSON.stringify(negotiation)).not.toContain("currency");
    expect(JSON.stringify(negotiation)).not.toContain("999900");
  });

  it("仅 merchant:owner 返回金额；read 与静态 token 仍脱敏", async () => {
    const dataDir = fixture();
    writeLedger(dataDir);
    const tools = buildMerchantMcpTools(buildService(dataDir));

    const readOnly = await tools.call(
      "kiwi_merchant_get_a2a_negotiation",
      { negotiation_id: "neg-1412" },
      ["merchant:read"],
    );
    expect(readOnly.isError).toBeUndefined();
    expect(JSON.stringify(readOnly.structuredContent)).not.toContain("999900");

    // 静态 token（scopes undefined）不能获得 owner 投影。
    const staticToken = await tools.call("kiwi_merchant_get_a2a_negotiation", {
      negotiation_id: "neg-1412",
    });
    expect(staticToken.isError).toBeUndefined();
    expect(JSON.stringify(staticToken.structuredContent)).not.toContain("999900");

    const owner = await tools.call(
      "kiwi_merchant_get_a2a_negotiation",
      { negotiation_id: "neg-1412" },
      ["merchant:read", "merchant:owner"],
    );
    expect(owner.isError).toBeUndefined();
    const payload = owner.structuredContent as {
      negotiation: {
        currency?: string;
        price_minor?: number;
        timeline: Array<{ total_minor?: number }>;
      };
    };
    expect(payload.negotiation.currency).toBe("CNY");
    expect(payload.negotiation.price_minor).toBe(999900);
    expect(JSON.stringify(payload)).toContain("999900");
  });

  it("未找到/空 id 明确报错；未配置旁观数据源 fail-closed", async () => {
    const dataDir = fixture();
    writeLedger(dataDir);
    const tools = buildMerchantMcpTools(buildService(dataDir));
    const missing = await tools.call(
      "kiwi_merchant_get_a2a_negotiation",
      { negotiation_id: "neg-missing" },
      ["merchant:read"],
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("未找到磋商 neg-missing");
    const empty = await tools.call(
      "kiwi_merchant_get_a2a_negotiation",
      { negotiation_id: "" },
      ["merchant:read"],
    );
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain("negotiation_id 不能为空");

    const withoutObserver = buildMerchantMcpTools(buildService(dataDir, { observer: false }));
    const unavailable = await withoutObserver.call(
      "kiwi_merchant_get_a2a_negotiation",
      { negotiation_id: "neg-1412" },
      ["merchant:read"],
    );
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content[0]?.text).toContain("未配置磋商旁观数据源");
  });

  it("进行中列表只留非终态，且只读 scope 可见", async () => {
    const dataDir = fixture();
    writeLedger(dataDir);
    const tools = buildMerchantMcpTools(buildService(dataDir));
    const result = await tools.call(
      "kiwi_merchant_list_active_consultations",
      {},
      ["merchant:read"],
    );
    const ids = (
      result.structuredContent as { items: Array<{ negotiation_id: string }> }
    ).items.map((item) => item.negotiation_id);
    expect(ids.sort()).toEqual(["neg-1403", "neg-1410"]);
    expect(ids).not.toContain("neg-1412");
  });
});

describe("直连只读工具的授权与 schema 边界", () => {
  it("新工具只要求 merchant:read；写 scope 不冒充读权限", async () => {
    const dataDir = fixture();
    const tools = buildMerchantMcpTools(buildService(dataDir));
    const readOnly = tools.listTools(["merchant:read"]).map((tool) => tool.name);
    expect(readOnly).toContain("kiwi_merchant_get_operations_report");
    expect(readOnly).toContain("kiwi_merchant_get_a2a_negotiation");
    expect(readOnly).toContain("kiwi_merchant_list_active_consultations");
    expect(readOnly).not.toContain("kiwi_merchant_prepare_product_change");

    const denied = await tools.call(
      "kiwi_merchant_get_operations_report",
      {},
      ["merchant:write"],
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("merchant:read");
  });

  it("只读工具不接受 merchant_id 或目标实例地址（无跨商家参数）", () => {
    const dataDir = fixture();
    const tools = buildMerchantMcpTools(buildService(dataDir));
    for (const name of [
      "kiwi_merchant_get_operations_report",
      "kiwi_merchant_get_a2a_negotiation",
      "kiwi_merchant_list_active_consultations",
    ]) {
      const definition = tools.tools.find((tool) => tool.name === name);
      expect(definition).toBeDefined();
      const schema = definition?.inputSchema as {
        additionalProperties?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {})).not.toContain("merchant_id");
      expect(Object.keys(schema.properties ?? {})).not.toContain("mcp_url");
    }
  });
});
