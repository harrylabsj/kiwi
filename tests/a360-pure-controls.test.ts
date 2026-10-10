import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { intent, profile } from "./fanout-helpers.js";
let m: typeof import("../src/fanout/disclosure.js") &
  typeof import("../src/negotiation/recovery/recover.js") &
  typeof import("../src/negotiation/context-map/store.js") &
  typeof import("../src/negotiation/ledger/store.js") &
  typeof import("../src/negotiation/idempotency/store.js") &
  typeof import("../src/a2a/server/pipeline.js") &
  typeof import("../src/a2a/server/task-registry.js") &
  typeof import("../src/a2a/server/handler.js") &
  typeof import("../src/negotiation/domain/envelope.js") &
  typeof import("../src/cloud/catalog-client.js") &
  typeof import("../src/cloud/connect-service.js") &
  typeof import("../src/cloud/product-source.js") &
  typeof import("../src/cloud/binding/proofs.js") &
  typeof import("../src/cloud/binding/runtime-challenge.js") &
  typeof import("../src/trust/identity/jws.js") &
  typeof import("../src/trust/binding/thumbprint.js");
const dirs: string[] = [];
const servers: Server[] = [];
const now = () => "2026-10-08T00:00:00.000Z";
beforeAll(async () => {
  const base = process.env.A360_PURE_SOURCE ?? process.cwd();
  const d = fs.mkdtempSync(path.join(process.cwd(), ".a360-pure-bundle-"));
  dirs.push(d);
  const modules = [
    "fanout/disclosure",
    "negotiation/recovery/recover",
    "negotiation/context-map/store",
    "negotiation/ledger/store",
    "negotiation/idempotency/store",
    "a2a/server/pipeline",
    "a2a/server/task-registry",
    "a2a/server/handler",
    "negotiation/domain/envelope",
    "cloud/catalog-client",
    "cloud/connect-service",
    "cloud/product-source",
    "cloud/binding/proofs",
    "cloud/binding/runtime-challenge",
    "trust/identity/jws",
    "trust/binding/thumbprint",
  ];
  const entry = path.join(d, "entry.ts");
  fs.writeFileSync(
    entry,
    modules
      .map((p) => `export * from ${JSON.stringify(path.join(base, "src", p + ".ts"))};`)
      .join("\n"),
  );
  await build({
    entryPoints: [entry],
    outfile: path.join(d, "bundle.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  m = await import(pathToFileURL(path.join(d, "bundle.mjs")).href);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a360-pure-"));
  dirs.push(d);
  return d;
}
function envelope() {
  return m.finalizeEnvelope({
    capability: "com.harrylabsj.kiwi.shopping.negotiation",
    protocol_version: "1.0",
    negotiation_id: "neg_pure",
    exchange_id: "ex_pure",
    message_id: "msg_pure",
    actor: "buyer",
    action: "rfq",
    created_at: now(),
    payload: { type: "rfq", items: [{ sku: "SKU-001", quantity: { value: 1, unit: "piece" } }] },
  });
}
function pipeline(d: string, handler: import("../src/a2a/server/types.js").NegotiationHandler, clock: () => string = now) {
  const ledger = new m.LedgerStore({ dir: d, now: clock });
  const idem = new m.IdempotencyStore({ dir: d, now: clock });
  return {
    ledger,
    idem,
    pipe: new m.InboundPipeline({
      handler,
      ledger,
      idempotency: idem,
      tasks: new m.TaskRegistry(),
      now: clock,
      logError: () => {},
    }),
  };
}
function send(p: import("../src/a2a/server/pipeline.js").InboundPipeline) {
  const e = envelope();
  return p.sendMessage(
    {
      message: {
        role: "user",
        messageId: e.message_id,
        parts: [{ kind: "data", data: { knp_envelope: e } }],
      },
    },
    { senderIdentity: "peer", identityVerified: true },
  );
}
async function waitFor(p: () => boolean) {
  const until = Date.now() + 1500;
  while (!p()) {
    if (Date.now() > until) throw Error("TEST_BARRIER_TIMEOUT");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("A360 pure 2-20 object-key privacy", () => {
  it.each(["phone-case-123", "contact-lens-A", "budget-model"])(
    "public SKU %s is not a private object key",
    (sku) => {
      const p = m.buildDisclosedRfq({
        intent: intent({
          items: [{ sku, quantity: 42, quantity_range: { min: 10, max: 50 }, unit: "piece" }],
        }),
        tier: "anonymous",
        allowed_attributes: [],
      });
      expect(p.rfq.items[0]!.sku).toBe(sku);
    },
  );
  it("nested actual private keys remain rejected", () => {
    const p = m.buildDisclosedRfq({ intent: intent(), tier: "anonymous", allowed_attributes: [] });
    (p.rfq.requested_terms! as Record<string, unknown>).extra = { phone_secret: "fixture-only" };
    expect(m.validateNetworkDisclosure(p, []).ok).toBe(false);
  });
});
describe("A360 pure 3-8 recovery evidence", () => {
  it("known resolved identity is retained on real getState failure", async () => {
    const d = dir();
    const ledger = new m.LedgerStore({ dir: d, now });
    const cm = new m.ContextMapStore({ dir: d, now });
    cm.set("neg_pure", { remote_context_id: "ctx_pure" });
    cm.addTask("neg_pure", "task_pure");
    const rec = new m.NegotiationRecovery({
      ledger,
      contextMap: cm,
      resolveCounterparty: async () => profile("merchant-known"),
      openChannel: async () => ({
        getState: async () => {
          throw new Error("unreachable");
        },
      } as unknown as import("../src/counterparty/channel.js").ChannelHandle),
      now,
    });
    expect((await rec.recover("neg_pure")).status).toBe("reconciliation_required");
    expect(ledger.events("neg_pure").at(-1)!.identity.counterparty_identity).toBe("merchant-known");
  });
  it("failure before resolution remains honestly unresolved", async () => {
    const d = dir();
    const ledger = new m.LedgerStore({ dir: d, now });
    const rec = new m.NegotiationRecovery({
      ledger,
      contextMap: new m.ContextMapStore({ dir: d, now }),
      resolveCounterparty: async () => {
        throw new Error("no profile");
      },
      now,
    });
    expect((await rec.recover("neg_pure")).status).toBe("reconciliation_required");
    expect(ledger.events("neg_pure").at(-1)!.identity.counterparty_identity).toBe("unresolved");
  });
});
describe("A360 pure 3-14 physical store coordination", () => {
  it("different stores can progress independently and each sweeps on injected time", async () => {
    let enterA = false,
      enterB = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const echo = m.echoHandler();
    const a = pipeline(
      dir(),
      {
        name: "A",
        handle: async (ctx: import("../src/a2a/server/types.js").InboundNegotiationContext) => {
          enterA = true;
          await gate;
          return echo.handle(ctx);
        },
      },
      () => "1970-01-01T00:00:03.000Z",
    );
    const b = pipeline(
      dir(),
      {
        name: "B",
        handle: async (ctx: import("../src/a2a/server/types.js").InboundNegotiationContext) => {
          enterB = true;
          return echo.handle(ctx);
        },
      },
      () => "1970-01-01T00:00:03.000Z",
    );
    const sa = vi.spyOn(a.idem, "sweep"),
      sb = vi.spyOn(b.idem, "sweep");
    const pa = send(a.pipe);
    await waitFor(() => enterA);
    const pb = send(b.pipe);
    try {
      await waitFor(() => enterB);
      expect(sa).toHaveBeenCalledTimes(1);
      expect(sb).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([pa, pb]);
    }
  });
  it("same physical store through symlink shares the serial gate, not merely wx rejection", async () => {
    const d = dir();
    const alias = path.join(dir(), "alias");
    fs.symlinkSync(d, alias, "dir");
    let entered = false,
      release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const echo = m.echoHandler();
    let calls = 0;
    const h = {
      name: "shared",
      handle: async (ctx: import("../src/a2a/server/types.js").InboundNegotiationContext) => {
        calls++;
        entered = true;
        await gate;
        return echo.handle(ctx);
      },
    };
    const a = pipeline(d, h),
      b = pipeline(alias, h);
    const pa = send(a.pipe);
    await waitFor(() => entered);
    let settled = false;
    const pb = send(b.pipe).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 35));
    expect(settled).toBe(false);
    release();
    await Promise.all([pa, pb]);
    expect(calls).toBe(1);
  });
});
const pair = generateKeyPairSync("ed25519");
const signing = {
  keyid: "fixture",
  algorithm: "ed25519" as const,
  privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() as unknown as import("node:crypto").KeyObject,
};
function runtimeIdentity() {
  return { keyId: "fixture", signingIdentity: signing };
}
const card = {
  name: "fixture",
  description: "fixture",
  version: "1.0",
  provider: { organization: "fixture" },
  supportedInterfaces: [
    {
      url: "https://runtime.fixture.invalid/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ],
};
async function connection(hook?: () => Promise<void>) {
  const d = dir();
  let t = Date.parse(now());
  const s = m.createMerchantConnectionService({
    dataDir: d,
    catalogUrl: "https://catalog.fixture.invalid",
    publicOrigin: "https://runtime.fixture.invalid",
    loadPublicCard: async () => card,
    now: () => new Date(t),
    beforePublish: hook,
  }) as unknown as Omit<import("../src/cloud/connect-service.js").MerchantConnectionService, never> & { client: import("../src/cloud/catalog-client.js").CatalogClient; keyThumbprint: string };
  s.client.createDeviceEnrollment = async () => ({
    enrollmentId: "enroll_fixture",
    deviceCode: "d".repeat(40),
    userCode: "FIXTURE",
    verificationUri: "https://catalog.fixture.invalid/pair",
    expiresAt: new Date(t + 60000).toISOString(),
    intervalSeconds: 1,
    keyThumbprint: s.keyThumbprint,
  });
  await s.begin();
  t += 2000;
  return { d, s };
}
describe("A360 pure 3-16/17/18 safe owner diagnostics", () => {
  it.each([200, 400])(
    "device access_denied HTTP%d is distinct from malformed/pending",
    async (status) => {
      const c = new m.CatalogClient({
        baseUrl: "https://catalog.fixture.invalid",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "access_denied" }), {
            status,
            headers: { "content-type": "application/json" },
          }),
        now: () => new Date(now()),
      });
      await expect(c.pollDeviceEnrollment("d".repeat(40), runtimeIdentity())).rejects.toMatchObject(
        { code: "AUTHORIZATION_DENIED" },
      );
    },
  );
  it("pending and slow_down remain successful polling states", async () => {
    for (const status of ["authorization_pending", "slow_down"]) {
      const c = new m.CatalogClient({
        baseUrl: "https://catalog.fixture.invalid",
        fetchImpl: async () =>
          new Response(JSON.stringify({ status, interval: 5 }), {
            headers: { "content-type": "application/json" },
          }),
      });
      expect((await c.pollDeviceEnrollment("d".repeat(40), runtimeIdentity())).status).toBe(status);
    }
  });
  it("public reconcile exposes explicit merchant denial safely", async () => {
    const { s } = await connection();
    s.client.pollDeviceEnrollment = async () => {
      throw new m.CatalogClientError("AUTHORIZATION_DENIED", "fixture-only");
    };
    await expect(s.reconcile()).rejects.toThrow();
    expect((await s.getSummary()).code).toBe("PAIRING_DENIED");
  });
  it("produced publication-check code is in the shared safe registry", () => {
    expect(m.CONNECTION_PAIRING_SAFE_CODES.has("PUBLICATION_CHECK_FAILED")).toBe(true);
    expect(m.CONNECTION_PAIRING_SAFE_CODES.has("arbitrary-sensitive-error")).toBe(false);
  });
  it("actual beforePublish ProductTableError produces safe diagnostic and zero publish", async () => {
    const failure = new m.ProductTableError("OWNER_MISMATCH", "secret-file-path-MUST-NOT-LEAK");
    const { s, d } = await connection(async () => {
      throw failure;
    });
    const file = path.join(d, "merchant-enrollments.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(data.sessions[0], {
      status: "bound",
      catalog_agent_id: "cagt_fixture",
      binding_id: "bnd_fixture",
      binding_version: 1,
      merchant_id: "merchant_fixture",
      binding_expires_at: "2026-10-08T01:00:00.000Z",
    });
    fs.writeFileSync(file, JSON.stringify(data));
    const publish = vi.fn();
    s.client.publishCard = publish;
    await expect(s.reconcile()).rejects.toBe(failure);
    const summary = await s.getSummary();
    expect(summary.code).toBe("PRODUCT_TABLE_INVALID");
    expect(summary.detail).toContain("商品表");
    expect(JSON.stringify(summary)).not.toContain("MUST-NOT-LEAK");
    expect(publish).not.toHaveBeenCalled();
  });
});
function challenge() {
  return m.createBindingChallenge({
    purpose: "endpoint",
    agentId: "agent",
    merchantId: "merchant",
    origin: "https://runtime.fixture.invalid",
    path: "/a2a",
    keyThumbprint: m.jwkThumbprint(pair.publicKey.export({ format: "jwk" })),
    generation: 1,
    now: () => new Date(now()),
    ttlSeconds: 30,
  });
}
async function responderCall(ch: object) {
  const responder = m.createChallengeResponder({
    signingIdentity: signing,
    expectedAgentId: "agent",
    expectedMerchantId: "merchant",
    currentGeneration: 1,
    now: () => new Date(now()),
  });
  const s = createServer(responder);
  servers.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  const port = (s.address() as import("node:net").AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}/control/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: ch }),
  });
}
describe("A360 pure 3-21 existing challenge time fields", () => {
  it.each([
    { expires_at: "not-a-date" },
    { issued_at: "garbage" },
    { issued_at: "2026-10-09T00:00:00Z" },
  ])("validly signed malformed/reversed times are rejected %j", (change) => {
    const c = { ...challenge(), ...change };
    const jws = m.signCompactJws(m.challengeSubject(c), signing);
    expect(() =>
      m.verifyBindingChallengeProof({
        challenge: c,
        proofJws: jws,
        publicKey: pair.publicKey,
        store: new m.BindingChallengeStore(),
        options: { now: () => new Date(now()) },
      }),
    ).toThrow();
    expect(() => m.signBindingChallenge(c, signing)).toThrow();
  });
  it("runtime public responder rejects bad expires_at before signing", async () => {
    const response = await responderCall({ ...challenge(), expires_at: "not-a-date" });
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty("proof_jws");
  });
  it("runtime public responder accepts a normal existing challenge", async () => {
    const c = challenge();
    const response = await responderCall(c);
    expect(response.status).toBe(200);
    const body = await response.json() as { proof_jws: string };
    expect(
      m.verifyBindingChallengeProof({
        challenge: c,
        proofJws: body.proof_jws,
        publicKey: pair.publicKey,
        store: new m.BindingChallengeStore(),
        options: { now: () => new Date(now()) },
      }).challenge_id,
    ).toBe(c.challenge_id);
  });
  it("genuinely expired but ordered window retains expired proof and HTTP403 semantics", async () => {
    const c = {
      ...challenge(),
      issued_at: "2026-10-07T23:59:00.000Z",
      expires_at: "2026-10-07T23:59:59.000Z",
    };
    const token = m.signBindingChallenge(c, signing);
    expect(() =>
      m.verifyBindingChallengeProof({
        challenge: c,
        proofJws: token,
        publicKey: pair.publicKey,
        store: new m.BindingChallengeStore(),
        options: { now: () => new Date(now()) },
      }),
    ).toThrow(/过期/);
    const response = await responderCall(c);
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("proof_jws");
  });
  it("normal proof still verifies and repeated challenge consumption rejects", () => {
    const c = challenge(),
      store = new m.BindingChallengeStore();
    const jws = m.signBindingChallenge(c, signing);
    expect(
      m.verifyBindingChallengeProof({
        challenge: c,
        proofJws: jws,
        publicKey: pair.publicKey,
        store,
        options: { now: () => new Date(now()) },
      }).challenge_id,
    ).toBe(c.challenge_id);
    expect(() =>
      m.verifyBindingChallengeProof({
        challenge: c,
        proofJws: jws,
        publicKey: pair.publicKey,
        store,
        options: { now: () => new Date(now()) },
      }),
    ).toThrow();
  });
});
describe("A360 pure 3-42 JOSE restricted profile", () => {
  it.each([
    { crit: ["unknown"], unknown: true },
    { crit: [] },
    { crit: "unknown" },
    { crit: ["x", "x"], x: true },
    { b64: false },
  ])("genuine signature cannot waive unsupported/malformed header %j", (extraHeader) => {
    const token = m.signCompactJws("fixture", signing, { extraHeader });
    expect(() => m.verifyCompactJws(token, pair.publicKey)).toThrow();
  });
  it("ordinary noncritical unknown header remains interoperable", () => {
    const token = m.signCompactJws("fixture", signing, {
      extraHeader: { ordinary_extension: "allowed", b64: true },
    });
    expect(m.verifyCompactJws(token, pair.publicKey).payload.toString()).toBe("fixture");
  });
});
