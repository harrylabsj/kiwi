import { describe, expect, it, vi } from "vitest";
import { HttpCommerceClient } from "../src/commerce/http-client.js";
import { CommerceError } from "../src/commerce/types.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type NegotiationSnapshot,
  type PolicyResult,
  type Proposal,
} from "../src/negotiation/types.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that records calls and routes (method, path) to handlers. */
function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch, timeoutMs?: number): HttpCommerceClient {
  return new HttpCommerceClient({
    baseUrl: "https://marketplace.example.com/",
    token: "agent-token-123",
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

const VALID_CAPABILITIES = {
  protocol_versions: [PROTOCOL_VERSION],
  backend: "local_marketplace",
  capabilities: {
    catalog_read: true,
    inventory_read: true,
    consultation_read: true,
    consultation_write: true,
    price_negotiate: true,
    webhook: false,
    orders: false,
  },
};

const PROPOSAL: Proposal = {
  sku: "sku-001",
  quantity: 2,
  unit_price: 89,
  currency: "CNY",
  stock: {
    status: "available",
    quantity: 12,
    observed_at: "2026-08-03T00:00:00Z",
    reserved: false,
  },
  delivery: { eta_start: "2026-08-04T00:00:00Z", eta_end: "2026-08-04T04:00:00Z", fee: 0 },
  after_sales_policy_refs: ["policy:return-7d"],
  valid_until: "2026-08-03T01:00:00Z",
};

const VALID_SNAPSHOT: NegotiationSnapshot = {
  protocol_version: PROTOCOL_VERSION,
  conversation: { id: "CONV-1", status: "waiting_merchant", next_actor: "merchant" },
  role: "merchant",
  in_reply_to_message_id: 1,
  product: { sku: "sku-001", title: "手写陶瓷杯", currency: "CNY", list_price: 99 },
  stock: {
    status: "available",
    quantity: 12,
    observed_at: "2026-08-03T00:00:00Z",
    reserved: false,
    source: { backend: "local_marketplace", observed_at: "2026-08-03T00:00:00Z" },
  },
  delivery: { eta_start: "2026-08-04T00:00:00Z", eta_end: "2026-08-04T04:00:00Z", fee: 0 },
  after_sales_policies: [{ ref: "policy:return-7d", summary: "签收后 7 天内无理由退货。" }],
  messages: [
    { id: 1, sender_role: "buyer", created_at: "2026-08-03T00:00:00Z", public_message: "便宜点？" },
  ],
  current_proposal: null,
  open_issues: [],
  policy_results: [],
};

const VALID_POLICY_RESULT: PolicyResult = {
  protocol_version: PROTOCOL_VERSION,
  result: "accepted",
  conversation_id: "CONV-1",
  message_id: 42,
  next_actor: "buyer",
  reason_codes: ["within_policy"],
  public_reason: "决策已接受并写入会话。",
  retries_remaining: 2,
};

function decision(overrides: Partial<NegotiationDecision> = {}): NegotiationDecision {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: "CONV-1",
    in_reply_to_message_id: 1,
    action: "counter",
    proposal: PROPOSAL,
    open_issues: [],
    public_message: "单价 89 元。",
    confidence: 0.9,
    reason_codes: ["within_policy"],
    request_human_review: false,
    ...overrides,
  };
}

describe("HttpCommerceClient 超时 timer 清理（审查 P2-02）", () => {
  it("fetch 拒绝 → timer 清理，不触发迟到的 abort", async () => {
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      const fetchImpl = (async (_url: string, init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => aborted.push("abort"));
        throw new Error("network down");
      }) as typeof fetch;
      const client = makeClient(fetchImpl, 100);
      await expect(client.health()).rejects.toMatchObject({ kind: "transient" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(aborted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redirect 响应 → timer 清理，不触发迟到的 abort", async () => {
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      const fetchImpl = (async (_url: string, init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => aborted.push("abort"));
        return new Response("", { status: 302, headers: { location: "https://evil.example/" } });
      }) as typeof fetch;
      const client = makeClient(fetchImpl, 100);
      await expect(client.health()).rejects.toMatchObject({ kind: "transient" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(aborted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HttpCommerceClient transport", () => {
  it("sends Bearer auth and JSON headers; strips trailing slashes on baseUrl", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ ok: true, service: "shopping", version: "2.0.0" }),
    );
    const health = await makeClient(fetchImpl).health();
    expect(health).toEqual({ ok: true, service: "shopping", version: "2.0.0" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://marketplace.example.com/health");
    expect(calls[0]?.headers.authorization).toBe("Bearer agent-token-123");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.headers.accept).toBe("application/json");
  });

  it("maps HTTP statuses to CommerceError kinds", async () => {
    const cases: [number, string][] = [
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [409, "conflict"],
      [429, "rate_limit"],
      [400, "validation"],
      [422, "validation"],
      [500, "transient"],
      [503, "transient"],
    ];
    for (const [status, kind] of cases) {
      const { fetchImpl } = stubFetch(() => jsonResponse({ ok: false, error: "boom" }, status));
      const err = await makeClient(fetchImpl)
        .health()
        .catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe(kind);
      expect((err as CommerceError).message).toBe("boom");
      expect((err as CommerceError).status).toBe(status);
    }
  });

  it("maps network failures and aborts to transient errors", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await makeClient(fetchImpl)
      .health()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceError);
    expect((err as CommerceError).kind).toBe("transient");
    expect((err as CommerceError).message).toContain("fetch failed");
  });

  it("aborts requests past the per-request timeout", async () => {
    const fetchImpl = ((input: FetchInput, init?: FetchInit): Promise<Response> => {
      void input;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const err = await makeClient(fetchImpl, 5)
      .health()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceError);
    expect((err as CommerceError).kind).toBe("transient");
  });
});

describe("HttpCommerceClient capabilities (real endpoint, schema fail closed)", () => {
  it("GET /capabilities returns the inner capabilities object, validated", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ ok: true, capabilities: VALID_CAPABILITIES }),
    );
    const caps = await makeClient(fetchImpl).getCapabilities();
    expect(caps).toEqual(VALID_CAPABILITIES);
    // Exactly one call, to the real endpoint — never synthesized from /health.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://marketplace.example.com/capabilities");
  });

  it("rejects a missing inner capabilities object as validation", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ ok: true }));
    const err = await makeClient(fetchImpl)
      .getCapabilities()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceError);
    expect((err as CommerceError).kind).toBe("validation");
  });

  it("rejects schema violations (orders=true, missing flags, extra fields)", async () => {
    const variants: unknown[] = [
      // no-order boundary violated
      {
        ...VALID_CAPABILITIES,
        capabilities: { ...VALID_CAPABILITIES.capabilities, orders: true },
      },
      // missing required flag
      {
        ...VALID_CAPABILITIES,
        capabilities: Object.fromEntries(
          Object.entries(VALID_CAPABILITIES.capabilities).filter(([k]) => k !== "webhook"),
        ),
      },
      // unknown extra field (additionalProperties: false)
      { ...VALID_CAPABILITIES, extra: 1 },
      // wrong field type
      { ...VALID_CAPABILITIES, protocol_versions: PROTOCOL_VERSION },
      // unknown backend enum
      { ...VALID_CAPABILITIES, backend: "mystery" },
    ];
    for (const inner of variants) {
      const { fetchImpl } = stubFetch(() => jsonResponse({ ok: true, capabilities: inner }));
      const err = await makeClient(fetchImpl)
        .getCapabilities()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe("validation");
    }
  });
});

describe("HttpCommerceClient pending messages (token-derived role/owner)", () => {
  const pendingPayload = {
    ok: true,
    role: "merchant",
    owner_id: "merchant-001",
    pending: [
      {
        conversation_id: "CONV-1",
        message_id: 3,
        conversation_status: "waiting_merchant",
        sender_role: "buyer",
        preview: "便宜点？",
        created_at: "t3",
      },
      {
        conversation_id: "CONV-2",
        message_id: 8,
        conversation_status: "waiting_merchant",
        sender_role: "buyer",
        preview: "要 2 件",
        created_at: "t8",
      },
    ],
  };

  it("GET /negotiation/pending-messages; no role/owner is sent or required", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(pendingPayload));
    const pending = await makeClient(fetchImpl).listPendingMessages();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://marketplace.example.com/negotiation/pending-messages");
    expect(calls[0]?.body).toBeUndefined();
    expect(pending).toHaveLength(2);
    expect(pending[0]).toEqual({
      conversation_id: "CONV-1",
      message_id: 3,
      conversation_status: "waiting_merchant",
      sender_role: "buyer",
      preview: "便宜点？",
      created_at: "t3",
    });
  });

  it("passes through buyer-side pending entries (server trims by token)", async () => {
    const buyerPending = {
      ok: true,
      role: "buyer",
      owner_id: "buyer-001",
      pending: [
        {
          conversation_id: "CONV-9",
          message_id: 5,
          conversation_status: "waiting_buyer",
          sender_role: "merchant",
          preview: "单价 89 元",
          created_at: "t5",
        },
      ],
    };
    const { fetchImpl } = stubFetch(() => jsonResponse(buyerPending));
    const pending = await makeClient(fetchImpl).listPendingMessages();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sender_role).toBe("merchant");
    expect(pending[0]?.conversation_status).toBe("waiting_buyer");
  });

  it("rejects malformed pending entries as validation", async () => {
    const badVariants: unknown[] = [
      { ok: true }, // no pending array
      { ok: true, pending: "nope" },
      { ok: true, pending: [{ conversation_id: "C" }] }, // missing fields
      { ok: true, pending: [{ ...pendingPayload.pending[0], message_id: "3" }] }, // wrong type
      { ok: true, pending: [{ ...pendingPayload.pending[0], sender_role: "admin" }] }, // bad enum
    ];
    for (const payload of badVariants) {
      const { fetchImpl } = stubFetch(() => jsonResponse(payload));
      const err = await makeClient(fetchImpl)
        .listPendingMessages()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe("validation");
    }
  });
});

describe("HttpCommerceClient claim and process", () => {
  it("POST /negotiation/claims with only conversation_id/message_id/idempotency_key", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({
        ok: true,
        claim: { claimed: true, status: "processing", attempts: 1, idempotency_key: "k1" },
      }),
    );
    const result = await makeClient(fetchImpl).claimMessage({
      conversation_id: "CONV-1",
      message_id: 7,
      idempotency_key: "k1",
    });
    expect(result).toEqual({
      claimed: true,
      status: "processing",
      attempts: 1,
      idempotency_key: "k1",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://marketplace.example.com/negotiation/claims");
    expect(calls[0]?.body).toEqual({
      conversation_id: "CONV-1",
      message_id: 7,
      idempotency_key: "k1",
    });
  });

  it("maps already-claimed (claimed=false) without an error", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({
        ok: true,
        claim: { claimed: false, status: "processed", attempts: 1, idempotency_key: "other" },
      }),
    );
    const result = await makeClient(fetchImpl).claimMessage({
      conversation_id: "CONV-1",
      message_id: 7,
      idempotency_key: "k1",
    });
    expect(result.claimed).toBe(false);
    expect(result.status).toBe("processed");
  });

  it("rejects a malformed claim result as validation", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ ok: true, claim: { claimed: "yes", status: 1 } }),
    );
    const err = await makeClient(fetchImpl)
      .claimMessage({ conversation_id: "CONV-1", message_id: 7, idempotency_key: "k1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceError);
    expect((err as CommerceError).kind).toBe("validation");
  });

  it("complete/fail/abandon post to /negotiation/claims/* with message_id only", async () => {
    const statuses: Record<string, string> = {
      complete: "processed",
      fail: "failed",
      abandon: "abandoned",
    };
    const { fetchImpl, calls } = stubFetch((call) => {
      const verb = call.url.split("/").pop() ?? "";
      return jsonResponse({
        ok: true,
        process: { status: statuses[verb], last_error: "x" },
      });
    });
    const client = makeClient(fetchImpl);
    await client.completeClaim({ message_id: 7, idempotency_key: "k1" });
    await client.failClaim({ message_id: 7, idempotency_key: "k1", error: "boom" });
    await client.abandonClaim({ message_id: 7, idempotency_key: "k1", error: "give up" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://marketplace.example.com/negotiation/claims/complete",
      "https://marketplace.example.com/negotiation/claims/fail",
      "https://marketplace.example.com/negotiation/claims/abandon",
    ]);
    expect(calls[0]?.body).toEqual({ message_id: 7 });
    expect(calls[1]?.body).toEqual({ message_id: 7, error: "boom" });
    expect(calls[2]?.body).toEqual({ message_id: 7, error: "give up" });
  });

  it("rejects an invalid process status as validation", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ ok: true, process: { status: "mystery" } }),
    );
    const err = await makeClient(fetchImpl)
      .completeClaim({ message_id: 7, idempotency_key: "k1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommerceError);
    expect((err as CommerceError).kind).toBe("validation");
  });
});

describe("HttpCommerceClient snapshot (real endpoint, schema fail closed)", () => {
  it("GET /negotiation/snapshot with query params; returns the validated snapshot", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ ok: true, snapshot: VALID_SNAPSHOT }),
    );
    const snapshot = await makeClient(fetchImpl).getNegotiationSnapshot({
      conversation_id: "CONV-1",
      message_id: 1,
    });
    expect(snapshot).toEqual(VALID_SNAPSHOT);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://marketplace.example.com/negotiation/snapshot?conversation_id=CONV-1&message_id=1",
    );
    expect(calls[0]?.body).toBeUndefined();
  });

  it("rejects schema-invalid snapshots (missing field, reserved=true, wrong type)", async () => {
    const variants: unknown[] = [
      { ...VALID_SNAPSHOT, stock: undefined }, // missing required object
      {
        ...VALID_SNAPSHOT,
        stock: { ...VALID_SNAPSHOT.stock, reserved: true }, // no-reservation boundary
      },
      { ...VALID_SNAPSHOT, role: "admin" }, // bad enum
      { ...VALID_SNAPSHOT, merchant_floor_price: 80 }, // private field / additionalProperties
      { ...VALID_SNAPSHOT, product: { ...VALID_SNAPSHOT.product, list_price: "99" } }, // wrong type
    ];
    for (const inner of variants) {
      const { fetchImpl } = stubFetch(() => jsonResponse({ ok: true, snapshot: inner }));
      const err = await makeClient(fetchImpl)
        .getNegotiationSnapshot({ conversation_id: "CONV-1", message_id: 1 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe("validation");
    }
  });
});

describe("HttpCommerceClient submit (real endpoint, schema fail closed)", () => {
  it("POST /negotiation/decisions with {idempotency_key, decision}; validates policy_result", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ ok: true, policy_result: VALID_POLICY_RESULT }),
    );
    const result = await makeClient(fetchImpl).submitNegotiationDecision({
      decision: decision(),
      idempotency_key: "k:submit:abc",
    });
    expect(result).toEqual(VALID_POLICY_RESULT);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://marketplace.example.com/negotiation/decisions");
    expect(calls[0]?.body).toEqual({
      idempotency_key: "k:submit:abc",
      decision: JSON.parse(JSON.stringify(decision())),
    });
  });

  it("rejects a schema-invalid policy_result as validation", async () => {
    const variants: unknown[] = [
      { ...VALID_POLICY_RESULT, result: "maybe" }, // bad enum
      { ...VALID_POLICY_RESULT, retries_remaining: "2" }, // wrong type
      { ...VALID_POLICY_RESULT, floor_price: 80 }, // private field leak / additionalProperties
      { ok: true }, // handled separately below (missing inner object)
    ];
    for (const inner of variants.slice(0, 3)) {
      const { fetchImpl } = stubFetch(() => jsonResponse({ ok: true, policy_result: inner }));
      const err = await makeClient(fetchImpl)
        .submitNegotiationDecision({ decision: decision(), idempotency_key: "k" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe("validation");
    }
    const { fetchImpl } = stubFetch(() => jsonResponse(variants[3]));
    const err = await makeClient(fetchImpl)
      .submitNegotiationDecision({ decision: decision(), idempotency_key: "k" })
      .catch((e: unknown) => e);
    expect((err as CommerceError).kind).toBe("validation");
  });
});

describe("HttpCommerceClient request bodies stay inside the protocol", () => {
  it("no request ever carries merchant_id/role/owner_id/order/payment/reservation fields", async () => {
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.url.endsWith("/capabilities")) {
        return jsonResponse({ ok: true, capabilities: VALID_CAPABILITIES });
      }
      if (call.url.includes("pending-messages")) {
        return jsonResponse({ ok: true, role: "merchant", owner_id: "m", pending: [] });
      }
      if (call.url.endsWith("/negotiation/claims")) {
        return jsonResponse({
          ok: true,
          claim: { claimed: true, status: "processing", attempts: 1, idempotency_key: "k" },
        });
      }
      if (call.url.includes("/negotiation/snapshot")) {
        return jsonResponse({ ok: true, snapshot: VALID_SNAPSHOT });
      }
      if (call.url.endsWith("/negotiation/decisions")) {
        return jsonResponse({ ok: true, policy_result: VALID_POLICY_RESULT });
      }
      return jsonResponse({ ok: true, process: { status: "processed" } });
    });
    const client = makeClient(fetchImpl);
    await client.getCapabilities();
    await client.listPendingMessages();
    await client.claimMessage({ conversation_id: "CONV-1", message_id: 1, idempotency_key: "k" });
    await client.getNegotiationSnapshot({ conversation_id: "CONV-1", message_id: 1 });
    await client.submitNegotiationDecision({ decision: decision(), idempotency_key: "k:s" });
    await client.completeClaim({ message_id: 1, idempotency_key: "k" });
    await client.failClaim({ message_id: 1, idempotency_key: "k", error: "x" });
    await client.abandonClaim({ message_id: 1, idempotency_key: "k", error: "x" });

    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) {
      const raw = JSON.stringify(call.body ?? {}).toLowerCase();
      for (const banned of [
        "merchant_id",
        "owner_id",
        '"role"',
        "order",
        "payment",
        "reservation",
      ]) {
        expect(raw, `${call.url} must not contain ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe("HttpCommerceClient heartbeat and stale recovery (M3)", () => {
  it("POST /negotiation/claims/heartbeat with optional message_id; validates shape", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({
        ok: true,
        heartbeat: { status: "ok", refreshed: 1, at: "2026-08-03T15:00:00" },
      }),
    );
    const client = makeClient(fetchImpl);
    const scoped = await client.heartbeat({ message_id: 7 });
    expect(scoped).toEqual({ status: "ok", refreshed: 1, at: "2026-08-03T15:00:00" });
    const all = await client.heartbeat();
    expect(all.refreshed).toBe(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://marketplace.example.com/negotiation/claims/heartbeat");
    expect(calls[0]?.body).toEqual({ message_id: 7 });
    expect(calls[1]?.body).toEqual({});
  });

  it("rejects a malformed heartbeat result as validation", async () => {
    const variants: unknown[] = [
      { ok: true }, // missing inner object
      { ok: true, heartbeat: { status: "ok", refreshed: "1", at: "t" } }, // wrong type
      { ok: true, heartbeat: { refreshed: 1, at: "t" } }, // missing field
    ];
    for (const payload of variants) {
      const { fetchImpl } = stubFetch(() => jsonResponse(payload));
      const err = await makeClient(fetchImpl)
        .heartbeat({ message_id: 7 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe("validation");
    }
  });

  it("POST /negotiation/claims/abandon-stale with optional ttl_seconds; validates shape", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({
        ok: true,
        stale: { abandoned: 1, message_ids: [7], ttl_seconds: 300, at: "2026-08-03T15:00:00" },
      }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.abandonStaleClaims({ ttl_seconds: 300 });
    expect(result).toEqual({
      abandoned: 1,
      message_ids: [7],
      ttl_seconds: 300,
      at: "2026-08-03T15:00:00",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://marketplace.example.com/negotiation/claims/abandon-stale");
    expect(calls[0]?.body).toEqual({ ttl_seconds: 300 });
    await client.abandonStaleClaims();
    expect(calls[1]?.body).toEqual({});
  });

  it("rejects a malformed stale-recovery result as validation", async () => {
    const variants: unknown[] = [
      { ok: true }, // missing inner object
      { ok: true, stale: { abandoned: 1, message_ids: ["7"], ttl_seconds: 300, at: "t" } },
      { ok: true, stale: { abandoned: 1, message_ids: [7], at: "t" } }, // missing ttl
    ];
    for (const payload of variants) {
      const { fetchImpl } = stubFetch(() => jsonResponse(payload));
      const err = await makeClient(fetchImpl)
        .abandonStaleClaims({ ttl_seconds: 300 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommerceError);
      expect((err as CommerceError).kind).toBe("validation");
    }
  });
});
