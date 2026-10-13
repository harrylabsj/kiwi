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
      // A659：merchant 栈真实时钟，与 buyer 服务默认真实时钟端到端一致
      //（原固定 August × 真实 October 混用 → 合法 offer 被如实判
      // offer_expired，a373-allowed-candidate.json 实证）；不延长有效期、
      // 不去 expiry 检查。
      now: () => new Date().toISOString(),
      productSource: {
        // A651 接缝修正（claude-ds 待运行复验）：联合 P2 merchant handler 按
        // 源事实严格单位门报价（product.unit 缺省 → field_unsupported decline），
        // intent 请求单位为 "piece"；补真实源字段与 P2 SHARED-FIXTURE-ONLY
        // 同一模式，不改请求单位、不放松源门。
        getProduct: async () => ({
          price: 189,
          currency: "CNY",
          title: "Test Product",
          stock: 10,
          unit: "piece",
          source_evidence: { system: "owned-test-fixture" },
        }),
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
        // A651 校准（经理 2026-10-13）：保持原正向验收目标——不因接收门对本
        // 发行版不支持 conditional_offer 而改写期望凑绿；真实回复语义归
        // claude-ds 实际运行定位（A651 报告 conditional 范围条目）。
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
// A651 接缝修正（claude-ds 待运行复验）：商家回复的 SKU 必须等于实际外发
// outbound RFQ 的 SKU（merchant 无 matching_skus → firstSku(intent) =
// "sku-001"）；A647 receive gate 按实际 persisted outbound 绑定，原 fixture
// 回 "s" 被如实拒为 sku_mismatch（A647 raw 实证）。此处只改 fixture 对齐
// 真实外发，不改请求单位、不放松接收门。
const line = (currency: unknown) => ({
  sku: "sku-001",
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
    // A659（独验 raw a373-custom-negotiate.json 校准）：混币 raw reply 现在
    // 在**接收门**被如实拒（两行 items → unsupported_offer_shape，候选
    // failed），比基线「succeeded-无terms」更早 fail-closed。安全断言保持：
    // 无 terms 投影、counter wire 不外发（effects 只有一次 RFQ 发送）、
    // 全局 transport 未被使用。delegation_denied 语义由 overcap/wrongunit
    // （真实 succeeded 候选）覆盖——此处不再伪造该层。
    const candidates = inner.store.listCandidates(String(created.task.task_id));
    expect(candidates[0]!.terms).toBeUndefined();
    expect(candidates[0]!.status).toBe("failed");
    expect(candidates[0]!.failure).toMatchObject({
      classification: "protocol_error",
      retryable: false,
      detail: "unsupported_offer_shape",
    });
    const negotiated = await service.negotiate({
      task_id: String(created.task.task_id),
      action: "counter_offer",
      summary: "mixed",
    });
    expect(negotiated.step.reply).toBeUndefined();
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
    // Exercise receipt recovery after a working SendMessage, not an 8ms discovery race.
    const service = buildBuyerService({ ...config(dir, endpoint), a2aTimeoutMs: 500 });
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
    expect(methods.filter((m) => m === "SendMessage")).toHaveLength(1);
    offer = true;
    const next = await service.requestQuotes(input);
    expect(next.created).toBe(false);
    expect(next.task.task_id).toBe(first.task.task_id);
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
