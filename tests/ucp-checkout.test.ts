/**
 * Kiwi v0.7.0 Transaction Handoff（WP2）— UcpCheckoutChannel tests。
 *
 * 覆盖（对齐工作包验收清单）：
 *  - createSession：HandoffPackage.agreed_terms → UCP line_items（Money minor
 *    units 直传、quantity 正整数校验）；expires_at 缺省 +6h；
 *  - 全生命周期：create → incomplete → update（全量替换 PUT）→ ready → complete；
 *  - 状态映射：requires_escalation → requires_user + continue_url；ucp.status=error
 *    各 severity 分支（unrecoverable → fail_closed；requires_* → requires_user；
 *    recoverable → fail_closed(retryable)；空 messages → fail_closed）；
 *  - totals 校验：sum 不符 → 拒绝完成（totals_mismatch，不修改不替代）；相符 → 放行；
 *  - 过期会话（getSession / updateSession / requestCompletion → session_expired）；
 *  - 网络面：SSRF（构造期 + DNS 复查）、超时、畸形、非 2xx 与 error envelope 共存；
 *  - complete 只在完成门禁通过时发出（拦截断言：deny provider 不发 complete、
 *    pass provider 只带 authorization_reference）；
 *  - UCP-Agent profile 头携带（RFC 8941 Dictionary）；
 *  - findCheckoutEndpoint / profile 构造 channel。
 */
import { describe, expect, it } from "vitest";
import {
  createHandoffPackage,
  createPaymentAuthorization,
  createUserConfirmationEvidence,
  digestTerms,
  HandoffError,
  newAuthorizationId,
  type AuthorizeCheckoutInput,
  type AuthorizeCheckoutResult,
  type AuthorizationProvider,
  type CreateIntentMandateInput,
  type CreateIntentMandateResult,
  type PaymentAuthorization,
  type VerifyIntentMandateInput,
  type VerifyIntentMandateResult,
} from "../src/handoff/index.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import {
  AGREEMENT_ID,
  NEGOTIATION_ID,
  OFFER_ID_3,
  SKU,
} from "./negotiation-helpers.js";
import {
  UcpCheckoutChannel,
  findCheckoutEndpoint,
  type UcpCheckoutChannelOptions,
} from "../src/handoff/ucp-checkout/index.js";
import type { UcpMessageSeverity, UcpMessageType } from "../src/handoff/ucp-checkout/index.js";
import type { UcpProfile } from "../src/discovery/ucp/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-08-06T12:00:00Z";
const CLOCK = () => NOW;

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

/** 一个"总是验证通过"的 fake provider（仅供测试：验证 pass、不伪造 mandate）。 */
class FakeAuthorizationProvider implements AuthorizationProvider {
  createIntentMandate(input: CreateIntentMandateInput): CreateIntentMandateResult {
    return {
      status: "ok",
      intent_mandate: `fake-mandate:${input.session_ref}:${input.terms_digest}`,
    };
  }
  verifyIntentMandate(_mandate: string, _input: VerifyIntentMandateInput): VerifyIntentMandateResult {
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

function validAuthorization(overrides: Record<string, unknown> = {}): PaymentAuthorization {
  const sessionRef = (overrides.session_ref as string) ?? "cs_1";
  return createPaymentAuthorization(
    {
      authorization_id: newAuthorizationId(),
      session_ref: sessionRef,
      terms_digest: (overrides.terms_digest as string) ?? digestTerms(TERMS),
      intent_mandate: (overrides.intent_mandate as string) ?? `mandate:${sessionRef}`,
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "approval-1" }, CLOCK),
      approved_at: NOW,
      expires_at: (overrides.expires_at as string) ?? "2026-08-06T13:00:00Z",
    },
    CLOCK,
  );
}

// ---------------------------------------------------------------------------
// HTTP 测试脚手架
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function msg(type: UcpMessageType, severity: UcpMessageSeverity, code?: string, message?: string): Record<string, unknown> {
  return {
    type,
    severity,
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function successCheckout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ucp: { status: "success", version: "2026-04-08" },
    status: "incomplete",
    session_id: "cs_test",
    line_items: [{ sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } }],
    expires_at: "2026-08-06T18:00:00Z",
    ...overrides,
  };
}

function errorEnvelope(messages: unknown[], continue_url?: string): Record<string, unknown> {
  return {
    ucp: { status: "error", version: "2026-04-08" },
    messages,
    ...(continue_url !== undefined ? { continue_url } : {}),
  };
}

/** 按 (method, URL 后缀) 路由的注入 fetch。 */
function routerFetch(
  routes: Array<{ match: (c: RecordedCall) => boolean; handler: (c: RecordedCall) => Response }>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const body = rawBody !== undefined ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    const call: RecordedCall = { method, url, headers, ...(body !== undefined ? { body } : {}) };
    calls.push(call);
    for (const route of routes) {
      if (route.match(call)) return route.handler(call);
    }
    return jsonResponse({ error: "unhandled route" }, 500);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeChannel(
  fetchImpl: typeof fetch,
  opts: Partial<UcpCheckoutChannelOptions> = {},
): UcpCheckoutChannel {
  return new UcpCheckoutChannel({
    endpoint: "http://127.0.0.1:8765/checkout",
    fetchImpl,
    skipDnsCheck: true,
    now: CLOCK,
    ...opts,
  });
}

/** 有状态 mock checkout server：create/get/update(PUT)/complete/cancel + 可覆盖 get。 */
interface ServerSession {
  session_id: string;
  status: string;
  line_items: unknown[];
  totals?: Record<string, unknown>;
  expires_at: string;
  messages?: unknown[];
  continue_url?: string;
}

interface HandlerResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function toResponse(res: HandlerResponse): Response {
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { "content-type": "application/json", ...res.headers },
  });
}

function successEnvelope(session: ServerSession): Record<string, unknown> {
  return { ucp: { status: "success", version: "2026-04-08" }, ...session };
}

class MockCheckoutServer {
  sessions = new Map<string, ServerSession>();
  calls: RecordedCall[] = [];
  private seq = 0;
  createStatus = "incomplete";
  statusAfterUpdate = "ready_for_complete";
  completeStatus = "completed";
  totals?: Record<string, unknown>;
  expiresAt = "2026-08-06T18:00:00Z";
  getHandler?: (id: string, session: ServerSession | undefined) => HandlerResponse;

  fetchImpl = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const body = rawBody !== undefined ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    const call: RecordedCall = { method, url, headers, ...(body !== undefined ? { body } : {}) };
    this.calls.push(call);

    const path = new URL(url).pathname;
    const completeMatch = /\/checkout-sessions\/([^/]+)\/complete$/.exec(path);
    const cancelMatch = /\/checkout-sessions\/([^/]+)\/cancel$/.exec(path);
    const idMatch = /\/checkout-sessions\/([^/]+)$/.exec(path);

    if (method === "POST" && path.endsWith("/checkout-sessions")) {
      const id = `cs_${++this.seq}`;
      const session: ServerSession = {
        session_id: id,
        status: this.createStatus,
        line_items: (body?.line_items as unknown[]) ?? [],
        ...(this.totals !== undefined ? { totals: this.totals } : {}),
        expires_at: this.expiresAt,
      };
      this.sessions.set(id, session);
      return jsonResponse(successEnvelope(session));
    }
    if (completeMatch !== null && method === "POST") {
      const id = decodeURIComponent(completeMatch[1]!);
      const session = this.sessions.get(id);
      if (session === undefined) return jsonResponse({ error: "not found" }, 404);
      session.status = this.completeStatus;
      return jsonResponse(successEnvelope(session));
    }
    if (cancelMatch !== null && method === "POST") {
      const id = decodeURIComponent(cancelMatch[1]!);
      const session = this.sessions.get(id);
      if (session === undefined) return jsonResponse({ error: "not found" }, 404);
      session.status = "canceled";
      return jsonResponse(successEnvelope(session));
    }
    if (idMatch !== null) {
      const id = decodeURIComponent(idMatch[1]!);
      const session = this.sessions.get(id);
      if (this.getHandler !== undefined) return toResponse(this.getHandler(id, session));
      if (session === undefined) return jsonResponse({ error: "not found" }, 404);
      if (method === "PUT") {
        session.line_items = (body?.line_items as unknown[]) ?? [];
        session.status = this.statusAfterUpdate;
      }
      return jsonResponse(successEnvelope(session));
    }
    return jsonResponse({ error: "unhandled" }, 500);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 1. createSession：HandoffPackage → UCP line_items
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel.createSession", () => {
  it("拒绝重定向：UCP 端点 3xx 不跟随（评审项 P3-1，与 a2a-client 同类的 SSRF 面）", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.url.includes("/checkout-sessions"),
        handler: () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          }),
      },
    ]);
    const channel = makeChannel(fetchImpl);
    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status === "fail_closed") {
      expect(res.code).toBe("network");
      expect(res.reason).toContain("redirect");
    }
  });

  it("拒绝超大响应：Content-Length 预检超限（评审项 P3-1）", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.url.includes("/checkout-sessions"),
        handler: () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "99999999" },
          }),
      },
    ]);
    const channel = makeChannel(fetchImpl);
    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status === "fail_closed") {
      expect(res.code).toBe("malformed");
      expect(res.reason).toContain("too large");
    }
  });

  it("maps agreed_terms to UCP line_items (Money minor units passthrough, integer quantity)", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);

    const res = await channel.createSession(makePackage());

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.session_ref).toBe("cs_1");
    expect(res.checkout.status).toBe("incomplete");
    expect(res.session.current_terms).toEqual(TERMS);
    expect(res.session.current_terms_digest).toBe(digestTerms(TERMS));

    const createCall = server.calls[0];
    expect(createCall?.method).toBe("POST");
    expect(createCall?.url).toBe("http://127.0.0.1:8765/checkout/checkout-sessions");
    expect(createCall?.body?.line_items).toEqual([
      { sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } },
    ]);
  });

  it("defaults expires_at to created_at + 6h when the server omits it", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () =>
          jsonResponse({
            ucp: { status: "success", version: "2026-04-08" },
            status: "incomplete",
            session_id: "cs_default",
            line_items: [],
          }),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(Date.parse(res.checkout.expires_at as string)).toBe(Date.parse("2026-08-06T18:00:00Z"));
  });

  it("rejects a fractional quantity (fail-closed invalid_quantity, no network call)", async () => {
    const badTerms: TermSet = {
      items: [
        { sku: SKU, quantity: { value: 1.5, unit: "kg" }, unit_price: { currency: "CNY", amount_minor: 100 } },
      ],
    };
    const { fetchImpl, calls } = routerFetch([]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage(badTerms));
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("invalid_quantity");
    expect(res.reason).toContain(SKU);
    expect(calls.length).toBe(0);
  });

  it("rejects a tampered package (digest mismatch) without network access", async () => {
    const pkg = makePackage();
    const tampered = { ...pkg, agreed_terms: structuredClone(TERMS_2) };
    const { fetchImpl, calls } = routerFetch([]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(tampered);
    expect(res.status).toBe("fail_closed");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 全生命周期：create → incomplete → update → ready → complete
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel lifecycle", () => {
  it("create → get incomplete → update (full replacement) → ready → complete", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl, {
      authorizationProvider: new FakeAuthorizationProvider(),
    });

    const created = await channel.createSession(makePackage());
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;
    const ref = created.session_ref;
    expect(created.checkout.status).toBe("incomplete");

    const got = await channel.getSession(ref);
    expect(got.status).toBe("ok");
    if (got.status !== "ok") return;
    expect(got.checkout.status).toBe("incomplete");

    const updated = await channel.updateSession(ref, TERMS_2);
    expect(updated.status).toBe("ok");
    if (updated.status !== "ok") return;
    expect(updated.session.current_terms).toEqual(TERMS_2);
    expect(updated.session.current_terms_digest).toBe(digestTerms(TERMS_2));
    expect(updated.checkout.status).toBe("ready_for_complete");

    const ready = await channel.getSession(ref);
    expect(ready.status).toBe("ok");
    if (ready.status !== "ok") return;
    expect(ready.checkout.status).toBe("ready_for_complete");

    const completed = await channel.requestCompletion(
      ref,
      validAuthorization({ session_ref: ref, terms_digest: digestTerms(TERMS_2) }),
    );
    expect(completed.status).toBe("ok");
    if (completed.status !== "ok") return;
    expect(completed.checkout_status).toBe("completed");
    expect(completed.session.status).toBe("completed");

    // Update 是全量替换：PUT body 带新的 line_items。
    const put = server.calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put?.body?.line_items).toEqual([
      { sku: SKU, quantity: 250, unit_price: { currency: "CNY", amount_minor: 83500 } },
    ]);

    // Complete 只带 authorization 证据引用，不构造任何支付凭据。
    const completeCall = server.calls.find((c) => c.url.endsWith("/complete"));
    expect(completeCall).toBeDefined();
    expect(completeCall?.method).toBe("POST");
    expect(completeCall?.body).toEqual({ authorization_reference: "approval-1" });
    expect((completeCall?.body as Record<string, unknown>).payment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. 状态映射：requires_escalation / ucp.status=error 各 severity 分支
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel state mapping", () => {
  it("requires_escalation → requires_user with continue_url + summarized messages", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;
    const ref = created.session_ref;

    server.getHandler = (_id, session) => ({
      status: 200,
      body: {
        ucp: { status: "success", version: "2026-04-08" },
        ...session,
        status: "requires_escalation",
        continue_url: "https://buyer.example/checkout/confirm",
        messages: [msg("error", "requires_buyer_review", "eligibility_invalid", "eligibility needs review")],
      },
    });

    const res = await channel.requestCompletion(
      ref,
      validAuthorization({ session_ref: ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("requires_user");
    if (res.status !== "requires_user") return;
    expect(res.continue_url).toBe("https://buyer.example/checkout/confirm");
    expect(res.reason).toContain("requires_escalation");
    expect(res.messages[0]?.code).toBe("eligibility_invalid");
    expect(res.checkout_status).toBe("requires_escalation");
  });

  it("getSession on requires_escalation also surfaces requires_user", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    server.getHandler = (_id, session) => ({
      status: 200,
      body: {
        ucp: { status: "success", version: "2026-04-08" },
        ...session,
        status: "requires_escalation",
        continue_url: "https://buyer.example/checkout/confirm",
        messages: [msg("error", "requires_buyer_input", "item_unavailable", "pick another")],
      },
    });

    const res = await channel.getSession(created.session_ref);
    expect(res.status).toBe("requires_user");
    if (res.status !== "requires_user") return;
    expect(res.continue_url).toBe("https://buyer.example/checkout/confirm");
  });

  it("ucp.status=error with unrecoverable severity → fail_closed (terminal)", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () =>
          jsonResponse(errorEnvelope([msg("error", "unrecoverable", "payment_failed", "payment failed")])),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("unrecoverable");
    expect(res.retryable).toBeUndefined();
    expect(res.reason).toContain("payment_failed");
  });

  it("ucp.status=error with requires_* severity → requires_user with continue_url", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () =>
          jsonResponse(
            errorEnvelope(
              [msg("error", "requires_buyer_input", "item_unavailable", "choose another")],
              "https://buyer.example/checkout/choose",
            ),
          ),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("requires_user");
    if (res.status !== "requires_user") return;
    expect(res.continue_url).toBe("https://buyer.example/checkout/choose");
    expect(res.messages[0]?.code).toBe("item_unavailable");
  });

  it("ucp.status=error with recoverable severity → fail_closed retryable (fix input, no auto-loop)", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () =>
          jsonResponse(errorEnvelope([msg("error", "recoverable", "out_of_stock", "reduce quantity")])),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("recoverable");
    expect(res.retryable).toBe(true);
  });

  it("ucp.status=error without actionable messages → fail_closed", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () => jsonResponse(errorEnvelope([])),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.reason).toContain("without actionable messages");
  });

  it("incomplete with recoverable messages on create carries session_ref for correction", async () => {
    // create 返回 success + incomplete + recoverable 消息：session 已创建，但要求改输入重试。
    const createResponse = {
      ucp: { status: "success", version: "2026-04-08" },
      status: "incomplete",
      session_id: "cs_recoverable",
      line_items: [{ sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } }],
      expires_at: "2026-08-06T18:00:00Z",
      messages: [msg("error", "recoverable", "out_of_stock", "only 150 available")],
    };
    const { fetchImpl } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () => jsonResponse(createResponse),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("recoverable");
    expect(res.retryable).toBe(true);
    expect(res.session_ref).toBe("cs_recoverable");
    expect(res.checkout?.status).toBe("incomplete");
    expect(res.messages[0]?.code).toBe("out_of_stock");
  });
});

// ---------------------------------------------------------------------------
// 4. totals 校验
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel totals validation", () => {
  it("refuses completion when sum of non-total fields != total (no complete sent)", async () => {
    const server = new MockCheckoutServer();
    server.createStatus = "ready_for_complete";
    server.totals = { currency: "CNY", items_total: 100, tax: 5, total: 200 };
    const channel = makeChannel(server.fetchImpl, {
      authorizationProvider: new FakeAuthorizationProvider(),
    });

    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    const res = await channel.requestCompletion(
      created.session_ref,
      validAuthorization({ session_ref: created.session_ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("totals_mismatch");
    expect(res.reason).toContain("105");
    expect(server.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });

  it("allows completion when totals sum matches", async () => {
    const server = new MockCheckoutServer();
    server.createStatus = "ready_for_complete";
    server.totals = { currency: "CNY", items_total: 195, tax: 5, total: 200 };
    const channel = makeChannel(server.fetchImpl, {
      authorizationProvider: new FakeAuthorizationProvider(),
    });

    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    const res = await channel.requestCompletion(
      created.session_ref,
      validAuthorization({ session_ref: created.session_ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("ok");
    expect(server.calls.some((c) => c.url.endsWith("/complete"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. 过期会话
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel expiry", () => {
  it("requestCompletion on an expired ready_for_complete session → session_expired", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl, {
      authorizationProvider: new FakeAuthorizationProvider(),
    });
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    server.getHandler = (_id, session) => ({
      status: 200,
      body: {
        ucp: { status: "success", version: "2026-04-08" },
        ...session,
        status: "ready_for_complete",
        expires_at: "2026-08-01T00:00:00Z",
      },
    });

    const res = await channel.requestCompletion(
      created.session_ref,
      validAuthorization({ session_ref: created.session_ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("session_expired");
    expect(server.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });

  it("getSession on an expired session → session_expired", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    server.getHandler = (_id, session) => ({
      status: 200,
      body: {
        ucp: { status: "success", version: "2026-04-08" },
        ...session,
        status: "incomplete",
        expires_at: "2026-08-01T00:00:00Z",
      },
    });

    const res = await channel.getSession(created.session_ref);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("session_expired");
  });

  it("updateSession on an expired session → session_expired (no PUT)", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    server.getHandler = (_id, session) => ({
      status: 200,
      body: {
        ucp: { status: "success", version: "2026-04-08" },
        ...session,
        status: "incomplete",
        expires_at: "2026-08-01T00:00:00Z",
      },
    });

    const res = await channel.updateSession(created.session_ref, TERMS_2);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("session_expired");
    expect(server.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. 网络面：SSRF / 超时 / 畸形 / 非 2xx
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel network failures", () => {
  it("rejects an unsafe endpoint at construction (link-local HTTP)", () => {
    expect(
      () => new UcpCheckoutChannel({ endpoint: "http://169.254.169.254/checkout" }),
    ).toThrow(HandoffError);
  });

  it("fails closed (unsafe_target) when DNS resolves to a private range", async () => {
    const { fetchImpl, calls } = routerFetch([]);
    const channel = makeChannel(fetchImpl, {
      endpoint: "https://merchant.example/checkout",
      skipDnsCheck: false,
      resolveIp: async () => ["10.0.0.1"],
    });

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("unsafe_target");
    expect(calls.length).toBe(0);
  });

  it("fails closed (timeout) when the request hangs", async () => {
    const hangFetch = (async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }) as typeof fetch;
    const channel = makeChannel(hangFetch, { timeoutMs: 20 });

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("timeout");
  });

  it("fails closed (malformed) on a non-JSON response", async () => {
    const { fetchImpl } = routerFetch([
      { match: () => true, handler: () => new Response("not json", { status: 200 }) },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("malformed");
  });

  it("fails closed (bad_status) on a non-2xx carrying an inconsistent success envelope", async () => {
    const { fetchImpl } = routerFetch([
      { match: () => true, handler: () => jsonResponse(successCheckout(), 500) },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("bad_status");
  });

  it("maps a non-2xx error envelope through the severity algorithm (requires_* → requires_user)", async () => {
    const { fetchImpl } = routerFetch([
      {
        match: () => true,
        handler: () =>
          jsonResponse(
            errorEnvelope(
              [msg("error", "requires_buyer_review", "eligibility_invalid", "review eligibility")],
              "https://buyer.example/checkout/review",
            ),
            409,
          ),
      },
    ]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("requires_user");
    if (res.status !== "requires_user") return;
    expect(res.continue_url).toBe("https://buyer.example/checkout/review");
  });
});

// ---------------------------------------------------------------------------
// 7. complete 只在完成门禁通过时发出
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel completion gate", () => {
  it("does not send Complete when the gate denies (default fail-closed provider)", async () => {
    const server = new MockCheckoutServer();
    server.createStatus = "ready_for_complete";
    const channel = makeChannel(server.fetchImpl); // default FailClosedAuthorizationProvider

    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    const res = await channel.requestCompletion(
      created.session_ref,
      validAuthorization({ session_ref: created.session_ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("gate_denied");
    expect(server.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });

  it("refuses completion on an incomplete (not ready) session before any Complete", async () => {
    const server = new MockCheckoutServer(); // createStatus incomplete
    const channel = makeChannel(server.fetchImpl, {
      authorizationProvider: new FakeAuthorizationProvider(),
    });
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    const res = await channel.requestCompletion(
      created.session_ref,
      validAuthorization({ session_ref: created.session_ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("not_ready");
    expect(server.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });

  it("requestCompletion on an unknown session fails closed without network access", async () => {
    const { fetchImpl, calls } = routerFetch([]);
    const channel = makeChannel(fetchImpl);

    const res = await channel.requestCompletion(
      "unknown",
      validAuthorization({ session_ref: "unknown", terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("session_not_found");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. updateSession / cancelSession
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel updateSession / cancelSession", () => {
  it("updateSession is a full-replacement PUT of the new session representation", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    const res = await channel.updateSession(created.session_ref, TERMS_2);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.session.current_terms).toEqual(TERMS_2);
    expect(res.checkout.status).toBe("ready_for_complete");

    const put = server.calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put?.url).toContain(`/checkout-sessions/${created.session_ref}`);
    expect(put?.body?.line_items).toEqual([
      { sku: SKU, quantity: 250, unit_price: { currency: "CNY", amount_minor: 83500 } },
    ]);
  });

  it("rejects update on a completed remote session", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    server.getHandler = (_id, session) => ({
      status: 200,
      body: { ucp: { status: "success", version: "2026-04-08" }, ...session, status: "completed" },
    });

    const res = await channel.updateSession(created.session_ref, TERMS_2);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("session_not_actionable");
    expect(server.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("cancels a session and mirrors the cancelled state", async () => {
    const server = new MockCheckoutServer();
    const channel = makeChannel(server.fetchImpl);
    const created = await channel.createSession(makePackage());
    if (created.status !== "ok") return;

    const res = await channel.cancelSession(created.session_ref);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.checkout_status).toBe("canceled");
    expect(res.session.status).toBe("cancelled");

    const cancelCall = server.calls.find((c) => c.url.endsWith("/cancel"));
    expect(cancelCall).toBeDefined();
    expect(cancelCall?.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// 9. UCP-Agent profile 头
// ---------------------------------------------------------------------------

describe("UcpCheckoutChannel UCP-Agent header", () => {
  it("carries UCP-Agent (RFC 8941 dictionary) when the buyer configures a profile URI", async () => {
    const { fetchImpl, calls } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.endsWith("/checkout-sessions"),
        handler: () => jsonResponse(successCheckout()),
      },
    ]);
    const channel = makeChannel(fetchImpl, {
      ucpAgentProfile: "https://buyer.example/.well-known/ucp",
    });

    await channel.createSession(makePackage());

    expect(calls[0]?.headers["ucp-agent"]).toBe('profile="https://buyer.example/.well-known/ucp"');
  });
});

// ---------------------------------------------------------------------------
// 10. endpoint 解析与 profile 构造
// ---------------------------------------------------------------------------

describe("findCheckoutEndpoint / profile construction", () => {
  const profile: UcpProfile = {
    ucp: {
      version: "2026-04-08",
      services: {
        "com.example.checkout": [
          {
            version: "1.0",
            spec: "https://example.com/spec/checkout.json",
            transport: "rest",
            endpoint: "https://example.com/api/checkout",
          },
        ],
        "com.example.other": [
          {
            version: "1.0",
            spec: "https://example.com/spec/other.json",
            transport: "a2a",
            endpoint: "https://example.com/card",
          },
        ],
      },
    },
  };

  it("finds the checkout REST service endpoint (auto-detect by service name)", () => {
    expect(findCheckoutEndpoint(profile)).toBe("https://example.com/api/checkout");
  });

  it("honours an explicit serviceName and ignores non-rest services", () => {
    expect(findCheckoutEndpoint(profile, { serviceName: "com.example.other" })).toBeUndefined();
    expect(findCheckoutEndpoint(profile, { serviceName: "missing.service" })).toBeUndefined();
  });

  it("returns undefined when the profile has no checkout service", () => {
    expect(findCheckoutEndpoint({ ucp: { version: "2026-04-08" } })).toBeUndefined();
  });

  it("constructs a channel from a profile and routes to the resolved endpoint", async () => {
    const { fetchImpl, calls } = routerFetch([
      {
        match: (c) => c.method === "POST" && c.url.startsWith("https://example.com/api/checkout"),
        handler: () => jsonResponse(successCheckout({ session_id: "cs_profile" })),
      },
    ]);
    const channel = new UcpCheckoutChannel({
      profile,
      fetchImpl,
      skipDnsCheck: true,
      now: CLOCK,
    });

    const res = await channel.createSession(makePackage());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.session_ref).toBe("cs_profile");
    expect(calls[0]?.url).toBe("https://example.com/api/checkout/checkout-sessions");
  });

  it("fails closed at construction when the profile has no rest checkout endpoint", () => {
    const badProfile: UcpProfile = {
      ucp: {
        version: "2026-04-08",
        services: {
          "com.example.other": [
            {
              version: "1.0",
              spec: "https://example.com/spec/other.json",
              transport: "a2a",
              endpoint: "https://example.com/card",
            },
          ],
        },
      },
    };
    expect(() => new UcpCheckoutChannel({ profile: badProfile })).toThrow(HandoffError);
  });
});
