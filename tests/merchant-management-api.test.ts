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
import { DatabaseSync } from "node:sqlite";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import type { MerchantRole } from "../src/merchant/application/actor.js";
import type { WriteApprovalCandidate } from "../src/agent/merchant/action-candidate.js";
import {
  createMerchantManagementApiHandler,
  type MerchantManagementApiOptions,
} from "../src/http/merchant-management/api.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";

const FIXED_NOW = new Date("2026-09-21T10:00:00Z");
const MERCHANT = "merchant-001";
const ORIGIN = "https://merchant.example";

const sessionsDb = new DatabaseSync(":memory:");
const operationsDb = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: sessionsDb });
const operations = new MerchantManagementOperationStore({ db: operationsDb, now: () => FIXED_NOW.toISOString() });
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
  base =
    "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
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
  mintCounter = 0;
  executeDecision.mockReset();
  executeDecision.mockImplementation(async () => {});
  mintCandidateConfirmation.mockClear();
  readiness.mockReset();
  readiness.mockImplementation(async () => ({ ready: true, checks: {} }));
});

async function login(role: MerchantRole = "owner", merchantId = MERCHANT): Promise<{ cookie: string; csrf: string }> {
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
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
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
      body: { candidate_id: "act_1", action: "approve", arguments_hash: "sha256:args", preconditions_hash: "sha256:pre" },
    });
    expect(missing.status).toBe(403);
    const wrong = await call("POST", "/merchant/api/confirmations", {
      cookie: auth.cookie,
      csrf: "definitely-wrong",
      body: { candidate_id: "act_1", action: "approve", arguments_hash: "sha256:args", preconditions_hash: "sha256:pre" },
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
      body: { candidate_id: "act_1", action: "approve", arguments_hash: "sha256:args", preconditions_hash: "sha256:pre" },
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
    const queried = await call("GET", `/merchant/api/operations/${String(approved.json["operation_id"])}`, auth);
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
      body: { expected_service_revision: serviceState.serviceRevision, reason: "维护", idempotency_key: "p1" },
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
  });

  it("未知路径 404；已知路径错误方法 405", async () => {
    const auth = await login("owner");
    expect((await call("GET", "/merchant/api/nope", auth)).status).toBe(404);
    expect((await call("GET", "/merchant/api/confirmations", auth)).status).toBe(405);
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
