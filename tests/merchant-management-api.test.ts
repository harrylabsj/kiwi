/**
 * BD-02：私有管理 API 适配层（BD 设计 §9/§10/§11）。
 *
 * 逐条对上验收用例：
 *   UC09 A 会话访问 B 对象   —— 统一 404；
 *   UC10 伪造 merchant_id    —— 未知字段拒绝，主体只从会话派生；
 *   UC12 未登录/viewer 写操作 —— 401/403，业务无变化；
 *   UC15 伪造人工同意        —— 无确认引用/自造引用不能执行；
 *   UC16 规则或候选变更后批准 —— 哈希不符 precondition_changed(409)；
 *   UC19 两会话同一业务权威  —— 决策与回执跨会话可见，无状态分叉；
 *   UC20 同键同内容重复审批  —— 一次业务效果，回放原回执；
 *   UC21 同键不同内容        —— 409，不能覆盖已执行命令；
 *   UC23 提交结果未知        —— operation_id 查询路径保留（unknown）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import type { MerchantRole } from "../src/merchant/application/actor.js";
import type { WriteApprovalCandidate } from "../src/agent/merchant/action-candidate.js";
import { createCloudRouter } from "../src/cloud/http-router.js";
import { commitProductTable, loadProductTableSnapshot } from "../src/cloud/product-source.js";
import {
  createMerchantManagementApiHandler,
  type MerchantManagementApiOptions,
} from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { renderMerchantManagementPage } from "../src/http/merchant-management/page.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { AlipayCollectionStore } from "../src/merchant-core/collection/alipay-store.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import { createNegotiationOps } from "../src/merchant/negotiation-ops.js";

const FIXED_NOW = new Date("2026-09-21T10:00:00Z");
const MERCHANT = "merchant-001";
const ORIGIN = "https://merchant.example";

const sessionsDb = new DatabaseSync(":memory:");
const operationsDb = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: sessionsDb });
const operations = new MerchantManagementOperationStore({
  db: operationsDb,
  now: () => FIXED_NOW.toISOString(),
});
const serviceState = new MutableServiceState("OPERATING");

let candidates: WriteApprovalCandidate[] = [];
const executeDecision = vi.fn<
  (input: { candidateId: string; approve: boolean; confirmationRef: string }) => Promise<void>
>(async () => {});
let mintCounter = 0;
const mintCandidateConfirmation = vi.fn<
  (input: { candidateId: string; action: string; principalId: string }) => string
>(() => {
  mintCounter += 1;
  return `tok_${mintCounter}`;
});
const readiness = vi.fn<() => Promise<{ ready: boolean; checks: Record<string, { ok: boolean }> }>>(
  async () => ({ ready: true, checks: {} }),
);
const policyApplyMock = vi.fn<
  (patch: Record<string, unknown>) => Promise<{ version: number; digest: string }>
>(async () => ({ version: 4, digest: "sha256:policy-new" }));

const importDir = mkdtempSync(path.join(tmpdir(), "kiwi-mgmt-import-"));
const productsFile = path.join(importDir, "products.json");
const negotiationApprovals = NegotiationApprovalStore.forDataDir(importDir, () => FIXED_NOW.toISOString());

const options: MerchantManagementApiOptions = {
  merchantId: MERCHANT,
  generation: () => 1,
  runtimeVersion: "test-runtime",
  sessions,
  allowedOrigins: [ORIGIN],
  alipayCollection: new AlipayCollectionStore(operationsDb, MERCHANT),
  alipayCollectionOwnerActorId: `admin:${MERCHANT}`,
  alipayNegotiationApprovals: createNegotiationOps({
    approvals: negotiationApprovals, ledgerDir: path.join(importDir, "a2a"),
    merchantId: MERCHANT, version: "test", now: () => FIXED_NOW.toISOString(),
  }),
  listPending: () => candidates,
  mintCandidateConfirmation: (input) => mintCandidateConfirmation(input),
  executeDecision: async (input) => {
    await executeDecision(input);
    candidates = candidates.filter((item) => item.candidate_id !== input.candidateId);
  },
  policy: () => ({ version: 3, digest: "sha256:policy" }),
  policyCurrent: () => ({
    price_floors: { "SKU-OLD": 10 },
    sku_max_discount_percent: { "SKU-OLD": 2 },
  }),
  productsImport: {
    currentTable: () => {
      const snapshot = loadProductTableSnapshot(productsFile, MERCHANT);
      return { digest: snapshot.digest, records: snapshot.records };
    },
    commit: (table: Parameters<typeof commitProductTable>[2]) =>
      commitProductTable(productsFile, MERCHANT, table),
  },
  policyApply: (patch: Record<string, unknown>) => policyApplyMock(patch),
  drafts: new MerchantImportDraftStore({ db: operationsDb, now: () => FIXED_NOW.toISOString() }),
  operations,
  serviceState,
  readiness: () => readiness(),
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

function candidate(overrides: Partial<WriteApprovalCandidate> = {}): WriteApprovalCandidate {
  return {
    candidate_id: "act_1",
    principal_id: `merchant-agent:${MERCHANT}`,
    tool: "publish_listing",
    arguments: { sku: "SKU-1" },
    arguments_hash: "sha256:args",
    preconditions: { policy_revision: 7 },
    preconditions_hash: "sha256:pre",
    risk: "medium",
    status: "pending_approval",
    expires_at: "2026-09-21T12:00:00Z",
    created_at: "2026-09-21T09:00:00Z",
    updated_at: "2026-09-21T09:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  candidates = [candidate()];
  serviceState.resume(true, []);
  mintCounter = 0;
  executeDecision.mockReset();
  executeDecision.mockImplementation(async () => {});
  mintCandidateConfirmation.mockClear();
  readiness.mockReset();
  readiness.mockImplementation(async () => ({ ready: true, checks: {} }));
  policyApplyMock.mockReset();
  policyApplyMock.mockImplementation(async () => ({ version: 4, digest: "sha256:policy-new" }));
});

async function login(
  role: MerchantRole = "owner",
  merchantId = MERCHANT,
): Promise<{ cookie: string; csrf: string }> {
  const { sessionId } = sessions.createSession({
    principalId: `admin:${merchantId}`,
    merchantId,
    role,
  });
  const res = await fetch(`${base}/merchant/api/session`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}` },
  });
  const json = (await res.json()) as { csrf_token: string };
  expect(res.status).toBe(200);
  return { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}`, csrf: json.csrf_token };
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; origin?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.csrf !== undefined ? { "x-csrf-token": opts.csrf } : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function mintApprovalConfirmation(
  auth: { cookie: string; csrf: string },
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return call("POST", "/merchant/api/confirmations", {
    ...auth,
    body: {
      candidate_id: "act_1",
      action: "approve",
      arguments_hash: "sha256:args",
      preconditions_hash: "sha256:pre",
      ...overrides,
    },
  });
}

describe("支付宝收款设置", () => {
  const route = "/merchant/api/v1/collection/alipay";

  it("不向匿名或非直接 owner 开放，首次读取默认关闭且不可缓存", async () => {
    expect((await call("GET", route)).status).toBe(401);
    expect((await call("GET", route, await login("operator"))).status).toBe(403);
    expect((await call("GET", route, await login("owner", "other"))).status).toBe(404);
    const { sessionId } = sessions.createSession({
      principalId: `merchant:${MERCHANT}`, merchantId: MERCHANT, role: "owner",
    });
    expect((await call("GET", route, { cookie: `${ADMIN_SESSION_COOKIE}=${sessionId}` })).status).toBe(403);
    const auth = await login();
    const response = await fetch(base + route, { headers: { cookie: auth.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: null, enabled: false, recipient_masked: null, account_masked: null, has_qr: false });
  });

  it("保存前要求直属 owner、CSRF、合法 Origin 和绑定到本会话及原值的明确确认，回执不回显收款数据", async () => {
    const auth = await login();
    const otherSession = await login();
    const current = (await call("GET", route, auth)).json;
    const draft = { expected_version: current.version, enabled: true, recipient: "示例收款主体", account: "buyer-fixture@example.invalid" };
    const preview = await call("POST", `${route}/preview`, { ...auth, body: draft });
    expect(preview.status).toBe(200);
    const commit = { ...draft, confirmation_ref: preview.json.confirmation_ref, confirm_owner_rights: true };
    const post = (body: unknown, headers = auth) => call("POST", route, { ...headers, body });
    expect((await post(commit, await login("operator"))).status).toBe(403);
    expect((await call("POST", route, { cookie: auth.cookie, body: commit })).status).toBe(403);
    expect((await call("POST", route, { ...auth, origin: "https://other.example", body: commit })).status).toBe(403);
    expect((await post({ ...commit, confirm_owner_rights: false })).status).toBe(422);
    expect((await post(commit, otherSession)).status).toBe(409);
    expect((await post({ ...commit, account: "other-fixture@example.invalid" })).status).toBe(409);
    const unknown = await post({ ...commit, [draft.account]: true });
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(unknown.json)).not.toContain(draft.account);
    expect((await call("GET", route, auth)).json).toEqual(current);

    const saved = await post(commit);
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({ version: expect.stringMatching(/^[a-f0-9-]{36}$/), enabled: true, recipient_masked: "示***", account_masked: "b***", has_qr: false });
    expect(JSON.stringify([preview.json, saved.json])).not.toContain(draft.account);
    expect(JSON.stringify([preview.json, saved.json])).not.toContain(draft.recipient);
    expect((await post(commit)).status).toBe(409);
    expect((await call("GET", route, auth)).json).toEqual(saved.json);
    expect(new AlipayCollectionStore(operationsDb, MERCHANT).current()).toMatchObject({
      version: saved.json.version, account: draft.account, recipient: draft.recipient,
    });
    expect(new AlipayCollectionStore(operationsDb, "other").current()).toBeUndefined();
  });

  it("只接受有界静态 PNG；停用轮换版本且审计不保存收款资料", async () => {
    const auth = await login();
    const current = (await call("GET", route, auth)).json;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bj0AAAAASUVORK5CYII=";
    const draft = { expected_version: current.version, enabled: true, recipient: "测试 PNG 主体", qr_png_base64: png };
    const preview = (body: unknown) => call("POST", `${route}/preview`, { ...auth, body });
    const hugeDimensions = Buffer.from(png, "base64");
    hugeDimensions.writeUInt32BE(100_000, 16);
    for (const invalid of ["https://example.invalid/qr.png", `data:image/png;base64,${png}`, png.slice(0, 40), hugeDimensions.toString("base64"), "A".repeat(350_000)]) {
      expect((await preview({ ...draft, qr_png_base64: invalid })).status).toBe(422);
    }
    const draftPreview = await preview(draft);
    expect(draftPreview.status).toBe(200);
    const saved = await call("POST", route, { ...auth, body: {
      ...draft, confirm_owner_rights: true, confirmation_ref: draftPreview.json.confirmation_ref,
    } });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ account_masked: null, has_qr: true });
    expect(JSON.stringify(saved.json)).not.toContain(png);
    const disable = { expected_version: saved.json.version, confirm_disable: true };
    expect((await call("POST", `${route}/disable`, { ...auth, body: { ...disable, confirm_disable: false } })).status).toBe(422);
    const disabled = await call("POST", `${route}/disable`, { ...auth, body: disable });
    expect(disabled.status).toBe(200);
    expect(disabled.json).toMatchObject({ enabled: false, has_qr: true });
    expect(disabled.json.version).not.toBe(saved.json.version);
    expect((await call("POST", `${route}/disable`, { ...auth, body: disable })).status).toBe(409);
    const audit = operationsDb.prepare("SELECT * FROM alipay_collection_audit WHERE version = ?")
      .get(disabled.json.version as string);
    expect(audit).toEqual({
      version: disabled.json.version, merchant_id: MERCHANT, actor_id: `admin:${MERCHANT}`,
      changed_at: FIXED_NOW.toISOString(), enabled: 0,
    });
    const changes = operationsDb.prepare("SELECT * FROM alipay_collection_audit_changes WHERE version = ?");
    expect(changes.get(saved.json.version as string)).toEqual({
      version: saved.json.version, initial: Number(current.version === null), recipient_changed: 1, account_changed: Number(current.account_masked !== null), qr_changed: 1,
    });
    expect(changes.get(disabled.json.version as string)).toEqual({
      version: disabled.json.version, initial: 0, recipient_changed: 0, account_changed: 0, qr_changed: 0,
    });
  });

  it("仅直接 owner 可明确批准指定 CNY 报价的应付总额，不返回私有底价", async () => {
    const auth = await login();
    const current = (await call("GET", route, auth)).json;
    const draft = { expected_version: current.version, enabled: true, recipient: "测试主体", account: "merchant-fixture@example.invalid" };
    const preview = await call("POST", `${route}/preview`, { ...auth, body: draft });
    const configured = await call("POST", route, { ...auth, body: {
      ...draft, confirmation_ref: preview.json.confirmation_ref, confirm_owner_rights: true,
    } });
    const fixture = { sku: "SKU-TEST", quantity: 2, unit: "piece", buyer_offer_minor: 700, floor_minor: 711 };
    const cny = negotiationApprovals.recordPending({ ...fixture, negotiation_id: "neg_test_cny", currency: "CNY" });
    const usd = negotiationApprovals.recordPending({ ...fixture, negotiation_id: "neg_test_usd", currency: "USD" });
    const approvalPath = `${route}/approvals`;
    const list = await call("GET", approvalPath, auth);
    expect(list.status).toBe(200);
    expect(list.json).toEqual({ items: [{
      approval_id: cny.approval_id, negotiation_id: cny.negotiation_id, sku: fixture.sku, quantity: 2,
      unit: "piece", buyer_offer_minor: 700, currency: "CNY", expires_at: null,
    }] });
    const approved = { approval_id: cny.approval_id, expected_version: configured.json.version,
      approved_minor: 800, alipay_total_minor: 1650, confirm_final_total: true };
    const post = (body: unknown, headers = auth) => call("POST", approvalPath, { ...headers, body });
    expect((await post(approved, await login("operator"))).status).toBe(403);
    expect((await post(approved, { ...auth, csrf: "" })).status).toBe(403);
    expect((await post({ ...approved, confirm_final_total: false })).status).toBe(422);
    expect((await post({ ...approved, alipay_total_minor: 1599 })).status).toBe(422);
    expect((await post({ ...approved, alipay_total_minor: Number.MAX_SAFE_INTEGER + 1 })).status).toBe(422);
    expect((await post({ ...approved, approval_id: usd.approval_id })).status).toBe(404);
    expect((await post({ ...approved, expected_version: current.version })).status).toBe(409);
    const receipt = await post(approved);
    expect(receipt.status).toBe(200);
    expect(receipt.json).toEqual({ approval_id: cny.approval_id, status: "approved", approved_minor: 800, alipay_total_minor: 1650 });
    expect((await post(approved)).status).toBe(404);
    expect(negotiationApprovals.list("approved")).toEqual([expect.objectContaining({
      approval_id: cny.approval_id, alipay_total_minor: 1650, approved_by: `admin:${MERCHANT}`,
    })]);
  });
});

describe("merchant management api — 认证与防护", () => {
  it("未认证 → 401（UC12 前半）", async () => {
    const res = await call("GET", "/merchant/api/status");
    expect(res.status).toBe(401);
    expect(res.json["code"]).toBe("unauthorized");
  });

  it("session→主体派生：角色与 CSRF 令牌来自会话，status 不含秘密", async () => {
    const auth = await login("owner");
    const status = await call("GET", "/merchant/api/status", auth);
    expect(status.status).toBe(200);
    expect(status.json["api_version"]).toBe("1");
    expect(status.json["service_state"]).toBe("OPERATING");
    expect(status.json["generation"]).toBe(1);
    const body = JSON.stringify(status.json);
    expect(body.includes("password")).toBe(false);
    expect(body.includes("token")).toBe(false);
    const session = await call("GET", "/merchant/api/session", auth);
    expect(session.json["role"]).toBe("owner");
    expect(String(session.json["csrf_token"]).length).toBeGreaterThan(10);
  });

  it("UC10：正文字段不能改变认证主体（未知字段拒绝）", async () => {
    const auth = await login("owner");
    const confirmation = await mintApprovalConfirmation(auth);
    expect(confirmation.status).toBe(200);
    expect(mintCandidateConfirmation.mock.calls[0]?.[0]["principalId"]).toBe(`admin:${MERCHANT}`);
    const forged = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: confirmation.json["confirmation_ref"],
        idempotency_key: "uc10",
        merchant_id: "merchant-002",
      },
    });
    expect(forged.status).toBe(400);
    expect(candidates.some((item) => item.candidate_id === "act_1")).toBe(true);
  });

  it("写请求缺 CSRF / 错 CSRF → 403", async () => {
    const auth = await login("owner");
    const missing = await call("POST", "/merchant/api/confirmations", {
      cookie: auth.cookie,
      body: {
        candidate_id: "act_1",
        action: "approve",
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
      },
    });
    expect(missing.status).toBe(403);
    const wrong = await call("POST", "/merchant/api/confirmations", {
      cookie: auth.cookie,
      csrf: "definitely-wrong",
      body: {
        candidate_id: "act_1",
        action: "approve",
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
      },
    });
    expect(wrong.status).toBe(403);
    expect(mintCounter).toBe(0);
  });

  it("写请求 Origin 不在允许列表 → 403（CORS 不是认证）", async () => {
    const auth = await login("owner");
    const res = await call("POST", "/merchant/api/confirmations", {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: "https://evil.example",
      body: {
        candidate_id: "act_1",
        action: "approve",
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("merchant management api — 权限与归属", () => {
  it("UC12：viewer 可读、写操作 403 且业务无变化", async () => {
    const viewer = await login("viewer");
    expect((await call("GET", "/merchant/api/status", viewer)).status).toBe(200);
    const paused = await call("POST", "/merchant/api/service/pause", {
      ...viewer,
      body: { expected_service_revision: serviceState.serviceRevision, idempotency_key: "v1" },
    });
    expect(paused.status).toBe(403);
    expect(paused.json["code"]).toBe("forbidden");
    expect(serviceState.gateCheck().accepting).toBe(true);
  });

  it("UC09：其他商家的会话访问本实例对象 → 统一 404", async () => {
    const foreign = await login("owner", "merchant-999");
    const res = await call("GET", "/merchant/api/approvals", foreign);
    expect(res.status).toBe(404);
    expect(res.json["code"]).toBe("not_found");
  });
});

describe("merchant management api — 审批链路与幂等", () => {
  it("确认→批准→回执落盘可查", async () => {
    const auth = await login("owner");
    const confirmation = await mintApprovalConfirmation(auth);
    expect(confirmation.status).toBe(200);
    const ref = String(confirmation.json["confirmation_ref"]);
    const approved = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: ref,
        idempotency_key: "k1",
      },
    });
    expect(approved.status).toBe(200);
    expect(approved.json["status"]).toBe("succeeded");
    expect(approved.json["resource_ref"]).toBe("act_1");
    expect(String(approved.json["operation_id"]).startsWith("mop_")).toBe(true);
    expect(executeDecision).toHaveBeenCalledTimes(1);
    const queried = await call(
      "GET",
      `/merchant/api/operations/${String(approved.json["operation_id"])}`,
      auth,
    );
    expect(queried.status).toBe(200);
    expect(queried.json["operation_id"]).toBe(approved.json["operation_id"]);
  });

  it("UC20：同键同内容重放 → 原回执，不重复执行", async () => {
    const auth = await login("owner");
    const body = {
      arguments_hash: "sha256:args",
      preconditions_hash: "sha256:pre",
      confirmation_ref: "tok-replay",
      idempotency_key: "same-key",
    };
    const first = await call("POST", "/merchant/api/approvals/act_1/approve", { ...auth, body });
    expect(first.status).toBe(200);
    const second = await call("POST", "/merchant/api/approvals/act_1/approve", { ...auth, body });
    expect(second.status).toBe(200);
    expect(second.json["operation_id"]).toBe(first.json["operation_id"]);
    expect(executeDecision).toHaveBeenCalledTimes(1);
  });

  it("UC21：同键不同内容 → 409，已执行命令不被覆盖", async () => {
    const auth = await login("owner");
    const first = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "tok-a",
        idempotency_key: "dup",
      },
    });
    expect(first.status).toBe(200);
    const second = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "tok-b",
        idempotency_key: "dup",
      },
    });
    expect(second.status).toBe(409);
    expect(second.json["code"]).toBe("conflict");
  });

  it("UC16：哈希不符 → precondition_changed(409)；释放占位后原键可重试", async () => {
    const auth = await login("owner");
    const stale = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:stale",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "tok-stale",
        idempotency_key: "uc16",
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.json["code"]).toBe("precondition_changed");
    expect(candidates.some((item) => item.candidate_id === "act_1")).toBe(true);
    const fresh = await mintApprovalConfirmation(auth);
    const retry = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: fresh.json["confirmation_ref"],
        idempotency_key: "uc16",
      },
    });
    expect(retry.status).toBe(200);
    expect(retry.json["status"]).toBe("succeeded");
  });

  it("UC15：确认引用被执行层拒绝 → 403，未执行且原键可重试", async () => {
    const auth = await login("owner");
    executeDecision.mockRejectedValue(new Error("确认凭证无效或已过期，请刷新后重试"));
    const rejected = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "bogus",
        idempotency_key: "uc15",
      },
    });
    expect(rejected.status).toBe(403);
    expect(candidates.some((item) => item.candidate_id === "act_1")).toBe(true);
    executeDecision.mockImplementation(async () => {});
    const retry = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "tok-fixed",
        idempotency_key: "uc15",
      },
    });
    expect(retry.status).toBe(200);
    expect(retry.json["status"]).toBe("succeeded");
  });

  it("UC23：执行层未知异常 → unknown 入库可对账，同键重试只回放", async () => {
    const auth = await login("owner");
    executeDecision.mockRejectedValue(new Error("connection reset mid-commit"));
    const attempted = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "tok-unknown",
        idempotency_key: "uc23",
      },
    });
    expect(attempted.status).toBe(503);
    const message = String(attempted.json["message"]);
    const operationId = /operation (mop_[0-9a-f]+)/.exec(message)?.[1];
    expect(operationId).toBeDefined();
    const queried = await call("GET", `/merchant/api/operations/${String(operationId)}`, auth);
    expect(queried.status).toBe(200);
    expect(queried.json["status"]).toBe("unknown");
    const retry = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...auth,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: "tok-unknown",
        idempotency_key: "uc23",
      },
    });
    expect(retry.status).toBe(200);
    expect(retry.json["status"]).toBe("unknown");
    expect(retry.json["operation_id"]).toBe(operationId);
  });

  it("UC19：两个会话共享同一业务权威——A 执行，B 可见回执与最新列表", async () => {
    const ownerA = await login("owner");
    const ownerB = await login("owner");
    const listB = await call("GET", "/merchant/api/approvals", ownerB);
    expect(listB.status).toBe(200);
    expect((listB.json["items"] as unknown[]).length).toBe(1);
    const confirmation = await mintApprovalConfirmation(ownerA);
    const approved = await call("POST", "/merchant/api/approvals/act_1/approve", {
      ...ownerA,
      body: {
        arguments_hash: "sha256:args",
        preconditions_hash: "sha256:pre",
        confirmation_ref: confirmation.json["confirmation_ref"],
        idempotency_key: "uc19",
      },
    });
    expect(approved.status).toBe(200);
    const receiptViaB = await call(
      "GET",
      `/merchant/api/operations/${String(approved.json["operation_id"])}`,
      ownerB,
    );
    expect(receiptViaB.status).toBe(200);
    const listAfterB = await call("GET", "/merchant/api/approvals", ownerB);
    expect((listAfterB.json["items"] as unknown[]).length).toBe(0);
  });
});

describe("merchant management api — 暂停与恢复", () => {
  it("pause 拒新询价；owner 经确认+就绪门 resume；状态投影同步", async () => {
    const owner = await login("owner");
    const paused = await call("POST", "/merchant/api/service/pause", {
      ...owner,
      body: {
        expected_service_revision: serviceState.serviceRevision,
        reason: "维护",
        idempotency_key: "p1",
      },
    });
    expect(paused.status).toBe(200);
    expect(paused.json["status"]).toBe("succeeded");
    expect(serviceState.gateCheck().accepting).toBe(false);
    const statusWhilePaused = await call("GET", "/merchant/api/status", owner);
    expect(statusWhilePaused.json["service_state"]).toBe("PAUSED");

    const confirmation = await call("POST", "/merchant/api/confirmations", {
      ...owner,
      body: { target: "service.resume", expected_service_revision: serviceState.serviceRevision },
    });
    expect(confirmation.status).toBe(200);
    const resumed = await call("POST", "/merchant/api/service/resume", {
      ...owner,
      body: {
        expected_service_revision: serviceState.serviceRevision,
        confirmation_ref: confirmation.json["confirmation_ref"],
        idempotency_key: "r1",
      },
    });
    expect(resumed.status).toBe(200);
    expect(serviceState.gateCheck().accepting).toBe(true);
    const statusAfter = await call("GET", "/merchant/api/status", owner);
    expect(statusAfter.json["service_state"]).toBe("OPERATING");
  });

  it("resume 就绪门未过 → 503 且状态不变", async () => {
    const owner = await login("owner");
    await call("POST", "/merchant/api/service/pause", {
      ...owner,
      body: { expected_service_revision: serviceState.serviceRevision, idempotency_key: "p2" },
    });
    readiness.mockImplementation(async () => ({
      ready: false,
      checks: { products: { ok: false } },
    }));
    const confirmation = await call("POST", "/merchant/api/confirmations", {
      ...owner,
      body: { target: "service.resume", expected_service_revision: serviceState.serviceRevision },
    });
    const refused = await call("POST", "/merchant/api/service/resume", {
      ...owner,
      body: {
        expected_service_revision: serviceState.serviceRevision,
        confirmation_ref: confirmation.json["confirmation_ref"],
        idempotency_key: "r2",
      },
    });
    expect(refused.status).toBe(503);
    expect(refused.json["code"]).toBe("unavailable");
    expect(serviceState.gateCheck().accepting).toBe(false);
  });

  it("resume 是 owner 专属；确认引用错误 → 403", async () => {
    const operator = await login("operator");
    const forbidden = await call("POST", "/merchant/api/service/resume", {
      ...operator,
      body: {
        expected_service_revision: serviceState.serviceRevision,
        confirmation_ref: "whatever",
        idempotency_key: "r3",
      },
    });
    expect(forbidden.status).toBe(403);
    const owner = await login("owner");
    await call("POST", "/merchant/api/service/pause", {
      ...owner,
      body: { expected_service_revision: serviceState.serviceRevision, idempotency_key: "p3" },
    });
    const badRef = await call("POST", "/merchant/api/service/resume", {
      ...owner,
      body: {
        expected_service_revision: serviceState.serviceRevision,
        confirmation_ref: "mcf_not-real",
        idempotency_key: "r4",
      },
    });
    expect(badRef.status).toBe(403);
  });
});

describe("merchant management api — 只读投影与路由", () => {
  it("无商品源 → 503（不伪造空目录）；policy 返回脱敏版本与摘要", async () => {
    const auth = await login("owner");
    const products = await call("GET", "/merchant/api/products", auth);
    expect(products.status).toBe(503);
    expect(products.json["code"]).toBe("unavailable");
    const policy = await call("GET", "/merchant/api/policy", auth);
    expect(policy.status).toBe(200);
    expect(policy.json["policy_revision"]).toBe(3);
    expect(policy.json["digest"]).toBe("sha256:policy");
    // 规则页安全投影：公开值/是否已设置可回显，私有底价金额不回显。
    expect(policy.json["auto_quote"]).toBe(true);
    expect(policy.json["sku_discounts"]).toEqual({ "SKU-OLD": 2 });
    expect(policy.json["sku_floors_configured"]).toEqual(["SKU-OLD"]);
    expect(policy.json["global_floor_configured"]).toBe(false);
    expect(Object.hasOwn(policy.json, "price_floors")).toBe(false);
  });

  it("未知路径 404；已知路径错误方法 405", async () => {
    const auth = await login("owner");
    expect((await call("GET", "/merchant/api/nope", auth)).status).toBe(404);
    expect((await call("GET", "/merchant/api/confirmations", auth)).status).toBe(405);
  });
});

describe("Workbench /merchant/api/v1 — RFC 9457 与兼容读取", () => {
  it("未登录读取 runtime/status 返回 application/problem+json", async () => {
    const res = await fetch(`${base}/merchant/api/v1/runtime/status`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "urn:kiwi:problem:unauthenticated",
      status: 401,
      code: "UNAUTHENTICATED",
      retryable: false,
      recovery_action: "reauthenticate",
    });
    expect(body["request_id"]).toBe(res.headers.get("x-request-id"));
  });

  it("复用同一应用服务读取状态；已知但未装配的资源明确 503，未知路由 404", async () => {
    const auth = await login("owner");
    const status = await fetch(`${base}/merchant/api/v1/runtime/status`, {
      headers: { cookie: auth.cookie },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      api_version: "1",
      runtime_version: "test-runtime",
      service_state: "OPERATING",
    });

    const missing = await fetch(`${base}/merchant/api/v1/promotions`, {
      headers: { cookie: auth.cookie },
    });
    expect(missing.status).toBe(503);
    expect(missing.headers.get("content-type")).toContain("application/problem+json");
    expect(await missing.json()).toMatchObject({ code: "DEPENDENCY_UNAVAILABLE", status: 503 });

    const products = await fetch(`${base}/merchant/api/v1/products`, {
      headers: { cookie: auth.cookie },
    });
    expect(products.status).toBe(503);
    expect(await products.json()).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      status: 503,
    });
  });

  it("v1 读取 policy：与 v0 同一脱敏投影（页面「报价规则」依赖）", async () => {
    const auth = await login("owner");
    const policy = await call("GET", "/merchant/api/v1/policy", auth);
    expect(policy.status).toBe(200);
    expect(policy.json["policy_revision"]).toBe(3);
    expect(policy.json["digest"]).toBe("sha256:policy");
    expect(policy.json["auto_quote"]).toBe(true);
    expect(policy.json["sku_discounts"]).toEqual({ "SKU-OLD": 2 });
    expect(policy.json["sku_floors_configured"]).toEqual(["SKU-OLD"]);
  });

  it("v1 管理页写路由的拒绝响应统一使用 RFC 9457", async () => {
    const auth = await login("owner");
    for (const [path, body] of [
      ["/merchant/api/v1/products/import-drafts", { unexpected: true }],
      ["/merchant/api/v1/policy/drafts", { unexpected: true }],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          cookie: auth.cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "x-csrf-token": auth.csrf,
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({
        status: 422,
        code: "VALIDATION_ERROR",
        retryable: false,
        recovery_action: "refresh_resource",
      });
    }
  });

  it("legacy /merchant/api/* 继续使用既有契约，不被静默改写", async () => {
    const legacy = await fetch(`${base}/merchant/api/status`);
    expect(legacy.status).toBe(401);
    expect(legacy.headers.get("content-type")).toContain("application/json");
    expect(legacy.headers.get("content-type")).not.toContain("application/problem+json");
    expect(await legacy.json()).toMatchObject({ code: "unauthorized" });
  });
});

describe("merchant admin sessions — 角色迁移（BD-02 会话改造）", () => {
  it("既有库缺 role 列 → 迁移补列，历史行按 owner；新会话可指定角色", () => {
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`
      CREATE TABLE admin_sessions (
        session_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const migrated = new MerchantAdminSessions({ db: legacy });
    const viewer = migrated.createSession({
      principalId: "admin:x",
      merchantId: MERCHANT,
      role: "viewer",
    });
    expect(migrated.getSession(viewer.sessionId)?.role).toBe("viewer");
    const legacyRow = migrated.createSession({ principalId: "admin:y", merchantId: MERCHANT });
    expect(migrated.getSession(legacyRow.sessionId)?.role).toBe("owner");
  });
});

// ── BD-03：商品导入与策略草稿（BD 设计 §10.1/§7.4）────────────────────────

function productTable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "0.1.2",
    merchant_id: MERCHANT,
    source: "merchant_upload",
    generated_at: "2026-09-21T09:00:00Z",
    products: [
      {
        sku: "SKU-1",
        title: "测试商品",
        currency: "CNY",
        unit: "piece",
        price: 99.5,
        moq: 2,
        updated_at: "2026-09-21T09:00:00Z",
        valid_until: "2099-01-01T00:00:00Z",
        status: "active",
      },
    ],
    ...overrides,
  };
}

describe("merchant management api — 商品导入（BD-03）", () => {
  it("校验预览 → 原子提交 → 幂等重放；重复提交草稿 → 409（UC28）", async () => {
    const auth = await login("owner");
    const draft = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: { table: productTable(), idempotency_key: "d1" },
    });
    expect(draft.status).toBe(200);
    expect(draft.json["preview"]).toMatchObject({ rows_total: 1, added: 1, removed: 0 });
    const digest = String(draft.json["digest"]);
    const committed = await call(
      "POST",
      `/merchant/api/products/import-drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...auth,
        body: { expected_draft_digest: digest, idempotency_key: "c1" },
      },
    );
    expect(committed.status).toBe(200);
    expect(committed.json["status"]).toBe("succeeded");
    // 文件真实写入且可解析（全批生效）
    const snapshot = loadProductTableSnapshot(productsFile, MERCHANT);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]?.sku).toBe("SKU-1");
    // 同键同内容重放 → 原回执（UC20 语义在导入同样成立）
    const replay = await call(
      "POST",
      `/merchant/api/products/import-drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...auth,
        body: { expected_draft_digest: digest, idempotency_key: "c1" },
      },
    );
    expect(replay.status).toBe(200);
    expect(replay.json["operation_id"]).toBe(committed.json["operation_id"]);
    // 已提交草稿再提交 → 409
    const again = await call(
      "POST",
      `/merchant/api/products/import-drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...auth,
        body: { expected_draft_digest: digest, idempotency_key: "c2" },
      },
    );
    expect(again.status).toBe(409);
  });

  it("按 SKU 合并追加：文件外的现有商品保留，removed 恒为 0", async () => {
    const auth = await login("owner");
    const first = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: { table: productTable(), idempotency_key: "merge-1" },
    });
    expect(first.status).toBe(200);
    const firstCommit = await call(
      "POST",
      `/merchant/api/products/import-drafts/${String(first.json["draft_id"])}/commit`,
      {
        ...auth,
        body: { expected_draft_digest: String(first.json["digest"]), idempotency_key: "merge-c1" },
      },
    );
    expect(firstCommit.status).toBe(200);

    const second = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: {
        table: productTable({
          products: [
            {
              sku: "SKU-2",
              title: "追加商品",
              currency: "CNY",
              unit: "piece",
              price: 12,
              updated_at: "2026-09-21T10:00:00Z",
              valid_until: "2099-01-01T00:00:00Z",
              status: "active",
            },
          ],
        }),
        idempotency_key: "merge-2",
      },
    });
    expect(second.status).toBe(200);
    expect(second.json["preview"]).toMatchObject({
      rows_total: 1,
      added: 1,
      updated: 0,
      unchanged: 0,
      kept: 1,
      removed: 0,
    });
    const secondCommit = await call(
      "POST",
      `/merchant/api/products/import-drafts/${String(second.json["draft_id"])}/commit`,
      {
        ...auth,
        body: { expected_draft_digest: String(second.json["digest"]), idempotency_key: "merge-c2" },
      },
    );
    expect(secondCommit.status).toBe(200);
    const snapshot = loadProductTableSnapshot(productsFile, MERCHANT);
    const skus = snapshot.records.map((record) => record.sku);
    expect(skus).toContain("SKU-1");
    expect(skus).toContain("SKU-2");
  });

  it("保留普通导入未提供的问答资料，显式替换与清空产生新发布版本", async () => {
    const auth = await login("owner");
    const endpoint = "/merchant/api/v1/products/import-drafts";
    const importTable = async (table: unknown, key: string, updated: number) => {
      const draft = await call("POST", endpoint, { ...auth, body: { table, idempotency_key: key } });
      expect(draft.status).toBe(200);
      expect(draft.json["preview"]).toMatchObject({ updated });
      const committed = await call("POST", `${endpoint}/${String(draft.json["draft_id"])}/commit`, {
        ...auth,
        body: { expected_draft_digest: String(draft.json["digest"]), idempotency_key: `${key}-commit` },
      });
      expect(committed.status).toBe(200);
      return loadProductTableSnapshot(productsFile, MERCHANT).records.find((row) => row.sku === "SKU-QA")!;
    };
    const [baseRow] = productTable()["products"] as Array<Record<string, unknown>>;
    const record = { ...baseRow, sku: "SKU-QA" };
    const withDetails = (details: unknown) => productTable({ products: [{ ...record, public_details: details }] });
    const details = { overview: "双层测试杯", capacity: "450 mL" };
    const first = await importTable(withDetails(details), "qa-first", 0);
    expect(first.public_details).toEqual(details);
    const legacy = await importTable(productTable({ products: [record] }), "qa-legacy", 0);
    expect(legacy).toEqual(first);

    const parsed = await fetch(`${base}/merchant/api/v1/products/import-parse?format=csv`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv", "x-csrf-token": auth.csrf },
      body: "sku,title,currency,unit,price,valid_until\nSKU-QA,更新商品,CNY,个,88,2027-12-31",
    });
    expect(parsed.status).toBe(200);
    const { table: fromCsv } = await parsed.json() as { table: unknown };
    const updated = await importTable(fromCsv, "qa-csv", 1);
    expect(updated).toMatchObject({ title: "更新商品", price: 88, public_details: details });
    expect(updated.public_details_revision).toBe(first.public_details_revision);

    const cleared = await importTable(withDetails({}), "qa-clear", 1);
    expect(cleared.public_details).toEqual({});
    const restored = await importTable(withDetails(details), "qa-restore", 1);
    expect(restored.public_details).toEqual(details);
    expect(new Set([first, cleared, restored].map((row) => row.public_details_revision)).size).toBe(3);
  });

  it("仅凭运营人员自报不能重发结果未知的通知", async () => {
    const { DeliveryConsentRepository } = await import("../src/merchant-core/customer-delivery/consent-repository.js");
    const { CustomerDeliveryRepository } = await import("../src/merchant-core/customer-delivery/repository.js");
    const now = () => FIXED_NOW.toISOString();
    options.deliveryConsent = new DeliveryConsentRepository({ db: operationsDb, now });
    options.customerDeliveries = new CustomerDeliveryRepository({ db: operationsDb, now });
    try {
      const response = await call("POST", "/merchant/api/v1/delivery/unknown/example/retry", {
        ...await login("owner"),
        body: { verified_not_executed: true, channel_idempotent: true },
      });
      expect(response.status).toBe(409);
    } finally {
      delete options.deliveryConsent;
      delete options.customerDeliveries;
    }
  });

  it("拒绝提交基于旧商品表的草稿，保留先前导入", async () => {
    const auth = await login("owner");
    const existing = loadProductTableSnapshot(productsFile, MERCHANT).records.map((row) => row.sku);
    const table = productTable();
    const rows = table.products as Array<Record<string, unknown>>;
    const draft = (sku: string) => call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: {
        table: { ...table, products: [{ ...rows[0], sku }] },
        idempotency_key: `draft-${sku}`,
      },
    });
    const first = await draft("FIRST");
    const second = await draft("SECOND");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const commit = (id: unknown, digest: unknown, key: string) => call(
      "POST", `/merchant/api/products/import-drafts/${String(id)}/commit`,
      { ...auth, body: { expected_draft_digest: digest, idempotency_key: key } },
    );
    expect((await commit(first.json["draft_id"], first.json["digest"], "commit-first")).status).toBe(200);
    expect((await commit(second.json["draft_id"], second.json["digest"], "commit-second")).status).toBe(409);
    expect(loadProductTableSnapshot(productsFile, MERCHANT).records.map((row) => row.sku)).toEqual([...existing, "FIRST"]);
  });

  it("同一文件内重复 SKU 整批拒绝（400）", async () => {
    const auth = await login("owner");
    const row = {
      sku: "SKU-DUP",
      title: "重复商品",
      currency: "CNY",
      unit: "piece",
      price: 10,
      updated_at: "2026-09-21T10:00:00Z",
      valid_until: "2099-01-01T00:00:00Z",
      status: "active",
    };
    const dupe = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: { table: productTable({ products: [row, row] }), idempotency_key: "dup" },
    });
    expect(dupe.status).toBe(400);
    expect(String(dupe.json["message"])).toContain("重复 SKU");
  });

  it("行级校验失败整表拒绝（400 报行号）；base_digest 不符 → 409；租户不符 → 403", async () => {
    const auth = await login("owner");
    const badRow = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: {
        table: productTable({
          products: [
            {
              sku: "S",
              title: "t",
              currency: "CNY",
              unit: "piece",
              price: "abc",
              updated_at: "2026-09-21T09:00:00Z",
              valid_until: "2099-01-01T00:00:00Z",
              status: "active",
            },
          ],
        }),
        idempotency_key: "bad",
      },
    });
    expect(badRow.status).toBe(400);
    expect(String(badRow.json["message"])).toContain("price");
    const draft = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: { table: productTable(), base_digest: "sha256:stale", idempotency_key: "cas" },
    });
    expect(draft.status).toBe(409);
    expect(draft.json["code"]).toBe("precondition_changed");
    const foreign = await call("POST", "/merchant/api/products/import-drafts", {
      ...auth,
      body: { table: productTable({ merchant_id: "merchant-999" }), idempotency_key: "tn" },
    });
    expect(foreign.status).toBe(403);
  });
});

describe("merchant management api — 策略草稿（BD-03，红线 6）", () => {
  it("草稿响应不含敏感原文；提交回执只有版本与摘要；原文可复用提交", async () => {
    const owner = await login("owner");
    const patch = { floor_overrides: { "SKU-1": 80 } };
    const draft = await call("POST", "/merchant/api/policy/drafts", {
      ...owner,
      body: { patch, expected_policy_revision: 3 },
    });
    expect(draft.status).toBe(200);
    const draftText = JSON.stringify(draft.json);
    // 泄漏探针必须是结构化形态（JSON 键名 / JSON 值）：响应里的 draft_id 是
    // 随机 hex、digest 是 sha256 hex——子串 "80" 恰好出现在其中是 ~7% 概率的
    // 正常事件（CI 实测踩中），不是补丁内容泄漏。红线 6 禁止的是补丁的键与
    // 值作为数据出现在响应里。
    expect(draftText.includes('"floor_overrides"')).toBe(false);
    expect(draftText.includes('": 80')).toBe(false);
    expect(draftText.includes('"80"')).toBe(false);
    const committed = await call(
      "POST",
      `/merchant/api/policy/drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...owner,
        body: { expected_draft_digest: draft.json["digest"], idempotency_key: "pc1" },
      },
    );
    expect(committed.status).toBe(200);
    expect(committed.json["result_revision"]).toBe(4);
    expect(policyApplyMock).toHaveBeenCalledWith(patch);
    const receiptText = JSON.stringify(committed.json);
    expect(receiptText.includes('"floor_overrides"')).toBe(false);
  });

  it("apply 校验失败 → 400 且草稿保留可重试；提交状态互斥", async () => {
    const owner = await login("owner");
    policyApplyMock.mockRejectedValue(new Error("策略补丁字段不合法"));
    const draft = await call("POST", "/merchant/api/policy/drafts", {
      ...owner,
      body: { patch: { bad: true } },
    });
    const failed = await call(
      "POST",
      `/merchant/api/policy/drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...owner,
        body: { expected_draft_digest: draft.json["digest"], idempotency_key: "pf1" },
      },
    );
    expect(failed.status).toBe(400);
    policyApplyMock.mockImplementation(async () => ({ version: 5, digest: "sha256:v5" }));
    const retry = await call(
      "POST",
      `/merchant/api/policy/drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...owner,
        body: { expected_draft_digest: draft.json["digest"], idempotency_key: "pf2" },
      },
    );
    expect(retry.status).toBe(200);
    expect(retry.json["result_revision"]).toBe(5);
    const again = await call(
      "POST",
      `/merchant/api/policy/drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...owner,
        body: { expected_draft_digest: draft.json["digest"], idempotency_key: "pf3" },
      },
    );
    expect(again.status).toBe(409);
  });

  it("SKU 规则表单：与当前 per-SKU map 合并，保留未列出的 SKU", async () => {
    const owner = await login("owner");
    const draft = await call("POST", "/merchant/api/v1/policy/form-drafts", {
      ...owner,
      body: {
        sku_rules: [
          { sku: "SKU-NEW", discount: 5, floor: 65 },
          { sku: "SKU-OLD", discount: 3 },
        ],
      },
    });
    expect(draft.status).toBe(200);
    expect((draft.json["applied_keys"] as string[]).sort()).toEqual([
      "price_floors",
      "sku_max_discount_percent",
    ]);
    const committed = await call(
      "POST",
      `/merchant/api/policy/drafts/${String(draft.json["draft_id"])}/commit`,
      {
        ...owner,
        body: { expected_draft_digest: draft.json["digest"], idempotency_key: "sku1" },
      },
    );
    expect(committed.status).toBe(200);
    expect(policyApplyMock).toHaveBeenLastCalledWith({
      price_floors: { "SKU-OLD": 10, "SKU-NEW": 65 },
      sku_max_discount_percent: { "SKU-OLD": 3, "SKU-NEW": 5 },
    });
  });
});

describe("merchant management page — 同源工作台壳（BD-03）", () => {
  it("GET /merchant/ 返回静态壳：含工作台文案，不含业务数据与敏感词", async () => {
    const router = createCloudRouter({
      a2aHandler: (_req, res) => {
        res.end();
      },
      merchantHandler: (_req, res) => {
        res.end();
      },
      merchantHomePage: (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderMerchantManagementPage());
      },
      readiness: async () => ({ ready: true, checks: {}, checked_at: FIXED_NOW.toISOString() }),
      version: "test",
    });
    const pageServer = createServer(router);
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = pageServer.address();
      const pageBase =
        "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
      const res = await fetch(pageBase + "/merchant/");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("商家工作台");
      expect(html).toContain("/merchant/api/session");
      expect(html).toContain('var API = "/merchant/api/v1"');
      expect(html).toContain("application/problem+json");
      expect(html).toContain("pf-sku-rules");
      expect(html).toContain("addSkuRuleRow");
      expect(html).toContain("recovery_action");
      expect(html).toContain("x-csrf-token");
      expect(html).toContain("/merchant/trusted/confirm?ref=");
      expect(html).not.toContain('call("GET", "/status")');
      expect(html).not.toContain('call("GET", "/products")');
      // URL.password 的链接校验不包含口令；禁止的是私有策略字段与口令输入框。
      expect(html).not.toMatch(/price_floors|min_unit_price_private|(?:type|name)=["']password/);
      // 别名仍生效：/merchant/ 之外的商家面路径走 merchantHandler（测试桩 → 2xx），
      // 这里只验证路由不崩、不落入管理页。
      const aliased = await fetch(pageBase + "/merchant/onboarding", { redirect: "manual" });
      expect(aliased.status).toBeLessThan(500);
    } finally {
      pageServer.closeAllConnections();
      await new Promise<void>((resolve) => pageServer.close(() => resolve()));
    }
  });
});

describe("Workbench /merchant/api/v1 — WP12 表格导入（CSV/xlsx 解析与模板）", () => {
  const TEMPLATE_HEADER = "sku,title,currency,unit,price,valid_until";
  const TEMPLATE_ROW = "T-1,测试商品,CNY,个,9.9,2027-12-31";
  const TEMPLATE_CSV = `${TEMPLATE_HEADER}\n${TEMPLATE_ROW}`;

  it("GET /products/import-template 未登录 401；登录后返回 CSV 模板（含双写表头与示例行）", async () => {
    const anon = await fetch(`${base}/merchant/api/v1/products/import-template?format=csv`);
    expect(anon.status).toBe(401);

    const auth = await login("owner");
    const res = await fetch(`${base}/merchant/api/v1/products/import-template?format=csv`, {
      headers: { cookie: auth.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("kiwi-product-import-template.csv");
    const raw = new Uint8Array(await res.arrayBuffer());
    // BOM：Excel 直接打开不乱码（fetch 的 res.text() 会剥 BOM，故按字节验证）
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
    const text = new TextDecoder().decode(raw);
    expect(text).toContain("商品编号/sku");
    expect(text).toContain("DEMO-001");
  });

  it("GET /products/import-template?format=xlsx 返回可解析的 xlsx；其他 format 拒绝", async () => {
    const auth = await login("owner");
    const res = await fetch(`${base}/merchant/api/v1/products/import-template?format=xlsx`, {
      headers: { cookie: auth.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x50); // PK 魔数
    expect(bytes[1]).toBe(0x4b);

    const bad = await fetch(`${base}/merchant/api/v1/products/import-template?format=tsv`, {
      headers: { cookie: auth.cookie },
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("POST /products/import-parse 转换 CSV：返回商品表与映射报告；runtime_owner_id 来自服务端", async () => {
    const auth = await login("owner");
    const res = await fetch(`${base}/merchant/api/v1/products/import-parse?format=csv`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv", "x-csrf-token": auth.csrf },
      body: `\ufeff${TEMPLATE_CSV}`,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
    const table = json["table"] as Record<string, unknown>;
    expect(table["runtime_owner_id"]).toBe(MERCHANT);
    expect(table["merchant_id"]).toBeUndefined();
    expect((table["products"] as unknown[]).length).toBe(1);
    const report = json["report"] as Record<string, unknown>;
    expect(report["rows"]).toBe(1);
  });

  it("POST /products/import-parse 拒绝含成本列的表（COST_COLUMN），且不返回 table", async () => {
    const auth = await login("owner");
    const csv = `${TEMPLATE_HEADER},底价\n${TEMPLATE_ROW},5.5`;
    const res = await fetch(`${base}/merchant/api/v1/products/import-parse?format=csv`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv", "x-csrf-token": auth.csrf },
      body: csv,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(false);
    expect(json["table"]).toBeUndefined();
    const errors = json["errors"] as Array<Record<string, unknown>>;
    expect(errors.some((e) => e["code"] === "COST_COLUMN")).toBe(true);
  });

  it("POST /products/import-parse 校验 CSRF 与 format 参数", async () => {
    const auth = await login("owner");
    const noCsrf = await fetch(`${base}/merchant/api/v1/products/import-parse?format=csv`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv" },
      body: TEMPLATE_CSV,
    });
    expect(noCsrf.status).toBe(403);

    const badFormat = await fetch(`${base}/merchant/api/v1/products/import-parse?format=pdf`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "text/csv", "x-csrf-token": auth.csrf },
      body: "x",
    });
    expect(badFormat.status).toBe(422);
  });

  it("POST /products/import-parse 接受服务端生成的 xlsx 模板并完成整链：parse → import-drafts 预览", async () => {
    const auth = await login("owner");
    const template = await fetch(`${base}/merchant/api/v1/products/import-template?format=xlsx`, {
      headers: { cookie: auth.cookie },
    });
    const bytes = new Uint8Array(await template.arrayBuffer());

    const parsed = await fetch(`${base}/merchant/api/v1/products/import-parse?format=xlsx`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        origin: ORIGIN,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x-csrf-token": auth.csrf,
      },
      body: bytes,
    });
    expect(parsed.status).toBe(200);
    const parseJson = (await parsed.json()) as Record<string, unknown>;
    expect(parseJson["ok"]).toBe(true);

    const draft = await call("POST", "/merchant/api/v1/products/import-drafts", {
      cookie: auth.cookie,
      csrf: auth.csrf,
      origin: ORIGIN,
      body: { table: parseJson["table"] },
    });
    expect(draft.status).toBe(200);
    expect(draft.json["preview"]).toMatchObject({ rows_total: 2, added: 2 });
  });
});


it("marks initial collection setup without reinterpreting older audit flags", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE alipay_collection_audit_changes (
      version TEXT PRIMARY KEY, recipient_changed INTEGER, account_changed INTEGER, qr_changed INTEGER
    ); INSERT INTO alipay_collection_audit_changes VALUES ('legacy-version', 1, 1, 0)`);
    const store = new AlipayCollectionStore(db, "fixture-merchant");
    const config = { enabled: true, recipient: "测试收款人", account: "test@example.invalid" };
    const first = store.replace(null, config, "owner", "2026-11-23T00:00:00Z");
    const second = store.replace(first.version, { ...config, enabled: false }, "owner", "2026-11-23T00:01:00Z");
    const audit = db.prepare("SELECT * FROM alipay_collection_audit_changes WHERE version = ?");
    expect(audit.get(first.version)).toMatchObject({ initial: 1, recipient_changed: 1, account_changed: 1, qr_changed: 0 });
    expect(audit.get(second.version)).toMatchObject({ initial: 0, recipient_changed: 0, account_changed: 0, qr_changed: 0 });
    expect(audit.get("legacy-version")).toMatchObject({ initial: null, recipient_changed: 1, account_changed: 1, qr_changed: 0 });
  } finally { db.close(); }
});
