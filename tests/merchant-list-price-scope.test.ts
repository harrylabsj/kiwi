/**
 * 磋商列表的金额边界（真实 MCP tool 返回层）：
 *   - merchant:read / 静态 token 列表无 price_minor；
 *   - merchant:owner 显式授权仍可读金额（原 owner 能力不变）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { buildMerchantMcpTools } from "../src/mcp/merchant-tools.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-11-07T06:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): ReturnType<typeof buildMerchantMcpTools> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-list-price-"));
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
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  const service = new MerchantWorkbenchService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals: new WriteApprovalCandidateStore({
      db,
      principalId: PRINCIPAL,
      now: () => T0,
    }),
    mode: () => "supervised",
    now: () => T0,
    a2aLedgerDir: dir,
  });
  return buildMerchantMcpTools(service);
}

describe("MCP negotiation list amount boundary", () => {
  it("merchant:read 列表无 price_minor；显式 merchant:owner 保留", async () => {
    const tools = setup();
    const read = await tools.call(
      "kiwi_merchant_list_a2a_negotiations",
      { limit: 10 },
      ["merchant:read"],
    );
    expect(read.isError).toBeUndefined();
    expect(JSON.stringify(read.structuredContent)).not.toContain("999900");
    expect(JSON.stringify(read.structuredContent)).not.toContain("price_minor");

    const owner = await tools.call(
      "kiwi_merchant_list_a2a_negotiations",
      { limit: 10 },
      ["merchant:read", "merchant:owner"],
    );
    expect(JSON.stringify(owner.structuredContent)).toContain("999900");
  });

  it("merchant:read 进行中列表无 price_minor；静态 token 也不泄露", async () => {
    const tools = setup();
    const read = await tools.call(
      "kiwi_merchant_list_active_consultations",
      {},
      ["merchant:read"],
    );
    expect(JSON.stringify(read.structuredContent)).not.toContain("999900");
    const staticToken = await tools.call("kiwi_merchant_list_active_consultations", {});
    expect(JSON.stringify(staticToken.structuredContent)).not.toContain("999900");
  });
});
