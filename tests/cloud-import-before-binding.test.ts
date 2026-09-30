/**
 * WP17 语义统一验收：商品表 merchant_id 语义（WP5）× 导入链路（WP12）。
 *
 * 统一后的口径：
 *   - `runtime_owner_id` 是本地租户边界（导入即写入，来自服务端会话，不由上传方声明）；
 *   - `merchant_id` 是 Catalog 设备授权**确认后**的身份，只能由服务端注入/盖戳；
 *   - 绑定前导入不被拒绝（导入即保存），但商品不可报价（CATALOG_BINDING_REQUIRED）；
 *   - 绑定后商品表带确认的 merchant_id，可报价；此后再导入也自动带上确认身份。
 *
 * 本文件走真实管理 API（import-parse → import-drafts → commit）+ 真实文件商品源，
 * prepareTable 与 bootstrap.ts 的接线语义一致（剥离上传方 merchant_id，按绑定态注入）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContext, runInContext } from "node:vm";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import {
  createMerchantManagementApiHandler,
  type MerchantManagementApiOptions,
} from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import {
  bindProductTableToCatalog,
  commitProductTable,
  createFileProductSource,
  loadProductTableSnapshot,
  type CloudProductTable,
} from "../src/cloud/product-source.js";

const OWNER = "runtime-owner-001";
const CATALOG_MERCHANT = "catalog-confirmed-merchant-77";
const ORIGIN = "https://merchant.example";
const FIXED_NOW = new Date("2026-09-28T12:00:00Z");

const IMPORT_CSV = [
  "商品编号/sku,名称/title,币种/currency,计价单位/unit,单价/price,有效期至/valid_until",
  "BIND-001,绑定链路测试商品,CNY,piece,29.90,2030-12-31",
  "BIND-002,绑定链路测试商品 二,CNY,box,3.50,2030-12-31",
].join("\r\n");

const sessionsDb = new DatabaseSync(":memory:");
const operationsDb = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: sessionsDb });
const operations = new MerchantManagementOperationStore({
  db: operationsDb,
  now: () => FIXED_NOW.toISOString(),
});
const serviceState = new MutableServiceState("OPERATING");

const importDir = mkdtempSync(path.join(tmpdir(), "kiwi-import-bind-"));
const productsFile = path.join(importDir, "products.json");

/** 绑定态旋钮：与 bootstrap 的 catalogMerchantIdForProducts() 对应；undefined = 尚未绑定。 */
let catalogMerchantId: string | undefined;

const options: MerchantManagementApiOptions = {
  merchantId: OWNER,
  generation: () => 1,
  runtimeVersion: "test-runtime",
  sessions,
  allowedOrigins: [ORIGIN],
  listPending: () => [],
  mintCandidateConfirmation: () => "tok_unused",
  executeDecision: async () => {},
  products: async () => ({
    items: createFileProductSource({ file: productsFile, merchantId: OWNER }).list().map((record) => ({
      sku: record.sku, title: record.title, currency: record.currency, price: record.price,
      price_unit: record.unit, min_order_qty: record.moq ?? null,
      valid_until: record.valid_until, updated_at: record.updated_at, status: record.status,
    })),
    next_cursor: null,
  }),
  exactProducts: {
    list: async () => [],
    get: async () => { throw new Error("No exact product in this file-import fixture"); },
  },
  productsImport: {
    currentTable: () => {
      const snapshot = loadProductTableSnapshot(productsFile, OWNER);
      return { digest: snapshot.digest, records: snapshot.records };
    },
    // 与 bootstrap.ts 接线同语义：剥离上传方 merchant_id，写本地租户边界，
    // 仅当 Catalog 已确认绑定时注入确认身份（sample 分支不在此测试范围）。
    prepareTable: (table) => {
      const { merchant_id: _untrustedMerchantId, ...unboundTable } = table;
      return {
        ...unboundTable,
        runtime_owner_id: OWNER,
        ...(catalogMerchantId !== undefined ? { merchant_id: catalogMerchantId } : {}),
      };
    },
    commit: (table: Parameters<typeof commitProductTable>[2]) =>
      commitProductTable(productsFile, OWNER, table),
  },
  drafts: new MerchantImportDraftStore({ db: operationsDb, now: () => FIXED_NOW.toISOString() }),
  operations,
  serviceState,
  readiness: async () => ({ ready: true, checks: {} }),
  now: () => FIXED_NOW,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(createMerchantManagementApiHandler(options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function login(): Promise<{ cookie: string; csrf: string }> {
  const { sessionId } = sessions.createSession({
    principalId: `admin:${OWNER}`,
    merchantId: OWNER,
    role: "owner",
  });
  const res = await fetch(`${base}/merchant/api/session`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}` },
  });
  const json = (await res.json()) as { csrf_token: string };
  expect(res.status).toBe(200);
  return { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}`, csrf: json.csrf_token };
}

async function postJson(
  pathWithQuery: string,
  auth: { cookie: string; csrf: string },
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + pathWithQuery, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      origin: ORIGIN,
      "content-type": "application/json",
      "x-csrf-token": auth.csrf,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** 走真实导入链路（parse → drafts → commit）把 CSV 变成落盘商品表。 */
async function importCsv(
  auth: { cookie: string; csrf: string },
  csv: string,
  idempotencyPrefix: string,
): Promise<void> {
  const parseRes = await fetch(`${base}/merchant/api/v1/products/import-parse?format=csv`, {
    method: "POST",
    headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv", "x-csrf-token": auth.csrf },
    body: `\ufeff${csv}`,
  });
  expect(parseRes.status).toBe(200);
  const parsed = (await parseRes.json()) as { ok: boolean; table?: CloudProductTable };
  expect(parsed.ok).toBe(true);
  expect(parsed.table).toBeDefined();

  const draft = await postJson("/merchant/api/v1/products/import-drafts", auth, {
    table: parsed.table,
    idempotency_key: `${idempotencyPrefix}-draft`,
  });
  expect(draft.status).toBe(200);

  const commit = await postJson(
    `/merchant/api/v1/products/import-drafts/${String(draft.json["draft_id"])}/commit`,
    auth,
    { expected_draft_digest: draft.json["digest"], idempotency_key: `${idempotencyPrefix}-commit` },
  );
  expect(commit.status).toBe(200);
}

describe("WP17 语义统一：绑定前导入 → 绑定 → 可报价", () => {
  it("绑定前：import-parse 产物只带 runtime_owner_id；伪造 merchant_id 被服务端剥离；导入即保存但不可报价", async () => {
    const auth = await login();

    const parseRes = await fetch(`${base}/merchant/api/v1/products/import-parse?format=csv`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv", "x-csrf-token": auth.csrf },
      body: `\ufeff${IMPORT_CSV}`,
    });
    expect(parseRes.status).toBe(200);
    const parsed = (await parseRes.json()) as { ok: boolean; table?: CloudProductTable };
    expect(parsed.ok).toBe(true);
    expect(parsed.table?.runtime_owner_id).toBe(OWNER);
    expect(parsed.table?.merchant_id).toBeUndefined();

    // 上传方伪造 Catalog 身份：prepareTable 必须剥离，导入不被拒绝（导入即保存）。
    const forged = { ...parsed.table, merchant_id: "catalog-forged-999" };
    const draft = await postJson("/merchant/api/v1/products/import-drafts", auth, {
      table: forged,
      idempotency_key: "wp17-unbound-draft",
    });
    expect(draft.status).toBe(200);

    const commit = await postJson(
      `/merchant/api/v1/products/import-drafts/${String(draft.json["draft_id"])}/commit`,
      auth,
      { expected_draft_digest: draft.json["digest"], idempotency_key: "wp17-unbound-commit" },
    );
    expect(commit.status).toBe(200);

    const stored = JSON.parse(readFileSync(productsFile, "utf8")) as CloudProductTable;
    expect(stored.runtime_owner_id).toBe(OWNER);
    expect(stored.merchant_id).toBeUndefined();
    expect(stored.products.map((row) => row.sku)).toEqual(["BIND-001", "BIND-002"]);

    // 绑定前有商品：不可报价（不因缺 Catalog 身份拒绝导入，但报价闸门关闭）。
    const unbound = createFileProductSource({ file: productsFile, merchantId: OWNER });
    expect(unbound.describeSku("BIND-001")).toEqual({
      available: false,
      code: "CATALOG_BINDING_REQUIRED",
    });
    await expect(unbound.source.getProduct("BIND-001")).rejects.toThrow();
  });

  it("导入后工作台显示文件商品，exact 库为空不会隐藏已保存的数据；未绑定仍不可报价", async () => {
    const auth = await login();
    const paths: string[] = [];
    async function renderProducts(productAuthority: "file" | "exact"): Promise<string> {
      const html = renderMerchantManagementPage({ productAuthority });
      const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/i)?.[1];
      expect(script).toBeDefined();
      const context = createContext({
        document: { querySelectorAll: () => [] },
        fetch: async (requestPath: string) => {
          if (requestPath === "/merchant/api/session") return new Response("null");
          paths.push(requestPath);
          return fetch(base + requestPath, { headers: { cookie: auth.cookie } });
        },
      });
      await runInContext(script!, context);
      return await runInContext("views.products()", context) as string;
    }
    const imported = await renderProducts("file");
    expect(imported).toContain("当前商品（2）");
    expect(imported).toContain("BIND-001");
    expect(imported).toContain("BIND-002");
    expect(imported).toContain("CNY 29.9 / piece");
    expect(paths).toContain("/merchant/api/products?limit=100");
    const exact = await renderProducts("exact");
    expect(exact).toContain("当前商品（0）");
    expect(exact).not.toContain("BIND-001");
    expect(paths).toContain("/merchant/api/v1/products?limit=100");
    expect(createFileProductSource({ file: productsFile, merchantId: OWNER }).describeSku("BIND-001"))
      .toEqual({ available: false, code: "CATALOG_BINDING_REQUIRED" });
    expect((await fetch(base + "/merchant/api/products")).status).toBe(401);
  });

  it("绑定：Catalog 确认后商品表盖确认 merchant_id，即刻可报价", async () => {
    bindProductTableToCatalog(productsFile, OWNER, CATALOG_MERCHANT);

    const bound = createFileProductSource({ file: productsFile, merchantId: OWNER });
    expect(bound.describeSku("BIND-001")).toEqual({ available: true });
    await expect(bound.source.getProduct("BIND-001")).resolves.toMatchObject({
      price: 29.9,
      currency: "CNY",
      title: "绑定链路测试商品",
    });

    const stored = JSON.parse(readFileSync(productsFile, "utf8")) as CloudProductTable;
    expect(stored.merchant_id).toBe(CATALOG_MERCHANT);
    expect(stored.runtime_owner_id).toBe(OWNER);
  });

  it("绑定后再导入：新表自动带上确认的 merchant_id（导入链路注入，不由上传方声明）", async () => {
    catalogMerchantId = CATALOG_MERCHANT;
    const auth = await login();
    const nextCsv = [
      "商品编号/sku,名称/title,币种/currency,计价单位/unit,单价/price,有效期至/valid_until",
      "BIND-001,绑定链路测试商品,CNY,piece,29.90,2031-12-31",
      "BIND-003,绑定后新商品,CNY,piece,15.00,2030-12-31",
    ].join("\r\n");
    await importCsv(auth, nextCsv, "wp17-bound");

    const stored = JSON.parse(readFileSync(productsFile, "utf8")) as CloudProductTable;
    expect(stored.merchant_id).toBe(CATALOG_MERCHANT);
    expect(stored.runtime_owner_id).toBe(OWNER);
    expect(stored.products.map((row) => row.sku)).toEqual(["BIND-001", "BIND-003"]);

    const bound = createFileProductSource({ file: productsFile, merchantId: OWNER });
    expect(bound.describeSku("BIND-003")).toEqual({ available: true });
  });
});
