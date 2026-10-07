import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  LocalMerchantOwnerSession,
  OwnerAccountingFailure,
  businessKey,
  checkFileGrant,
  merchantStorageDir,
} from "../src/merchant/ai-runtime/owner-session.js";
import {
  prepareNewOwnerStorage,
  openRegisteredOwnerStorage,
} from "../src/merchant/ai-runtime/owner-storage-admission.js";
import { createFileGrantResolver } from "../src/merchant/ai-runtime/owner-file-grant.js";
import { createOwnerBudgetGate } from "../src/merchant/ai-runtime/owner-budget-gate.js";
import { parseAiRuntimeConfig } from "../src/merchant/ai-runtime/config.js";
import { AiRuntimeGate } from "../src/merchant/ai-runtime/gate.js";
import { SqliteDailyBudgetStore } from "../src/merchant/ai-runtime/sqlite-budget-store.js";
import { openAgentDatabase } from "../src/agent/agent-db.js";
import {
  WriteApprovalCandidateStore,
  contentHash,
} from "../src/agent/merchant/action-candidate.js";
import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";
import { OwnerCommittedProofAuthority } from "../src/merchant/ai-runtime/owner-committed-proof.js";
import { OwnerBusinessHost } from "../src/merchant/ai-runtime/owner-business-host.js";
import { EXACT_PRODUCT_TOOLS } from "../src/merchant/exact-product-executors.js";
import { parseExactMoney } from "../src/merchant/application/money.js";
import type { MerchantClient } from "../src/agent/merchant/types.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const merchantId = "owner-accounting-merchant",
  principal = "owner-accounting-principal";
const now = "2026-10-07T01:00:00.000Z",
  expires = "2026-10-07T01:04:00.000Z";
function temp() {
  const root = mkdtempSync(join(tmpdir(), "kiwi-owner-accounting-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function config() {
  return parseAiRuntimeConfig({
    enabled: true,
    provider: "openai",
    model: "fixture",
    api_key_env: "OFFLINE_TEST_UNUSED",
    max_output_tokens: 1000,
    daily_token_limit: 10000,
  });
}
function setup() {
  const storageRoot = temp();
  const grantFile = join(storageRoot, "grant.json");
  writeFileSync(grantFile, JSON.stringify({ merchantId, principal, granted_at: now }));
  const storageAdmission = prepareNewOwnerStorage({ storageRoot, merchantId, principal });
  const dataDir = merchantStorageDir(storageRoot, merchantId);
  const dbPath = join(dataDir, "budget.sqlite");
  const budget = createOwnerBudgetGate({ dbPath, config: config() });
  cleanup.push(() => budget.close());
  const observer = new DatabaseSync(dbPath);
  cleanup.push(() => observer.close());
  const fail = () =>
    observer.exec(
      "CREATE TRIGGER fail_accounting BEFORE UPDATE ON ai_budget_day BEGIN SELECT RAISE(FAIL, 'test accounting fault'); END",
    );
  const repair = () => observer.exec("DROP TRIGGER fail_accounting");
  const base = {
    storageRoot,
    merchantId,
    principal,
    grantFile,
    storageAdmission,
    switches: { ownerEnabled: true, aiRuntimeEnabled: true },
    now: () => now,
  };
  return { base, budget, observer, fail, repair, dataDir };
}
function sdkFixture(
  options: { unknown?: boolean; breakJournal?: boolean; settlementFault?: boolean } = {},
) {
  const h = setup();
  const provider = fauxProvider({ models: [{ id: "accounting-fixture" }] });
  provider.setResponses([
    () => {
      if (options.settlementFault !== false) h.fail();
      if (options.breakJournal) writeFileSync(session.operationsPath, "invalid-journal");
      const message = fauxAssistantMessage(
        "offline response",
        options.unknown ? { stopReason: "error", errorMessage: "offline result unknown" } : {},
      );
      return message;
    },
  ]);
  const models = createModels();
  models.setProvider(provider.provider);
  const model = provider.getModel();
  const session = new LocalMerchantOwnerSession({
    ...h.base,
    budgetGate: h.budget.budgetGate,
    sdkRuntime: {
      models,
      model: { provider: model.provider, modelId: model.id },
      reservationTokens: 5,
      maxRequests: 1,
      timeoutMs: 5000,
      tools: [],
    },
  });
  cleanup.push(() => session.release());
  return {
    ...h,
    session,
    provider,
    sdkRuntime: {
      models,
      model: { provider: model.provider, modelId: model.id },
      reservationTokens: 5,
      maxRequests: 1,
      timeoutMs: 5000,
      tools: [],
    },
  };
}
async function accountingFailure(work: Promise<unknown>) {
  try {
    await work;
    throw new Error("expected accounting failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAccountingFailure);
    return error as OwnerAccountingFailure;
  }
}
function ledger(h: ReturnType<typeof setup>, lease: string) {
  return h.observer
    .prepare("SELECT settled, amount, actual FROM ai_budget_lease WHERE lease_id=?")
    .get(lease) as { settled: number; amount: number; actual: number | null };
}

describe("owner review: strong legacy grant and independent accounting", () => {
  it("legacy grant delegates shape checks while retaining principal mismatch mapping and exact opaque IDs", () => {
    const root = temp(),
      file = join(root, "grant.json");
    const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
    write({ merchantId, principal, granted_at: now });
    expect(checkFileGrant(file, merchantId, principal).ok).toBe(true);
    for (const granted_at of [0, "", "   ", null]) {
      write({ merchantId, principal, granted_at });
      expect(checkFileGrant(file, merchantId, principal)).toEqual({
        ok: false,
        code: "grant_unknown",
      });
    }
    write({ merchantId, principal: "other", granted_at: now });
    expect(checkFileGrant(file, merchantId, principal)).toEqual({
      ok: false,
      code: "grant_merchant_mismatch",
    });
    for (const [m, p] of [
      [" ", principal],
      [merchantId, " "],
    ]) {
      write({ merchantId: m, principal: p });
      expect(checkFileGrant(file, m!, p!)).toEqual({ ok: false, code: "grant_unknown" });
    }
    const binding = { merchantId: " ../opaque: merchant ", principal: " exact principal " };
    write({ ...binding, granted_at: now });
    expect(checkFileGrant(file, binding.merchantId, binding.principal).ok).toBe(true);
    const resolver = createFileGrantResolver(binding);
    const initial = resolver.readStrong(file);
    expect(initial.ok).toBe(true);
    write({ ...binding, granted_at: expires });
    const changed = resolver.readStrong(file);
    expect(changed.ok && initial.ok && changed.grant.digest !== initial.grant.digest).toBe(true);
    rmSync(file);
    expect(resolver.readStrong(file).ok).toBe(false);
  });
  it("SDK success survives settlement failure as typed evidence; accounting-only retry does not run provider or refund", async () => {
    const h = sdkFixture();
    const failure = await accountingFailure(h.session.submitTurn({ text: "one turn" }));
    expect(failure.businessOutcome).toMatchObject({
      ok: true,
      state: "settled",
      operationId: failure.operationId,
    });
    const actual = failure.usedTokens;
    expect(actual).toBeGreaterThan(5);
    expect(failure.budgetError).toBeInstanceOf(Error);
    expect(failure.message).not.toContain("test accounting fault");
    expect(ledger(h, failure.leaseId)).toMatchObject({ settled: 0, amount: 5, actual: null });
    const journal = JSON.parse(readFileSync(h.session.operationsPath, "utf8"));
    expect(journal.operations[failure.operationId]).toMatchObject({
      state: "settled",
      budget_accounting_state: "pending",
      budget_lease_id: failure.leaseId,
      budget_charged_tokens: actual,
    });
    expect(await h.session.submitTurn({ text: "one turn" })).toMatchObject({
      ok: false,
      code: "owner_accounting_reconciliation",
    });
    h.repair();
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(h.provider.state.callCount).toBe(1);
    expect(ledger(h, failure.leaseId)).toMatchObject({ settled: 1, actual });
  });
  it("SDK unknown business result remains reconciliation when accounting fails and after accounting recovery", async () => {
    const h = sdkFixture({ unknown: true });
    const failure = await accountingFailure(h.session.submitTurn({ text: "unknown turn" }));
    expect(failure.businessOutcome).toMatchObject({
      ok: false,
      state: "reconciliation",
      reason: "unknown_result_no_redrive",
    });
    expect(failure.usedTokens).toBeGreaterThanOrEqual(5);
    h.repair();
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(h.provider.state.callCount).toBe(1);
  });
  it("journal IO plus settlement failure retain both errors and the unreadable journal; recovery cannot invent evidence", async () => {
    const h = sdkFixture({ breakJournal: true });
    const failure = await accountingFailure(h.session.submitTurn({ text: "broken journal" }));
    expect(failure.businessOutcome).toMatchObject({ ok: false, state: "reconciliation" });
    expect(failure.businessError).toMatchObject({ code: "operations_unknown" });
    expect(failure.journalErrors.length).toBeGreaterThan(0);
    expect(failure.budgetError).toBeInstanceOf(Error);
    expect(failure.cause.errors).toContain(failure.businessError);
    expect(failure.cause.errors).toContain(failure.budgetError);
    expect(readFileSync(h.session.operationsPath, "utf8")).toBe("invalid-journal");
    h.repair();
    await expect(h.session.retryAccounting(failure)).rejects.toMatchObject({
      code: "operations_unknown",
    });
    expect(ledger(h, failure.leaseId).settled).toBe(0);
  });
  it("recovery rejects fabricated errors, changed grant and changed journal usage before bookkeeping", async () => {
    const h = sdkFixture();
    const failure = await accountingFailure(h.session.submitTurn({ text: "bound recovery" }));
    h.repair();
    await expect(
      h.session.retryAccounting({ ...failure } as OwnerAccountingFailure),
    ).rejects.toMatchObject({ code: "accounting_recovery_unknown" });
    const original = readFileSync(h.session.operationsPath, "utf8");
    const journal = JSON.parse(original);
    journal.operations[failure.operationId].budget_charged_tokens = 0;
    writeFileSync(h.session.operationsPath, JSON.stringify(journal));
    await expect(h.session.retryAccounting(failure)).rejects.toMatchObject({
      code: "accounting_recovery_unknown",
    });
    writeFileSync(h.session.operationsPath, original);
    writeFileSync(h.base.grantFile, JSON.stringify({ merchantId, principal, granted_at: expires }));
    await expect(h.session.retryAccounting(failure)).rejects.toMatchObject({
      code: "accounting_recovery_unknown",
    });
    expect(ledger(h, failure.leaseId).settled).toBe(0);
  });
  it("actual gate retains active lease after SQLite settlement fault and same lease retry charges exactly once above reservation", async () => {
    const root = temp(),
      dbPath = join(root, "budget.sqlite"),
      store = new SqliteDailyBudgetStore(dbPath);
    cleanup.push(() => store.close());
    const observer = new DatabaseSync(dbPath);
    cleanup.push(() => observer.close());
    const gate = new AiRuntimeGate({ config: config(), budgetStore: store });
    const decision = await gate.acquireTurnLease({ merchantId, estimatedTokens: 20 });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("lease missing");
    const lease = decision.lease.leaseId;
    expect(gate.markInFlight(lease)).toBe(true);
    gate.confirmCallEnded(lease);
    observer.exec(
      "CREATE TRIGGER fail_settle BEFORE UPDATE ON ai_budget_day BEGIN SELECT RAISE(FAIL, 'fault'); END",
    );
    expect(await gate.settleLease(lease, { usedTokens: 30 })).toMatchObject({
      settled: false,
      error: "budget_settle_failed",
    });
    expect(gate.stats()).toMatchObject({ activeLeases: 1, inflightGlobal: 0 });
    observer.exec("DROP TRIGGER fail_settle");
    expect(await gate.settleLease(lease, { usedTokens: 30 })).toMatchObject({ settled: true });
    expect(await gate.settleLease(lease, { usedTokens: 30 })).toMatchObject({ settled: false });
    expect(gate.stats().activeLeases).toBe(0);
    expect(observer.prepare("SELECT used FROM ai_budget_day").get()).toEqual({ used: 30 });
  });
});

function committedFixture(
  options: { unknown?: boolean; revokeAfterReceipt?: boolean; settlementFault?: boolean } = {},
) {
  const h = setup();
  const candidateDb = openAgentDatabase(join(h.dataDir, "candidates.sqlite"));
  cleanup.push(() => candidateDb.close());
  candidateDb
    .prepare(
      "INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at) VALUES (?, ?, 'merchant', 'zh-CN', 'Asia/Shanghai', 1, ?, ?)",
    )
    .run(principal, merchantId, now, now);
  const candidates = new WriteApprovalCandidateStore({
    db: candidateDb,
    ownerMerchantId: merchantId,
    principalId: principal,
    now: () => now,
  });
  const confirmationDb = new DatabaseSync(join(h.dataDir, "confirmations.sqlite"));
  cleanup.push(() => confirmationDb.close());
  const confirmations = new WorkbenchConfirmationStore({ db: confirmationDb, now: () => now });
  const authority = new OwnerCommittedProofAuthority({
    confirmations,
    confirmationDb,
    candidates,
    merchantId,
    principal,
    authoritySource: "offline-receipt-service",
    subject: {
      source: "offline-subject-authority",
      resolve: () => ({
        principal,
        upstreamMerchantId: "upstream",
        generation: 1,
        expiresAt: expires,
        revoked: false,
      }),
    },
    now: () => now,
  });
  const money = parseExactMoney(
    { currency: "CNY", amount_minor: "300" },
    { requireOperatingSupport: true },
  );
  const product = {
    sku: "sku-a",
    merchant_id: "upstream",
    currency: money.currency,
    price_minor: "200",
    currency_table_version: money.currency_table_version,
    authority_version: 1,
  };
  let effects = 0,
    reads = 0;
  const client = {
    getExactProduct: async () => product,
    updateExactProductMoney: async () => {
      effects += 1;
      if (options.settlementFault !== false) h.fail();
      return { ...product, price_minor: "300", authority_version: 2 };
    },
    getProductOperation: async (_merchant: string, operationId: string) => {
      reads += 1;
      if (options.revokeAfterReceipt)
        writeFileSync(
          h.base.grantFile,
          JSON.stringify({ merchantId, principal: "revoked", granted_at: now }),
        );
      return options.unknown
        ? undefined
        : {
            operation_id: operationId,
            merchant_id: "upstream",
            operation_kind: "exact_product_money_update",
            sku: product.sku,
            status: "succeeded",
            result: {
              expected_authority_version: 1,
              product: { ...product, price_minor: "300", authority_version: 2 },
            },
          };
    },
  } as unknown as MerchantClient;
  const host = new OwnerBusinessHost({
    authority,
    client,
    upstreamMerchantId: "upstream",
    authoritySource: "offline-receipt-service",
    timeoutMs: 1000,
    reservationTokens: 20,
    conditionalOperationContract: "exact-money-version-and-operation-id/1",
  });
  const session = new LocalMerchantOwnerSession({
    ...h.base,
    budgetGate: h.budget.budgetGate,
    approvals: candidates,
    businessHost: host,
  });
  cleanup.push(() => session.release());
  const args = {
    sku: product.sku,
    money: { currency: "CNY", amount_minor: "300" },
    expected_authority_version: 1,
  };
  const preconditions = {
    sku: product.sku,
    currency: product.currency,
    price_minor: "200",
    currency_table_version: product.currency_table_version,
    authority_version: 1,
    merchant_id: merchantId,
    principal,
    business_key: businessKey(EXACT_PRODUCT_TOOLS.updateMoney, args),
  };
  const candidate = candidates.create({
    tool: EXACT_PRODUCT_TOOLS.updateMoney,
    arguments: args,
    preconditions,
    risk: "write_catalog",
    expires_at: expires,
  });
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  confirmations.persistVerifiedCredential({
    registrationVerified: true,
    credentialId: "offline-credential",
    merchantId,
    actorId: "offline-actor",
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    rpId: "merchant.example",
    origin: "https://merchant.example",
  });
  const binding = {
    merchantId,
    principal,
    operationId: "committed-accounting-op",
    candidateId: candidate.candidate_id,
    actionDigest: contentHash({ arguments: args, preconditions }),
    sku: product.sku,
    expectedMoneyAuthorityVersion: 1,
    actorId: "offline-actor",
    upstreamMerchantId: "upstream",
    authoritySource: "offline-receipt-service",
    subjectSource: "offline-subject-authority",
    approvalGeneration: 1,
    expiresAt: expires,
    kind: EXACT_PRODUCT_TOOLS.updateMoney,
    currency: money.currency,
    amountMinor: money.amount_minor,
    currencyTableVersion: money.currency_table_version,
    arguments: args,
    preconditions,
  };
  const request = confirmations.createRequest({
    merchantId,
    actorId: binding.actorId,
    candidateId: binding.candidateId,
    approvalGeneration: 1,
    decision: "approve",
    operationId: binding.operationId,
    actionDigest: binding.actionDigest,
    actionSnapshot: { decision_authorization: binding },
    expectedVersion: 1,
    expiresAt: expires,
  });
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: request.challenge,
      origin: "https://merchant.example",
      crossOrigin: false,
    }),
  );
  const authenticator = Buffer.alloc(37);
  createHash("sha256").update("merchant.example").digest().copy(authenticator);
  authenticator[32] = 5;
  authenticator.writeUInt32BE(1, 33);
  const assertion = {
    credentialId: "offline-credential",
    clientDataJSON: clientData.toString("base64url"),
    authenticatorData: authenticator.toString("base64url"),
    signature: sign(
      "sha256",
      Buffer.concat([authenticator, createHash("sha256").update(clientData).digest()]),
      pair.privateKey,
    ).toString("base64url"),
  };
  expect(
    confirmations.finalizeDecision({
      confirmationId: request.confirmationId,
      merchantId,
      actorId: binding.actorId,
      candidateId: binding.candidateId,
      approvalGeneration: 1,
      decision: "approve",
      actionDigest: binding.actionDigest,
      expectedVersion: 1,
      assertion,
    }),
  ).toMatchObject({ kind: "decided" });
  const permit = authority.issue(binding.operationId);
  return { ...h, session, permit, confirmations, candidate, counts: () => ({ effects, reads }) };
}

describe("committed owner accounting preserves authoritative business evidence", () => {
  it("authoritative receipt remains settled after budget failure; one accounting retry never repeats the claim or effect", async () => {
    const h = committedFixture();
    const failure = await accountingFailure(h.session.submitCommittedOperation(h.permit));
    expect(failure.businessOutcome).toMatchObject({
      ok: true,
      state: "settled",
      turnSummary: "authoritative_exact_money_receipt",
    });
    expect(failure.usedTokens).toBe(20);
    expect(ledger(h, failure.leaseId)).toMatchObject({ settled: 0, amount: 20 });
    expect(await h.session.submitCommittedOperation(h.permit)).toMatchObject({
      ok: false,
      code: "owner_accounting_reconciliation",
    });
    h.repair();
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(h.counts()).toEqual({ effects: 1, reads: 1 });
  });
  it("unknown receipt never becomes business success even after accounting retry", async () => {
    const h = committedFixture({ unknown: true });
    const failure = await accountingFailure(h.session.submitCommittedOperation(h.permit));
    expect(failure.businessOutcome).toMatchObject({ ok: false, state: "reconciliation" });
    h.repair();
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(h.counts().effects).toBe(1);
  });
  it("post-await grant revocation remains fail-closed with unknown business result and blocks accounting recovery", async () => {
    const h = committedFixture({ revokeAfterReceipt: true });
    const failure = await accountingFailure(h.session.submitCommittedOperation(h.permit));
    expect(failure.businessOutcome).toMatchObject({ ok: false, state: "reconciliation" });
    h.repair();
    await expect(h.session.retryAccounting(failure)).rejects.toMatchObject({
      code: "grant_principal_mismatch",
    });
    expect(ledger(h, failure.leaseId).settled).toBe(0);
    expect(h.counts().effects).toBe(1);
  });
});

describe("owner accounting recovery trust boundary", () => {
  it("normal SDK settlement preserves the original success contract", async () => {
    const h = sdkFixture({ settlementFault: false });
    const outcome = await h.session.submitTurn({ text: "normal turn" });
    expect(outcome).toMatchObject({ ok: true, state: "settled" });
    if (!outcome.ok) throw new Error("expected original success");
    const record = JSON.parse(readFileSync(h.session.operationsPath, "utf8")).operations[
      outcome.operationId
    ];
    expect(record.budget_accounting_state).toBe("settled");
    expect(ledger(h, record.budget_lease_id).settled).toBe(1);
  });
  it("registered session restart cannot consume the old live failure or redrive pending accounting", async () => {
    const h = sdkFixture();
    const failure = await accountingFailure(h.session.submitTurn({ text: "restart turn" }));
    h.session.release();
    const storageAdmission = openRegisteredOwnerStorage(h.base);
    const restarted = new LocalMerchantOwnerSession({
      ...h.base,
      storageAdmission,
      budgetGate: h.budget.budgetGate,
      sdkRuntime: h.sdkRuntime,
    });
    cleanup.push(() => restarted.release());
    await expect(restarted.retryAccounting(failure)).rejects.toMatchObject({
      code: "accounting_recovery_unknown",
    });
    expect(await restarted.submitTurn({ text: "restart turn" })).toMatchObject({
      ok: false,
      code: "owner_accounting_reconciliation",
    });
    expect(ledger(h, failure.leaseId).settled).toBe(0);
    expect(h.provider.state.callCount).toBe(1);
  });
  it("committed recovery revalidates the actual WebAuthn credential authority before accounting", async () => {
    const h = committedFixture();
    const failure = await accountingFailure(h.session.submitCommittedOperation(h.permit));
    h.repair();
    expect(
      h.confirmations.revokeCredential("offline-credential", merchantId, "offline-actor"),
    ).toBe(true);
    await expect(h.session.retryAccounting(failure)).rejects.toThrow("committed_proof_invalid");
    expect(ledger(h, failure.leaseId).settled).toBe(0);
    expect(h.counts().effects).toBe(1);
  });
});

describe("owner accounting: known settlement survives journal failure", () => {
  it("a journal-only recovery never settles the already charged original lease twice", async () => {
    const h = sdkFixture({ settlementFault: false });
    const settle = h.budget.budgetGate.settle.bind(h.budget.budgetGate);
    let settlements = 0;
    h.budget.budgetGate.settle = async (input) => {
      settlements += 1;
      await settle(input); // Real persistent adapter succeeds before journal fault.
      chmodSync(h.dataDir, 0o500);
    };
    cleanup.push(() => chmodSync(h.dataDir, 0o700));
    const failure = await accountingFailure(
      h.session.submitTurn({ text: "journal-only recovery" }),
    );
    expect(failure.businessOutcome).toMatchObject({ ok: true, state: "settled" });
    expect(failure.budgetSettled).toBe(true);
    expect(failure.budgetError).toBeUndefined();
    expect(failure.journalErrors.length).toBeGreaterThan(0);
    const charged = ledger(h, failure.leaseId);
    expect(charged).toMatchObject({ settled: 1, actual: failure.usedTokens });
    expect(
      JSON.parse(readFileSync(h.session.operationsPath, "utf8")).operations[failure.operationId],
    ).toMatchObject({ state: "settled", budget_accounting_state: "pending" });
    chmodSync(h.dataDir, 0o700);
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(await h.session.retryAccounting(failure)).toEqual(failure.businessOutcome);
    expect(settlements).toBe(1);
    expect(ledger(h, failure.leaseId)).toEqual(charged);
    expect(h.provider.state.callCount).toBe(1);
    expect(
      JSON.parse(readFileSync(h.session.operationsPath, "utf8")).operations[failure.operationId]
        .budget_accounting_state,
    ).toBe("settled");
  });
});
