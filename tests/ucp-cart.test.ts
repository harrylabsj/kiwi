/**
 * Kiwi v0.7.0 Transaction Handoff（WP2 补全）— UcpCartChannel + cart→checkout 转换 tests。
 *
 * 覆盖（对齐工作包验收清单）：
 *  - Cart CRUD 全路径：create → get → update（全量替换 PUT）→ cancel；
 *  - line_items 映射与 checkout 同规则（Money minor units 直传、整数 quantity）；
 *  - not_found 分支：Get 对不存在/过期/已取消返回 not_found → cart_not_found；
 *  - error 判别（全缺货）：error envelope 各 severity 分支（recoverable → fail_closed
 *    retryable；requires_* → requires_user）；
 *  - 估算 totals 通过（不做 checkout 级 sum 校验——sum 不符也接受）；
 *  - Cancel 返回删除前的 cart 状态，后续操作返回 not_found；
 *  - cart capability 检测（profileHasCartCapability / findCartEndpoint）；
 *  - cart_id 转换：payload 无重叠 line_items、同 cart_id + 同 terms 短接幂等、
 *    business 返回既有会话按成功处理并记录链接、门禁不绕过（complete 仍需授权）。
 */
import { describe, expect, it } from "vitest";
import {
  createHandoffPackage,
  createPaymentAuthorization,
  createUserConfirmationEvidence,
  digestTerms,
  HandoffError,
  newAuthorizationId,
  type PaymentAuthorization,
} from "../src/handoff/index.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import { AGREEMENT_ID, NEGOTIATION_ID, OFFER_ID_3, SKU } from "./negotiation-helpers.js";
import {
  findCartEndpoint,
  profileHasCartCapability,
  UcpCartChannel,
  UcpCheckoutChannel,
  type UcpCartChannelOptions,
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

/** 声明 cart capability + cart/checkout REST service 的 profile。 */
function makeCartProfile(): UcpProfile {
  return {
    ucp: {
      version: "2026-04-08",
      services: {
        "dev.ucp.shopping": [
          {
            version: "1.0",
            spec: "https://ucp.dev/spec/shopping.json",
            transport: "rest",
            endpoint: "http://127.0.0.1:8765/cart",
          },
        ],
        "dev.ucp.checkout": [
          {
            version: "1.0",
            spec: "https://ucp.dev/spec/checkout.json",
            transport: "rest",
            endpoint: "http://127.0.0.1:8765/checkout",
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.cart": [
          {
            version: "2026-04-08",
            spec: "https://ucp.dev/spec/shopping.cart.json",
            schema: "https://ucp.dev/spec/shopping.cart.schema.json",
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP 测试脚手架
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

interface RecordedCall {
  method: string;
  url: string;
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

function errorEnvelope(messages: unknown[], continue_url?: string): Record<string, unknown> {
  return {
    ucp: { status: "error", version: "2026-04-08" },
    messages,
    ...(continue_url !== undefined ? { continue_url } : {}),
  };
}

function successCart(cart: unknown): Record<string, unknown> {
  return { ucp: { status: "success", version: "2026-04-08" }, ...(cart as Record<string, unknown>) };
}

interface ServerCart {
  cart_id: string;
  line_items: unknown[];
  totals?: Record<string, unknown>;
  expires_at?: string;
  continue_url?: string;
  messages?: unknown[];
}

interface ServerSession {
  session_id: string;
  status: string;
  line_items: unknown[];
  cart_id?: string;
  expires_at?: string;
  totals?: Record<string, unknown>;
  continue_url?: string;
}

const CART_BASE = "/cart/carts";
const CO_BASE = "/checkout/checkout-sessions";

/**
 * 有状态 mock：cart CRUD（/cart/carts*）+ checkout（/checkout/checkout-sessions*）。
 * 支持模拟：cart GET 404（不存在/过期/已取消）、business 对 cart_id 返回既有会话
 * （fixedSessionId）、checkout create 状态可配。
 */
class MockUcpServer {
  carts = new Map<string, ServerCart>();
  sessions = new Map<string, ServerSession>();
  calls: RecordedCall[] = [];
  private cartSeq = 0;
  private sessionSeq = 0;

  /** 估算 totals（sum 不必等于 total——cart 不做 checkout 级 sum 校验）。 */
  cartTotals?: Record<string, unknown>;
  /** 强制 cart GET 返回 404（模拟过期/已取消）。 */
  cartGetNotFound = false;
  checkoutCreateStatus = "incomplete";
  checkoutCompleteStatus = "completed";
  /** 模拟 business 对 cart_id 幂等返回既有会话。 */
  fixedSessionId?: string;

  fetchImpl = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const body = rawBody !== undefined ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
    this.calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
    const path = new URL(url).pathname;

    // -- Cart routes -------------------------------------------------------
    if (path === CART_BASE && method === "POST") {
      const cart: ServerCart = {
        cart_id: `cart_${++this.cartSeq}`,
        line_items: (body?.line_items as unknown[]) ?? [],
        ...(this.cartTotals !== undefined ? { totals: this.cartTotals } : {}),
        expires_at: "2026-08-06T18:00:00Z",
      };
      this.carts.set(cart.cart_id, cart);
      return jsonResponse(successCart(cart));
    }
    const cartMatch = /^\/cart\/carts\/([^/]+)$/.exec(path);
    if (cartMatch !== null) {
      const id = decodeURIComponent(cartMatch[1]!);
      if (method === "GET") {
        if (this.cartGetNotFound || !this.carts.has(id)) {
          return jsonResponse({ error: "not found" }, 404);
        }
        return jsonResponse(successCart(this.carts.get(id)!));
      }
      if (method === "PUT") {
        const existing = this.carts.get(id);
        if (existing === undefined) return jsonResponse({ error: "not found" }, 404);
        existing.line_items = (body?.line_items as unknown[]) ?? [];
        return jsonResponse(successCart(existing));
      }
    }
    const cartCancelMatch = /^\/cart\/carts\/([^/]+)\/cancel$/.exec(path);
    if (cartCancelMatch !== null && method === "POST") {
      const id = decodeURIComponent(cartCancelMatch[1]!);
      const existing = this.carts.get(id);
      if (existing === undefined) return jsonResponse({ error: "not found" }, 404);
      // Cancel 返回删除前的 cart 状态；随后从 map 移除 → 后续操作 not_found。
      this.carts.delete(id);
      return jsonResponse(successCart(existing));
    }

    // -- Checkout routes ----------------------------------------------------
    if (path === CO_BASE && method === "POST") {
      const sessionId = this.fixedSessionId ?? `cs_${++this.sessionSeq}`;
      const session: ServerSession = {
        session_id: sessionId,
        status: this.checkoutCreateStatus,
        line_items: (body?.line_items as unknown[]) ?? [],
        ...(body?.cart_id !== undefined ? { cart_id: body.cart_id as string } : {}),
        expires_at: "2026-08-06T18:00:00Z",
      };
      this.sessions.set(sessionId, session);
      return jsonResponse(successCart(session));
    }
    const sessionMatch = /^\/checkout\/checkout-sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null) {
      const id = decodeURIComponent(sessionMatch[1]!);
      const session = this.sessions.get(id);
      if (session === undefined) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse(successCart(session));
    }
    const completeMatch = /^\/checkout\/checkout-sessions\/([^/]+)\/complete$/.exec(path);
    if (completeMatch !== null && method === "POST") {
      const id = decodeURIComponent(completeMatch[1]!);
      const session = this.sessions.get(id);
      if (session === undefined) return jsonResponse({ error: "not found" }, 404);
      session.status = this.checkoutCompleteStatus;
      return jsonResponse(successCart(session));
    }
    return jsonResponse({ error: "unhandled" }, 500);
  }) as typeof fetch;

  cartCreateCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.url.endsWith(CART_BASE));
  }
  cartPutCalls(cartId: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === "PUT" && c.url.endsWith(`/cart/carts/${cartId}`));
  }
  checkoutCreateCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.url.endsWith(CO_BASE));
  }
  completeCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.url.endsWith("/complete"));
  }
}

function makeCartChannel(
  server: MockUcpServer,
  opts: { checkout?: UcpCheckoutChannel; options?: Partial<UcpCartChannelOptions> } = {},
): { cart: UcpCartChannel; checkout?: UcpCheckoutChannel } {
  const base: Partial<UcpCartChannelOptions> = {
    profile: makeCartProfile(),
    fetchImpl: server.fetchImpl,
    skipDnsCheck: true,
    now: CLOCK,
  };
  if (opts.checkout !== undefined) {
    base.checkout = opts.checkout;
  }
  return { cart: new UcpCartChannel({ ...base, ...opts.options }), checkout: opts.checkout };
}

function makeCheckoutChannel(server: MockUcpServer): UcpCheckoutChannel {
  return new UcpCheckoutChannel({
    profile: makeCartProfile(),
    fetchImpl: server.fetchImpl,
    skipDnsCheck: true,
    now: CLOCK,
  });
}

// ---------------------------------------------------------------------------
// 1. createCart：line_items 映射 + 估算 totals + error 判别
// ---------------------------------------------------------------------------

describe("UcpCartChannel.createCart", () => {
  it("maps agreed_terms to UCP line_items (Money minor units, integer quantity)", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);

    const res = await cart.createCart(makePackage());

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.cart_ref).toBe("cart_1");
    expect(res.cart.line_items).toEqual([
      { sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } },
    ]);
    const create = server.cartCreateCalls()[0];
    expect(create?.url).toBe("http://127.0.0.1:8765/cart/carts");
    expect(create?.body?.line_items).toEqual([
      { sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } },
    ]);
  });

  it("accepts estimate totals without checkout-level sum validation (sum mismatch is fine)", async () => {
    const server = new MockUcpServer();
    // items_total 100 + tax 5 = 105 != 200：cart totals 是估算，不拒绝。
    server.cartTotals = { currency: "CNY", items_total: 100, tax: 5, total: 200 };
    const { cart } = makeCartChannel(server);

    const res = await cart.createCart(makePackage());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.cart.totals).toEqual({ currency: "CNY", items_total: 100, tax: 5, total: 200 });
  });

  it("rejects a fractional quantity (fail-closed invalid_quantity, no network call)", async () => {
    const badTerms: TermSet = {
      items: [
        { sku: SKU, quantity: { value: 1.5, unit: "kg" }, unit_price: { currency: "CNY", amount_minor: 100 } },
      ],
    };
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);

    const res = await cart.createCart(makePackage(badTerms));
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("invalid_quantity");
    expect(server.calls.length).toBe(0);
  });

  it("rejects a tampered package (digest mismatch) without network access", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const tampered = { ...makePackage(), agreed_terms: structuredClone(TERMS_2) };

    const res = await cart.createCart(tampered);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("invalid_package");
    expect(server.calls.length).toBe(0);
  });

  it("error envelope: all-unavailable (recoverable) → fail_closed retryable", async () => {
    const server = new MockUcpServer();
    const original = server.fetchImpl;
    server.fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      server.calls.push({ method, url });
      if (method === "POST" && url.endsWith(CART_BASE)) {
        return jsonResponse(
          errorEnvelope([msg("error", "recoverable", "out_of_stock", "all items unavailable")]),
        );
      }
      return original(input, init);
    }) as typeof fetch;
    const { cart } = makeCartChannel(server);

    const res = await cart.createCart(makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("recoverable");
    expect(res.retryable).toBe(true);
    expect(res.messages[0]?.code).toBe("out_of_stock");
  });

  it("error envelope: requires_buyer_input → requires_user with continue_url", async () => {
    const server = new MockUcpServer();
    const original = server.fetchImpl;
    server.fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      server.calls.push({ method, url });
      if (method === "POST" && url.endsWith(CART_BASE)) {
        return jsonResponse(
          errorEnvelope(
            [msg("error", "requires_buyer_input", "item_unavailable", "choose another")],
            "https://buyer.example/cart/choose",
          ),
        );
      }
      return original(input, init);
    }) as typeof fetch;
    const { cart } = makeCartChannel(server);

    const res = await cart.createCart(makePackage());
    expect(res.status).toBe("requires_user");
    if (res.status !== "requires_user") return;
    expect(res.continue_url).toBe("https://buyer.example/cart/choose");
    expect(res.messages[0]?.code).toBe("item_unavailable");
  });
});

// ---------------------------------------------------------------------------
// 2. getCart / not_found 分支
// ---------------------------------------------------------------------------

describe("UcpCartChannel.getCart / not_found", () => {
  it("getCart returns ok and refreshes the local mirror", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const res = await cart.getCart(created.cart_ref);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.cart.cart_id).toBe("cart_1");
  });

  it("getCart on a missing cart (HTTP 404) → fail_closed cart_not_found", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);

    const res = await cart.getCart("cart_missing");
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_found");
  });

  it("getCart on an expired/canceled cart (remote 404) → cart_not_found", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;
    server.cartGetNotFound = true;

    const res = await cart.getCart(created.cart_ref);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_found");
  });
});

// ---------------------------------------------------------------------------
// 3. updateCart：全量替换
// ---------------------------------------------------------------------------

describe("UcpCartChannel.updateCart (full replacement)", () => {
  it("updateCart is a full-replacement PUT of the new cart representation", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const res = await cart.updateCart(created.cart_ref, TERMS_2);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.cart.line_items).toEqual([
      { sku: SKU, quantity: 250, unit_price: { currency: "CNY", amount_minor: 83500 } },
    ]);
    const put = server.cartPutCalls(created.cart_ref)[0];
    expect(put?.method).toBe("PUT");
    expect(put?.url).toContain(`/cart/carts/${created.cart_ref}`);
    expect(put?.body?.line_items).toEqual([
      { sku: SKU, quantity: 250, unit_price: { currency: "CNY", amount_minor: 83500 } },
    ]);
  });

  it("updateCart on an unknown local cart → cart_not_found without network", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);

    const res = await cart.updateCart("cart_missing", TERMS_2);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_found");
    expect(server.calls.length).toBe(0);
  });

  it("updateCart on a canceled cart → cart_not_actionable", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;
    const canceled = await cart.cancelCart(created.cart_ref);
    if (canceled.status !== "ok") return;

    const res = await cart.updateCart(created.cart_ref, TERMS_2);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_actionable");
  });

  it("updateCart on a remote-missing cart (refetch 404) → cart_not_found", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;
    server.cartGetNotFound = true;

    const res = await cart.updateCart(created.cart_ref, TERMS_2);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_found");
    expect(server.cartPutCalls(created.cart_ref).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. cancelCart
// ---------------------------------------------------------------------------

describe("UcpCartChannel.cancelCart", () => {
  it("cancel returns the pre-delete cart state; subsequent get returns not_found", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const res = await cart.cancelCart(created.cart_ref);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.canceled).toBe(true);
    // 返回的是删除前的 cart 状态（line_items 仍在）。
    expect(res.cart.line_items).toEqual([
      { sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } },
    ]);

    const cancelCall = server.calls.find(
      (c) => c.method === "POST" && c.url.endsWith(`/cart/carts/${created.cart_ref}/cancel`),
    );
    expect(cancelCall).toBeDefined();

    // 后续操作返回 not_found（远端已删除）。
    const after = await cart.getCart(created.cart_ref);
    expect(after.status).toBe("fail_closed");
    if (after.status !== "fail_closed") return;
    expect(after.code).toBe("cart_not_found");
  });

  it("cancel on an already-canceled cart → cart_not_actionable", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;
    await cart.cancelCart(created.cart_ref);

    const res = await cart.cancelCart(created.cart_ref);
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_actionable");
  });

  it("cancel on an unknown local cart → cart_not_found without network", async () => {
    const server = new MockUcpServer();
    const { cart } = makeCartChannel(server);

    const res = await cart.cancelCart("cart_missing");
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_found");
    expect(server.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. cart capability 检测 + endpoint 解析
// ---------------------------------------------------------------------------

describe("cart capability discovery", () => {
  it("profileHasCartCapability detects dev.ucp.shopping.cart", () => {
    expect(profileHasCartCapability(makeCartProfile())).toBe(true);
    expect(profileHasCartCapability({ ucp: { version: "2026-04-08" } })).toBe(false);
    expect(
      profileHasCartCapability({
        ucp: {
          version: "2026-04-08",
          capabilities: {
            "dev.ucp.checkout.checkout": [
              {
                version: "2026-04-08",
                spec: "https://ucp.dev/spec/checkout.json",
                schema: "https://ucp.dev/spec/checkout.schema.json",
              },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("findCartEndpoint resolves the capability-hosted service endpoint", () => {
    expect(findCartEndpoint(makeCartProfile())).toBe("http://127.0.0.1:8765/cart");
  });

  it("findCartEndpoint returns undefined without a cart service/capability", () => {
    expect(findCartEndpoint({ ucp: { version: "2026-04-08" } })).toBeUndefined();
  });

  it("UcpCartChannel constructor fails closed without a cart endpoint", () => {
    const profile: UcpProfile = {
      ucp: {
        version: "2026-04-08",
        services: {
          "dev.ucp.checkout": [
            {
              version: "1.0",
              spec: "https://ucp.dev/spec/checkout.json",
              transport: "rest",
              endpoint: "http://127.0.0.1:8765/checkout",
            },
          ],
        },
      },
    };
    expect(() => new UcpCartChannel({ profile })).toThrow(HandoffError);
  });
});

// ---------------------------------------------------------------------------
// 6. cart→checkout 转换
// ---------------------------------------------------------------------------

describe("cart→checkout conversion", () => {
  it("sends cart_id without overlapping line_items and records the link", async () => {
    const server = new MockUcpServer();
    const checkout = makeCheckoutChannel(server);
    const { cart } = makeCartChannel(server, { checkout });
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const res = await cart.createCheckoutFromCart(created.cart_ref, makePackage());
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.session_ref).toBe("cs_1");

    // Checkout create 请求：cart_id + reference，无 line_items。
    const createCall = server.checkoutCreateCalls()[0];
    expect(createCall?.method).toBe("POST");
    expect(createCall?.url).toBe("http://127.0.0.1:8765/checkout/checkout-sessions");
    expect(createCall?.body?.cart_id).toBe(created.cart_ref);
    expect((createCall?.body as Record<string, unknown>).line_items).toBeUndefined();
    expect((createCall?.body as Record<string, unknown>).reference).toBeDefined();

    // 本地记录 cart→checkout 链接。
    const link = checkout.cartCheckoutLink(created.cart_ref);
    expect(link).toBeDefined();
    expect(link?.session_ref).toBe("cs_1");
  });

  it("is idempotent client-side: same cart + same terms returns the existing session without a new checkout create", async () => {
    const server = new MockUcpServer();
    const checkout = makeCheckoutChannel(server);
    const { cart } = makeCartChannel(server, { checkout });
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;
    const pkg = makePackage();

    const first = await cart.createCheckoutFromCart(created.cart_ref, pkg);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(server.checkoutCreateCalls().length).toBe(1);

    const second = await cart.createCheckoutFromCart(created.cart_ref, pkg);
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.session_ref).toBe(first.session_ref);
    // 第二次转换不产生新的 Checkout create（短接为既有会话）。
    expect(server.checkoutCreateCalls().length).toBe(1);
  });

  it("business returning an existing session is treated as success and re-recorded", async () => {
    const server = new MockUcpServer();
    server.fixedSessionId = "cs_fixed"; // business 幂等：始终返回既有会话
    const checkout = makeCheckoutChannel(server);
    const { cart } = makeCartChannel(server, { checkout });
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const first = await cart.createCheckoutFromCart(created.cart_ref, makePackage());
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.session_ref).toBe("cs_fixed");

    // 换一组 terms（digest 不同，客户端短接不触发）→ 仍收到既有会话 cs_fixed → 按成功处理。
    const second = await cart.createCheckoutFromCart(created.cart_ref, makePackage(TERMS_2));
    expect(second.status).toBe("ok");
    if (second.status !== "ok") return;
    expect(second.session_ref).toBe("cs_fixed");
    expect(server.checkoutCreateCalls().length).toBe(2);
    expect(server.checkoutCreateCalls()[1]?.body?.cart_id).toBe(created.cart_ref);
    expect((server.checkoutCreateCalls()[1]?.body as Record<string, unknown>).line_items).toBeUndefined();

    // 链接被重新记录（terms_digest 指向最近一次转换）。
    const link = checkout.cartCheckoutLink(created.cart_ref);
    expect(link?.session_ref).toBe("cs_fixed");
    expect(link?.terms_digest).toBe(digestTerms(TERMS_2));
  });

  it("fails closed when the business profile does not declare the cart capability", async () => {
    const server = new MockUcpServer();
    const checkout = new UcpCheckoutChannel({
      endpoint: "http://127.0.0.1:8765/checkout",
      fetchImpl: server.fetchImpl,
      skipDnsCheck: true,
      now: CLOCK,
    });
    const noCartCapProfile: UcpProfile = {
      ucp: {
        version: "2026-04-08",
        capabilities: {
          "dev.ucp.checkout.checkout": [
            {
              version: "2026-04-08",
              spec: "https://ucp.dev/spec/checkout.json",
              schema: "https://ucp.dev/spec/checkout.schema.json",
            },
          ],
        },
      },
    };
    const cart = new UcpCartChannel({
      endpoint: "http://127.0.0.1:8765/cart",
      profile: noCartCapProfile,
      checkout,
      fetchImpl: server.fetchImpl,
      skipDnsCheck: true,
      now: CLOCK,
    });
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const res = await cart.createCheckoutFromCart(created.cart_ref, makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_capability_unavailable");
    expect(server.checkoutCreateCalls().length).toBe(0);
  });

  it("refresh rejects an expired/canceled cart before any checkout create", async () => {
    const server = new MockUcpServer();
    const checkout = makeCheckoutChannel(server);
    const { cart } = makeCartChannel(server, { checkout });
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;
    server.cartGetNotFound = true;

    const res = await cart.createCheckoutFromCart(created.cart_ref, makePackage());
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_not_found");
    expect(server.checkoutCreateCalls().length).toBe(0);
  });

  it("completion gate is not bypassed: converting via cart still requires authorization", async () => {
    const server = new MockUcpServer();
    server.checkoutCreateStatus = "ready_for_complete";
    const checkout = makeCheckoutChannel(server); // 缺省 FailClosedAuthorizationProvider
    const { cart } = makeCartChannel(server, { checkout });
    const created = await cart.createCart(makePackage());
    if (created.status !== "ok") return;

    const converted = await cart.createCheckoutFromCart(created.cart_ref, makePackage());
    expect(converted.status).toBe("ok");
    if (converted.status !== "ok") return;
    const ref = converted.session_ref;

    const res = await checkout.requestCompletion(
      ref,
      validAuthorization({ session_ref: ref, terms_digest: digestTerms(TERMS) }),
    );
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("gate_denied");
    expect(server.completeCalls().length).toBe(0);
  });

  it("createSession with cart_id on a checkout channel built without a profile fails closed", async () => {
    const server = new MockUcpServer();
    const checkout = new UcpCheckoutChannel({
      endpoint: "http://127.0.0.1:8765/checkout",
      fetchImpl: server.fetchImpl,
      skipDnsCheck: true,
      now: CLOCK,
    });

    const res = await checkout.createSession(makePackage(), { cart_id: "cart_1" });
    expect(res.status).toBe("fail_closed");
    if (res.status !== "fail_closed") return;
    expect(res.code).toBe("cart_capability_unavailable");
    expect(server.checkoutCreateCalls().length).toBe(0);
  });
});
