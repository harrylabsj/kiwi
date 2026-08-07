/**
 * Kiwi v1.1 Transaction Handoff（WP3）— OperatorApprovalAuthorizationProvider tests。
 *
 * 覆盖（对齐工作包验收清单）：
 *  - 审批证据→授权全链路：recordApproval → createIntentMandate → authorizeCheckout
 *    → 完成门禁通过（evidence.confirmed_at ≤ approved_at）；
 *  - 未确认 → requires_user，绝不自动授权；
 *  - 过期 / 吊销 / 底层候选 superseded / rejected → 授权失效（verified:false）；
 *  - §19 remote_revision 绑定：revision 变化即 stale；
 *  - 授权绑定：换 session / 换 terms 即失效；evidence 必须引用记录的审批；
 *  - write-gate 适配：WriteApprovalCandidate 生命周期桥接为审批状态源。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { writeApprovalStatusSource } from "../src/agent/write-gate.js";
import { createHandoffPackage } from "../src/handoff/package.js";
import { ManualHandoffChannel } from "../src/handoff/channel.js";
import { createUserConfirmationEvidence } from "../src/handoff/authorization.js";
import {
  OperatorApprovalAuthorizationProvider,
  operatorConfirmationEvidence,
  summarizeCheckoutSession,
  type OperatorApprovalRecord,
} from "../src/handoff/operator-approval.js";
import {
  AGREEMENT_ID,
  NEGOTIATION_ID,
  OFFER_ID_3,
  SKU,
} from "./negotiation-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-08-06T12:00:00Z";

const TERMS: TermSet = {
  items: [
    {
      sku: SKU,
      quantity: { value: 200, unit: "piece" },
      unit_price: { currency: "CNY", amount_minor: 85000 },
    },
  ],
  fulfillment_terms: { delivery_before: "2026-08-20T18:00:00Z" },
  valid_until: "2026-08-07T12:00:00Z",
};

const TERMS_2: TermSet = {
  items: [
    {
      sku: SKU,
      quantity: { value: 250, unit: "piece" },
      unit_price: { currency: "CNY", amount_minor: 83500 },
    },
  ],
};

const IDENTITY = { buyer_identity: "buyer-001", merchant_identity: "merchant-001" };
const CANDIDATE_DIGEST = contentDigest({ action: "approve_checkout", amount_minor: 85000 });
const POLICY_VERSION = "kiwi.handoff/1.0";

function makeAgreement(terms: TermSet = TERMS): AcceptedNonbindingAgreement {
  return {
    type: "accepted_nonbinding_agreement",
    agreement_id: AGREEMENT_ID,
    negotiation_id: NEGOTIATION_ID,
    accepted_offer_id: OFFER_ID_3,
    agreed_terms: structuredClone(terms),
    terms_digest: contentDigest(terms),
    accepted_by: ["buyer", "merchant"],
    created_at: "2026-08-05T12:30:00Z",
    binding_effect: "nonbinding",
    creates_order: false,
    reserves_inventory: false,
    authorizes_payment: false,
  };
}

function makePackage(terms: TermSet = TERMS): ReturnType<typeof createHandoffPackage> {
  return createHandoffPackage({
    agreement: makeAgreement(terms),
    identity: IDENTITY,
    capability_version: "ucp.checkout/1",
    created_at: NOW,
  });
}

interface SessionFixture {
  provider: OperatorApprovalAuthorizationProvider;
  channel: ManualHandoffChannel;
  sessionRef: string;
  sessionTerms: TermSet;
}

function sessionFixture(now: () => string = () => NOW): SessionFixture {
  const provider = new OperatorApprovalAuthorizationProvider({ now });
  const channel = new ManualHandoffChannel({ now, authorizationProvider: provider });
  const created = channel.createSession(makePackage());
  if (created.status !== "ok") throw new Error("create session failed");
  return {
    provider,
    channel,
    sessionRef: created.session_ref,
    sessionTerms: created.session.current_terms,
  };
}

function recordFor(
  provider: OperatorApprovalAuthorizationProvider,
  sessionRef: string,
  overrides: Record<string, unknown> = {},
): OperatorApprovalRecord {
  const approvalId = (overrides.approval_id as string) ?? "act_approval_1";
  const summary = summarizeCheckoutSession(
    {
      session_ref: sessionRef,
      current_terms_digest: contentDigest(TERMS),
      status: "created",
      updated_at: NOW,
    },
    (overrides.remote_revision as string) ?? "rev-1",
  );
  return provider.recordApproval({
    approval_id: approvalId,
    package: makePackage(),
    session: summary,
    candidate_digest: CANDIDATE_DIGEST,
    policy_version: POLICY_VERSION,
    ...(overrides.confirmed_at !== undefined
      ? { confirmed_at: overrides.confirmed_at as string }
      : {}),
    ...(overrides.ttl_ms !== undefined ? { ttl_ms: overrides.ttl_ms as number } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. 审批证据 → 授权全链路
// ---------------------------------------------------------------------------

describe("OperatorApprovalAuthorizationProvider full path", () => {
  it("confirms → mandate → authorization → completion gate passes", () => {
    const { provider, channel, sessionRef, sessionTerms } = sessionFixture();
    const approval = recordFor(provider, sessionRef);
    expect(approval.status).toBe("approved");
    expect(approval.package_digest).toMatch(/^sha256:/);
    expect(approval.candidate_digest).toBe(CANDIDATE_DIGEST);
    expect(approval.policy_version).toBe(POLICY_VERSION);

    const mandate = provider.createIntentMandate({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      terms: sessionTerms,
    });
    expect(mandate.status).toBe("ok");
    if (mandate.status !== "ok") return;
    expect(mandate.intent_mandate).toBe("act_approval_1");

    const checkout = provider.authorizeCheckout({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      intent_mandate: mandate.intent_mandate,
      evidence: operatorConfirmationEvidence(approval, () => NOW),
    });
    expect(checkout.status).toBe("ok");
    if (checkout.status !== "ok") return;
    const authz = checkout.authorization;
    expect(authz.session_ref).toBe(sessionRef);
    expect(authz.terms_digest).toBe(contentDigest(TERMS));
    expect(authz.intent_mandate).toBe("act_approval_1");
    expect(authz.evidence.kind).toBe("manual");
    expect(authz.evidence.reference).toBe("act_approval_1");
    expect(authz.evidence.confirmed_at <= authz.approved_at).toBe(true);
    expect(authz.expires_at).toBe(approval.expires_at);

    const result = channel.requestCompletion(sessionRef, authz);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session.status).toBe("completed");
  });

  it("evidence.confirmed_at MUST NOT be after approved_at", () => {
    const { provider, sessionRef } = sessionFixture();
    const approval = recordFor(provider, sessionRef, { confirmed_at: "2026-08-06T13:00:00Z" });
    const checkout = provider.authorizeCheckout({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      intent_mandate: approval.approval_id,
      evidence: createUserConfirmationEvidence(
        { kind: "manual", reference: approval.approval_id, confirmed_at: "2026-08-06T13:00:00Z" },
        () => NOW,
      ),
    });
    // NOW (approved_at) is before confirmed_at 13:00 → fail closed.
    expect(checkout.status).toBe("fail_closed");
    if (checkout.status === "fail_closed") {
      expect(checkout.reason).toMatch(/confirmed_at MUST NOT be after approved_at/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 未确认 / 超时 → requires_user，绝不自动授权
// ---------------------------------------------------------------------------

describe("OperatorApprovalAuthorizationProvider requires explicit confirmation", () => {
  it("createIntentMandate with no recorded approval → requires_user", () => {
    const { provider, sessionRef, sessionTerms } = sessionFixture();
    const result = provider.createIntentMandate({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      terms: sessionTerms,
    });
    expect(result.status).toBe("requires_user");
    if (result.status === "requires_user") {
      expect(result.reason).toMatch(/operator approval required/);
    }
  });

  it("verifyIntentMandate for an unknown approval → verified:false", () => {
    const { provider, sessionRef } = sessionFixture();
    const result = provider.verifyIntentMandate("act_never_approved", {
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
    });
    expect(result.verified).toBe(false);
  });

  it("an expired approval is treated as unconfirmed → requires_user / verified:false", () => {
    let clock = NOW;
    const { provider, sessionRef, sessionTerms } = sessionFixture(() => clock);
    recordFor(provider, sessionRef, { ttl_ms: 1000 }); // expires 12:00:01Z
    clock = "2026-08-06T12:00:02Z"; // past expiry

    const mandate = provider.createIntentMandate({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      terms: sessionTerms,
    });
    expect(mandate.status).toBe("requires_user");

    const verify = provider.verifyIntentMandate("act_approval_1", {
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/expired/);

    const checkout = provider.authorizeCheckout({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      intent_mandate: "act_approval_1",
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "act_approval_1" }, () => clock),
    });
    expect(checkout.status).toBe("fail_closed");
  });
});

// ---------------------------------------------------------------------------
// 3. 吊销 / stale → 授权失效
// ---------------------------------------------------------------------------

describe("OperatorApprovalAuthorizationProvider revocation & staleness", () => {
  it("an explicitly revoked approval fails verification", () => {
    const { provider, sessionRef } = sessionFixture();
    const approval = recordFor(provider, sessionRef);
    provider.revokeApproval(approval.approval_id);

    const verify = provider.verifyIntentMandate(approval.approval_id, {
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/revoked/);

    // No usable approval remains → createIntentMandate requires user again.
    const mandate = provider.createIntentMandate({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      terms: TERMS,
    });
    expect(mandate.status).toBe("requires_user");
  });

  it("remote_revision change → approval stale (§19 binding)", () => {
    let currentRev = "rev-1";
    const provider = new OperatorApprovalAuthorizationProvider({
      now: () => NOW,
      currentRevision: () => currentRev,
    });
    const channel = new ManualHandoffChannel({ now: () => NOW, authorizationProvider: provider });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const approval = recordFor(provider, created.session_ref, { remote_revision: "rev-1" });

    // Confirmed against rev-1, then the remote checkout moves to rev-2.
    currentRev = "rev-2";
    const verify = provider.verifyIntentMandate(approval.approval_id, {
      session_ref: created.session_ref,
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/remote revision changed/);
  });

  it("an approval bound to a different session fails verification", () => {
    const { provider, sessionRef } = sessionFixture();
    const approval = recordFor(provider, sessionRef);
    const verify = provider.verifyIntentMandate(approval.approval_id, {
      session_ref: "hs_other_session",
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/session_ref/);
  });

  it("an approval bound to different terms fails verification", () => {
    const { provider, sessionRef } = sessionFixture();
    const approval = recordFor(provider, sessionRef);
    const verify = provider.verifyIntentMandate(approval.approval_id, {
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS_2),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/terms_digest/);
  });

  it("authorizeCheckout rejects evidence that does not reference the recorded approval", () => {
    const { provider, sessionRef } = sessionFixture();
    const approval = recordFor(provider, sessionRef);
    const checkout = provider.authorizeCheckout({
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      intent_mandate: approval.approval_id,
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "act_someone_else" }, () => NOW),
    });
    expect(checkout.status).toBe("fail_closed");
    if (checkout.status === "fail_closed") {
      expect(checkout.reason).toMatch(/does not reference the recorded operator approval/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. WriteApprovalCandidate 生命周期桥接（write-gate 接缝）
// ---------------------------------------------------------------------------

describe("OperatorApprovalAuthorizationProvider × WriteApprovalCandidate", () => {
  const PRINCIPAL = "buyer-001";

  function candidateStore() {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, NOW, NOW);
    const store = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => NOW });
    return { db, store };
  }

  it("a pending candidate is not usable; approved is usable; superseded invalidates", () => {
    const { store } = candidateStore();
    const provider = new OperatorApprovalAuthorizationProvider({
      now: () => NOW,
      statusSource: writeApprovalStatusSource(store),
    });
    const channel = new ManualHandoffChannel({ now: () => NOW, authorizationProvider: provider });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");

    const candidate = store.create({
      tool: "approve_checkout",
      arguments: { order_amount_minor: 85000 },
      preconditions: { session_ref: created.session_ref, terms_digest: contentDigest(TERMS) },
      risk: "checkout_authorization",
      expires_at: "2026-08-06T13:00:00Z",
    });
    recordFor(provider, created.session_ref, { approval_id: candidate.candidate_id });

    // pending_approval → not usable.
    expect(
      provider.verifyIntentMandate(candidate.candidate_id, {
        session_ref: created.session_ref,
        terms_digest: contentDigest(TERMS),
      }).verified,
    ).toBe(false);

    // Operator approves → usable.
    store.markApproved(candidate.candidate_id);
    expect(
      provider.verifyIntentMandate(candidate.candidate_id, {
        session_ref: created.session_ref,
        terms_digest: contentDigest(TERMS),
      }).verified,
    ).toBe(true);

    // Candidate superseded (§19 any binding change → STALE) → invalid again.
    store.supersede(candidate.candidate_id);
    const verify = provider.verifyIntentMandate(candidate.candidate_id, {
      session_ref: created.session_ref,
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/superseded/);
  });

  it("an unknown candidate in the status source fails closed", () => {
    const { store } = candidateStore();
    const provider = new OperatorApprovalAuthorizationProvider({
      now: () => NOW,
      statusSource: writeApprovalStatusSource(store),
    });
    const channel = new ManualHandoffChannel({ now: () => NOW, authorizationProvider: provider });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");

    recordFor(provider, created.session_ref, { approval_id: "act_not_in_store" });
    const verify = provider.verifyIntentMandate("act_not_in_store", {
      session_ref: created.session_ref,
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(false);
    if (!verify.verified) expect(verify.reason).toMatch(/unknown/);
  });

  it("persistDir：审批记录落 JSONL，重启后恢复（record + revoke 重放）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-opappr-"));

    const provider = new OperatorApprovalAuthorizationProvider({ now: () => NOW, persistDir: dir });
    const channel = new ManualHandoffChannel({ now: () => NOW, authorizationProvider: provider });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create session failed");
    const summary = summarizeCheckoutSession(
      {
        session_ref: created.session_ref,
        current_terms_digest: contentDigest(TERMS),
        status: "created",
        updated_at: NOW,
      },
      "rev-1",
    );
    provider.recordApproval({
      approval_id: "act_persist_1",
      package: makePackage(),
      session: summary,
      candidate_digest: CANDIDATE_DIGEST,
      policy_version: POLICY_VERSION,
    });

    // 重启：新 provider 从 JSONL 重放，审批仍在（含 revoked 状态）。
    const revived = new OperatorApprovalAuthorizationProvider({
      now: () => NOW,
      persistDir: dir,
    });
    expect(revived.getApproval("act_persist_1")?.status).toBe("approved");
    const verify = revived.verifyIntentMandate("act_persist_1", {
      session_ref: created.session_ref,
      terms_digest: contentDigest(TERMS),
    });
    expect(verify.verified).toBe(true);

    // revoke 同样持久化。
    revived.revokeApproval("act_persist_1");
    const revivedAgain = new OperatorApprovalAuthorizationProvider({
      now: () => NOW,
      persistDir: dir,
    });
    expect(revivedAgain.getApproval("act_persist_1")?.status).toBe("revoked");
  });
});
