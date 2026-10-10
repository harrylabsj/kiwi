
type HandlerObservation = import("../src/a2a/server/types.js").NegotiationHandlerResult & {
  reasonCode?: string;
  protocolCode?: string;
  artifactParts?: import("../src/a2a/client/types.js").A2APart[];
};
type OfferFields = { offer_id: string; terms: import("../src/negotiation/domain/common.js").TermSet };
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { InboundPipeline } from "../src/a2a/server/pipeline.js";
import { TaskRegistry } from "../src/a2a/server/task-registry.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/store.js";
import { echoHandler } from "../src/a2a/server/handler.js";
let m: typeof import("../src/a2a/server/merchant-handler.js") &
  typeof import("../src/negotiation/ledger/store.js") &
  typeof import("../src/buyer-core/a2a-knp.js");
let bundle: string;
const dirs: string[] = [];
const children: ChildProcess[] = [];
let serial = 0;
const now = () => "2026-10-08T00:00:00Z";
beforeAll(async () => {
  const base = process.env.A360_SOURCE_ROOT ?? process.cwd();
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".a360-bundle-"));
  dirs.push(dir);
  const entry = path.join(dir, "entry.ts");
  fs.writeFileSync(
    entry,
    `export * from ${JSON.stringify(path.join(base, "src/a2a/server/merchant-handler.ts"))};export * from ${JSON.stringify(path.join(base, "src/negotiation/ledger/store.ts"))};export * from ${JSON.stringify(path.join(base, "src/buyer-core/a2a-knp.ts"))};export {finalizeEnvelope} from ${JSON.stringify(path.join(base, "src/negotiation/domain/envelope.ts"))};`,
  );
  await build({
    entryPoints: [entry],
    outfile: path.join(dir, "bundle.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  bundle = pathToFileURL(path.join(dir, "bundle.mjs")).href;
  m = await import(bundle);
});
afterEach(() => {
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a360-id-"));
  dirs.push(dir);
  const ledger = new m.LedgerStore({ dir, now });
  const handler = m.createMerchantHandler({
    ledger,
    now,
    sender: "merchant-local",
    counterparty: "placeholder",
    allowDemoPriceFallback: true,
  });
  return { dir, ledger, handler };
}
function env(
  action = "rfq",
  payload: Record<string, unknown> = {
    type: "rfq",
    items: [{ sku: "SKU-001", quantity: { value: 1, unit: "piece" } }],
  },
  extra: Record<string, unknown> = {},
): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: "com.harrylabsj.kiwi.shopping.negotiation",
    protocol_version: "1.0",
    negotiation_id: "neg_test",
    exchange_id: "ex_" + ++serial,
    message_id: "msg_" + serial,
    actor: "buyer",
    action,
    created_at: now(),
    payload,
    ...extra,
  } as unknown as Parameters<typeof finalizeEnvelope>[0]);
}
function handle(h: import("../src/a2a/server/types.js").NegotiationHandler, e: NegotiationEnvelope, peer = "peer-a") {
  return h.handle({
    envelope: e,
    message: { role: "user", messageId: e.message_id, parts: [] },
    taskId: "task_" + e.message_id,
    senderIdentity: peer,
  }) as Promise<HandlerObservation>;
}
function reply(r: HandlerObservation): NegotiationEnvelope {
  return ((r.message as import("../src/a2a/client/types.js").A2AMessage).parts.find((p) => p.kind === "data") as Extract<import("../src/a2a/client/types.js").A2APart, { kind: "data" }>).data.knp_envelope as NegotiationEnvelope;
}
function task(e: NegotiationEnvelope): import("../src/a2a/client/types.js").A2ATask {
  return {
    id: "task_reply",
    status: {
      state: "completed",
      message: {
        role: "agent",
        messageId: e.message_id,
        parts: [{ kind: "data", data: { knp_envelope: e } }],
      },
    },
  };
}
async function until(p: () => boolean) {
  const end = Date.now() + 5000;
  while (!p()) {
    if (Date.now() > end) throw Error("PARENT_BARRIER_TIMEOUT");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("A360 2-1 trusted negotiation binding", () => {
  it("foreign sender cannot accept a known merchant offer; real owner still accepts", async () => {
    const { handler } = setup();
    const offer = reply(await handle(handler, env()));
    const payload = offer.payload as unknown as OfferFields;
    const accepted = env(
      "accept_nonbinding",
      {
        type: "accept_nonbinding",
        offer_id: payload.offer_id,
        terms_digest: contentDigest(payload.terms),
      },
      { in_reply_to: offer.message_id },
    );
    const foreign: HandlerObservation = await handle(handler, accepted, "peer-b");
    expect(foreign.kind).toBe("declined");
    expect(foreign.reasonCode).toBe("authorization_failed");
    const owner: HandlerObservation = await handle(handler, { ...accepted, message_id: "msg_real_owner" });
    expect(owner.kind).toBe("accepted");
    expect(owner.artifactParts?.some((p) => (p as Extract<import("../src/a2a/client/types.js").A2APart, { kind: "data" }>).data?.agreement)).toBe(true);
  });
  it("wrong actor cannot claim or change a negotiation", async () => {
    const s = setup();
    const r: HandlerObservation = await handle(s.handler, env("rfq", undefined, { actor: "merchant" }));
    expect(r.kind).toBe("declined");
    expect(s.ledger.events("neg_test")).toHaveLength(0);
    expect(((await handle(s.handler, env())) as HandlerObservation).kind).toBe("accepted");
  });
  it("same owner restart accepts; foreign restart does not adopt owner", async () => {
    const s = setup();
    const offer = reply(await handle(s.handler, env()));
    const h = m.createMerchantHandler({
      ledger: new m.LedgerStore({ dir: s.dir, now }),
      now,
      sender: "merchant-local",
      counterparty: "placeholder",
      allowDemoPriceFallback: true,
    });
    const p = offer.payload as unknown as OfferFields;
    const a = env(
      "accept_nonbinding",
      { type: "accept_nonbinding", offer_id: p.offer_id, terms_digest: contentDigest(p.terms) },
      { in_reply_to: offer.message_id },
    );
    expect(((await handle(h, a, "peer-b")) as HandlerObservation).kind).toBe("declined");
    expect(((await handle(h, { ...a, message_id: "msg_restart_owner" })) as HandlerObservation).kind).toBe(
      "accepted",
    );
  });
  it("buyer cannot withdraw merchant-authored offer; legal decline remains one transition", async () => {
    const s = setup();
    const offer = reply(await handle(s.handler, env()));
    const p = offer.payload as unknown as OfferFields;
    const target = {
      scope: "offer",
      target_message_id: offer.message_id,
      target_offer_id: p.offer_id,
    };
    expect(
      ((await handle(s.handler, env("withdraw", { type: "withdraw", ...target }))) as HandlerObservation)
        .reasonCode,
    ).toBe("authorization_failed");
    expect(
      ((await handle(s.handler, env("decline", { type: "decline", ...target }))) as HandlerObservation).kind,
    ).toBe("accepted");
    expect(
      s.ledger.events("neg_test").filter((e) => e.state_transition?.to_phase === "OPEN"),
    ).toHaveLength(1);
  });
  it("rejected same-ID buyer proposal cannot impersonate the merchant active offer author", async () => {
    const s = setup();
    const offer = reply(await handle(s.handler, env()));
    const p = offer.payload as unknown as OfferFields;
    const fake = env("offer", { type: "offer", offer_id: p.offer_id, terms: p.terms });
    expect(((await handle(s.handler, fake)) as HandlerObservation).kind).toBe("declined");
    const withdrawal = env("withdraw", {
      type: "withdraw",
      scope: "offer",
      target_message_id: fake.message_id,
      target_offer_id: p.offer_id,
    });
    expect(((await handle(s.handler, withdrawal)) as HandlerObservation).reasonCode).toBe("offer_unknown");
    expect(
      s.ledger.events("neg_test").filter((e) => e.state_transition?.to_phase === "OPEN"),
    ).toHaveLength(0);
  });
  it("bound buyer can withdraw its own active offer after a pre-effect quote failure", async () => {
    const s = setup();
    const h = m.createMerchantHandler({
      ledger: s.ledger,
      now,
      sender: "merchant-local",
      counterparty: "placeholder",
      productSource: {
        getProduct: async () => {
          throw new Error("product unavailable");
        },
      } as unknown as NonNullable<Parameters<typeof m.createMerchantHandler>[0]["productSource"]>,
    });
    const own = env("offer", {
      type: "offer",
      offer_id: "offer_own",
      terms: {
        items: [
          {
            sku: "SKU-001",
            quantity: { value: 1, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 100 },
          },
        ],
      },
    });
    expect(((await handle(h, own)) as HandlerObservation).kind).toBe("declined");
    const withdraw = env("withdraw", {
      type: "withdraw",
      scope: "offer",
      target_message_id: own.message_id,
      target_offer_id: "offer_own",
    });
    expect(((await handle(h, withdraw)) as HandlerObservation).kind).toBe("accepted");
    expect(
      s.ledger.events("neg_test").filter((e) => e.state_transition?.to_phase === "OPEN"),
    ).toHaveLength(1);
  });
  it("legacy commercial history without trusted inbound receipt cannot be adopted", async () => {
    const s = setup();
    const offer = finalizeEnvelope({
      ...env(),
      actor: "merchant",
      action: "offer",
      payload: {
        type: "offer",
        offer_id: "offer_old",
        terms: {
          items: [
            {
              sku: "SKU-001",
              quantity: { value: 1, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 85000 },
            },
          ],
        },
      },
    } as unknown as Parameters<typeof finalizeEnvelope>[0]);
    s.ledger.append({
      event_kind: "message_sent",
      negotiation_id: "neg_test",
      message_id: offer.message_id,
      identity: {
        sender_identity: "merchant-local",
        counterparty_identity: "guessed",
        actor: "merchant",
      },
      capability: { capability: offer.capability, protocol_version: "1.0" },
      wire_payload: offer as unknown as Record<string, unknown>,
      wire_digest: offer.digest,
      outcome: { kind: "ok" },
      occurred_at: now(),
    });
    const h = m.createMerchantHandler({
      ledger: s.ledger,
      now,
      sender: "merchant-local",
      counterparty: "placeholder",
      allowDemoPriceFallback: true,
    });
    const r: HandlerObservation = await handle(h, env());
    expect(r.kind).toBe("error");
    expect(r.protocolCode).toBe("reconciliation_required");
  });
  it("legacy pipeline snapshot restores owner; raw remote peer_binding cannot override it", async () => {
    const s = setup();
    const pipeline = new InboundPipeline({
      handler: echoHandler(),
      ledger: s.ledger,
      idempotency: new IdempotencyStore({ dir: s.dir, now }),
      tasks: new TaskRegistry(),
      now,
      logError: () => {},
    });
    const e = env("rfq", {
      type: "rfq",
      items: [{ sku: "SKU-001", quantity: { value: 1, unit: "piece" } }],
      peer_binding: {
        sender_identity: "peer-b",
        actor: "buyer",
        version: 1,
        type: "merchant-peer-binding",
      },
    });
    await pipeline.sendMessage(
      {
        message: {
          role: "user",
          messageId: e.message_id,
          parts: [{ kind: "data", data: { knp_envelope: e } }],
        },
      },
      { senderIdentity: "peer-a", identityVerified: true },
    );
    const h = m.createMerchantHandler({
      ledger: s.ledger,
      now,
      sender: "merchant-local",
      counterparty: "placeholder",
      allowDemoPriceFallback: true,
    });
    expect(((await handle(h, env(), "peer-b")) as HandlerObservation).kind).toBe("declined");
    expect(((await handle(h, env(), "peer-a")) as HandlerObservation).kind).toBe("accepted");
  });
  it("two real processes racing same negotiation bind exactly one sender", async () => {
    const s = setup();
    const go = path.join(s.dir, "go");
    const done = [];
    for (const peer of ["peer-a", "peer-b"]) {
      const o = {
        peer,
        dir: s.dir,
        bundle,
        go,
        ready: path.join(s.dir, peer + ".ready"),
        result: path.join(s.dir, peer + ".json"),
      };
      const c = spawn(
        process.execPath,
        ["tests/fixtures/a360-binding-child.mjs", JSON.stringify(o)],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(c);
      c.stderr!.on("data", (x) => process.stderr.write(x));
      done.push(
        new Promise<number | null>((resolve, reject) => {
          c.once("error", reject);
          c.once("exit", resolve);
        }),
      );
    }
    await until(() =>
      ["peer-a", "peer-b"].every((p) => fs.existsSync(path.join(s.dir, p + ".ready"))),
    );
    fs.writeFileSync(go, "go");
    expect(await Promise.all(done)).toEqual([0, 0]);
    const values = ["peer-a", "peer-b"].map((p) =>
      JSON.parse(fs.readFileSync(path.join(s.dir, p + ".json"), "utf8")),
    );
    const raw = process.env.A360_RAW_DIR;
    if (raw) {
      fs.mkdirSync(raw, { recursive: true });
      fs.writeFileSync(
        path.join(raw, "cross-process.json"),
        JSON.stringify({ values, events: s.ledger.events("neg_cross_process") }, null, 2),
      );
    }
    expect(values.filter((v) => v.kind === "accepted")).toHaveLength(1);
    expect(values.filter((v) => v.reason === "authorization_failed")).toHaveLength(1);
  });
});

describe("A360 2-7 raw merchant reply authority (partial ID)", () => {
  function pair(extra: Record<string, unknown> = {}) {
    const request = env();
    const response = finalizeEnvelope({
      ...request,
      message_id: "msg_reply",
      actor: "merchant",
      action: "offer",
      in_reply_to: request.message_id,
      payload: {
        type: "offer",
        offer_id: "offer_reply",
        terms: {
          items: [
            {
              sku: "SKU-001",
              quantity: { value: 1, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 100, extension: "kept" },
            },
          ],
        },
        signature: "business",
      },
      ...extra,
    } as unknown as Parameters<typeof finalizeEnvelope>[0]);
    return { request, response };
  }
  it("valid raw reply and legal extensions survive extraction", () => {
    const { request, response } = pair();
    expect(m.extractKnpEnvelope(task(response), request)).toEqual(response);
  });
  it("modified digest cannot be extracted", () => {
    const { request, response } = pair();
    expect(() =>
      m.extractKnpEnvelope(task({ ...response, public_message: "changed" }), request),
    ).toThrow();
  });
  it.each([
    { actor: "buyer" },
    { negotiation_id: "neg_other" },
    { in_reply_to: "msg_other" },
    { capability: "different" },
  ])("valid digest with wrong reply binding rejects %j", (change) => {
    const { request, response } = pair(change);
    expect(() => m.extractKnpEnvelope(task(response), request)).toThrow();
  });
  it("unknown top-level field and invalid condition extra reject with correct raw digest", () => {
    const { request, response } = pair({ signature: "invalid_top" });
    expect(() => m.extractKnpEnvelope(task(response), request)).toThrow();
    const c = pair({
      action: "conditional_offer",
      payload: {
        type: "conditional_offer",
        offer_id: "offer_c",
        base_terms: {},
        conditions: [
          {
            when: { field: "aggregate.total_quantity", op: "gte", value: 1, extra: true },
            then_terms: {},
          },
        ],
      },
    });
    expect(() => m.extractKnpEnvelope(task(c.response), c.request)).toThrow();
  });
});
