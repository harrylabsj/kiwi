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
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import type { MerchantRole } from "../src/merchant/application/actor.js";
import type { WriteApprovalCandidate } from "../src/agent/merchant/action-candidate.js";

import { commitProductTable, loadProductTableSnapshot } from "../src/cloud/product-source.js";
import {
  createMerchantManagementApiHandler,
  type MerchantManagementApiOptions,
} from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";

import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";

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

const options: MerchantManagementApiOptions = {
  merchantId: MERCHANT,
  generation: () => 1,
  runtimeVersion: "test-runtime",
  sessions,
  allowedOrigins: [ORIGIN],
  listPending: () => candidates,
  mintCandidateConfirmation: (input) => mintCandidateConfirmation(input),
  executeDecision: async (input) => {
    await executeDecision(input);
    candidates = candidates.filter((item) => item.candidate_id !== input.candidateId);
  },
  policy: () => ({ version: 3, digest: "sha256:policy" }),
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

async function _mintApprovalConfirmation(
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


afterEach(()=>{options.allowedOrigins=[ORIGIN];options.quotePreview=undefined;options.webauthnRegistration=undefined;});
it("A387 preview POST retains session/read permission and requires CSRF even without Origin",async()=>{let computed=0;options.quotePreview=async()=>{computed++;return {status:"approval_required",reason:"invalid_promotion",calculator_version:"kiwi-quote/1"};};const auth=await login("viewer");for(const req of [{},{cookie:auth.cookie},{...auth,csrf:"bad"},{...auth,origin:"https://evil.example"}]){const r=await call("POST","/merchant/api/v1/pricing/previews",{...req,body:{sku:"SKU",quantity:1}});expect([401,403]).toContain(r.status);}expect(computed).toBe(0);expect((await call("POST","/merchant/api/v1/pricing/previews",{...auth,body:{sku:"SKU",quantity:1}})).status).toBe(200);expect(computed).toBe(1);});
it("A387 optional Origin allowlist never replaces session-bound CSRF",async()=>{options.allowedOrigins=undefined;let computed=0;options.quotePreview=async()=>{computed++;return {status:"approval_required",reason:"invalid_promotion",calculator_version:"kiwi-quote/1"};};const auth=await login();expect((await call("POST","/merchant/api/v1/pricing/previews",{cookie:auth.cookie,origin:"https://any.example",body:{sku:"SKU",quantity:1}})).status).toBe(403);expect((await call("POST","/merchant/api/v1/pricing/previews",{...auth,origin:"https://any.example",body:{sku:"SKU",quantity:1}})).status).toBe(200);expect(computed).toBe(1);});
it("A387 configured HTTP confirmation explains HTTPS early while ordinary session remains available",async()=>{const auth=await login(),authorize=vi.fn(async()=>true);options.webauthnRegistration={origin:"http://localhost:9000",rpName:"test",rpId:"localhost",authorize};expect((await call("GET","/merchant/api/session",{cookie:auth.cookie})).status).toBe(200);const r=await call("POST","/merchant/api/v1/webauthn/registrations/options",auth);expect(JSON.stringify(r.json)).toMatch(/HTTPS/);expect(JSON.stringify(r.json)).toMatch(/CONFIRMATION_CHANNEL_UNAVAILABLE/);expect(authorize).not.toHaveBeenCalled();});
it("A387 cloud-style sole HTTP public Origin provides same confirmation capability prompt",async()=>{const auth=await login();options.allowedOrigins=["http://localhost:9000"];const r=await call("POST","/merchant/api/v1/webauthn/registrations/options",auth);expect(JSON.stringify(r.json)).toMatch(/HTTPS/);});
