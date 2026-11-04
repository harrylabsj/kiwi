/** Session ownership boundary for local buyer tasks (no network). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { resolveSessionOwner } from "../src/mcp/session-owner.js";

const dirs: string[] = [];
function fixture(sessionName: string, taskId: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-session-"));
  dirs.push(dir);
  const db = path.join(dir, "buyer.sqlite");
  const store = new TaskApprovalStore({ dbPath: db });
  const policy = {
    policy_id: "p", version: "1.0", principal: "company:test",
    expires_at: "2099-12-31T23:59:59Z",
    actions: { counter_offer: { mode: "auto" }, accept_nonbinding: { mode: "ask" }, handoff: { mode: "ask" }, payment: { mode: "never" } },
    limits: { max_rounds: 3 },
  };
  store.createTask({
    task_id: taskId, task_kind: "request_quotes", status: "succeeded",
    idempotency_key: `idem-${taskId}`, created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z", resumable: true,
    payload: JSON.stringify({ task_id: taskId, task_kind: "request_quotes", status: "succeeded", idempotency_key: `idem-${taskId}`, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", expires_at: "2099-12-31T23:59:59Z", resumable: true, candidates: [], intent: { intent_id: "i", intent_type: "inquiry", items: [] } }),
  });
  // The task above is legacy (no owner); the service adopts it on open.
  const service = new KiwiBuyerService({
    store, principal: "company:test", buyerAgentId: "buyer:test",
    sessionId: sessionName, sessionOwner: `owner-${sessionName}`, delegationPolicy: policy,
  });
  return { db, store, service };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buyer task session ownership", () => {
  it("same DB, different session cannot read or mutate a task", () => {
    const a = fixture("a", "task-owned");
    expect(() => a.service.getTask("task-owned")).toThrow(/not found/);
    expect(a.service.adoptLegacyTasks()).toBe(1);
    expect(a.service.getTask("task-owned").task.task_id).toBe("task-owned");
    const b = new KiwiBuyerService({
      store: a.store, principal: "company:test", buyerAgentId: "buyer:test",
      sessionId: "b", sessionOwner: "owner-b", delegationPolicy: {
        policy_id: "p", version: "1.0", principal: "company:test", expires_at: "2099-12-31T23:59:59Z",
        actions: { counter_offer: { mode: "auto" } }, limits: { max_rounds: 3 },
      },
    });
    expect(() => b.getTask("task-owned")).toThrow(/not found/);
    return expect(b.negotiate({ task_id: "task-owned", action: "clarification", summary: "test" }))
      .rejects.toMatchObject({ code: "task_not_found" });
  });

  it("same DB, no token, same caller-chosen label cannot read another task", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-session-notoken-"));
    dirs.push(dir);
    const store = new TaskApprovalStore({ dbPath: path.join(dir, "buyer.sqlite") });
    const aOwner = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same-label" });
    const bOwner = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same-label" });
    expect(aOwner).not.toBe(bOwner);
    store.createTask({
      task_id: "task-notoken", task_kind: "request_quotes", status: "succeeded",
      idempotency_key: "idem-notoken", created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z", resumable: true, owner_hash: aOwner, payload: "{}",
    });
    const b = new KiwiBuyerService({
      store, principal: "p", buyerAgentId: "a", sessionId: "same-label", sessionOwner: bOwner,
      delegationPolicy: {
        policy_id: "p", version: "1.0", principal: "p", expires_at: "2099-12-31T23:59:59Z",
        actions: { counter_offer: { mode: "auto" } }, limits: { max_rounds: 3 },
      },
    });
    expect(() => b.getTask("task-notoken")).toThrow(/not found/);
    store.close();
  });

  it("different session cannot read approval or agreement rows", () => {
    const a = fixture("a-write", "task-write");
    a.store.setApproval("task-write", {
      approval_id: "approval-write", task_id: "task-write", action: "handoff",
      status: "pending", candidate_digest: "digest", expires_at: "2099-12-31T23:59:59Z",
    });
    a.store.createAgreement({
      agreement_id: "agreement-write", task_id: "task-write", created_at: "2026-11-01T00:00:00Z",
      payload: "{}",
    });
    const b = new KiwiBuyerService({
      store: a.store, principal: "company:test", buyerAgentId: "buyer:test",
      sessionId: "b-write", sessionOwner: "owner-b-write", delegationPolicy: {
        policy_id: "p", version: "1.0", principal: "company:test", expires_at: "2099-12-31T23:59:59Z",
        actions: { handoff: { mode: "ask" } }, limits: {},
      },
    });
    expect(() => b.approve({ approval_id: "approval-write" })).toThrow(/not found/);
    expect(() => b.getAgreement("agreement-write")).toThrow(/not found/);
  });

  it("same session label without a token is not a shared identity", () => {
    const one = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same" });
    const two = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same" });
    expect(one).not.toBe(two);
    expect(one.startsWith("ephemeral:")).toBe(true);
    expect(two.startsWith("ephemeral:")).toBe(true);
  });

  it("only an explicit token gives a stable reconnectable owner", () => {
    const one = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same", sessionToken: "token-one" });
    const two = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same", sessionToken: "token-two" });
    const again = resolveSessionOwner({ principal: "p", buyerAgentId: "a", sessionId: "same", sessionToken: "token-one" });
    expect(one).not.toBe(two);
    expect(one).toBe(again);
  });

  it("owner survives store reopen and a different session stays denied", () => {
    const a = fixture("persist-a", "task-persist");
    a.service.adoptLegacyTasks();
    a.store.close();
    const reopened = new TaskApprovalStore({ dbPath: a.db });
    const same = new KiwiBuyerService({
      store: reopened, principal: "company:test", buyerAgentId: "buyer:test",
      sessionId: "persist-a", sessionOwner: "owner-persist-a", delegationPolicy: {
        policy_id: "p", version: "1.0", principal: "company:test", expires_at: "2099-12-31T23:59:59Z",
        actions: { counter_offer: { mode: "auto" } }, limits: { max_rounds: 3 },
      },
    });
    expect(same.getTask("task-persist").task.task_id).toBe("task-persist");
    const other = new KiwiBuyerService({
      store: reopened, principal: "company:test", buyerAgentId: "buyer:test",
      sessionId: "persist-b", sessionOwner: "owner-persist-b", delegationPolicy: {
        policy_id: "p", version: "1.0", principal: "company:test", expires_at: "2099-12-31T23:59:59Z",
        actions: { counter_offer: { mode: "auto" } }, limits: { max_rounds: 3 },
      },
    });
    expect(() => other.getTask("task-persist")).toThrow(/not found/);
    reopened.close();
  });
});
