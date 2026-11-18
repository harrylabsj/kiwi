/**
 * TOP1 M2：商家纠正入口（Workbench v1 HTTP）。
 * 认证主体注入、learning:read/manage 授权、纠正提交/提升、幂等与预检错误映射。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";

import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { openMerchantOperationsFacade } from "../src/merchant-core/ops/facade.js";
import { MerchantOperationsSurface } from "../src/merchant-core/ops/surface.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";
import type {
  EvaluationRunner,
  EvaluationSuite,
} from "../src/merchant-core/learning/evaluation.js";

import { parseGovernanceFeatureFlags } from "../src/merchant-core/context-governance/feature-flags.js";
import { GovernanceRuntimeError, initializeGovernanceRuntime } from "../src/merchant-core/ownership/runtime.js";

const MERCHANT = "merchant-learning";
const ORIGIN = "https://merchant.example";
const NOW = "2026-11-17T00:00:00.000Z";

const db = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: new DatabaseSync(":memory:"), now: () => NOW });
const operations = new MerchantManagementOperationStore({ db: new DatabaseSync(":memory:"), now: () => NOW });
const drafts = new MerchantImportDraftStore({ db: new DatabaseSync(":memory:"), now: () => NOW });
const serviceState = new MutableServiceState("OPERATING");
const facade = openMerchantOperationsFacade({ db, merchantId: MERCHANT, now: () => NOW });
const merchantOperations = new MerchantOperationsSurface({ facade, now: () => NOW });

let server: Server;
let base: string;
const flags = parseGovernanceFeatureFlags({ learning_enabled: true });
const runtime = initializeGovernanceRuntime({
  db, merchantId: MERCHANT, ownerId: "workbench-test", flags, now: () => NOW,
});

beforeAll(async () => {
  server = createServer(
    createMerchantManagementApiHandler({
      merchantId: MERCHANT,
      generation: () => 1,
      runtimeVersion: "test",
      sessions,
      allowedOrigins: [ORIGIN],
      listPending: () => [],
      mintCandidateConfirmation: () => "unused",
      executeDecision: async () => {},
      drafts,
      operations,
      serviceState,
      merchantOperations,
      governance: { flags, write: (work) => runtime.writeUnderOwnership(work) },
      readiness: async () => ({ ready: true, checks: {} }),
      now: () => new Date(NOW),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = "http://127.0.0.1:" + (typeof address === "object" && address !== null ? address.port : 0);
});

afterAll(async () => {
  runtime.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function login(role: "owner" | "operator" | "viewer", merchantId = MERCHANT) {
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
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts.csrf !== undefined ? { "x-csrf-token": opts.csrf, origin: ORIGIN } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe("商家纠正入口（Workbench v1）", () => {
  it("operator 提交纠正 → 提升案例；列表与详情可读", async () => {
    const operator = await login("operator");
    const created = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...operator,
      body: {
        correction_text: "买家说两箱时先读取商家单位规则，缺少倍率再澄清。",
        issue_tags: ["unit"],
        idempotency_key: "corr-cmd-1",
      },
    });
    expect(created.status).toBe(201);
    const correctionId = String(created.json.correction_id);
    expect(correctionId).toMatch(/^corr_/);
    expect(created.json).toMatchObject({ revision: 1, status: "DRAFT" });

    const promoted = await call(
      "POST",
      `/merchant/api/v1/learning/corrections/${correctionId}/promote`,
      { ...operator, body: { expected_revision: 1 } },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.json).toMatchObject({
      correction_id: correctionId,
      status: "ACTIVE",
      revision: 1,
    });

    const list = await call("GET", "/merchant/api/v1/learning/corrections", operator);
    expect(list.status).toBe(200);
    expect((list.json.corrections as unknown[]).length).toBe(1);
    const detail = await call(
      "GET",
      `/merchant/api/v1/learning/corrections/${correctionId}`,
      operator,
    );
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ correction_id: correctionId, status: "CASE_CREATED" });
  });

  it("viewer 只读：可读列表，提交/提升 403", async () => {
    const viewer = await login("viewer");
    const list = await call("GET", "/merchant/api/v1/learning/corrections", viewer);
    expect(list.status).toBe(200);
    const submit = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...viewer,
      body: { correction_text: "抽象流程" },
    });
    expect(submit.status).toBe(403);
  });

  it("敏感正文预检拒绝映射为 422，且不落纠正", async () => {
    const operator = await login("operator");
    const before = (await call("GET", "/merchant/api/v1/learning/corrections", operator)).json
      .corrections as unknown[];
    const rejected = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...operator,
      body: { correction_text: "联系电话 13800138000" },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.json).toMatchObject({ code: "VALIDATION_ERROR" });
    const after = (await call("GET", "/merchant/api/v1/learning/corrections", operator)).json
      .corrections as unknown[];
    expect(after.length).toBe(before.length);
  });

  it("command_id 幂等：同键同内容返回原纠正；异内容 409", async () => {
    const operator = await login("operator");
    const body = { correction_text: "幂等抽象流程", idempotency_key: "corr-cmd-idem" };
    const first = await call("POST", "/merchant/api/v1/learning/corrections", { ...operator, body });
    const replay = await call("POST", "/merchant/api/v1/learning/corrections", { ...operator, body });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.json.correction_id).toBe(first.json.correction_id);
    const conflict = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...operator,
      body: { correction_text: "另一个流程", idempotency_key: "corr-cmd-idem" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("候选入口：形成草稿/读取/编辑；viewer 不可写", async () => {
    const operator = await login("operator");
    const correction = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...operator,
      body: { correction_text: "候选入口的抽象流程", issue_tags: ["unit"] },
    });
    const correctionId = String(correction.json.correction_id);
    const promoted = await call(
      "POST",
      `/merchant/api/v1/learning/corrections/${correctionId}/promote`,
      { ...operator, body: { expected_revision: 1 } },
    );
    const caseId = String(promoted.json.case_id);

    const created = await call("POST", "/merchant/api/v1/learning/candidates", {
      ...operator,
      body: {
        case_ids: [caseId],
        skill_key: "trial-unit-clarification",
        trigger: "单位不明确时先读取商家单位规则",
        proposed_steps: [
          { action_ref: "get_commercial_facts" },
          {
            action_ref: "ask_registered_question",
            question_id: "q_unit_mismatch_v1",
            guard_ref: "unit_unresolved",
          },
        ],
        reason: "避免把箱按件处理",
        idempotency_key: "cand-api-1",
      },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ revision: 1, state: "DRAFT" });
    const candidateId = String(created.json.candidate_id);

    const list = await call("GET", "/merchant/api/v1/learning/candidates", operator);
    expect(list.status).toBe(200);
    expect((list.json.candidates as unknown[]).length).toBe(1);
    const detail = await call(
      "GET",
      `/merchant/api/v1/learning/candidates/${candidateId}`,
      operator,
    );
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ candidate_id: candidateId, state: "DRAFT" });

    const revised = await call(
      "POST",
      `/merchant/api/v1/learning/candidates/${candidateId}/revise`,
      {
        ...operator,
        body: {
          expected_revision: 1,
          case_ids: [caseId],
          skill_key: "trial-unit-clarification",
          trigger: "修订后的触发说明",
          proposed_steps: [{ action_ref: "search_products" }],
          reason: "修订后的原因",
        },
      },
    );
    expect(revised.status).toBe(200);
    expect(revised.json).toMatchObject({ revision: 2, state: "DRAFT" });

    const viewer = await login("viewer");
    const denied = await call("POST", "/merchant/api/v1/learning/candidates", {
      ...viewer,
      body: {
        case_ids: [caseId],
        skill_key: "trial-unit-clarification",
        trigger: "viewer 不应能写",
        proposed_steps: [{ action_ref: "get_commercial_facts" }],
        reason: "越权",
      },
    });
    expect(denied.status).toBe(403);
  });

  it("审核/发布/撤回入口：owner 可审核发布，operator 无审核权", async () => {
    const owner = await login("owner");
    const operator = await login("operator");
    const correction = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...operator,
      body: { correction_text: "审核发布链路的抽象流程" },
    });
    const correctionId = String(correction.json.correction_id);
    const promoted = await call(
      "POST",
      `/merchant/api/v1/learning/corrections/${correctionId}/promote`,
      { ...operator, body: { expected_revision: 1 } },
    );
    const caseId = String(promoted.json.case_id);
    const created = await call("POST", "/merchant/api/v1/learning/candidates", {
      ...operator,
      body: {
        case_ids: [caseId],
        skill_key: "trial-unit-clarification",
        trigger: "单位不明确时先读取单位规则",
        proposed_steps: [{ action_ref: "get_commercial_facts" }],
        reason: "避免误换算",
      },
    });
    const candidateId = String(created.json.candidate_id);
    const contentHash = String(created.json.compiled_artifact_hash);

    // 评测由隔离 worker 执行（API 不直接跑模型）。
    const suite: EvaluationSuite = {
      suite_version: "suite-api",
      scenarios: [
        ...Array.from({ length: 8 }, (_, index) => ({
          scenario_id: `target-${index}`,
          kind: "target" as const,
          input: { index },
        })),
        ...Array.from({ length: 6 }, (_, index) => ({
          scenario_id: `adjacent-${index}`,
          kind: "adjacent" as const,
          input: { index },
        })),
        ...Array.from({ length: 6 }, (_, index) => ({
          scenario_id: `boundary-${index}`,
          kind: "boundary" as const,
          input: { index },
        })),
      ],
    };
    const runner: EvaluationRunner = ({ variant }) => ({
      passed: true,
      hard_gate_failures: 0,
      ...(variant === "candidate" ? { improvement_delta: 1 } : {}),
    });
    const evaluation = await facade.learning.evaluateCandidate({
      merchant_id: MERCHANT,
      actor: createActorContext({
        merchant_id: MERCHANT,
        actor_id: "admin:merchant-learning",
        auth_strength: "session",
        subject_binding: "organization",
        capabilities: ["learning:manage"],
      }),
      candidate_id: candidateId,
      content_hash: contentHash,
      suite,
      runner,
    });
    expect(evaluation.state).toBe("READY_FOR_REVIEW");

    const denied = await call(
      "POST",
      `/merchant/api/v1/learning/candidates/${candidateId}/review`,
      {
        ...operator,
        body: {
          content_hash: contentHash,
          evaluation_id: evaluation.evaluation_id,
          decision: "approve",
        },
      },
    );
    expect(denied.status).toBe(403);

    const review = await call(
      "POST",
      `/merchant/api/v1/learning/candidates/${candidateId}/review`,
      {
        ...owner,
        body: {
          content_hash: contentHash,
          evaluation_id: evaluation.evaluation_id,
          decision: "approve",
        },
      },
    );
    expect(review.status).toBe(200);
    const approvalRef = String(review.json.approval_ref);

    const published = await call("POST", "/merchant/api/v1/learning/releases/publish", {
      ...owner,
      body: { approval_ref: approvalRef, expected_generation: 0 },
    });
    expect(published.status).toBe(201);
    expect(published.json).toMatchObject({ generation: 1, state: "ACTIVE" });
    const releaseId = String(published.json.release_id);

    const active = await call(
      "GET",
      "/merchant/api/v1/learning/releases/active?skill_key=trial-unit-clarification",
      owner,
    );
    expect(active.status).toBe(200);
    expect(active.json.release_id).toBe(releaseId);

    const revoked = await call(
      "POST",
      `/merchant/api/v1/learning/releases/${releaseId}/revoke`,
      { ...owner, body: { expected_generation: 1, reason: "撤回测试" } },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.json).toMatchObject({ state: "REVOKED", revocation_epoch: 1 });
    const gone = await call(
      "GET",
      "/merchant/api/v1/learning/releases/active?skill_key=trial-unit-clarification",
      owner,
    );
    expect(gone.status).toBe(404);
  });

  it("跨商家会话不能写入本实例商家域（统一 404，不泄露存在性）", async () => {
    const foreign = await login("owner", "merchant-other");
    const attempt = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...foreign,
      body: { correction_text: "抽象流程" },
    });
    // 适配层先按会话 merchant 拦截（404）；服务层另有 actor_merchant_mismatch
    // 的 defense-in-depth（见 learning-corrections.test.ts）。
    expect(attempt.status).toBe(404);
  });

  it("要求审核权限与 CSRF，并仅接受可信核验结果", async () => {
    const owner = await login("owner");
    const operator = await login("operator");
    const correction = await call("POST", "/merchant/api/v1/learning/corrections", { ...operator, body: { correction_text: "恢复路径测试" } });
    const promoted = await call("POST", `/merchant/api/v1/learning/corrections/${String(correction.json.correction_id)}/promote`, { ...operator, body: { expected_revision: 1 } });
    const candidate = await call("POST", "/merchant/api/v1/learning/candidates", { ...operator, body: {
      case_ids: [promoted.json.case_id], skill_key: "recovery-test", trigger: "测试触发", proposed_steps: [{ action_ref: "get_commercial_facts" }], reason: "测试恢复",
    } });
    expect(candidate.status, JSON.stringify(candidate.json)).toBe(201);
    const suite: EvaluationSuite = { suite_version: "recovery-suite", scenarios: [
      ...Array.from({ length: 8 }, (_, index) => ({ scenario_id: `t-${index}`, kind: "target" as const, input: { index } })),
      ...Array.from({ length: 6 }, (_, index) => ({ scenario_id: `a-${index}`, kind: "adjacent" as const, input: { index } })),
      ...Array.from({ length: 6 }, (_, index) => ({ scenario_id: `b-${index}`, kind: "boundary" as const, input: { index } })),
    ] };
    await expect(facade.learning.evaluateCandidate({ merchant_id: MERCHANT, actor: createActorContext({ merchant_id: MERCHANT, actor_id: "operator", auth_strength: "verified", subject_binding: "organization", capabilities: ["learning:manage"] }), candidate_id: String(candidate.json.candidate_id), content_hash: String(candidate.json.compiled_artifact_hash), suite, runner: async () => { throw new Error("uncertain"); } })).rejects.toThrow();
    const evaluationId = facade.learning.listEvaluations(MERCHANT).find((item) => item.candidate_id === candidate.json.candidate_id)!.evaluation_id;
    const path = `/merchant/api/v1/learning/evaluations/${evaluationId}/recovery`;
    expect((await call("GET", path)).status).toBe(401);
    expect((await call("GET", path, operator)).status).toBe(403);
    const pending = await call("GET", path, owner);
    expect(pending.status).toBe(200);
    const binding = pending.json.binding as { dispatch_id: string };
    const body = { evidence_ref: "receipt-1", expected_dispatch_id: binding.dispatch_id, command_id: "recovery-1" };
    expect((await call("POST", path, { cookie: owner.cookie, body })).status).toBe(403);
    expect((await call("POST", path, { ...owner, body: { ...body, outcome: { passed: true } } })).status).toBe(422);
    expect((await call("POST", path, { ...owner, body })).status).toBe(409);

    let calls = 0;
    let ownershipLost = false;
    const trustedFacade = openMerchantOperationsFacade({ db, merchantId: MERCHANT, now: () => NOW,
      recoveryWriteGuard: (work) => {
        if (ownershipLost) throw new GovernanceRuntimeError("not_acquired", "ownership lost");
        return runtime.writeUnderOwnership(work);
      },
      recoveryVerifier: async (actual) => { calls++; return { status: "completed", binding: actual, outcome: { passed: true, hard_gate_failures: 0 } }; },
    });
    const trustedServer = createServer(createMerchantManagementApiHandler({ merchantId: MERCHANT, generation: () => 1, runtimeVersion: "test", sessions,
      allowedOrigins: [ORIGIN], listPending: () => [], mintCandidateConfirmation: () => "unused", executeDecision: async () => {}, drafts, operations, serviceState,
      merchantOperations: new MerchantOperationsSurface({ facade: trustedFacade }), governance: { flags, write: (work) => runtime.writeUnderOwnership(work) }, readiness: async () => ({ ready: true, checks: {} }), now: () => new Date(NOW),
    }));
    await new Promise<void>((resolve) => trustedServer.listen(0, "127.0.0.1", resolve));
    const address = trustedServer.address();
    const trustedBase = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    try {
      const session = await fetch(`${trustedBase}/merchant/api/session`, { headers: { cookie: owner.cookie } });
      const { csrf_token: csrf } = await session.json() as { csrf_token: string };
      const post = async (payload: unknown) => fetch(trustedBase + path, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": csrf, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(payload) });
      expect((await post({ ...body, expected_dispatch_id: "wrong" })).status).toBe(409);
      ownershipLost = true;
      expect((await post(body)).status).toBe(409);
      ownershipLost = false;
      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);
      expect((await post({ ...body, evidence_ref: "other" })).status).toBe(409);
      expect(calls).toBe(1);
      expect((await call("GET", path, owner)).json.pending).toBeNull();
    } finally {
      trustedServer.closeAllConnections();
      await new Promise<void>((resolve) => trustedServer.close(() => resolve()));
    }
  });

  it("运行期失去治理所有权：学习写 409，读仍可用", async () => {
    const operator = await login("operator");
    db.prepare("UPDATE instance_ownership SET lease_expires_at = ? WHERE merchant_id = ?")
      .run(NOW, MERCHANT);
    const write = await call("POST", "/merchant/api/v1/learning/corrections", {
      ...operator,
      body: {
        correction_text: "失去所有权后不应落库。",
        idempotency_key: "corr-lost-owner",
      },
    });
    expect(write.status).toBe(409);
    const list = await call("GET", "/merchant/api/v1/learning/corrections", operator);
    expect(list.status).toBe(200);
  });
});
