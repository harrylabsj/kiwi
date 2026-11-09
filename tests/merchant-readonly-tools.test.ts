/**
 * 只读商家对话的工具白名单 / 金额负例（真实 buildMerchantTools 装配）：
 * 写工具、私有阈值、经营摘要等金额工具不注入；磋商列表在 redactAmounts 下
 * 不输出 price_minor。普通（非只读）装配保持原行为。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { buildMerchantTools } from "../src/agent/merchant/merchant-tools.js";
import { filterReadOnlyMerchantTools } from "../src/agent/merchant/read-only-tools.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-11-07T06:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(redactAmounts: boolean, a2aLedgerDir?: string) {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  const tools = buildMerchantTools({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    broker: new StaticCredentialBroker({
      negotiation: "fake-negotiation-token",
      catalog: "fake-catalog-token",
      inventory: "fake-inventory-token",
    }),
    approvals: new WriteApprovalCandidateStore({
      db,
      principalId: PRINCIPAL,
      now: () => T0,
    }),
    mode: () => "supervised",
    now: () => T0,
    ...(a2aLedgerDir !== undefined ? { a2aLedgerDir } : {}),
    ...(redactAmounts ? { redactAmounts: true } : {}),
  });
  return { tools, db };
}

describe("read-only merchant tool assembly", () => {
  it("真实装配中剔除写工具/私有阈值/金额摘要，保留无金额磋商投影", () => {
    const ledgerDir = mkdtempSync(path.join(tmpdir(), "kiwi-readonly-tools-ledger-"));
    dirs.push(ledgerDir);
    const { tools, db } = fixture(true, ledgerDir);
    try {
      const allNames = tools.map((tool) => tool.name);
      expect(allNames).toContain("create_product");
      expect(allNames).toContain("update_product");
      expect(allNames).toContain("draft_product_change");

      const readOnly = filterReadOnlyMerchantTools(tools).map((tool) => tool.name);
      for (const forbidden of [
        "create_product",
        "update_product",
        "update_inventory",
        "pause_or_resume_listing",
        "draft_product_change",
        "view_private_thresholds",
        "get_pending_actions",
        "get_negotiation_digest",
        "get_human_review_queue",
        "get_business_snapshot",
        "query_merchant_metric",
      ]) {
        expect(readOnly, forbidden).not.toContain(forbidden);
      }
      expect(readOnly).toContain("list_catalog_products");
      expect(readOnly).toContain("list_a2a_negotiations");
      expect(readOnly).toContain("list_incoming_consultations");
      expect(readOnly.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("redactAmounts=true 时 list_a2a_negotiations 真实返回不含金额；普通模式仍保留", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-readonly-ledger-"));
    dirs.push(dir);
    const ledger = new LedgerStore({ dir, now: () => T0 });
    ledger.append({
      event_kind: "message_sent",
      negotiation_id: "neg-price",
      identity: {
        sender_identity: "mkt_test",
        counterparty_identity: "buyer:buyer-1",
        actor: "merchant",
      },
      capability: {
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
      },
      wire_payload: {
        action: "offer",
        payload: {
          type: "offer",
          terms: {
            items: [
              {
                sku: "sku-price",
                quantity: { value: 1, unit: "piece" },
                unit_price: { currency: "CNY", amount_minor: 999900 },
              },
            ],
          },
        },
      },
      outcome: { kind: "ok" },
      occurred_at: T0,
    });

    const readonly = fixture(true, dir);
    try {
      const tool = readonly.tools.find((entry) => entry.name === "list_a2a_negotiations");
      expect(tool).toBeDefined();
      const result = (await tool!.execute("call-1", { limit: 10 })) as {
        content: Array<{ text?: string }>;
      };
      const text = result.content.map((entry) => entry.text ?? "").join("\n");
      expect(text).toContain("neg-price");
      expect(text).not.toContain("9999");
      expect(text).not.toContain("价 ");

      const activeTool = readonly.tools.find(
        (entry) => entry.name === "list_incoming_consultations",
      );
      expect(activeTool).toBeDefined();
      const activeResult = (await activeTool!.execute("call-active", {})) as {
        content: Array<{ text?: string }>;
      };
      const activeText = activeResult.content.map((entry) => entry.text ?? "").join("\n");
      expect(activeText).toContain("neg-price");
      expect(activeText).not.toContain("9999");
      expect(activeText).not.toContain("价 ");
    } finally {
      readonly.db.close();
    }

    const normal = fixture(false, dir);
    try {
      const tool = normal.tools.find((entry) => entry.name === "list_a2a_negotiations");
      const result = (await tool!.execute("call-2", { limit: 10 })) as {
        content: Array<{ text?: string }>;
      };
      const text = result.content.map((entry) => entry.text ?? "").join("\n");
      expect(text).toContain("9999.00");
    } finally {
      normal.db.close();
    }
  });
});
