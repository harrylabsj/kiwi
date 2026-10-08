import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { A2AQuoteFetcher, projectOfferTerms } from "../src/buyer-core/a2a-quote-fetcher.js";
import { A2ANegotiator } from "../src/buyer-core/a2a-negotiator.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { startTestA2aStack } from "./helpers.js";
const policy = (unit = "piece") => ({
  policy_id: "r1",
  version: "1.0",
  principal: "company:r1",
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "auto" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: {
    allowed_merchants: ["merchant-001"],
    allowed_currencies: ["CNY"],
    max_unit_price: { currency: "CNY", amount_minor: 20000 },
    max_total_price: { currency: "CNY", amount_minor: 30000 },
    max_quantity: { value: 10, unit },
  },
});
const intent = (amount = 18000) => ({
  intent_id: "r1-intent",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 1, unit: "piece" } }],
  constraints: { target_unit_price: { currency: "CNY", amount_minor: amount } },
});
function config(dir: string, catalogUrl: string, unit = "piece") {
  return {
    dbPath: path.join(dir, "buyer.sqlite"),
    principal: "company:r1",
    buyerAgentId: "buyer:r1",
    sessionId: "r1",
    policy: policy(unit),
    catalogUrl,
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 1000,
  };
}
it.each([
  ["allowed", 18000, "piece", 1],
  ["overcap", 25000, "piece", 0],
  ["wrongunit", 18000, "kg", 0],
] as const)(
  "native factory %s uses uniform Money facts and actual pinned RPC with hard policy intact",
  async (kind, target, unit, counterCount) => {
    const dir = mkdtempSync(path.join(tmpdir(), "a373-r1-native-"));
    const capture: Array<{
      action: string;
      senderIdentity: string;
      envelope: Record<string, unknown>;
    }> = [];
    const stack = await startTestA2aStack({
      capture,
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 10 }),
      },
    });
    let store: TaskApprovalStore | undefined;
    const native = globalThis.fetch;
    const globalRpc: string[] = [];
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
        if (args[1]?.body) {
          try {
            const body = JSON.parse(String(args[1].body));
            if (["SendMessage", "GetTask"].includes(body.method)) globalRpc.push(body.method);
          } catch { /* Non-RPC discovery bodies are intentionally not counted. */ }
        }
        return native(...args);
      });
      const service = buildBuyerService(config(dir, stack.catalogUrl, unit));
      store = (service as unknown as { store: TaskApprovalStore }).store;
      const created = await service.requestQuotes({
        intent: intent(target),
        merchant_ids: ["merchant-001"],
        idempotency_key: "native",
      });
      const candidate = store.listCandidates(String(created.task.task_id))[0]!;
      expect(candidate.terms).toMatchObject({
        currency: "CNY",
        items: [{ unit_price_minor: 18900, quantity_value: 1, quantity_unit: "piece" }],
      });
      const raw = JSON.parse(String((candidate.provenance as { reply_text: string }).reply_text));
      expect(Object.hasOwn(raw.payload.terms, "currency")).toBe(false);
      if (kind === "wrongunit")
        await expect(
          service.negotiate({
            task_id: String(created.task.task_id),
            action: "counter_offer",
            summary: "native",
          }),
        ).rejects.toMatchObject({ code: "delegation_denied" });
      else {
        const result = await service.negotiate({
          task_id: String(created.task.task_id),
          action: "counter_offer",
          summary: "native",
        });
        if (kind === "allowed") expect(result.step.reply).toBeDefined();
        else expect(result.step.summary).toContain("阻断");
      }
      expect(capture.filter((e) => e.action === "rfq")).toHaveLength(1);
      expect(capture.filter((e) => e.action === "counter_offer")).toHaveLength(counterCount);
      expect(globalRpc, "factory did not explicitly inject a custom transport").toEqual([]);
    } finally {
      vi.restoreAllMocks();
      store?.close();
      await stack.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
const line = (currency: unknown) => ({
  sku: "s",
  quantity: { value: 1, unit: "piece" },
  unit_price: { currency, amount_minor: 100 },
});
it("only truly absent top currency is inferred after checking every Money", () => {
  expect(projectOfferTerms({ terms: { items: [line("CNY"), line("CNY")] } })?.currency).toBe("CNY");
  for (const currency of ["", null, 7, "USD", undefined])
    expect(projectOfferTerms({ terms: { currency, items: [line("CNY")] } })).toBeUndefined();
  expect(projectOfferTerms({ terms: { items: [line("CNY"), line("USD")] } })).toBeUndefined();
  expect(projectOfferTerms({ terms: { items: [line("CNY"), line(undefined)] } })).toBeUndefined();
  for (const currency of ["", undefined, 7, "USD"])
    expect(
      projectOfferTerms({
        terms: { items: [line("CNY")], total_price: { amount_minor: 100, currency } },
      }),
    ).toBeUndefined();
  expect(
    projectOfferTerms({
      terms: { items: [line("CNY")], total_price: { amount_minor: 100, currency: "CNY" } },
    })?.total_price_minor,
  ).toBe(100);
});
it("explicit custom fetch remains honored and mixed-currency raw reply cannot produce a counter wire", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "a373-r1-custom-"));
  let effects = 0;
  const find = (v: unknown): NegotiationEnvelope | undefined => {
    if (!v || typeof v !== "object") return;
    if ("knp_envelope" in v) return (v as { knp_envelope: NegotiationEnvelope }).knp_envelope;
    for (const x of Object.values(v)) {
      const e = find(x);
      if (e) return e;
    }
    return;
  };
  const custom = (async (_url: unknown, init?: Parameters<typeof fetch>[1]) => {
    if (!init?.body)
      return new Response(
        JSON.stringify({
          supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "http://127.0.0.1:1/rpc" }],
        }),
      );
    const body = JSON.parse(String(init.body)),
      wire = find(body)!;
    effects++;
    const { digest: _digest, ...base } = wire;
    const reply = finalizeEnvelope({
      ...base,
      message_id: "reply-" + wire.message_id,
      in_reply_to: wire.message_id,
      actor: "merchant",
      action: "offer",
      payload: { type: "offer", offer_id: "offer", terms: { items: [line("CNY"), line("USD")] } },
    } as Parameters<typeof finalizeEnvelope>[0]);
    const task = {
      id: "remote",
      status: {
        state: "completed",
        message: {
          role: "agent",
          messageId: reply.message_id,
          parts: [{ kind: "data", data: { knp_envelope: reply } }],
        },
      },
    };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task } }));
  }) as typeof fetch;
  const service = buildBuyerService(config(dir, "http://catalog.invalid"));
  const inner = service as unknown as {
    store: TaskApprovalStore;
    quoteFetcher: A2AQuoteFetcher;
    negotiator: A2ANegotiator;
    merchantIndex: unknown;
  };
  const opts = {
    protocolStateDir: path.join(dir, "buyer-knp"),
    localBuyerAgentId: "buyer:r1",
    fetchImpl: custom,
    allowPrivateRanges: true,
    skipDnsCheck: true,
    timeoutMs: 100,
  };
  inner.quoteFetcher = new A2AQuoteFetcher(opts);
  inner.negotiator = new A2ANegotiator({
    ...opts,
    counterProposalGate: (p) => service.checkCounterProposalLimits(p),
  });
  const merchant = {
    merchant_id: "merchant-001",
    name: "test",
    verified: true,
    capabilities: [],
    agent_card_url: "http://127.0.0.1:1/card",
  };
  inner.merchantIndex = { search: async () => [merchant], resolveById: async () => merchant };
  const global = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("unconfigured global transport");
  });
  try {
    const created = await service.requestQuotes({
      intent: intent(),
      merchant_ids: ["merchant-001"],
      idempotency_key: "mixed",
    });
    expect(inner.store.listCandidates(String(created.task.task_id))[0]!.terms).toBeUndefined();
    await expect(
      service.negotiate({
        task_id: String(created.task.task_id),
        action: "counter_offer",
        summary: "mixed",
      }),
    ).rejects.toMatchObject({ code: "delegation_denied" });
    expect(effects).toBe(1);
    expect(global).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    inner.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("native factory receipt recovery uses pinned GetTask rather than an implicit global transport", async () => {
  const { createServer } = await import("node:http");
  const dir = mkdtempSync(path.join(tmpdir(), "a373-r1-get-"));
  let offer = false,
    wire: NegotiationEnvelope | undefined;
  const methods: string[] = [],
    globalRpc: string[] = [];
  let endpoint = "";
  const find = (v: unknown): NegotiationEnvelope | undefined => {
    if (!v || typeof v !== "object") return;
    if ("knp_envelope" in v) return (v as { knp_envelope: NegotiationEnvelope }).knp_envelope;
    for (const x of Object.values(v)) {
      const e = find(x);
      if (e) return e;
    }
    return;
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/card") {
      res.end(
        JSON.stringify({
          supportedInterfaces: [{ protocolBinding: "JSONRPC", url: endpoint + "/rpc" }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      methods.push(body.method);
      const outgoing = find(body);
      if (outgoing) wire = outgoing;
      const request = wire!;
      const { digest: _digest, ...base } = request;
      const reply = offer
        ? finalizeEnvelope({
            ...base,
            message_id: "reply-" + request.message_id,
            in_reply_to: request.message_id,
            actor: "merchant",
            action: "offer",
            payload: { type: "offer", offer_id: "offer-pin", terms: { items: [line("CNY")] } },
          } as Parameters<typeof finalizeEnvelope>[0])
        : request;
      const task = {
        id: "task-pin",
        status: {
          state: "working",
          message: {
            role: "agent",
            messageId: reply.message_id,
            parts: [{ kind: "data", data: { knp_envelope: reply } }],
          },
        },
      };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const native = globalThis.fetch;
  let store: TaskApprovalStore | undefined;
  try {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      if (args[1]?.body) {
        try {
          const b = JSON.parse(String(args[1].body));
          if (["SendMessage", "GetTask"].includes(b.method)) globalRpc.push(b.method);
        } catch { /* Non-RPC discovery bodies are intentionally not counted. */ }
      }
      return native(...args);
    });
    const service = buildBuyerService({ ...config(dir, endpoint), a2aTimeoutMs: 8 });
    const inner = service as unknown as { store: TaskApprovalStore; merchantIndex: unknown };
    store = inner.store;
    const merchant = {
      merchant_id: "merchant-001",
      name: "local",
      verified: true,
      capabilities: [],
      agent_card_url: endpoint + "/card",
    };
    inner.merchantIndex = { search: async () => [merchant], resolveById: async () => merchant };
    const input = {
      intent: intent(),
      merchant_ids: ["merchant-001"],
      idempotency_key: "native-recovery",
    };
    const first = await service.requestQuotes(input);
    expect(first.task.status).toBe("partial_success");
    offer = true;
    const next = await service.requestQuotes(input);
    expect(next.created).toBe(false);
    expect(next.task.status).toBe("succeeded");
    expect(methods.filter((m) => m === "SendMessage")).toHaveLength(1);
    expect(methods.filter((m) => m === "GetTask").length).toBeGreaterThan(0);
    expect(globalRpc).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    store?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
