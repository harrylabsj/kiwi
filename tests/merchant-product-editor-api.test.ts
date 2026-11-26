import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { commitProductTable, loadProductTableSnapshot, parseProductTable } from "../src/cloud/product-source.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); cleanup.push(() => db.close());
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-editor-api-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "products.json");
  const merchantId = "editor-merchant";
  const table = parseProductTable({ schema_version: "0.1.2", merchant_id: merchantId, source: "merchant_upload", generated_at: new Date().toISOString(), products: [
    { sku: "A", title: "螺丝刀", price: 19.7, currency: "CNY", unit: "件", valid_until: "2099-01-01T00:00:00Z", updated_at: "2026-11-27T00:00:00Z", status: "active", supply_note: "原供货说明", public_details: { overview: "25合一" } },
    { sku: "B", title: "其他商品", price: 1, currency: "CNY", unit: "件", stock: 5, valid_until: "2099-01-01T00:00:00Z", updated_at: "2026-11-27T00:00:00Z", status: "active" },
  ] }, "fixture");
  commitProductTable(file, merchantId, table);
  const sessions = new MerchantAdminSessions({ db });
  const handler = createMerchantManagementApiHandler({
    merchantId, generation: () => 1, runtimeVersion: "test", sessions,
    listPending: () => [], mintCandidateConfirmation: () => "unused", executeDecision: async () => {},
    drafts: new MerchantImportDraftStore({ db }), operations: new MerchantManagementOperationStore({ db }),
    serviceState: new MutableServiceState("OPERATING"), readiness: async () => ({ ready: true, checks: {} }),
    marketplacePlatforms: async () => [{ id: "custom-shop", label: "配置的平台", domain: "shop.example", url_template: "https://shop.example/{id}", sort_order: 1 }],
    productsImport: { currentTable: () => { const s = loadProductTableSnapshot(file, merchantId); return { digest: s.digest, records: s.records }; }, commit: (table) => commitProductTable(file, merchantId, table) },
  });
  async function request(method: string, url: string, cookie?: string, csrf?: string, body?: unknown, raw?: string) {
    const data = raw ?? (body === undefined ? "" : JSON.stringify(body));
    const req = Object.assign(Readable.from(data ? [Buffer.from(data)] : []), {
      method, url, headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), host: "merchant.example", "content-type": raw ? "text/csv" : "application/json" },
    }) as unknown as IncomingMessage;
    return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      const res = { headersSent: false, status: 200,
        writeHead(status: number) { this.status = status; this.headersSent = true; },
        end(value = "{}") { resolve({ status: this.status, body: JSON.parse(String(value)) as Record<string, unknown> }); },
      };
      handler(req, res as unknown as ServerResponse);
    });
  }
  async function login(role: "owner" | "viewer" = "owner", tenant = merchantId) {
    const { sessionId } = sessions.createSession({ principalId: `admin:${tenant}`, merchantId: tenant, role });
    const cookie = `${ADMIN_SESSION_COOKIE}=${sessionId}`;
    const session = await request("GET", "/merchant/api/session", cookie);
    return { cookie, csrf: String(session.body["csrf_token"]) };
  }
  return { request, login, file, merchantId };
}

describe("商品页面直接编辑 API（无监听端口）", () => {
  it("读取原商品与平台配置 → 补库存保存 → 同键重放，保留其他商品及规格", async () => {
    const f = fixture(), auth = await f.login();
    const state = await f.request("GET", "/merchant/api/v1/products/edit-state?sku=A", auth.cookie);
    expect(state.status).toBe(200);
    expect(state.body["platforms"]).toEqual([{ id: "custom-shop", label: "配置的平台" }]);
    const table = state.body["table"] as { products: Array<Record<string, unknown>> };
    expect(table.products[0]).not.toHaveProperty("stock");
    table.products[0]!["stock"] = 0;
    table.products[0]!["title"] = "更新名称"; table.products[0]!["category"] = "工具";
    const draft = await f.request("POST", "/merchant/api/v1/products/import-drafts", auth.cookie, auth.csrf, { table, base_digest: state.body["base_digest"] });
    expect(draft.status).toBe(200);
    const endpoint = `/merchant/api/v1/products/import-drafts/${String(draft.body["draft_id"])}/commit`;
    const body = { expected_draft_digest: draft.body["digest"], idempotency_key: "save-a" };
    const saved = await f.request("POST", endpoint, auth.cookie, auth.csrf, body);
    expect(saved.body["status"]).toBe("succeeded");
    const replay = await f.request("POST", endpoint, auth.cookie, auth.csrf, body);
    expect(replay.body["operation_id"]).toBe(saved.body["operation_id"]);
    const records = loadProductTableSnapshot(f.file, f.merchantId).records;
    expect(records[0]).toMatchObject({ sku: "A", title: "更新名称", category: "工具", stock: 0, supply_note: "原供货说明", public_details: { overview: "25合一" } });
    expect(records[1]).toMatchObject({ sku: "B", stock: 5 });
  });
  it("拒绝缺少商品名、价格、库存的 JSON，并按行提醒；不改变原数据", async () => {
    const f = fixture(), auth = await f.login();
    const state = await f.request("GET", "/merchant/api/v1/products/edit-state?sku=A", auth.cookie);
    const table = state.body["table"] as { products: Array<Record<string, unknown>> };
    delete table.products[0]!["title"]; delete table.products[0]!["price"];
    const result = await f.request("POST", "/merchant/api/v1/products/import-drafts", auth.cookie, auth.csrf, { table });
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).toContain("第 1 行缺少必填信息：商品名、价格、库存");
    expect(loadProductTableSnapshot(f.file, f.merchantId).records[0]?.title).toBe("螺丝刀");
  });
  it.each([{ price: 19.995, stock: 1 }, { price: 1, stock: 9007199254740992 }])("拒绝无法精确表示的商品数据 %j", async (values) => {
    const f = fixture(), auth = await f.login();
    const state = await f.request("GET", "/merchant/api/v1/products/edit-state?sku=A", auth.cookie);
    const table = state.body["table"] as { products: Array<Record<string, unknown>> };
    Object.assign(table.products[0]!, values);
    const result = await f.request("POST", "/merchant/api/v1/products/import-drafts", auth.cookie, auth.csrf, { table });
    expect(result.status).toBe(422);
    expect(loadProductTableSnapshot(f.file, f.merchantId).records[0]?.price).toBe(19.7);
  });
  it("CSV 校验预览指出空库存与缺库存列，0 库存可以导入", async () => {
    const f = fixture(), a = await f.login();
    const endpoint = "/merchant/api/v1/products/import-parse?format=csv";
    const header = "sku,title,currency,unit,price,valid_until";
    const row = "A,螺丝刀,CNY,件,19.7,2099-01-01";
    const missing = await f.request("POST", endpoint, a.cookie, a.csrf, undefined, header + "\n" + row);
    expect(missing.body["ok"]).toBe(false); expect(JSON.stringify(missing.body)).toContain("库存");
    const blank = await f.request("POST", endpoint, a.cookie, a.csrf, undefined, header + ",stock\n" + row + ",");
    expect(blank.body["ok"]).toBe(false); expect(JSON.stringify(blank.body)).toContain("第 2 行缺少必填信息：库存");
    const zero = await f.request("POST", endpoint, a.cookie, a.csrf, undefined, header + ",stock\n" + row + ",0");
    expect(zero.body["ok"]).toBe(true);
  });
  it("旧快照保存返回冲突；未登录、viewer 和其他商户不能读取编辑信息", async () => {
    const f = fixture(), a = await f.login();
    const endpoint = "/merchant/api/v1/products/edit-state?sku=A";
    expect((await f.request("GET", endpoint)).status).toBe(401);
    expect((await f.request("GET", endpoint, (await f.login("viewer")).cookie)).status).toBe(403);
    expect((await f.request("GET", endpoint, (await f.login("owner", "other")).cookie)).status).toBe(404);
    const state = await f.request("GET", endpoint, a.cookie);
    const current = loadProductTableSnapshot(f.file, f.merchantId).table;
    if (!current) throw new Error("missing fixture table");
    current.products[1]!.stock = 9; commitProductTable(f.file, f.merchantId, current);
    const table = state.body["table"] as { products: Array<Record<string, unknown>> }; table.products[0]!["stock"] = 1;
    const result = await f.request("POST", "/merchant/api/v1/products/import-drafts", a.cookie, a.csrf, { table, base_digest: state.body["base_digest"] });
    expect(result.status).toBe(409); expect(loadProductTableSnapshot(f.file, f.merchantId).records[1]?.stock).toBe(9);
  });
});
