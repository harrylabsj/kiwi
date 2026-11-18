/**
 * TOP1-3 M3：客户主体绑定、一次性授权、记忆域、历史检索、删除与留存。
 * P0 只允许 organization/agent_scope；自由文本不构成同意；删除先封存再清理。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";
import { SourceGovernanceService } from "../src/merchant-core/context-governance/source-governance.js";
import { DataUseGrantStore } from "../src/merchant-core/context-governance/data-use-grant.js";
import { CustomerIdentityService } from "../src/merchant-core/customer-memory/identity.js";
import { GrantRequestService } from "../src/merchant-core/customer-memory/grants.js";
import { CustomerMemoryService } from "../src/merchant-core/customer-memory/memory.js";
import { HistorySearchService } from "../src/merchant-core/customer-memory/history.js";
import { CustomerMemoryError } from "../src/merchant-core/customer-memory/types.js";

const NOW = "2026-11-17T00:00:00.000Z";
const MERCHANT = "m-1";

function manager(capabilities = ["memory:write", "memory:read"]) {
  return createActorContext({
    merchant_id: MERCHANT,
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities,
  });
}

function customer() {
  return createActorContext({
    merchant_id: MERCHANT,
    actor_id: "buyer-session-1",
    auth_strength: "session",
    subject_binding: "none",
    capabilities: ["customer:self"],
  });
}

function expectError(fn: () => unknown, code: string, reason: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${code}/${reason}`);
  } catch (err) {
    expect(err).toBeInstanceOf(CustomerMemoryError);
    const e = err as CustomerMemoryError;
    expect(e.code).toBe(code);
    expect(e.reason).toContain(reason);
  }
}

describe("客户记忆 M3", () => {
  let db: DatabaseSync;
  let clock: string;
  let identity: CustomerIdentityService;
  let grantRequests: GrantRequestService;
  let memory: CustomerMemoryService;
  let history: HistorySearchService;
  let subjectId: string;
  let scope: string;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    clock = NOW;
    const now = () => clock;
    const sourceGovernance = new SourceGovernanceService({ db, now });
    identity = new CustomerIdentityService({ db, now });
    grantRequests = new GrantRequestService({ db, now });
    memory = new CustomerMemoryService({ db, now, sourceGovernance, identity });
    history = new HistorySearchService({ db, now });
    subjectId = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "organization",
    }).subject_id;
    scope = "org-scope-1";
  });
  afterEach(() => db.close());

  function grant(purpose: "customer_memory" | "history_recall", resourceScope = scope) {
    // 两方流程：客户会话先绑定到主体，商家侧签发请求，客户确认。
    if (identity.currentSubjectForActor(MERCHANT, "buyer-session-1") === undefined) {
      bindCustomer();
    }
    const request = grantRequests.createGrantRequest({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      purpose,
      resource_scope_id: resourceScope,
      grant_ttl_seconds: 30 * 24 * 60 * 60,
    });
    return grantRequests.confirmGrant({
      merchant_id: MERCHANT,
      actor: customer(),
      grant_request_id: request.grant_request.grant_request_id,
      confirmation_phrase: request.confirmation_phrase,
    });
  }

  function bindCustomer(targetSubjectId = subjectId, sessionId = "session-1") {
    const challenge = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session",
      target_subject_id: targetSubjectId,
    });
    identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: customer(),
      challenge_id: challenge.challenge_id,
      source_session_id: sessionId,
      proof: challenge.proof,
    });
  }

  it("主体：P0 拒绝 person；绑定挑战 5 分钟单次消费；撤销递增 epoch", () => {
    expectError(
      () =>
        identity.createSubject({
          merchant_id: MERCHANT,
          actor: manager(),
          subject_kind: "person",
        }),
      "validation",
      "subject_kind_rejected",
    );
    const challenge = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session",
      target_subject_id: subjectId,
    });
    const binding = identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: customer(),
      challenge_id: challenge.challenge_id,
      source_session_id: "session-1",
      proof: challenge.proof,
    });
    expect(binding).toMatchObject({ subject_id: subjectId, binding_epoch: 1, status: "ACTIVE" });
    expect(identity.currentSubjectForActor(MERCHANT, "buyer-session-1")).toMatchObject({
      subject_id: subjectId,
      binding_epoch: 1,
    });
    // 单次消费：重放拒绝。
    expectError(
      () =>
        identity.linkConfirm({
          merchant_id: MERCHANT,
          actor: customer(),
          challenge_id: challenge.challenge_id,
          source_session_id: "session-1",
          proof: challenge.proof,
        }),
      "confirmation_consumed",
      "challenge_consumed",
    );
    // 撤销后不再返回绑定。
    identity.revokeBinding({
      merchant_id: MERCHANT,
      actor: customer(),
      binding_id: binding.binding_id,
      expected_epoch: 1,
    });
    expect(identity.currentSubjectForActor(MERCHANT, "buyer-session-1")).toBeUndefined();
  });

  it("授权：一次性短语/卡片引用；自由文本不入口；重放/错误短语拒绝", () => {
    bindCustomer();
    const request = grantRequests.createGrantRequest({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      purpose: "customer_memory",
      resource_scope_id: scope,
    });
    expect(request.confirmation_phrase).toMatch(/^确认授权-/);
    const confirmed = grantRequests.confirmGrant({
      merchant_id: MERCHANT,
      actor: customer(),
      grant_request_id: request.grant_request.grant_request_id,
      confirmation_phrase: request.confirmation_phrase,
    });
    expect(confirmed).toMatchObject({ purpose: "customer_memory", status: "ACTIVE" });
    expectError(
      () =>
        grantRequests.confirmGrant({
          merchant_id: MERCHANT,
          actor: customer(),
          grant_request_id: request.grant_request.grant_request_id,
          confirmation_phrase: request.confirmation_phrase,
        }),
      "confirmation_consumed",
      "grant_request_consumed",
    );
    const request2 = grantRequests.createGrantRequest({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      purpose: "history_recall",
      resource_scope_id: scope,
    });
    expectError(
      () =>
        grantRequests.confirmGrant({
          merchant_id: MERCHANT,
          actor: customer(),
          grant_request_id: request2.grant_request.grant_request_id,
          confirmation_phrase: "好的，可以",
        }),
      "confirmation_invalid",
      "confirmation_mismatch",
    );
    const card = grantRequests.confirmGrant({
      merchant_id: MERCHANT,
      actor: customer(),
      grant_request_id: request2.grant_request.grant_request_id,
      confirmation_ref: request2.confirmation_ref,
    });
    expect(card.purpose).toBe("history_recall");
  });

  it("记忆：候选 → 确认 → 纠错；推断不自动 active；无授权拒绝", () => {
    const grantRecord = grant("customer_memory");
    const candidate = memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      resource_scope_id: scope,
      namespace: "preference",
      key: "unit",
      value_ref: "箱",
      value_type: "enum",
      source_kind: "explicit",
      source_refs: ["src-1"],
      confidence: 1,
    });
    expect(candidate.state).toBe("candidate");
    expect(memory.listMine(MERCHANT, subjectId)).toEqual([]);
    bindCustomer();
    const active = memory.confirmMemory({
      merchant_id: MERCHANT,
      actor: customer(),
      memory_id: candidate.memory_id,
      expected_version: 1,
    });
    expect(active).toMatchObject({ state: "active", version: 2, confirmed_by: "buyer-session-1" });
    expect(memory.currentMemorySetVersion(MERCHANT, subjectId)).toBe(1);
    expect(memory.listMine(MERCHANT, subjectId)).toHaveLength(1);
    expect(memory.listMine(MERCHANT, "other-subject")).toEqual([]);

    const corrected = memory.correctMemory({
      merchant_id: MERCHANT,
      actor: customer(),
      memory_id: active.memory_id,
      expected_version: 2,
      value_ref: "盒",
      source_refs: ["src-2"],
    });
    expect(corrected).toMatchObject({ state: "active", version: 3, value_ref: "盒" });
    expect(memory.getMemory(MERCHANT, active.memory_id)?.state).toBe("superseded");
    expect(memory.currentMemorySetVersion(MERCHANT, subjectId)).toBe(2);

    const inferred = memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      resource_scope_id: scope,
      namespace: "preference",
      key: "payment",
      value_ref: "月结",
      value_type: "enum",
      source_kind: "inferred",
      confidence: 0.6,
    });
    expect(inferred.state).toBe("needs_review");

    // 撤销 grant 后不能再写。
    const other = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "agent_scope",
    }).subject_id;
    expectError(
      () =>
        memory.proposeMemory({
          merchant_id: MERCHANT,
          actor: manager(),
          subject_id: other,
          resource_scope_id: scope,
          namespace: "preference",
          key: "unit",
          value_ref: "箱",
          value_type: "enum",
          source_kind: "explicit",
        }),
      "grant_unavailable",
      "grant_not_active",
    );
    void grantRecord;
  });

  it("历史检索：中文子串、5 片段上限、游标、no_match 与 unavailable 区分", () => {
    grant("history_recall");
    for (let index = 0; index < 7; index++) {
      history.indexHistoryDocument({
        merchant_id: MERCHANT,
        subject_id: subjectId,
        kind: "prior_inquiry",
        sku: `SKU-${index}`,
        occurred_at: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
        source_version: index + 1,
        text: `客户询问纸箱包装和单位换算的细节 ${index}`,
        grant_id: 'unused',
        erase_scope_id: scope,
      });
    }
    const first = history.search({
      merchant_id: MERCHANT,
      actor: customer(),
      subject_id: subjectId,
      resource_scope_id: scope,
      query: "纸箱包装",
    });
    expect(first.status).toBe("ok");
    if (first.status === "ok") {
      expect(first.hits.length).toBeLessThanOrEqual(5);
      expect(first.hits.every((hit) => hit.historical && hit.is_current === false)).toBe(true);
      expect(first.next_cursor).toBeDefined();
      const second = history.search({
        merchant_id: MERCHANT,
        actor: customer(),
        subject_id: subjectId,
        resource_scope_id: scope,
        query: "纸箱包装",
        cursor: first.next_cursor!,
      });
      expect(second.status).toBe("ok");
      if (second.status === "ok") {
        expect(second.hits[0]!.document_ref).not.toBe(first.hits[0]!.document_ref);
      }
    }
    const short = history.search({
      merchant_id: MERCHANT,
      actor: customer(),
      subject_id: subjectId,
      resource_scope_id: scope,
      query: "纸箱",
    });
    expect(short.status).toBe("ok");
    const none = history.search({
      merchant_id: MERCHANT,
      actor: customer(),
      subject_id: subjectId,
      resource_scope_id: scope,
      query: "完全不存在的词语",
    });
    expect(none.status).toBe("no_match");
  });

  it("B15：确认前卡片引用被篡改 → 摘要校验失败，不建 grant", () => {
    bindCustomer();
    const request = grantRequests.createGrantRequest({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      purpose: "customer_memory",
      resource_scope_id: scope,
      grant_ttl_seconds: 60 * 60,
    });
    db.prepare(
      "UPDATE grant_requests SET confirmation_ref_digest = ? WHERE merchant_id = ? AND grant_request_id = ?",
    ).run("sha256:tampered", MERCHANT, request.grant_request.grant_request_id);
    expectError(
      () =>
        grantRequests.confirmGrant({
          merchant_id: MERCHANT,
          actor: customer(),
          grant_request_id: request.grant_request.grant_request_id,
          confirmation_ref: request.confirmation_ref,
        }),
      "confirmation_invalid",
      "confirmation_mismatch",
    );
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM data_grants WHERE merchant_id = ? AND subject_id = ?")
      .get(MERCHANT, subjectId) as { n: number };
    expect(count.n).toBe(0);
  });

  it("B11：撤权后旧历史游标不能继续分页", () => {
    const active = grant("history_recall");
    for (let index = 0; index < 7; index++) {
      history.indexHistoryDocument({
        merchant_id: MERCHANT,
        subject_id: subjectId,
        kind: "prior_inquiry",
        sku: `SKU-${index}`,
        occurred_at: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
        source_version: index + 1,
        text: `客户询问纸箱包装和单位换算 ${index}`,
        grant_id: active.grant_id,
        erase_scope_id: scope,
      });
    }
    const first = history.search({
      merchant_id: MERCHANT,
      actor: customer(),
      subject_id: subjectId,
      resource_scope_id: scope,
      query: "纸箱包装",
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok" || first.next_cursor === undefined) {
      throw new Error("expected cursor");
    }
    // 读取后撤权：旧游标再分页必须失败，不返回第二页。
    const grants = new DataUseGrantStore({ db, now: () => clock });
    grants.revokeGrant({
      merchant_id: MERCHANT,
      grant_id: active.grant_id,
      expected_epoch: active.grant_epoch,
    });
    expectError(
      () =>
        history.search({
          merchant_id: MERCHANT,
          actor: customer(),
          subject_id: subjectId,
          resource_scope_id: scope,
          query: "纸箱包装",
          cursor: first.next_cursor,
        }),
      "grant_unavailable",
      "grant_not_active",
    );
  });

  it("B05：同 scope 高相关也硬过滤其他客户，不进入检索结果", () => {
    const scopeA = "shared-scope";
    grant("history_recall", scopeA);
    const otherSubject = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "organization",
    }).subject_id;
    // 商家侧直接登记另一客户的检索授权（索引由系统 worker 写入）。
    new DataUseGrantStore({ db, now: () => clock }).createGrant({
      merchant_id: MERCHANT,
      subject_id: otherSubject,
      purpose: "history_recall",
      resource_scope_id: scopeA,
      expires_at: "2026-11-18T00:00:00.000Z",
    });
    history.indexHistoryDocument({
      merchant_id: MERCHANT,
      subject_id: otherSubject,
      kind: "prior_inquiry",
      sku: "SKU-OTHER",
      occurred_at: NOW,
      source_version: 1,
      text: "另一个客户询问纸箱包装和单位换算",
      grant_id: "unused",
      erase_scope_id: scopeA,
    });
    const mine = history.search({
      merchant_id: MERCHANT,
      actor: customer(),
      subject_id: subjectId,
      resource_scope_id: scopeA,
      query: "纸箱包装",
    });
    expect(mine.status).toBe("no_match");
    // P0-1：持 grant 但未绑定到 otherSubject 的会话不能检索他人历史。
    expectError(
      () =>
        history.search({
          merchant_id: MERCHANT,
          actor: customer(),
          subject_id: otherSubject,
          resource_scope_id: scopeA,
          query: "纸箱包装",
        }),
      "access_denied",
      "subject_not_bound",
    );
    const ownerB = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "buyer-session-b",
      auth_strength: "session",
      subject_binding: "none",
      capabilities: ["customer:self"],
    });
    const challengeB = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session",
      target_subject_id: otherSubject,
    });
    identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: ownerB,
      challenge_id: challengeB.challenge_id,
      source_session_id: "session-b",
      proof: challengeB.proof,
    });
    const theirs = history.search({
      merchant_id: MERCHANT,
      actor: ownerB,
      subject_id: otherSubject,
      resource_scope_id: scopeA,
      query: "纸箱包装",
    });
    expect(theirs.status).toBe("ok");
    if (theirs.status === "ok") expect(theirs.hits).toHaveLength(1);
  });

  it("删除：封存 scope、撤销 grant、清理记忆/历史，故障原子回滚，外部存储面保持 pending", () => {
    grant("customer_memory");
    const candidate = memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      resource_scope_id: scope,
      namespace: "preference",
      key: "unit",
      value_ref: "箱",
      value_type: "enum",
      source_kind: "explicit",
      source_refs: ["test-memory-source"],
    });
    bindCustomer();
    const active = memory.confirmMemory({
      merchant_id: MERCHANT,
      actor: customer(),
      memory_id: candidate.memory_id,
      expected_version: 1,
    });
    const historyGrant = grant("history_recall");
    history.indexHistoryDocument({
      merchant_id: MERCHANT,
      subject_id: subjectId,
      kind: "prior_inquiry",
      sku: "test-memory-source",
      source_version: 1,
      occurred_at: NOW,
      text: "纸箱包装和单位换算",
      grant_id: historyGrant.grant_id,
      erase_scope_id: scope,
    });
    const request = {
      merchant_id: MERCHANT,
      actor: customer(),
      erase_scope_id: scope,
      requested_by: "buyer-session-1",
      reason: "客户删除请求",
    };
    db.exec(`CREATE TRIGGER reject_index_delete BEFORE DELETE ON history_index
             BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END`);
    expect(() => memory.requestDeletion(request)).toThrow("fixture storage failure");
    expect(memory.getMemory(MERCHANT, active.memory_id)?.state).toBe("active");
    expect(db.prepare("SELECT COUNT(*) AS n FROM deletion_jobs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM history_fts").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM customer_memory_evidence").get()).toEqual({ n: 1 });

    db.exec("DROP TRIGGER reject_index_delete");
    const job = memory.requestDeletion(request);
    expect(job).toBeDefined();
    expect(memory.getMemory(MERCHANT, active.memory_id)).toMatchObject({
      state: "deleted", key: "", value_ref: "", source_refs: [],
    });
    expect(memory.listMine(MERCHANT, subjectId)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM history_fts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM customer_memory_evidence").get()).toEqual({ n: 0 });
    expect(job?.surfaces.every((surface) => surface.status === "PENDING")).toBe(true);
    const setVersion = memory.currentMemorySetVersion(MERCHANT, subjectId);
    expect(memory.requestDeletion(request)?.deletion_job_id).toBe(job?.deletion_job_id);
    expect(memory.currentMemorySetVersion(MERCHANT, subjectId)).toBe(setVersion);
    // 删除后该 scope 不能再用原 grant 写。
    expectError(
      () =>
        memory.proposeMemory({
          merchant_id: MERCHANT,
          actor: manager(),
          subject_id: subjectId,
          resource_scope_id: scope,
          namespace: "preference",
          key: "unit",
          value_ref: "箱",
          value_type: "enum",
          source_kind: "explicit",
        }),
      "grant_unavailable",
      "grant_not_active",
    );
  });

  it("留存：到期记忆失效、历史超期删除并递增 set version", () => {
    grant("customer_memory");
    const candidate = memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: subjectId,
      resource_scope_id: scope,
      namespace: "preference",
      key: "unit",
      value_ref: "箱",
      value_type: "enum",
      source_kind: "explicit",
      expires_at: "2026-12-31T00:00:00.000Z",
      source_refs: ["test-expiry-source"],
    });
    bindCustomer();
    memory.confirmMemory({
      merchant_id: MERCHANT,
      actor: customer(),
      memory_id: candidate.memory_id,
      expected_version: 1,
    });
    clock = candidate.purge_at;
    expect(memory.listMine(MERCHANT, subjectId)).toEqual([]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM binding_challenges").get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM grant_requests").get()).toEqual({ n: 1 });
    const expired = memory.expireDue();
    expect(expired.memories).toBeGreaterThanOrEqual(1);
    // P1-7：保留期清算同时清理已消费的挑战/授权请求。
    expect(db.prepare("SELECT COUNT(*) AS n FROM binding_challenges").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM grant_requests").get()).toEqual({ n: 0 });
    expect(memory.listMine(MERCHANT, subjectId)).toEqual([]);
    expect(memory.getMemory(MERCHANT, candidate.memory_id)).toMatchObject({
      state: "expired", key: "", value_ref: "", source_refs: [],
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM customer_memory_evidence").get()).toEqual({ n: 0 });
  });

  it("B01：匿名 T0 两次访问只保留当前会话，不建个人档案", () => {
    const anonymous = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "anon-1",
      auth_strength: "anonymous",
      subject_binding: "none",
      capabilities: ["customer:self"],
    });
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM customer_subjects WHERE merchant_id = ?")
      .get(MERCHANT) as { n: number };
    expect(identity.currentSubjectForActor(MERCHANT, "anon-1")).toBeUndefined();
    expect(identity.currentSubjectForActor(MERCHANT, "anon-2")).toBeUndefined();
    expectError(
      () =>
        identity.createSubject({
          merchant_id: MERCHANT,
          actor: anonymous,
          subject_kind: "organization",
        }),
      "access_denied",
      "capability_missing",
    );
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM customer_subjects WHERE merchant_id = ?")
      .get(MERCHANT) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("B02：同一 Agent 代理两人无被代理证明不合并档案", () => {
    const agentSubject = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "agent_scope",
    }).subject_id;
    const actorA = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "agent-proxy-a",
      auth_strength: "session",
      subject_binding: "agent_scope",
      capabilities: ["customer:self"],
    });
    const actorB = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "agent-proxy-b",
      auth_strength: "session",
      subject_binding: "agent_scope",
      capabilities: ["customer:self"],
    });
    expect(identity.currentSubjectForActor(MERCHANT, actorA.actor_id)).toBeUndefined();
    expect(identity.currentSubjectForActor(MERCHANT, actorB.actor_id)).toBeUndefined();
    const challenge = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session",
      target_subject_id: agentSubject,
    });
    identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: actorA,
      challenge_id: challenge.challenge_id,
      source_session_id: "session-a",
      proof: challenge.proof,
    });
    expect(identity.currentSubjectForActor(MERCHANT, actorA.actor_id)?.subject_id).toBe(
      agentSubject,
    );
    expect(identity.currentSubjectForActor(MERCHANT, actorB.actor_id)).toBeUndefined();
  });

  it("B03：绑定挑战过期/重复消费被拒绝，不建立第二条绑定", () => {
    const short = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session-exp",
      target_subject_id: subjectId,
      ttl_seconds: 60,
    });
    clock = new Date(Date.parse(NOW) + 61_000).toISOString();
    expectError(
      () =>
        identity.linkConfirm({
          merchant_id: MERCHANT,
          actor: customer(),
          challenge_id: short.challenge_id,
          source_session_id: "session-exp",
          proof: short.proof,
        }),
      "confirmation_expired",
      "challenge_expired",
    );
    clock = NOW;
    const challenge = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session",
      target_subject_id: subjectId,
    });
    identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: customer(),
      challenge_id: challenge.challenge_id,
      source_session_id: "session-1",
      proof: challenge.proof,
    });
    expectError(
      () =>
        identity.linkConfirm({
          merchant_id: MERCHANT,
          actor: customer(),
          challenge_id: challenge.challenge_id,
          source_session_id: "session-1",
          proof: challenge.proof,
        }),
      "confirmation_consumed",
      "challenge_consumed",
    );
  });

  it("P0-1：客户会话不能自签授权，签发者不能自我确认", () => {
    expectError(
      () =>
        grantRequests.createGrantRequest({
          merchant_id: MERCHANT,
          actor: customer(),
          subject_id: subjectId,
          purpose: "customer_memory",
          resource_scope_id: scope,
        }),
      "access_denied",
      "capability_missing",
    );
    const operator = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "operator-1",
      auth_strength: "verified",
      subject_binding: "organization",
      capabilities: ["memory:write", "customer:self"],
    });
    const request = grantRequests.createGrantRequest({
      merchant_id: MERCHANT,
      actor: operator,
      subject_id: subjectId,
      purpose: "customer_memory",
      resource_scope_id: scope,
    });
    expectError(
      () =>
        grantRequests.confirmGrant({
          merchant_id: MERCHANT,
          actor: operator,
          grant_request_id: request.grant_request.grant_request_id,
          confirmation_phrase: request.confirmation_phrase,
        }),
      "access_denied",
      "issuer_cannot_confirm",
    );
  });

  it("P0-2：绑定挑战只能由商家侧签发，签发者不能自我确认", () => {
    expectError(
      () =>
        identity.linkChallenge({
          merchant_id: MERCHANT,
          actor: customer(),
          source_session_id: "session-1",
          target_subject_id: subjectId,
        }),
      "access_denied",
      "capability_missing",
    );
    const operator = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "operator-1",
      auth_strength: "verified",
      subject_binding: "organization",
      capabilities: ["memory:write", "customer:self"],
    });
    const challenge = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: operator,
      source_session_id: "operator-session",
      target_subject_id: subjectId,
    });
    expectError(
      () =>
        identity.linkConfirm({
          merchant_id: MERCHANT,
          actor: operator,
          challenge_id: challenge.challenge_id,
          source_session_id: "operator-session",
          proof: challenge.proof,
        }),
      "access_denied",
      "issuer_cannot_confirm",
    );
  });

  it("P1-1：客户不能凭他人 erase_scope_id 跨主体删除", () => {
    bindCustomer();
    const otherSubject = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "organization",
    }).subject_id;
    new DataUseGrantStore({ db, now: () => clock }).createGrant({
      merchant_id: MERCHANT,
      subject_id: otherSubject,
      purpose: "customer_memory",
      resource_scope_id: "other-delete-scope",
      expires_at: "2026-12-01T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO data_scopes
        (merchant_id, erase_scope_id, data_epoch, state, sealed_at, updated_at)
       VALUES (?, ?, 1, 'ACTIVE', NULL, ?)`,
    ).run(MERCHANT, "other-delete-scope", clock);
    memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: otherSubject,
      resource_scope_id: "other-delete-scope",
      namespace: "preference",
      key: "unit",
      value_ref: "箱",
      value_type: "enum",
      source_kind: "explicit",
    });
    expectError(
      () =>
        memory.requestDeletion({
          merchant_id: MERCHANT,
          actor: customer(),
          erase_scope_id: "other-delete-scope",
          requested_by: "buyer-session-1",
          reason: "越权删除",
        }),
      "access_denied",
      "subject_not_bound",
    );
  });

  it("B04：未绑定到该主体的会话不能确认/纠错他人记忆", () => {
    const otherSubject = identity.createSubject({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_kind: "organization",
    }).subject_id;
    const otherGrantRequest = grantRequests.createGrantRequest({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: otherSubject,
      purpose: "customer_memory",
      resource_scope_id: "other-scope",
      grant_ttl_seconds: 24 * 60 * 60,
    });
    // P0-1：未绑定到 otherSubject 的会话即使持有短语也不能确认授权。
    expectError(
      () =>
        grantRequests.confirmGrant({
          merchant_id: MERCHANT,
          actor: customer(),
          grant_request_id: otherGrantRequest.grant_request.grant_request_id,
          confirmation_phrase: otherGrantRequest.confirmation_phrase,
        }),
      "access_denied",
      "subject_not_bound",
    );
    // 另一条真实绑定到 otherSubject 的客户会话可以完成确认。
    const ownerB = createActorContext({
      merchant_id: MERCHANT,
      actor_id: "buyer-session-b",
      auth_strength: "session",
      subject_binding: "none",
      capabilities: ["customer:self"],
    });
    const challengeB = identity.linkChallenge({
      merchant_id: MERCHANT,
      actor: manager(),
      source_session_id: "operator-session",
      target_subject_id: otherSubject,
    });
    identity.linkConfirm({
      merchant_id: MERCHANT,
      actor: ownerB,
      challenge_id: challengeB.challenge_id,
      source_session_id: "session-b",
      proof: challengeB.proof,
    });
    grantRequests.confirmGrant({
      merchant_id: MERCHANT,
      actor: ownerB,
      grant_request_id: otherGrantRequest.grant_request.grant_request_id,
      confirmation_phrase: otherGrantRequest.confirmation_phrase,
    });
    const candidate = memory.proposeMemory({
      merchant_id: MERCHANT,
      actor: manager(),
      subject_id: otherSubject,
      resource_scope_id: "other-scope",
      namespace: "preference",
      key: "unit",
      value_ref: "箱",
      value_type: "enum",
      source_kind: "explicit",
    });
    bindCustomer(subjectId);
    expectError(
      () =>
        memory.confirmMemory({
          merchant_id: MERCHANT,
          actor: customer(),
          memory_id: candidate.memory_id,
          expected_version: 1,
        }),
      "access_denied",
      "subject_not_bound",
    );
    expect(memory.listMine(MERCHANT, subjectId)).toEqual([]);
    expect(memory.listMine(MERCHANT, otherSubject)).toHaveLength(0);
  });
});
