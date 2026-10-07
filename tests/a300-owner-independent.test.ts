import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { LocalMerchantOwnerSession, OwnerAccountingFailure, merchantStorageDir, type OwnerBudgetGate } from "../src/merchant/ai-runtime/owner-session.js";
import { prepareNewOwnerStorage, openRegisteredOwnerStorage } from "../src/merchant/ai-runtime/owner-storage-admission.js";
import { parseAiRuntimeConfig } from "../src/merchant/ai-runtime/config.js";
import { AiRuntimeGate } from "../src/merchant/ai-runtime/gate.js";
import { SqliteDailyBudgetStore } from "../src/merchant/ai-runtime/sqlite-budget-store.js";

const close: Array<() => void> = [];
afterEach(() => { for (const dispose of close.splice(0).reverse()) dispose(); });
const merchantId = "independent-merchant", principal = "independent-owner";
const now = "2026-10-07T03:00:00.000Z";
function fixture(mode: "budget-fail" | "dual-fail" | "journal-after-ledger") {
  const storageRoot = mkdtempSync(join(tmpdir(), "a300-owner-proof-"));
  close.push(() => rmSync(storageRoot, { recursive: true, force: true }));
  const grantFile = join(storageRoot, "grant.json");
  writeFileSync(grantFile, JSON.stringify({ merchantId, principal, granted_at: now }));
  const storageAdmission = prepareNewOwnerStorage({ storageRoot, merchantId, principal });
  const dataDir = merchantStorageDir(storageRoot, merchantId);
  const dbPath = join(dataDir, "a300-budget.sqlite");
  const store = new SqliteDailyBudgetStore(dbPath);
  close.push(() => store.close());
  const sql = new DatabaseSync(dbPath);
  close.push(() => sql.close());
  const gate = new AiRuntimeGate({ config: parseAiRuntimeConfig({ enabled: true, provider: "openai", model: "offline-a300", api_key_env: "NEVER_READ_A300", max_output_tokens: 1000, daily_token_limit: 10000 }), budgetStore: store });
  const accounting: Array<{ leaseId: string; usedTokens: number }> = [];
  const budgetGate: OwnerBudgetGate = {
    async acquire(input) {
      const decision = await gate.acquireTurnLease(input);
      if (!decision.ok) return { allowed: false, reason: decision.reason };
      if (!gate.markInFlight(decision.lease.leaseId)) throw new Error("independent fixture admission denied");
      return { allowed: true, leaseId: decision.lease.leaseId };
    },
    async settle(input) {
      accounting.push({ ...input });
      gate.confirmCallEnded(input.leaseId);
      const settled = await gate.settleLease(input.leaseId, { usedTokens: input.usedTokens });
      if (settled.error) throw new Error(settled.error);
      if (mode === "journal-after-ledger" && accounting.length === 1) chmodSync(dataDir, 0o500);
    },
  };
  const provider = fauxProvider({ models: [{ id: "a300-offline" }] });
  const marker = "A300 authoritative offline completion " + "observed tokens ".repeat(40);
  let completed = false;
  let session: LocalMerchantOwnerSession;
  provider.setResponses([() => {
    if (mode !== "journal-after-ledger") sql.exec("CREATE TRIGGER a300_fault BEFORE UPDATE ON ai_budget_day BEGIN SELECT RAISE(FAIL, 'a300-settle-fault'); END");
    if (mode === "dual-fail") writeFileSync(session.operationsPath, "A300 irrecoverable journal bytes");
    completed = true;
    return fauxAssistantMessage(marker);
  }]);
  const models = createModels(); models.setProvider(provider.provider);
  const model = provider.getModel();
  const runtime = { models, model: { provider: model.provider, modelId: model.id }, reservationTokens: 1, maxRequests: 1, timeoutMs: 5000, tools: [] };
  const base = { storageRoot, merchantId, principal, grantFile, storageAdmission, switches: { ownerEnabled: true, aiRuntimeEnabled: true }, now: () => now };
  session = new LocalMerchantOwnerSession({ ...base, budgetGate, sdkRuntime: runtime });
  close.push(() => { chmodSync(dataDir, 0o700); session.release(); });
  const snapshot = () => ({ leases: sql.prepare("SELECT lease_id,amount,settled,actual FROM ai_budget_lease ORDER BY lease_id").all(), days: sql.prepare("SELECT day_key,used FROM ai_budget_day ORDER BY day_key").all() });
  return { base, dataDir, session, runtime, budgetGate, provider, accounting, gate, sql, snapshot, completed: () => completed, marker };
}
async function typedFailure(work: Promise<unknown>) {
  let returned = false;
  try { await work; returned = true; } catch (error) {
    expect(error).toBeInstanceOf(OwnerAccountingFailure);
    return error as OwnerAccountingFailure;
  }
  throw new Error(`ordinary response incorrectly returned: ${returned}`);
}

describe("A300 non-author independent owner accounting evidence", () => {
  it("SDK completion above reservation keeps typed success and real active lease; recovery only charges that lease once", async () => {
    const h = fixture("budget-fail");
    const failure = await typedFailure(h.session.submitTurn({ text: "a300-success" }));
    expect(h.completed()).toBe(true);
    expect((await h.session.history(20)).some((turn) => JSON.stringify(turn).includes(h.marker))).toBe(true);
    expect(failure.businessOutcome).toMatchObject({ ok: true, state: "settled", operationId: failure.operationId });
    expect(failure.usedTokens).toBeGreaterThan(1);
    expect(failure.budgetSettled).toBe(false);
    expect(h.gate.stats()).toMatchObject({ activeLeases: 1, inflightGlobal: 0 });
    const before = h.snapshot();
    expect(before.leases).toEqual([expect.objectContaining({ lease_id: failure.leaseId, amount: 1, settled: 0, actual: null })]);
    expect(before.days).toEqual([expect.objectContaining({ used: 1 })]);
    const operations = JSON.parse(readFileSync(h.session.operationsPath, "utf8"));
    expect(operations.operations[failure.operationId]).toMatchObject({ state: "settled", budget_accounting_state: "pending", budget_charged_tokens: failure.usedTokens });
    h.sql.exec("DROP TRIGGER a300_fault");
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    const after = h.snapshot();
    expect(after.leases).toEqual([expect.objectContaining({ lease_id: failure.leaseId, settled: 1, actual: failure.usedTokens })]);
    expect(after.days).toEqual([expect.objectContaining({ used: failure.usedTokens })]);
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(h.snapshot()).toEqual(after);
    expect(h.accounting).toEqual([{ leaseId: failure.leaseId, usedTokens: failure.usedTokens }, { leaseId: failure.leaseId, usedTokens: failure.usedTokens }]);
    expect(h.gate.stats().activeLeases).toBe(0);
    expect(h.provider.state.callCount).toBe(1);
  });

  it("JSON forgery and a new live session cannot recover or redrive the old persisted operation", async () => {
    const h = fixture("budget-fail");
    const failure = await typedFailure(h.session.submitTurn({ text: "a300-no-redrive" }));
    const ledgerBefore = h.snapshot();
    const operationsBefore = readFileSync(h.session.operationsPath, "utf8");
    h.sql.exec("DROP TRIGGER a300_fault");
    const counterfeit = JSON.parse(JSON.stringify(failure)) as OwnerAccountingFailure;
    await expect(h.session.retryAccounting(counterfeit)).rejects.toMatchObject({ code: "accounting_recovery_unknown" });
    h.session.release();
    const restarted = new LocalMerchantOwnerSession({ ...h.base, storageAdmission: openRegisteredOwnerStorage(h.base), budgetGate: h.budgetGate, sdkRuntime: h.runtime });
    close.push(() => restarted.release());
    await expect(restarted.retryAccounting(failure)).rejects.toMatchObject({ code: "accounting_recovery_unknown" });
    expect(await restarted.submitTurn({ text: "a300-no-redrive" })).toMatchObject({ ok: false, code: "owner_accounting_reconciliation" });
    expect(h.snapshot()).toEqual(ledgerBefore);
    expect(readFileSync(restarted.operationsPath, "utf8")).toBe(operationsBefore);
    expect(h.provider.state.callCount).toBe(1);
    expect(h.accounting).toHaveLength(1);
  });

  it("completed SDK transcript survives simultaneous journal corruption and real SQLite settlement failure", async () => {
    const h = fixture("dual-fail");
    const failure = await typedFailure(h.session.submitTurn({ text: "a300-double-fault" }));
    expect((await h.session.history(20)).some((turn) => JSON.stringify(turn).includes(h.marker))).toBe(true);
    expect(failure.businessOutcome).toMatchObject({ ok: false, state: "reconciliation", reason: "unknown_result_no_redrive" });
    expect(failure.businessError).toMatchObject({ code: "operations_unknown" });
    expect(failure.journalErrors.length).toBeGreaterThanOrEqual(2);
    expect(failure.budgetError).toMatchObject({ message: "budget_settle_failed" });
    expect(failure.cause.errors).toContain(failure.businessError);
    expect(failure.cause.errors).toContain(failure.budgetError);
    for (const error of failure.journalErrors) expect(failure.cause.errors).toContain(error);
    expect(readFileSync(h.session.operationsPath, "utf8")).toBe("A300 irrecoverable journal bytes");
    const before = h.snapshot();
    h.sql.exec("DROP TRIGGER a300_fault");
    await expect(h.session.retryAccounting(failure)).rejects.toMatchObject({ code: "operations_unknown" });
    expect(h.snapshot()).toEqual(before);
    expect(h.provider.state.callCount).toBe(1);
  });

  it("a known successful ledger settlement followed by recoverable journal IO only repairs the marker without resettling", async () => {
    const h = fixture("journal-after-ledger");
    const failure = await typedFailure(h.session.submitTurn({ text: "a300-journal-after-ledger" }));
    expect(failure.businessOutcome).toMatchObject({ ok: true, state: "settled" });
    expect(failure.budgetSettled).toBe(true);
    expect(failure.budgetError).toBeUndefined();
    expect(failure.journalErrors.length).toBeGreaterThan(0);
    const before = h.snapshot();
    expect(before.leases).toEqual([expect.objectContaining({ lease_id: failure.leaseId, settled: 1, actual: failure.usedTokens })]);
    expect(h.gate.stats().activeLeases).toBe(0);
    chmodSync(h.dataDir, 0o700);
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(h.snapshot()).toEqual(before);
    expect(JSON.parse(readFileSync(h.session.operationsPath, "utf8")).operations[failure.operationId].budget_accounting_state).toBe("settled");
    expect(h.provider.state.callCount).toBe(1);
    expect(h.accounting).toHaveLength(1);
  });
});
