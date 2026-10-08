import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { A2ANegotiator } from "../src/buyer-core/a2a-negotiator.js";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/store.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import type { MerchantIndex } from "../src/buyer-core/service.js";
const children: Array<{ p: ChildProcess; done: Promise<number | null> }> = [];
const bundles: string[] = [];
const dirs: string[] = [];
const closers: Array<() => void> = [];
function temp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a373-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) close();
  for (const file of bundles.splice(0)) fs.rmSync(file, { force: true });
  for (const c of children.splice(0)) {
    if (c.p.exitCode === null && c.p.signalCode === null) c.p.kill("SIGTERM");
    await c.done;
  }
  for (const d of dirs.splice(0)) {
    if (process.env.A373_RAW_DIR) {
      fs.mkdirSync(process.env.A373_RAW_DIR, { recursive: true });
      for (const name of ["effects", "A.ready", "B.ready", "A.result", "B.result", "stderr"]) {
        const p = path.join(d, name);
        if (fs.existsSync(p))
          fs.copyFileSync(p, path.join(process.env.A373_RAW_DIR, path.basename(d) + "-" + name));
      }
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const T = "2026-10-08T00:00:00.000Z";
const context = {
  taskId: "task-fixed",
  createdAt: T,
  intentBindingDigest: "persisted-intent-policy-digest",
};
const intent = {
  intent_id: "int-recovery",
  intent_type: "purchase",
  items: [{ sku: "SKU", query: "cup", quantity: { value: 1, unit: "piece" } }],
  constraints: { target_unit_price: { currency: "CNY", amount_minor: 80 } },
};
const merchant = {
  merchant_id: "merchant",
  name: "merchant",
  verified: true,
  capabilities: [],
  agent_card_url: "http://127.0.0.1:1/card",
  matching_skus: ["SKU"],
};
function findWire(value: unknown): NegotiationEnvelope | undefined {
  if (!value || typeof value !== "object") return;
  if ("knp_envelope" in value) return (value as { knp_envelope: NegotiationEnvelope }).knp_envelope;
  for (const v of Object.values(value)) {
    const e = findWire(v);
    if (e) return e;
  }
  return;
}
function server() {
  let mode = "offer",
    effects = 0,
    polls = 0;
  let request: NegotiationEnvelope;
  const wires: NegotiationEnvelope[] = [];
  const reply = () =>
    finalizeEnvelope({
      capability: request.capability,
      protocol_version: request.protocol_version,
      negotiation_id: request.negotiation_id,
      exchange_id: "ex-reply",
      message_id: "msg-reply-" + request.message_id,
      actor: "merchant",
      action: "offer",
      in_reply_to: request.message_id,
      created_at: T,
      payload: {
        type: "offer",
        offer_id: "off-reply",
        terms: {
          currency: "CNY",
          items: [
            {
              sku: "SKU",
              quantity: { value: 1, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 100 },
            },
          ],
          total_price: { currency: "CNY", amount_minor: 100 },
        } as TermSet,
      },
    });
  const fetchImpl = (async (_url: unknown, init?: Parameters<typeof globalThis.fetch>[1]) => {
    if (!init?.body)
      return new Response(
        JSON.stringify({
          supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "http://127.0.0.1:1/rpc" }],
        }),
      );
    const body = JSON.parse(String(init.body));
    const wire = findWire(body);
    if (wire) {
      effects++;
      request = wire;
      wires.push(wire);
      if (mode === "lost") throw new Error("effect happened; response lost");
    } else polls++;
    let e = ["working", "working-no-context"].includes(mode) ? request : reply();
    if (mode === "actor") e = finalizeEnvelope({ ...e, actor: "buyer" });
    if (mode === "digest") e = { ...e, digest: "wrong" };
    const task = {
      id: mode.startsWith("wrong-task") ? "other" : "remote-task",
      ...(!["missing-context", "working-no-context", "wrong-task-no-context"].includes(mode)
        ? { contextId: mode === "wrong-context" ? "other" : "remote-context" }
        : {}),
      status: {
        state: ["working", "working-no-context"].includes(mode) ? "working" : "completed",
        message: {
          role: "agent",
          messageId: e.message_id,
          parts: [{ kind: "data", data: { knp_envelope: e } }],
        },
      },
    };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    set: (value: string) => (mode = value),
    effects: () => effects,
    polls: () => polls,
    wires,
  };
}
function options(dir: string, h: ReturnType<typeof server>) {
  return {
    protocolStateDir: dir,
    localBuyerAgentId: "buyer-fixed",
    allowPrivateRanges: true,
    skipDnsCheck: true,
    timeoutMs: 8,
    pollIntervalMs: 1,
    fetchImpl: h.fetchImpl,
  };
}
it("lost response persists unknown over reopen and expired index sweep without a second effect", async () => {
  const d = temp(),
    h = server();
  h.set("lost");
  const first = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  new IdempotencyStore({ dir: d }).sweep("2099-01-01T00:00:00Z");
  const second = await new A2AQuoteFetcher(options(d, h)).requestQuotes(
    intent,
    [merchant],
    context,
  );
  expect({
    effects: h.effects(),
    retryable: [first[0]!.failure?.retryable, second[0]!.failure?.retryable],
  }).toEqual({ effects: 1, retryable: [false, false] });
  expect(h.wires).toHaveLength(1);
});
it("known receipt reopens with only GetTask; original wire id/time stay unchanged", async () => {
  const d = temp(),
    h = server();
  h.set("working");
  const q = new A2AQuoteFetcher(options(d, h));
  await q.requestQuotes(intent, [merchant], context);
  const wire = structuredClone(h.wires[0]);
  h.set("offer");
  const results = await new A2AQuoteFetcher(options(d, h)).requestQuotes(
    intent,
    [merchant],
    context,
  );
  expect(results[0]!.status).toBe("succeeded");
  expect(h.effects()).toBe(1);
  expect(h.polls()).toBeGreaterThan(0);
  expect(h.wires[0]).toEqual(wire);
});
it.each(["wrong-task", "wrong-context", "missing-context", "actor", "digest"])(
  "receipt recovery rejects %s and never resends",
  async (mode) => {
    const d = temp(),
      h = server();
    h.set("working");
    await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
    h.set(mode);
    const result = await new A2AQuoteFetcher(options(d, h)).requestQuotes(
      intent,
      [merchant],
      context,
    );
    expect({ effects: h.effects(), status: result[0]!.status }).toEqual({
      effects: 1,
      status: "failed",
    });
  },
);
it("same operation with different intent is a conflict and does not create a fresh wire", async () => {
  const d = temp(),
    h = server();
  h.set("lost");
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  const r = await new A2AQuoteFetcher(options(d, h)).requestQuotes(
    {
      ...intent,
      items: [{ sku: "DIFFERENT", query: "other", quantity: { value: 2, unit: "piece" } }],
    },
    [merchant],
    context,
  );
  expect(h.effects()).toBe(1);
  expect(r[0]!.failure?.detail).toMatch(/different request/);
});
function policy() {
  return {
    policy_id: "policy",
    version: "1.0",
    principal: "company:test",
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
  };
}
function service(file: string, h: ReturnType<typeof server>, extra: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", h.fetchImpl);
  const s = buildBuyerService({
    dbPath: file,
    principal: "company:test",
    buyerAgentId: "buyer-fixed",
    sessionId: "session",
    policy: policy(),
    catalogUrl: "http://catalog.invalid",
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 8,
    ...extra,
  });
  const inner = s as unknown as { store: TaskApprovalStore; merchantIndex: MerchantIndex };
  inner.merchantIndex = { search: async () => [merchant], resolveById: async () => merchant };
  // Explicit test transport, rather than silently replacing the production RPC default.
  // Native factory/pin/limits integration is exercised separately in the R1 stack controls.
  const protocolStateDir = typeof extra.protocolStateDir === "string" ? extra.protocolStateDir : path.join(path.dirname(file), "buyer-knp");
  const injected = s as unknown as { quoteFetcher: A2AQuoteFetcher; negotiator: A2ANegotiator };
  const transport = { protocolStateDir, localBuyerAgentId: "buyer-fixed", fetchImpl: h.fetchImpl, allowPrivateRanges: true, skipDnsCheck: true, timeoutMs: 8, pollIntervalMs: 1 };
  injected.quoteFetcher = new A2AQuoteFetcher(transport);
  injected.negotiator = new A2ANegotiator({ ...transport, counterProposalGate: p => s.checkCounterProposalLimits(p) });
  closers.push(() => inner.store.close());
  return { s, store: inner.store };
}
it("real service with explicitly injected adapter transport same-key replay performs readonly receipt recovery and updates original candidate", async () => {
  const d = temp(),
    h = server();
  h.set("working");
  const first = service(path.join(d, "buyer.sqlite"), h);
  const input = { intent, merchant_ids: [merchant.merchant_id], idempotency_key: "request-fixed" };
  const before = await first.s.requestQuotes(input);
  const id = String(before.task.task_id);
  const oldCandidate = first.store.listCandidates(id)[0]!;
  first.store.close();
  closers.pop();
  h.set("offer");
  const second = service(path.join(d, "buyer.sqlite"), h);
  const after = await second.s.requestQuotes(input);
  expect({ created: after.created, status: after.task.status, effects: h.effects() }).toEqual({
    created: false,
    status: "succeeded",
    effects: 1,
  });
  expect(second.store.listCandidates(id)).toHaveLength(1);
  expect(second.store.listCandidates(id)[0]!.candidate_id).toBe(oldCandidate.candidate_id);
  expect(h.polls()).toBeGreaterThan(0);
});
it("service legacy task without journal evidence cannot trigger a fresh send on replay", async () => {
  const d = temp(),
    h = server(),
    s = service(path.join(d, "buyer.sqlite"), h);
  const now = new Date().toISOString();
  s.store.createTask({
    task_id: "legacy",
    task_kind: "request_quotes",
    status: "in_progress",
    idempotency_key: "legacy-key",
    created_at: now,
    updated_at: now,
    resumable: true,
    payload: JSON.stringify({ task_id: "legacy", intent, status: "in_progress" }),
  });
  const r = await s.s.requestQuotes({
    intent,
    merchant_ids: [merchant.merchant_id],
    idempotency_key: "legacy-key",
  });
  expect(r.created).toBe(false);
  expect(h.effects()).toBe(0);
});
it("counter unknown throws and cannot turn a failed transport into an appended round", async () => {
  const d = temp(),
    h = server();
  h.set("lost");
  const n = new A2ANegotiator({ ...options(d, h), counterProposalGate: () => undefined });
  const c = {
    candidate_id: "candidate",
    merchant_id: "merchant",
    status: "succeeded",
    provenance: {
      negotiation_id: "existing-neg",
      offer_id: "offer-prior",
      merchant_reply_id: "msg-prior",
      reply_text: JSON.stringify({
        payload: { terms: { items: [{ unit_price: { amount_minor: 100 } }] } },
      }),
      sku: "SKU",
      a2a_endpoint: "http://127.0.0.1:1/rpc",
    },
  };
  const step = { round: 1, action: "counter_offer" as const, summary: "counter" };
  let rejected = 0;
  for (let i = 0; i < 2; i++)
    try {
      await n.negotiate(context.taskId, intent, step, [c], context);
    } catch {
      rejected++;
    }
  expect({ effects: h.effects(), rejected }).toEqual({ effects: 1, rejected: 2 });
});
it.each([":memory:", "", "file::memory:?cache=shared"])(
  "memory/empty/URI db %s cannot implicitly persist protocol files in CWD",
  (dbPath) => {
    expect(() =>
      buildBuyerService({
        dbPath,
        principal: "p",
        buyerAgentId: "b",
        sessionId: "s",
        policy: policy(),
        catalogUrl: "http://catalog.invalid",
      }),
    ).toThrow(/explicit protocolStateDir/);
  },
);
it("marker that was written before failure never permits an uncertain retry to send", async () => {
  const d = temp(),
    h = server();
  const original = IdempotencyStore.prototype.markInFlight;
  const fault = vi.spyOn(IdempotencyStore.prototype, "markInFlight").mockImplementation(function (
    this: IdempotencyStore,
    input,
  ) {
    original.call(this, input);
    throw new Error("after marker persistence fault");
  });
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  fault.mockRestore();
  const next = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  expect(h.effects()).toBe(0);
  expect(next[0]!.failure?.retryable).toBe(false);
});
it("pre-send Ledger intent failure is zero wire and preserves the in-flight barrier", async () => {
  const { LedgerStore } = await import("../src/negotiation/ledger/store.js");
  const d = temp(),
    h = server();
  const append = vi.spyOn(LedgerStore.prototype, "append").mockImplementation(() => {
    throw new Error("intent write failed");
  });
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  append.mockRestore();
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  expect(h.effects()).toBe(0);
});
it("post-effect result commit failure remains unknown, then reopens from original validated reply without resend", async () => {
  const d = temp(),
    h = server();
  const commit = vi.spyOn(IdempotencyStore.prototype, "commit").mockImplementation(() => {
    throw new Error("result write failure");
  });
  const first = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  expect(first[0]!.status).toBe("failed");
  commit.mockRestore();
  const next = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  expect(next[0]!.status).toBe("succeeded");
  expect(h.effects()).toBe(1);
  expect(h.polls()).toBe(0);
});
it("service recovery with explicit custom transport refuses changed persisted intent binding rather than merging an old quote", async () => {
  const d = temp(),
    h = server();
  h.set("working");
  const s = service(path.join(d, "buyer.sqlite"), h);
  const input = { intent, merchant_ids: [merchant.merchant_id], idempotency_key: "intent-changed" };
  const first = await s.s.requestQuotes(input);
  const taskId = String(first.task.task_id),
    snapshot = s.store.getTask(taskId)!;
  s.store.updateTask(
    taskId,
    {
      payload: JSON.stringify({
        ...JSON.parse(snapshot.payload),
        intent: { ...intent, items: [{ query: "changed", quantity: { value: 1, unit: "piece" } }] },
      }),
    },
    snapshot,
  );
  const before = s.store.getTask(taskId);
  h.set("offer");
  await expect(s.s.requestQuotes(input)).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(s.store.getTask(taskId)).toEqual(before);
  expect(h.effects()).toBe(1);
});
it("service recovery with explicit custom transport CAS conflict after readonly poll rolls back candidate writes and preserves journal result", async () => {
  const d = temp(),
    h = server();
  h.set("working");
  const s = service(path.join(d, "buyer.sqlite"), h);
  const input = { intent, merchant_ids: [merchant.merchant_id], idempotency_key: "cas-recovery" };
  const first = await s.s.requestQuotes(input);
  const id = String(first.task.task_id),
    before = s.store.listCandidates(id);
  h.set("offer");
  const q = (
    s.s as unknown as { quoteFetcher: { recoverQuotes: (c: unknown) => Promise<unknown> } }
  ).quoteFetcher;
  const recover = q.recoverQuotes.bind(q);
  q.recoverQuotes = async (c) => {
    const result = await recover(c);
    s.store.updateTask(id, { status: "succeeded" });
    return result;
  };
  await expect(s.s.requestQuotes(input)).rejects.toThrow(/changed/);
  expect(s.store.listCandidates(id)).toEqual(before);
  expect(h.effects()).toBe(1);
});
it("actual service counter unknown does not append a round or permit a new effect after reopen", async () => {
  const d = temp(),
    h = server(),
    file = path.join(d, "buyer.sqlite"),
    s = service(file, h);
  const created = await s.s.requestQuotes({
    intent,
    merchant_ids: [merchant.merchant_id],
    idempotency_key: "counter-seed",
  });
  const id = String(created.task.task_id);
  h.set("lost");
  const args = { task_id: id, action: "counter_offer" as const, summary: "counter" };
  let rejected = 0;
  try {
    await s.s.negotiate(args);
  } catch {
    rejected++;
  }
  const oldTask = s.store.getTask(id)!;
  s.store.close();
  closers.pop();
  const next = service(file, h);
  try {
    await next.s.negotiate(args);
  } catch {
    rejected++;
  }
  expect(rejected).toBe(2);
  expect(h.effects()).toBe(2);
  expect(next.store.getTask(id)?.payload).toBe(oldTask.payload);
  expect(JSON.parse(oldTask.payload).steps ?? []).toHaveLength(0);
});
it("explicit memory database recovery directory is allowed without claiming task restart persistence", () => {
  const h = server(),
    s = service(":memory:", h, { protocolStateDir: path.join(temp(), "protocol") });
  expect(s.s).toBeDefined();
  expect(h.effects()).toBe(0);
});

it("two real children stop before the claim/effect boundary; only one wire effect and one ledger send survive", async () => {
  const d = temp(),
    bundleFile = path.resolve("dist/contracts", path.basename(d) + ".mjs");
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true, mode: 0o700 });
  bundles.push(bundleFile);
  await build({
    stdin: {
      contents:
        'export {A2AQuoteFetcher} from "./buyer-core/a2a-quote-fetcher.ts"; export {IdempotencyStore} from "./negotiation/idempotency/store.ts"; export {finalizeEnvelope} from "./negotiation/domain/envelope.ts";',
      resolveDir: path.resolve("src"),
      loader: "ts",
    },
    outfile: bundleFile,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import {createRequire as a373CreateRequire} from "node:module"; const require=a373CreateRequire(import.meta.url);',
    },
  });
  const jobs = ["A", "B"].map((actor) => {
    const p = spawn(
      process.execPath,
      [
        path.resolve("tests/fixtures/a373-recovery-child.mjs"),
        JSON.stringify({
          dir: d,
          actor,
          bundle: pathToFileURL(bundleFile).href,
          intent,
          merchant,
          context,
        }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    p.stderr?.on("data", (b) => fs.appendFileSync(path.join(d, "stderr"), b));
    const done = new Promise<number | null>((resolve) => p.once("close", resolve));
    const c = { p, done };
    children.push(c);
    return c;
  });
  try {
    const end = Date.now() + 6000;
    while (!["A", "B"].every((a) => fs.existsSync(path.join(d, a + ".ready")))) {
      if (Date.now() > end) throw new Error("child race ready timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    fs.writeFileSync(path.join(d, "go"), "");
    expect(await Promise.all(jobs.map((c) => c.done))).toEqual([0, 0]);
    const effects = fs.readFileSync(path.join(d, "effects"), "utf8").trim().split("\n");
    expect(effects).toHaveLength(1);
    const { LedgerStore } = await import("../src/negotiation/ledger/store.js");
    const ledger = new LedgerStore({ dir: path.join(d, "state") });
    const ids = ledger.listNegotiations();
    expect(ids).toHaveLength(1);
    expect(ledger.verifyChain(ids[0]!).valid).toBe(true);
    expect(ledger.events(ids[0]!).filter((e) => e.event_kind === "message_sent")).toHaveLength(1);
  } finally {
    fs.writeFileSync(path.join(d, "go"), "");
  }
});
it("synchronous bound raw reply without remote context is valid and cached without inventing context", async () => {
  const d = temp(),
    h = server();
  h.set("missing-context");
  const first = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  const second = await new A2AQuoteFetcher(options(d, h)).requestQuotes(
    intent,
    [merchant],
    context,
  );
  expect(first[0]!.status).toBe("succeeded");
  expect(second[0]!.status).toBe("succeeded");
  expect(h.effects()).toBe(1);
  expect(h.polls()).toBe(0);
});

it("private intent constraints are hashed locally but absent from raw wire and ledger text", async () => {
  const d = temp(),
    h = server(),
    privateValue = "fake-sealed-budget-1987654321";
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(
    { ...intent, constraints: { private_budget: privateValue } },
    [merchant],
    context,
  );
  expect(JSON.stringify(h.wires)).not.toContain(privateValue);
  const paths = fs.readdirSync(path.join(d, "ledger")).filter((p) => p.endsWith(".jsonl"));
  expect(paths).toHaveLength(1);
  expect(fs.readFileSync(path.join(d, "ledger", paths[0]!), "utf8")).not.toContain(privateValue);
});

it("counter retry with changed full payload conflicts at the same persisted round and never invents another wire", async () => {
  const d = temp(),
    h = server();
  h.set("lost");
  const n = new A2ANegotiator({ ...options(d, h), counterProposalGate: () => undefined });
  const c = {
    candidate_id: "candidate",
    merchant_id: "merchant",
    status: "succeeded",
    provenance: {
      negotiation_id: "existing-neg",
      offer_id: "offer-prior",
      merchant_reply_id: "msg-prior",
      reply_text: JSON.stringify({
        payload: { terms: { items: [{ unit_price: { amount_minor: 100 } }] } },
      }),
      sku: "SKU",
      a2a_endpoint: "http://127.0.0.1:1/rpc",
    },
  };
  await expect(
    n.negotiate(
      context.taskId,
      intent,
      { round: 1, action: "counter_offer", summary: "original" },
      [c],
      context,
    ),
  ).rejects.toMatchObject({ code: "internal_error" });
  await expect(
    n.negotiate(
      context.taskId,
      intent,
      { round: 1, action: "counter_offer", summary: "changed payload" },
      [c],
      context,
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(h.effects()).toBe(1);
});
it("candidate ownership changed during readonly poll causes conflict and zero new candidates", async () => {
  const d = temp(),
    h = server();
  h.set("working");
  const s = service(path.join(d, "buyer.sqlite"), h),
    input = { intent, merchant_ids: [merchant.merchant_id], idempotency_key: "candidate-changed" };
  const first = await s.s.requestQuotes(input);
  const id = String(first.task.task_id),
    before = s.store.getTask(id),
    candidate = s.store.listCandidates(id)[0]!;
  h.set("offer");
  const q = (
      s.s as unknown as { quoteFetcher: { recoverQuotes: (c: unknown) => Promise<unknown> } }
    ).quoteFetcher,
    recover = q.recoverQuotes.bind(q);
  q.recoverQuotes = async (c) => {
    const result = await recover(c);
    (s.store as unknown as { db: import("node:sqlite").DatabaseSync }).db
      .prepare("UPDATE mcp_candidates SET merchant_id='different-owner' WHERE candidate_id=?")
      .run(String(candidate.candidate_id));
    return result;
  };
  await expect(s.s.requestQuotes(input)).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(s.store.listCandidates(id)).toHaveLength(1);
  expect(s.store.listCandidates(id)[0]!.merchant_id).toBe("different-owner");
  expect(s.store.getTask(id)).toEqual(before);
  expect(h.effects()).toBe(1);
});

it("contextless echo resumes by actual task id only and accepts a strictly bound raw reply", async () => {
  const d = temp(),
    h = server();
  h.set("working-no-context");
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  h.set("missing-context");
  const r = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  expect(r[0]!.status).toBe("succeeded");
  expect(h.effects()).toBe(1);
  expect(h.polls()).toBeGreaterThan(0);
});
it("contextless receipt still rejects a different task id without any new send", async () => {
  const d = temp(),
    h = server();
  h.set("working-no-context");
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  h.set("wrong-task-no-context");
  const r = await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  expect(r[0]!.status).toBe("failed");
  expect(h.effects()).toBe(1);
});
it("later actual context is learned once, then absence and swaps reject while the original value recovers", async () => {
  const d = temp(),
    h = server();
  h.set("working-no-context");
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  h.set("working");
  await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context);
  for (const mode of ["missing-context", "wrong-context"]) {
    h.set(mode);
    expect(
      (await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context))[0]!
        .status,
    ).toBe("failed");
  }
  h.set("offer");
  expect(
    (await new A2AQuoteFetcher(options(d, h)).requestQuotes(intent, [merchant], context))[0]!
      .status,
  ).toBe("succeeded");
  expect(h.effects()).toBe(1);
});

it("same service request key cannot accept a different full intent or selected merchant set as historical replay",async()=>{const d=temp(),h=server(),s=service(path.join(d,"buyer.sqlite"),h),input={intent,merchant_ids:[merchant.merchant_id],idempotency_key:"full-request"};const first=await s.s.requestQuotes(input),before=s.store.getTask(String(first.task.task_id));await expect(s.s.requestQuotes({...input,intent:{...intent,items:[{query:"different",quantity:{value:1,unit:"piece"}}]}})).rejects.toMatchObject({code:"idempotency_conflict"});await expect(s.s.requestQuotes({...input,merchant_ids:["different-target"]})).rejects.toMatchObject({code:"idempotency_conflict"});expect(s.store.getTask(String(first.task.task_id))).toEqual(before);expect(h.effects()).toBe(1);});
