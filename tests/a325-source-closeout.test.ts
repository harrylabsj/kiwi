import { mkdirSync, readFileSync } from "node:fs";
/**
 * A325 七项候选源码收口自有控制：
 * - P1-2 生产 gate 接线（build-service 真实工厂）+ 事务内 fresh 授权故障注入
 * - 2-8 只 ESRCH 确认死回收 / EPERM·EINVAL·新 owner 锁不删
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { KiwiBuyerService } from "../src/buyer-core/service.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { ledgerFileName } from "../src/negotiation/ledger/store.js";

const _T0 = "2026-08-05T12:00:00+08:00";
const _PRINCIPAL = "buyer-agent:buyer-001";
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const LIMITS = {
  max_unit_price: { currency: "CNY", amount_minor: 100_000 },
  max_total_price: { currency: "CNY", amount_minor: 1_000_000 },
  max_quantity: { value: 10, unit: "个" },
  allowed_currencies: ["CNY"],
};

function makeServiceWithA2A() {
  const protocolStateDir = mkdtempSync(path.join(tmpdir(), "a325-protocol-state-"));
  const svc = buildBuyerService({
    protocolStateDir,
    dbPath: ":memory:",
    principal: "c:a325",
    buyerAgentId: "buyer-agent:a325",
    sessionId: "a325",
    catalogUrl: "http://127.0.0.1:1", // 触发 a2a/negotiator 分支（测试内不真连）
    policy: {
      policy_id: "dp-a325",
      version: "1.0",
      principal: "c:a325",
      expires_at: "2099-12-31T23:59:59Z",
      actions: {
        discover: { mode: "auto" },
        inquiry_rfq: { mode: "auto" },
        compare_offers: { mode: "auto" },
        counter_offer: { mode: "auto" },
        accept_nonbinding: { mode: "ask" },
        handoff: { mode: "ask" },
        payment: { mode: "never" },
      },
      limits: LIMITS,
    } as never,
  } as never);
  cleanups.push(async () => {
    try { (svc as unknown as { store: import("../src/buyer-core/store.js").TaskApprovalStore }).store.close(); }
    finally { rmSync(protocolStateDir, { recursive: true, force: true }); }
  });
  return svc;
}

describe("A325 P1-2：生产工厂 gate 接线与限额语义", () => {
  it("build-service 真实工厂的 negotiator 已接 counterProposalGate（函数）", () => {
    const svc = makeServiceWithA2A();
    const negotiator = (svc as unknown as { negotiator?: { counterProposalGate?: unknown } })
      .negotiator;
    expect(negotiator).toBeDefined();
    expect(typeof negotiator?.counterProposalGate).toBe("function");
  });

  it("gate（复用 service.checkCounterProposalLimits）语义：超限拒/界内放/非整数拒/缺单位拒", () => {
    const svc = makeServiceWithA2A();
    const gate = (svc as unknown as { negotiator: { counterProposalGate: (p: unknown) => string | undefined } })
      .negotiator.counterProposalGate;
    const over = gate({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 10, quantity_unit: "个",
      unit_price_minor: 999_999_900, total_price_minor: 9_999_999_000_000,
    });
    expect(over).toContain("超过");
    const ok = gate({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 10, quantity_unit: "个",
      unit_price_minor: 99_900, total_price_minor: 999_000,
    });
    expect(ok).toBeUndefined();
    const nonInt = gate({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 1, quantity_unit: "个",
      unit_price_minor: 10.5, total_price_minor: 10.5,
    });
    expect(nonInt).toContain("安全整数");
    const missingUnit = gate({
      merchant_id: "m1", sku: "s", currency: "CNY",
      quantity_value: 1, unit_price_minor: 100, total_price_minor: 100,
    });
    expect(missingUnit).toContain("单位");
  });
});

describe("A325 P1-2：事务内 fresh 授权（跨连接窗口故障注入）", () => {
  function _seedApprovedApproval(
    svc: KiwiBuyerService,
    taskId: string,
    digest: string,
  ): { approvalId: string; store: Record<string, unknown> } {
    const store = (svc as unknown as { store: TaskApprovalStoreLike }).store;
    const { approval_id } = svc.requestApproval({
      task_id: taskId,
      action: "accept_nonbinding",
      candidate_digest: digest,
    });
    svc.approve({ approval_id });
    return { approvalId: approval_id, store: store as unknown as Record<string, unknown> };
  }

  interface TaskApprovalStoreLike {
    getApproval(id: string): Record<string, unknown> | undefined;
    listCandidates(taskId: string): Array<Record<string, unknown>>;
    setApproval(taskId: string, a: unknown): void;
    addCandidate(taskId: string, c: unknown): void;
  }

  function makePlainService() {
    return buildBuyerService({
      dbPath: ":memory:",
      principal: "c:a325-plain",
      buyerAgentId: "buyer-agent:a325",
      sessionId: "a325-plain",
      policy: {
        policy_id: "dp", version: "1.0", principal: "c:a325-plain", expires_at: "2099-12-31T23:59:59Z",
        actions: { discover: { mode: "auto" }, inquiry_rfq: { mode: "auto" }, compare_offers: { mode: "auto" }, counter_offer: { mode: "auto" }, accept_nonbinding: { mode: "ask" }, handoff: { mode: "ask" }, payment: { mode: "never" } },
        limits: LIMITS,
      } as never,
    } as never);
  }

  it("故障注入：evaluate 见 approved、事务内变 denied → 拒绝消费，零 agreement", async () => {
    const svc = makePlainService();
    const { task } = await svc.requestQuotes({
      intent: { intent_id: "i", intent_type: "purchase", items: [{ query: "x", quantity: { value: 1, unit: "台" } }] },
      merchant_ids: ["m1"],
      idempotency_key: "a325-f1",
    });
    const taskId = (task as { task_id: string }).task_id;
    const store = (svc as unknown as { store: TaskApprovalStoreLike }).store;
    store.addCandidate(taskId, {
      candidate_id: "cand",
      merchant_id: "m1",
      status: "succeeded",
      provenance: {},
      terms: { currency: "CNY", items: [{ sku: "s", quantity_value: 1, quantity_unit: "个", unit_price_minor: 10_000 }], total_price_minor: 10_000 },
      retryable: false,
    });
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const digest = contentDigest(
      store.listCandidates(taskId).find((c) => c.candidate_id === "cand") as never,
    );
    const { approval_id } = svc.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digest });
    svc.approve({ approval_id });

    // 跨连接窗口故障注入：getApproval 首次（evaluate）真 approved，其后（事务内）denied
    const real = store.getApproval.bind(store);
    let calls = 0;
    Object.defineProperty(store, "getApproval", {
      value: (id: string) => {
        calls += 1;
        const a = real(id);
        if (a !== undefined && calls >= 2) return { ...a, status: "denied" } as Record<string, unknown>;
        return a;
      },
      configurable: true,
    });

    await expect(
      svc.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id }),
    ).rejects.toMatchObject({ code: "approval_denied" });
    delete (store as unknown as { getApproval?: unknown }).getApproval;
  });

  it("正控：无故障时事务内逐项复核通过 → agreement + approval used", async () => {
    const svc = makePlainService();
    const { task } = await svc.requestQuotes({
      intent: { intent_id: "i", intent_type: "purchase", items: [{ query: "x", quantity: { value: 1, unit: "台" } }] },
      merchant_ids: ["m1"],
      idempotency_key: "a325-f2",
    });
    const taskId = (task as { task_id: string }).task_id;
    const store = (svc as unknown as { store: TaskApprovalStoreLike }).store;
    store.addCandidate(taskId, {
      candidate_id: "cand",
      merchant_id: "m1",
      status: "succeeded",
      provenance: {},
      terms: { currency: "CNY", items: [{ sku: "s", quantity_value: 1, quantity_unit: "个", unit_price_minor: 10_000 }], total_price_minor: 10_000 },
      retryable: false,
    });
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const digest = contentDigest(
      store.listCandidates(taskId).find((c) => c.candidate_id === "cand") as never,
    );
    const { approval_id } = svc.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digest });
    svc.approve({ approval_id });
    const done = await svc.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id });
    expect((done.agreement as { agreement_id: string }).agreement_id).toMatch(/^agreement-/);
    const approval = store.getApproval(approval_id) as { status?: string };
    expect(approval.status).toBe("used");
  });
});

describe("A325 2-8：锁回收身份边界（EPERM/EINVAL 保留、死 PID 回收）", () => {
  const dirs: string[] = [];
  function mk(): { store: LedgerStore; dir: string; lockPath: string; negId: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "a325-lock-"));
    dirs.push(dir);
    const negId = `neg-a325-${Math.random().toString(36).slice(2, 8)}`;
    const store = new LedgerStore({ dir, now: () => new Date().toISOString(), lockTimeoutMs: 400 });
    return { store, dir, lockPath: path.join(dir, "ledger", `${ledgerFileName(negId)}.lock`), negId };
  }
  function seedStaleLock(lockPath: string, content: unknown): void {
    mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify(content), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
  }
  function appendArgs(negId: string) {
    return {
      event_kind: "message_sent" as const,
      negotiation_id: negId,
      exchange_id: `exch-${negId}`,
      message_id: `m-${Math.random()}`,
      identity: { sender_identity: "merchant:m", counterparty_identity: "buyer:*", actor: "merchant" as const },
      capability: { capability: "cap", protocol_version: "1.0" },
      wire_digest: "sha256:x",
      wire_payload: {},
      outcome: { kind: "ok" as const },
      occurred_at: new Date().toISOString(),
    };
  }

  it("EPERM（pid 1 非特权进程）→ 视为存活：fail-closed 超时，锁保留", async () => {
    const { store, dir: _dir, lockPath, negId } = mk();
    seedStaleLock(lockPath, { pid: 1, token: "eperm-holder" });
    let threw: unknown;
    try {
      await store.append(appendArgs(negId));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();
    expect(existsSync(lockPath)).toBe(true);
    void _dir;
  });

  it("越界 PID（kill 抛 EINVAL，非 ESRCH）→ 身份未知：锁保留", async () => {
    const { store, dir: _dir, lockPath, negId } = mk();
    seedStaleLock(lockPath, { pid: 2 ** 31, token: "einval-holder" });
    let threw2: unknown;
    try {
      await store.append(appendArgs(negId));
    } catch (err) {
      threw2 = err;
    }
    expect(threw2).toBeDefined();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("死 PID（ESRCH）→ 回收接管成功：事件落账、锁清除", async () => {
    const { store, dir: _dir, lockPath, negId } = mk();
    seedStaleLock(lockPath, { pid: 2_147_000_000, token: "dead" });
    const ev = await store.append(appendArgs(negId));
    expect(ev.event_id).toBeTruthy();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("双 reclaimer/新 owner 归属：陈旧锁被换成新 owner（活 PID）→ 不删新锁，fail-closed", async () => {
    const { store, dir: _dir, lockPath, negId } = mk();
    seedStaleLock(lockPath, { pid: 2_147_000_000, token: "stale" });
    // 竞争窗口模拟：回收判定后、unlink 前锁已被换成新 owner（活 PID=自身）
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "new-owner" }), { mode: 0o600 });
    let threw3: unknown;
    try {
      await store.append(appendArgs(negId));
    } catch (err) {
      threw3 = err;
    }
    expect(threw3).toBeDefined();
    // 新 owner 锁文件未被删除（内容仍是 new-owner）
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("new-owner");
    void createHash; void dirs;
  });
});
