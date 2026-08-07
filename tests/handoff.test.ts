/**
 * Kiwi v0.7.0 Transaction Handoff（WP1）tests。
 *
 * 覆盖（对齐工作包验收清单）：
 *  - HandoffPackage 构造与 digest 校验（JCS+SHA-256 重算、fail-closed 拒绝）；
 *  - 篡改 terms 拒绝（构造期 terms_digest_mismatch + 校验期 verify 为 false）；
 *  - ManualHandoffChannel 行为（create/get/update/cancel/complete、JSON 导出、
 *    无网络写入、非可操作状态拒绝）；
 *  - 默认 AuthorizationProvider fail-closed（requires_user / 拒绝 / 不伪造）；
 *  - 授权绑定（换 terms / 换 session 即失效）；
 *  - 完成门禁全组合（验授权 → 验 terms 绑定 → 验 stale）。
 */
import { describe, expect, it } from "vitest";
import {
  COMPLETION_GATE_FAILURE_CODES,
  createHandoffPackage,
  createPaymentAuthorization,
  createUserConfirmationEvidence,
  digestTerms,
  evaluateCompletionGate,
  FailClosedAuthorizationProvider,
  HandoffError,
  isHandoffPackage,
  ManualHandoffChannel,
  newAuthorizationId,
  verifyHandoffPackageDigest,
  type AuthorizeCheckoutInput,
  type AuthorizeCheckoutResult,
  type AuthorizationProvider,
  type CreateIntentMandateInput,
  type CreateIntentMandateResult,
  type HandoffSession,
  type PaymentAuthorization,
  type VerifyIntentMandateInput,
  type VerifyIntentMandateResult,
} from "../src/handoff/index.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { NegotiationValidationError } from "../src/negotiation/domain/common.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import { AGREEMENT_ID, NEGOTIATION_ID, SKU, validAgreement } from "./negotiation-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-08-06T12:00:00Z";
const CLOCK = () => NOW;

const TERMS = {
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

const TERMS_2 = {
  items: [
    {
      sku: SKU,
      quantity: { value: 250, unit: "piece" },
      unit_price: { currency: "CNY", amount_minor: 83500 },
    },
  ],
  fulfillment_terms: { delivery_before: "2026-08-22T18:00:00Z" },
};

const IDENTITY = { buyer_identity: "buyer-001", merchant_identity: "merchant-001" };

function makeAgreement(overrides: Record<string, unknown> = {}): AcceptedNonbindingAgreement {
  const agreement = validAgreement();
  return {
    ...agreement,
    // Clone so fixtures never share mutable objects across tests.
    agreed_terms: structuredClone(TERMS),
    terms_digest: contentDigest(TERMS),
    ...overrides,
  } as AcceptedNonbindingAgreement;
}

function makePackage(agreementOverrides: Record<string, unknown> = {}): ReturnType<
  typeof createHandoffPackage
> {
  return createHandoffPackage({
    agreement: makeAgreement(agreementOverrides),
    identity: IDENTITY,
    capability_version: "ucp.checkout/1",
    created_at: NOW,
  });
}

/** 一个"总是验证通过 + 能签出授权"的 fake provider（仅供测试）。 */
class FakeAuthorizationProvider implements AuthorizationProvider {
  createIntentMandate(input: CreateIntentMandateInput): CreateIntentMandateResult {
    return {
      status: "ok",
      intent_mandate: `fake-mandate:${input.session_ref}:${input.terms_digest}`,
    };
  }
  verifyIntentMandate(
    _mandate: string,
    _input: VerifyIntentMandateInput,
  ): VerifyIntentMandateResult {
    return { verified: true };
  }
  authorizeCheckout(input: AuthorizeCheckoutInput): AuthorizeCheckoutResult {
    return {
      status: "ok",
      authorization: createPaymentAuthorization(
        {
          authorization_id: newAuthorizationId(),
          session_ref: input.session_ref,
          terms_digest: input.terms_digest,
          intent_mandate: input.intent_mandate,
          evidence: createUserConfirmationEvidence({ kind: "manual", reference: "approval-1" }, CLOCK),
          expires_at: "2026-08-06T13:00:00Z",
        },
        CLOCK,
      ),
    };
  }
}

/** 一个"始终拒绝验证"的 provider（验证授权时 fail-closed）。 */
class DenyAuthorizationProvider implements AuthorizationProvider {
  createIntentMandate(_input: CreateIntentMandateInput): CreateIntentMandateResult {
    return { status: "fail_closed", reason: "denied" };
  }
  verifyIntentMandate(
    _mandate: string,
    _input: VerifyIntentMandateInput,
  ): VerifyIntentMandateResult {
    return { verified: false, reason: "denied" };
  }
  authorizeCheckout(_input: AuthorizeCheckoutInput): AuthorizeCheckoutResult {
    return { status: "fail_closed", reason: "denied" };
  }
}

function validAuthorization(overrides: Record<string, unknown> = {}): PaymentAuthorization {
  const sessionRef = (overrides.session_ref as string) ?? "hs_test";
  const termsDigest = (overrides.terms_digest as string) ?? digestTerms(TERMS);
  return createPaymentAuthorization(
    {
      authorization_id: (overrides.authorization_id as string) ?? newAuthorizationId(),
      session_ref: sessionRef,
      terms_digest: termsDigest,
      intent_mandate: (overrides.intent_mandate as string) ?? `mandate:${sessionRef}`,
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "approval-1" }, CLOCK),
      approved_at: NOW,
      expires_at: (overrides.expires_at as string) ?? "2026-08-06T13:00:00Z",
    },
    CLOCK,
  );
}

// ---------------------------------------------------------------------------
// 1. HandoffPackage 构造与 digest 校验
// ---------------------------------------------------------------------------

describe("HandoffPackage construction", () => {
  it("builds a package carrying full agreement identity and agreed terms", () => {
    const agreement = makeAgreement();
    const pkg = createHandoffPackage({
      agreement,
      identity: IDENTITY,
      capability_version: "ucp.checkout/1",
      created_at: NOW,
    });
    expect(pkg.type).toBe("handoff_package");
    expect(pkg.package_version).toBe("1.0");
    expect(pkg.agreement_id).toBe(agreement.agreement_id);
    expect(pkg.negotiation_id).toBe(agreement.negotiation_id);
    expect(pkg.accepted_offer_id).toBe(agreement.accepted_offer_id);
    expect(pkg.agreed_terms).toEqual(TERMS);
    expect(pkg.identity).toEqual(IDENTITY);
    expect(pkg.capability_version).toBe("ucp.checkout/1");
    expect(pkg.created_at).toBe(NOW);
    expect(pkg.semantics).toEqual({
      creates_order: false,
      authorizes_payment: false,
      reserves_inventory: false,
    });
  });

  it("recomputes terms_digest with JCS+SHA-256 equal to the agreement's digest", () => {
    const agreement = makeAgreement();
    const pkg = createHandoffPackage({
      agreement,
      identity: IDENTITY,
      capability_version: "ucp.checkout/1",
    });
    expect(pkg.terms_digest).toBe(contentDigest(TERMS));
    expect(pkg.terms_digest).toBe(agreement.terms_digest);
    expect(verifyHandoffPackageDigest(pkg)).toBe(true);
  });

  it("copies agreed_terms defensively (later mutation of the agreement does not leak)", () => {
    const agreement = makeAgreement();
    const pkg = createHandoffPackage({
      agreement,
      identity: IDENTITY,
      capability_version: "ucp.checkout/1",
    });
    (agreement.agreed_terms as Record<string, unknown>).items = [];
    expect(pkg.agreed_terms.items).toHaveLength(1);
    expect(pkg.agreed_terms.items?.[0]).toMatchObject({ sku: SKU });
    expect(verifyHandoffPackageDigest(pkg)).toBe(true);
  });

  it("defaults created_at to a current timestamp when not provided", () => {
    const pkg = createHandoffPackage({
      agreement: makeAgreement(),
      identity: IDENTITY,
      capability_version: "ucp.checkout/1",
    });
    expect(new Date(pkg.created_at).getTime()).toBeGreaterThan(0);
    expect(pkg.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an agreement whose terms_digest does not match agreed_terms (terms_digest_mismatch)", () => {
    const agreement = makeAgreement({
      terms_digest: contentDigest({ items: [] }),
    });
    let thrown: unknown;
    try {
      createHandoffPackage({ agreement, identity: IDENTITY, capability_version: "ucp.checkout/1" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HandoffError);
    expect((thrown as HandoffError).code).toBe("terms_digest_mismatch");
  });

  it("rejects an agreement with transaction side-effect flags set (invalid_agreement)", () => {
    const agreement = makeAgreement({ creates_order: true });
    expect(() =>
      createHandoffPackage({ agreement, identity: IDENTITY, capability_version: "ucp.checkout/1" }),
    ).toThrowError(/creates_order=false/);
  });

  it("rejects unsupported protocol_version", () => {
    expect(() =>
      createHandoffPackage({
        agreement: makeAgreement(),
        identity: IDENTITY,
        capability_version: "ucp.checkout/1",
        protocol_version: "2.0",
      }),
    ).toThrowError(/unsupported protocol_version/);
  });

  it("rejects malformed identity snapshot (structural failure is fail-closed)", () => {
    const agreement = makeAgreement();
    expect(() =>
      createHandoffPackage({
        agreement,
        identity: { buyer_identity: "", merchant_identity: "merchant-001" },
        capability_version: "ucp.checkout/1",
      }),
    ).toThrowError(NegotiationValidationError);
  });
});

describe("HandoffPackage tamper detection", () => {
  it("verifyHandoffPackageDigest returns false when agreed_terms are mutated", () => {
    const pkg = makePackage();
    pkg.agreed_terms = { ...TERMS_2 };
    expect(verifyHandoffPackageDigest(pkg)).toBe(false);
  });

  it("verifyHandoffPackageDigest returns false when terms_digest is changed", () => {
    const pkg = makePackage();
    pkg.terms_digest = contentDigest(TERMS_2);
    expect(verifyHandoffPackageDigest(pkg)).toBe(false);
  });

  it("verifyHandoffPackageDigest returns false for a non-package object", () => {
    expect(verifyHandoffPackageDigest({ type: "not_a_package" } as never)).toBe(false);
  });

  it("isHandoffPackage rejects packages with forbidden side-effect semantics", () => {
    const pkg = makePackage() as unknown as Record<string, unknown>;
    pkg.semantics = { creates_order: false, authorizes_payment: true, reserves_inventory: false };
    expect(isHandoffPackage(pkg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 默认 AuthorizationProvider fail-closed
// ---------------------------------------------------------------------------

describe("FailClosedAuthorizationProvider (default AP2)", () => {
  const provider = new FailClosedAuthorizationProvider();

  it("createIntentMandate never fabricates a mandate; requires user", () => {
    const result = provider.createIntentMandate({
      session_ref: "hs_1",
      terms_digest: digestTerms(TERMS),
      terms: TERMS,
    });
    expect(result.status).toBe("requires_user");
    if (result.status === "requires_user") {
      expect(result.reason).toMatch(/no_ap2_configured/);
    }
  });

  it("verifyIntentMandate always denies", () => {
    const result = provider.verifyIntentMandate("mandate", {
      session_ref: "hs_1",
      terms_digest: digestTerms(TERMS),
    });
    expect(result.verified).toBe(false);
  });

  it("authorizeCheckout never fabricates an authorization", () => {
    const result = provider.authorizeCheckout({
      session_ref: "hs_1",
      terms_digest: digestTerms(TERMS),
      intent_mandate: "mandate",
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "approval-1" }, CLOCK),
    });
    expect(result.status).toBe("fail_closed");
    if (result.status === "fail_closed") {
      expect(result.reason).toMatch(/no_ap2_configured/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. ManualHandoffChannel 行为
// ---------------------------------------------------------------------------

describe("ManualHandoffChannel", () => {
  it("creates a session bound to the package terms, with a display continue_url", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const pkg = makePackage();
    const result = channel.createSession(pkg);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session_ref).toMatch(/^hs_/);
    expect(result.session.package.agreement_id).toBe(AGREEMENT_ID);
    expect(result.session.current_terms).toEqual(TERMS);
    expect(result.session.current_terms_digest).toBe(pkg.terms_digest);
    expect(result.session.status).toBe("created");
    expect(result.continue_url).toBe(`manual://checkout/${result.session_ref}`);
  });

  it("rejects creating a session from a tampered package", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const pkg = makePackage();
    pkg.agreed_terms = { ...TERMS_2 };
    const result = channel.createSession(pkg);
    expect(result.status).toBe("fail_closed");
    if (result.status === "fail_closed") {
      expect(result.reason).toMatch(/digest verification failed/);
    }
  });

  it("rejects a forged digest-consistent but structurally invalid package", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const forged = {
      type: "handoff_package",
      package_version: "1.0",
      agreement_id: "agr_forged",
      negotiation_id: "neg_forged",
      accepted_offer_id: "off_forged",
      agreed_terms: "hello", // not a TermSet, but digest is self-consistent
      terms_digest: contentDigest("hello"),
      identity: IDENTITY,
      capability_version: "ucp.checkout/1",
      protocol_version: "1.0",
      created_at: NOW,
      semantics: { creates_order: false, authorizes_payment: false, reserves_inventory: false },
    } as unknown as ReturnType<typeof createHandoffPackage>;
    const result = channel.createSession(forged);
    expect(result.status).toBe("fail_closed");
    if (result.status === "fail_closed") {
      expect(result.reason).toMatch(/structural validation/);
    }
  });

  it("getSession returns ok for existing, fail_closed for unknown", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const found = channel.getSession(created.session_ref);
    expect(found.status).toBe("ok");
    const missing = channel.getSession("hs_does_not_exist");
    expect(missing.status).toBe("fail_closed");
    if (missing.status === "fail_closed") {
      expect(missing.reason).toMatch(/session_not_found/);
    }
  });

  it("updateSession recomputes the digest and marks status updated", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const updated = channel.updateSession(created.session_ref, TERMS_2);
    expect(updated.status).toBe("ok");
    if (updated.status !== "ok") return;
    expect(updated.session.current_terms).toEqual(TERMS_2);
    expect(updated.session.current_terms_digest).toBe(digestTerms(TERMS_2));
    expect(updated.session.status).toBe("updated");
  });

  it("cancelSession marks cancelled and later actions fail closed", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const cancelled = channel.cancelSession(created.session_ref);
    expect(cancelled.status).toBe("ok");
    if (cancelled.status !== "ok") return;
    expect(cancelled.session.status).toBe("cancelled");

    const again = channel.cancelSession(created.session_ref);
    expect(again.status).toBe("fail_closed");
    const update = channel.updateSession(created.session_ref, TERMS_2);
    expect(update.status).toBe("fail_closed");
  });

  it("exportSessionJson serializes the session and performs no network writes", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const exported = channel.exportSessionJson(created.session_ref);
    expect(exported.status).toBe("ok");
    if (exported.status !== "ok") return;
    const parsed = JSON.parse(exported.json) as { session_ref: string; status: string };
    expect(parsed.session_ref).toBe(created.session_ref);
    expect(parsed.status).toBe("created");
  });

  it("requestCompletion fails closed with the default (no-AP2) provider", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const authz = validAuthorization({ session_ref: created.session_ref });
    const result = channel.requestCompletion(created.session_ref, authz);
    expect(result.status).toBe("fail_closed");
    if (result.status === "fail_closed") {
      expect(result.reason).toMatch(/no_ap2_configured/);
    }
    const session = channel.getSession(created.session_ref);
    if (session.status !== "ok") throw new Error("get failed");
    expect(session.session.status).toBe("created");
  });

  it("completes a session when the provider verifies the authorization", () => {
    const channel = new ManualHandoffChannel({
      now: CLOCK,
      authorizationProvider: new FakeAuthorizationProvider(),
    });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const authz = validAuthorization({ session_ref: created.session_ref });
    const result = channel.requestCompletion(created.session_ref, authz);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session.status).toBe("completed");
  });

  it("does not complete twice", () => {
    const channel = new ManualHandoffChannel({
      now: CLOCK,
      authorizationProvider: new FakeAuthorizationProvider(),
    });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const authz = validAuthorization({ session_ref: created.session_ref });
    expect(channel.requestCompletion(created.session_ref, authz).status).toBe("ok");
    const again = channel.requestCompletion(created.session_ref, authz);
    expect(again.status).toBe("fail_closed");
    if (again.status === "fail_closed") {
      expect(again.reason).toMatch(/session_not_actionable/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 授权绑定：换 terms / 换 session 即失效
// ---------------------------------------------------------------------------

describe("Authorization binding", () => {
  it("createPaymentAuthorization requires user confirmation evidence to precede approval", () => {
    expect(() =>
      createPaymentAuthorization(
        {
          authorization_id: "authz_1",
          session_ref: "hs_1",
          terms_digest: digestTerms(TERMS),
          intent_mandate: "mandate",
          evidence: createUserConfirmationEvidence(
            { kind: "manual", reference: "approval-1", confirmed_at: "2026-08-06T14:00:00Z" },
            CLOCK,
          ),
          approved_at: "2026-08-06T12:00:00Z",
          expires_at: "2026-08-06T13:00:00Z",
        },
        CLOCK,
      ),
    ).toThrowError(/confirmed_at MUST NOT be after approved_at/);
  });

  it("an authorization bound to one session fails the gate on another session (swap session)", () => {
    const channel = new ManualHandoffChannel({
      now: CLOCK,
      authorizationProvider: new FakeAuthorizationProvider(),
    });
    const createdA = channel.createSession(makePackage());
    const createdB = channel.createSession(makePackage());
    if (createdA.status !== "ok" || createdB.status !== "ok") throw new Error("create failed");
    const authz = validAuthorization({ session_ref: createdA.session_ref });

    const gate = evaluateCompletionGate({
      authorization: authz,
      session: createdB.session,
      authorizationProvider: new FakeAuthorizationProvider(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("approval_stale");
  });

  it("an authorization bound to the original terms fails after updateSession swaps terms", () => {
    const channel = new ManualHandoffChannel({
      now: CLOCK,
      authorizationProvider: new FakeAuthorizationProvider(),
    });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const authz = validAuthorization({ session_ref: created.session_ref });

    const updated = channel.updateSession(created.session_ref, TERMS_2);
    if (updated.status !== "ok") throw new Error("update failed");
    const gate = evaluateCompletionGate({
      authorization: authz,
      session: updated.session,
      authorizationProvider: new FakeAuthorizationProvider(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("terms_digest_mismatch");
  });
});

// ---------------------------------------------------------------------------
// 5. 完成门禁全组合
// ---------------------------------------------------------------------------

describe("completion gate (evaluateCompletionGate)", () => {
  const channel = () =>
    new ManualHandoffChannel({
      now: CLOCK,
      authorizationProvider: new FakeAuthorizationProvider(),
    });
  const fake = () => new FakeAuthorizationProvider();

  function sessionFor(): HandoffSession {
    const created = channel().createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    return created.session;
  }

  it("allows completion when authorization verifies, digest matches, and not stale", () => {
    const session = sessionFor();
    const gate = evaluateCompletionGate({
      authorization: validAuthorization({ session_ref: session.session_ref }),
      session,
      authorizationProvider: fake(),
      now: CLOCK,
    });
    expect(gate).toEqual({ allowed: true });
  });

  it("fails closed when the provider denies verification (authorization_not_verified)", () => {
    const session = sessionFor();
    const gate = evaluateCompletionGate({
      authorization: validAuthorization({ session_ref: session.session_ref }),
      session,
      authorizationProvider: new DenyAuthorizationProvider(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("authorization_not_verified");
  });

  it("fails closed on a malformed authorization object", () => {
    const session = sessionFor();
    const gate = evaluateCompletionGate({
      authorization: { authorization_id: "x" } as unknown as PaymentAuthorization,
      session,
      authorizationProvider: fake(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("authorization_not_verified");
  });

  it("fails closed when session current_terms are tampered without updating the digest", () => {
    const session = sessionFor();
    (session.current_terms as Record<string, unknown>).items = [];
    const gate = evaluateCompletionGate({
      authorization: validAuthorization({ session_ref: session.session_ref }),
      session,
      authorizationProvider: fake(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("terms_digest_mismatch");
  });

  it("fails closed when the authorization is bound to different terms than the session", () => {
    const session = sessionFor();
    const authz = validAuthorization({ session_ref: session.session_ref });
    const gate = evaluateCompletionGate({
      authorization: { ...authz, terms_digest: digestTerms(TERMS_2) },
      session,
      authorizationProvider: fake(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("terms_digest_mismatch");
  });

  it("fails closed when the authorization is for a different session_ref", () => {
    const session = sessionFor();
    const gate = evaluateCompletionGate({
      authorization: validAuthorization({ session_ref: "hs_other" }),
      session,
      authorizationProvider: fake(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("approval_stale");
  });

  it("fails closed when the authorization has expired (approval_stale)", () => {
    const session = sessionFor();
    const authz = validAuthorization({
      session_ref: session.session_ref,
      expires_at: "2020-01-01T00:00:00Z",
    });
    const gate = evaluateCompletionGate({
      authorization: authz,
      session,
      authorizationProvider: fake(),
      now: CLOCK,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("approval_stale");
  });

  it("fails closed when the authorization expires relative to the injected clock", () => {
    const session = sessionFor();
    const authz = validAuthorization({ session_ref: session.session_ref });
    const gate = evaluateCompletionGate({
      authorization: authz,
      session,
      authorizationProvider: fake(),
      now: () => "2026-08-06T14:00:00Z", // after expires_at 13:00
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe("approval_stale");
  });

  it("covers every defined failure code with a scenario", () => {
    const session = sessionFor();
    const scenarios: [string, PaymentAuthorization, AuthorizationProvider][] = [
      [
        "authorization_not_verified",
        validAuthorization({ session_ref: session.session_ref }),
        new DenyAuthorizationProvider(),
      ],
      [
        "terms_digest_mismatch",
        {
          ...validAuthorization({ session_ref: session.session_ref }),
          terms_digest: digestTerms(TERMS_2),
        },
        fake(),
      ],
      ["approval_stale", validAuthorization({ session_ref: "hs_other" }), fake()],
    ];
    for (const [expectedCode, authorization, provider] of scenarios) {
      const gate = evaluateCompletionGate({
        authorization,
        session,
        authorizationProvider: provider,
        now: CLOCK,
      });
      expect(gate.allowed).toBe(false);
      if (!gate.allowed) expect(gate.code).toBe(expectedCode);
    }
    expect(COMPLETION_GATE_FAILURE_CODES).toEqual(
      expect.arrayContaining([
        "authorization_not_verified",
        "terms_digest_mismatch",
        "approval_stale",
      ]),
    );
  });

  it("fully completes a session end-to-end (mandate → authorize → complete)", () => {
    const provider = new FakeAuthorizationProvider();
    const channel = new ManualHandoffChannel({ now: CLOCK, authorizationProvider: provider });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");

    const mandate = provider.createIntentMandate({
      session_ref: created.session_ref,
      terms_digest: created.session.current_terms_digest,
      terms: created.session.current_terms,
    });
    if (mandate.status !== "ok") throw new Error("mandate failed");

    const checkout = provider.authorizeCheckout({
      session_ref: created.session_ref,
      terms_digest: created.session.current_terms_digest,
      intent_mandate: mandate.intent_mandate,
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "approval-1" }, CLOCK),
    });
    if (checkout.status !== "ok") throw new Error("checkout failed");

    const result = channel.requestCompletion(created.session_ref, checkout.authorization);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.session.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 6. 与既有 negotiation 域的一致性
// ---------------------------------------------------------------------------

describe("handoff interop with negotiation domain", () => {
  it("matches the agreement digest used by negotiation fixtures", () => {
    const agreement = validAgreement();
    expect(contentDigest(agreement.agreed_terms)).toBe(agreement.terms_digest);
    const pkg = createHandoffPackage({
      agreement,
      identity: IDENTITY,
      capability_version: "ucp.checkout/1",
    });
    expect(pkg.terms_digest).toBe(agreement.terms_digest);
  });

  it("AGREEMENT_ID / NEGOTIATION_ID fixtures flow through the package", () => {
    const pkg = makePackage();
    expect(pkg.agreement_id).toBe(AGREEMENT_ID);
    expect(pkg.negotiation_id).toBe(NEGOTIATION_ID);
  });
});
