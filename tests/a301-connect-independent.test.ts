import * as fs from "node:fs";
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";
import type { JsonWebKey } from "../src/trust/identity/jwk.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMerchantConnectionService } from "../src/cloud/connect-service.js";
import { readEnrollmentStore } from "../src/cloud/binding/enrollment-challenge.js";
import { withEnrollmentStoreLock } from "../src/cloud/binding/store-lock.js";
import { writeFileAtomic, AtomicWriteError } from "../src/fs/atomic-write.js";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { signCompactJws, verifyCompactJws } from "../src/trust/identity/jws.js";
import { validateAgentCard } from "../src/discovery/agent-card/validate.js";
import { canonicalize } from "../src/negotiation/jcs.js";

const ORIGIN = "https://runtime.independent.test",
  CATALOG = "https://catalog.independent.test",
  AGENT = "cagt_independent",
  BIND = "bind-independent";
const card = validateAgentCard({
  name: "Independent merchant",
  description: "Independent connection test",
  provider: { organization: "Independent" },
  version: "1.0",
  url: ORIGIN,
  supportedInterfaces: [
    { url: `${ORIGIN}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
});
const digest = `sha256:${createHash("sha256").update(canonicalize(card)).digest("hex")}`;
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
function directory() {
  const dir = fs.mkdtempSync(join(tmpdir(), "kiwi-a301-"));
  closers.push(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
function delayGate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  let value = "";
  for await (const chunk of req) value += chunk;
  return value === "" ? {} : JSON.parse(value);
}
async function socket(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { server, port: (server.address() as { port: number }).port };
}
function fixtureIdentity(dir: string) {
  const raw = loadOrCreateA2aSigningIdentity(dir, ORIGIN);
  return { raw, thumb: publicKeyThumbprint(raw.publicKeyPem) };
}
function issuerFixture(dir: string, time: () => Date = () => new Date()) {
  const identity = fixtureIdentity(dir),
    issuer = generateKeyPairSync("ed25519"),
    kid = "independent-issuer";
  const jwk = issuer.publicKey.export({ format: "jwk" }) as JsonWebKey;
  const thumb = `sha256:${createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest("hex")}`;
  function claims(overrides: Record<string, unknown> = {}) {
    return {
      ...buildBindingClaims({
        bindingId: BIND,
        bindingVersion: 7,
        merchantId: "merchant-verified",
        agentId: AGENT,
        workloadRef: "wb_independent",
        runtimeOrigin: ORIGIN,
        a2aEndpoint: `${ORIGIN}/a2a`,
        cardUrl: `${CATALOG}/v1/agents/${AGENT}/agent-card.json`,
        keyId: identity.raw.keyid,
        keyThumbprint: identity.thumb,
        serviceEpoch: 9,
        issuedAt: time().toISOString(),
        ttlSeconds: 900,
        issuer: "independent.catalog",
      }),
      ...overrides,
    };
  }
  function envelope(value = claims()) {
    return {
      claims: value,
      claims_jws: signCompactJws(value, {
        keyid: kid,
        algorithm: "ed25519",
        privateKey: issuer.privateKey,
      }),
      issuer_kid: kid,
      issuer_thumbprint: thumb,
      card_revision: 4,
      governance: { publication_state: "ACTIVE" },
      card_etag: '"independent"',
    };
  }
  const keys = {
    issuer: "independent.catalog",
    keys: [
      { kid, state: "ACTIVE", jwk, thumbprint: thumb },
      { kid: "issuer-alias", state: "ACTIVE", jwk, thumbprint: thumb },
    ],
  };
  return { ...identity, issuer, kid, keys, claims, envelope };
}
function seed(dir: string, thumb: string, status = "published") {
  const session = {
    enrollment_id: "enr_independent",
    runtime_origin: ORIGIN,
    key_thumbprint: thumb,
    catalog_origin: CATALOG,
    generation: 1,
    status,
    frozen_card: card,
    preview_digest: digest,
    expires_at: new Date(Date.now() + 600000).toISOString(),
    device_code: "d".repeat(40),
    user_code: "I-1234",
    verification_uri: `${CATALOG}/confirm`,
    interval: 1,
    catalog_agent_id: AGENT,
    grant: "offline-grant",
    authorization_epoch: 1,
    offered_merchant_id: "merchant-verified",
    ...(status === "published"
      ? {
          binding_id: BIND,
          binding_version: 7,
          card_revision: 4,
          binding_expires_at: new Date(Date.now() + 900000).toISOString(),
        }
      : {}),
  };
  fs.writeFileSync(
    join(dir, "merchant-enrollments.json"),
    JSON.stringify({ version: 1, sessions: [session], consumed: ["historical-marker"] }),
    { mode: 0o600 },
  );
  return session;
}
function shim(runtime: number, catalog: number): typeof fetch {
  return ((input: string | URL | Request, init?: Parameters<typeof fetch>[1]) =>
    fetch(
      String(input)
        .replace(CATALOG, `http://127.0.0.1:${catalog}`)
        .replace(ORIGIN, `http://127.0.0.1:${runtime}`),
      init,
    )) as typeof fetch;
}
async function networkFixture(dir: string, time: () => Date = () => new Date()) {
  const issuer = issuerFixture(dir, time);
  const runtime = await socket((_req, res) => json(res, 200, card));
  const counts = { creates: 0, polls: 0, binds: 0, publish: 0, activate: 0, callback: 0 };
  let callbackPort = 0,
    loseBindReply = false;
  const bindEntered = delayGate(),
    bindRelease = delayGate();
  let waitBind = false;
  const catalog = await socket((req, res) => {
    void (async () => {
      await body(req);
      const path = req.url ?? "";
      if (path === "/v1/issuer-keys") return json(res, 200, issuer.keys);
      if (path.endsWith("/runtime-binding")) return json(res, 200, issuer.envelope());
      if (path === "/v1/enrollments/device") {
        counts.creates += 1;
        return json(res, 200, {
          // 真实 Catalog 每次创建都发新随机 id；判死后重新配对的场景会持有
          // 新旧两条会话，固定 id 会让 persist 的 CAS 误判同 id 冲突。
          enrollment_id: counts.creates === 1 ? "enr_independent" : `enr_independent_${counts.creates}`,
          device_code: "d".repeat(40),
          user_code: "I-1234",
          verification_uri: `${CATALOG}/confirm`,
          expires_at: new Date(time().getTime() + 600000).toISOString(),
          interval: 1,
        });
      }
      if (path === "/v1/enrollments/device/token") {
        counts.polls += 1;
        return json(res, 200, {
          status: "authorized",
          enrollment_id: "enr_independent",
          grant: "offline-grant",
          catalog_agent_id: AGENT,
          merchant_id: "merchant-verified",
          runtime_origin: ORIGIN,
          a2a_endpoint: `${ORIGIN}/a2a`,
          expires_at: new Date(time().getTime() + 600000).toISOString(),
          authorization_epoch: 1,
          approved_card_digest: digest,
          scopes: ["runtime:bind", "card:publish", "heartbeat"],
        });
      }
      if (path.endsWith("/runtime-bindings")) {
        counts.binds += 1;
        bindEntered.open();
        if (waitBind) await bindRelease.promise;
        if (callbackPort) {
          const stamp = Date.now();
          const response = await fetch(
            `http://127.0.0.1:${callbackPort}/.well-known/kiwi-binding-challenge`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                enrollment_id: "enr_independent",
                challenge: "q".repeat(40),
                audience: "kiwi-catalog",
                origin: ORIGIN,
                key_thumbprint: issuer.thumb,
                issued_at: new Date(stamp).toISOString(),
                expires_at: new Date(stamp + 60000).toISOString(),
              }),
            },
          );
          counts.callback += 1;
          if (response.status !== 200) throw new Error(`callback ${response.status}`);
        }
        if (loseBindReply) return res.destroy();
        const value = issuer.claims();
        const envelope = issuer.envelope(value);
        return json(res, 200, {
          binding_id: BIND,
          binding_version: 7,
          key_thumbprint: issuer.thumb,
          binding_claim: {
            ...envelope,
            claims: { merchant_id: value.merchant_id, expires_at: value.expires_at },
          },
        });
      }
      if (path.endsWith("/card-publications")) {
        counts.publish += 1;
        return json(res, 200, { revision: 4 });
      }
      if (path.endsWith("/publish")) {
        counts.activate += 1;
        return json(res, 200, { revision: 4 });
      }
      json(res, 404, {});
    })().catch((error) => {
      if (!res.headersSent) json(res, 500, { error: String(error) });
    });
  });
  const options = {
    dataDir: dir,
    catalogUrl: CATALOG,
    publicOrigin: ORIGIN,
    serviceEpoch: 9,
    now: time,
    fetchImpl: shim(runtime.port, catalog.port),
  };
  return {
    issuer,
    runtime,
    catalog,
    counts,
    options,
    bindEntered,
    bindRelease,
    setCallback: (port: number) => {
      callbackPort = port;
    },
    loseReply: () => {
      loseBindReply = true;
    },
    holdBind: () => {
      waitBind = true;
    },
  };
}
function child(runtime: number, catalog: number, dir: string) {
  const process = fork(
    resolve("tests/fixtures/a301-child.mjs"),
    [dir, String(runtime), String(catalog)],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const mailbox: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  process.on("message", (message) => {
    mailbox.push(message as Record<string, unknown>);
    for (const notify of waiters.splice(0)) notify();
  });
  async function event(name: string) {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const index = mailbox.findIndex((item) => item.event === name);
      if (index >= 0) return mailbox.splice(index, 1)[0]!;
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 20)),
      ]);
    }
    throw new Error(`child event timeout ${name}`);
  }
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        if (process.exitCode !== null) {
          if (process.exitCode === 0) resolve();
          else reject(new Error(`child exit ${process.exitCode}`));
          return;
        }
        const timer = setTimeout(() => {
          process.kill("SIGTERM");
          reject(new Error("own child stop timeout"));
        }, 3000);
        process.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`child exit ${code}`));
        });
        process.send("stop");
      }),
  );
  return { process, event };
}

describe("A301 independent Connect critical acceptance", () => {
  it("real signature and full local binding check protect legacy revision-zero merchant backfill", async () => {
    const dir = directory(),
      issuer = issuerFixture(dir);
    let reply = issuer.envelope();
    let heldPublic:
      { entered: ReturnType<typeof delayGate>; release: ReturnType<typeof delayGate> } | undefined;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (!String(input).endsWith("issuer-keys") && heldPublic) {
        heldPublic.entered.open();
        await heldPublic.release.promise;
      }
      return new Response(
        JSON.stringify(String(input).endsWith("issuer-keys") ? issuer.keys : reply),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    const service = createMerchantConnectionService({
      dataDir: dir,
      catalogUrl: CATALOG,
      publicOrigin: ORIGIN,
      serviceEpoch: 9,
      fetchImpl,
    });
    const _original = seed(dir, issuer.thumb);
    const file = join(dir, "merchant-enrollments.json"),
      bytes = fs.readFileSync(file);
    const baseline = issuer.envelope();
    verifyCompactJws(baseline.claims_jws, issuer.issuer.publicKey);
    const cases: Array<(value: typeof reply) => typeof reply> = [
      (value) => {
        delete (value as Partial<typeof value>).claims_jws;
        return value;
      },
      (value) => {
        const pieces = value.claims_jws.split(".");
        const signature = Buffer.from(pieces[2]!, "base64url");
        signature[0] = signature[0]! ^ 1;
        pieces[2] = signature.toString("base64url");
        value.claims_jws = pieces.join(".");
        return value;
      },
      (value) => ({ ...value, claims: { ...value.claims, merchant_id: "unverified-attacker" } }),
      (value) => ({ ...value, issuer_kid: "unknown-issuer" }),
      (value) => ({ ...value, issuer_kid: "issuer-alias" }),
      (value) => ({ ...value, issuer_thumbprint: `sha256:${"0".repeat(64)}` }),
      () => issuer.envelope(issuer.claims({ service_epoch: 8 })),
      () => issuer.envelope(issuer.claims({ key_id: "wrong-runtime-key" })),
      (value) => ({ ...value, card_revision: 5 }),
    ];
    for (const corrupt of cases) {
      reply = corrupt(structuredClone(baseline));
      expect(await service.getVerifiedBinding()).toBeNull();
      expect(fs.readFileSync(file)).toEqual(bytes);
    }
    reply = baseline;
    expect(await service.getVerifiedBinding()).toMatchObject({
      merchantId: "merchant-verified",
      bindingVersion: 7,
      cardRevision: 4,
    });
    const written = readEnrollmentStore(dir).sessions[0] as typeof _original & {
      merchant_id: string;
      store_revision: number;
    };
    expect(written.merchant_id).toBe("merchant-verified");
    expect(written.store_revision).toBe(1);
    expect(readEnrollmentStore(dir).consumed).toEqual(["historical-marker"]);
    seed(dir, issuer.thumb); // An old writer still uses version 1 without revision.
    heldPublic = { entered: delayGate(), release: delayGate() };
    const backfill = service.getVerifiedBinding();
    await heldPublic.entered.promise;
    const replaced = JSON.parse(fs.readFileSync(file, "utf8"));
    replaced.sessions[0].status = "replaced";
    fs.writeFileSync(file, JSON.stringify(replaced));
    const replacedBytes = fs.readFileSync(file);
    heldPublic.release.open();
    expect(await backfill).toBeNull();
    expect(fs.readFileSync(file)).toEqual(replacedBytes); // SnapshotSymbol rejects same-revision stale overwrite.
  });

  it("two genuine processes consume one nonce, reserve one bind/publish and complete a callback without RMW deadlock", async () => {
    const dir = directory(),
      h = await networkFixture(dir);
    seed(dir, h.issuer.thumb, "authorized");
    const a = child(h.runtime.port, h.catalog.port, dir),
      b = child(h.runtime.port, h.catalog.port, dir);
    const [readyA, readyB] = await Promise.all([a.event("ready"), b.event("ready")]);
    const stamp = Date.now(),
      nonce = {
        enrollment_id: "enr_independent",
        challenge: "r".repeat(40),
        audience: "kiwi-catalog",
        origin: ORIGIN,
        key_thumbprint: h.issuer.thumb,
        issued_at: new Date(stamp).toISOString(),
        expires_at: new Date(stamp + 60000).toISOString(),
      };
    const requests = await Promise.all(
      [readyA.port, readyB.port].map((port) =>
        fetch(`http://127.0.0.1:${port}/.well-known/kiwi-binding-challenge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(nonce),
        }),
      ),
    );
    const winnerIndex = requests.findIndex((response) => response.status === 200);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const loserIndex = 1 - winnerIndex;
    const loser = requests[loserIndex]!;
    const rejected = await loser.json() as { error?: string; signature?: string };
    if (loser.status === 503) expect(rejected.error).toBe("challenge_store_busy");
    else { expect(loser.status).toBe(409); expect(rejected.error).toBe("challenge_replayed"); }
    expect(rejected.signature).toBeUndefined();
    const proofResponse = requests[winnerIndex]!;
    const proof = (await proofResponse.json()) as { signature: string };
    verifyCompactJws(proof.signature, createPublicKey(h.issuer.raw.publicKeyPem));
    expect(readEnrollmentStore(dir).consumed).toHaveLength(2); // Historical marker + one nonce.
    const loserPort = loserIndex === 0 ? readyA.port : readyB.port;
    const replay = await fetch(`http://127.0.0.1:${loserPort}/.well-known/kiwi-binding-challenge`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(nonce),
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "challenge_replayed" });
    expect(readEnrollmentStore(dir).consumed).toHaveLength(2);
    expect(h.counts).toMatchObject({ binds: 0, publish: 0, activate: 0, callback: 0 });
    h.setCallback(Number(readyA.port));
    h.holdBind();
    a.process.send("go");
    await h.bindEntered.promise;
    b.process.send("go");
    const blockedBind = await b.event("result");
    expect(blockedBind.code).toBe("CONNECTION_OPERATION_PENDING");
    expect(h.counts.binds).toBe(1);
    h.bindRelease.open();
    await a.event("beforePublish");
    b.process.send("go");
    const blockedPublish = await b.event("result");
    expect(blockedPublish.code).toBe("CONNECTION_OPERATION_PENDING");
    a.process.send("publish");
    const done = await a.event("result");
    expect(done.result).toMatchObject({ status: "published", published: true });
    expect(h.counts).toMatchObject({ binds: 1, publish: 1, activate: 1, callback: 1 });
    expect(readEnrollmentStore(dir).consumed).toHaveLength(3);
    expect(readEnrollmentStore(dir).consumed).toContain("historical-marker");
    const current = readEnrollmentStore(dir).sessions[0] as {
      status: string;
      operation_claim?: unknown;
      store_revision?: number;
    };
    expect(current.status).toBe("published");
    expect(current.operation_claim).toBeUndefined();
    expect(current.store_revision).toBeGreaterThan(0);
  });

  it("a lost bind reply is never retried automatically; after grant window death, explicit begin may re-pair", async () => {
    const dir = directory();
    let ms = Date.now();
    const h = await networkFixture(dir, () => new Date(ms));
    h.loseReply();
    const first = createMerchantConnectionService(h.options);
    await first.begin();
    await expect(first.reconcile()).rejects.toThrow();
    expect(h.counts.binds).toBe(1);
    const retained = readEnrollmentStore(dir).sessions[0] as unknown as {
      status: string;
      operation_claim: { state: string; expires_at: string };
    };
    expect(retained).toMatchObject({ status: "authorized", operation_claim: { state: "unknown" } });
    ms += 601000;
    const restarted = createMerchantConnectionService(h.options);
    // 判死前（窗口刚过、reconcile 尚未标记）：显式 begin 同样拒绝，绝不自动
    // 重试（no stale lease stealing；副作用可能已到达，未对账不得二次 bind）。
    await expect(restarted.begin()).rejects.toMatchObject({ code: "CONNECTION_OPERATION_UNKNOWN" });
    expect(h.counts).toMatchObject({ creates: 1, binds: 1, publish: 0, activate: 0 });
    // reconcile 判死：授权窗口过期 → Catalog 必拒绝该 enrollment 的后续写，
    // 副作用不再悬而未决 → 标 expired 并持久化清除僵尸 claim。
    const judged = await restarted.reconcile();
    expect(judged.status).toBe("expired");
    expect(
      (readEnrollmentStore(dir).sessions[0] as unknown as { operation_claim?: unknown })
        .operation_claim,
    ).toBeUndefined();
    expect(h.counts).toMatchObject({ creates: 1, binds: 1, publish: 0, activate: 0 });
    // 判死后人工显式 begin 放行重新配对（2026-11-24 海纳百川死锁事故：
    // 此前这条路径被永久挡住）。若旧 bind 实际已到达，Catalog 侧按
    // binding_version 收敛到新版，旧版 revoke，不产生双活。
    const repaired = await restarted.begin();
    expect(["preparing", "awaiting_confirmation"]).toContain(repaired.status);
    expect(h.counts).toMatchObject({ creates: 2, binds: 1, publish: 0, activate: 0 });
    // 崩溃残留 active claim（进程未及标记 unknown）在窗口过期后同样：判死前
    // 拒绝、判死后解锁。
    const file = join(dir, "merchant-enrollments.json"),
      crash = JSON.parse(fs.readFileSync(file, "utf8"));
    const last = crash.sessions.length - 1;
    crash.sessions[last].status = "authorized";
    crash.sessions[last].expires_at = new Date(ms - 1000).toISOString();
    crash.sessions[last].operation_claim = {
      token: "crash-leftover",
      stage: "bind",
      state: "active", // Process died before it could mark unknown.
      expires_at: new Date(ms - 1000).toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(crash));
    const afterCrash = createMerchantConnectionService(h.options);
    await expect(afterCrash.begin()).rejects.toMatchObject({
      code: "CONNECTION_OPERATION_UNKNOWN",
    });
    await afterCrash.reconcile();
    const reparedAfterCrash = await afterCrash.begin();
    expect(["preparing", "awaiting_confirmation"]).toContain(reparedAfterCrash.status);
    expect(h.counts).toMatchObject({ creates: 3, binds: 1, publish: 0, activate: 0 });
  });

  it("atomic replacement closes metadata faults, honors explicit private mode and distinguishes pre-rename from committed directory-sync failure", () => {
    const dir = directory(),
      file = join(dir, "store.json");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    writeFileAtomic(file, "private", { mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    let closed = 0,
      callback = 0;
    expect(() =>
      withEnrollmentStoreLock(
        dir,
        () => {
          callback += 1;
        },
        {
          io: {
            ...fs,
            writeFileSync: (() => {
              throw new Error("independent metadata fault");
            }) as typeof fs.writeFileSync,
            closeSync: (fd) => {
              closed += 1;
              fs.closeSync(fd);
            },
          },
        },
      ),
    ).toThrow("independent metadata fault");
    expect(closed).toBe(1);
    expect(callback).toBe(0);
    expect(fs.existsSync(join(dir, "merchant-enrollments.lock"))).toBe(true);
    const preIo = {
      ...fs,
      fsyncSync: (() => {
        throw new Error("file sync fault");
      }) as typeof fs.fsyncSync,
    };
    expect(() => writeFileAtomic(file, "must-not-commit", { io: preIo })).toThrow(AtomicWriteError);
    expect(fs.readFileSync(file, "utf8")).toBe("private");
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    let syncs = 0;
    const postIo = {
      ...fs,
      fsyncSync: ((fd: number) => {
        if (++syncs === 2) throw new Error("directory sync fault");
        fs.fsyncSync(fd);
      }) as typeof fs.fsyncSync,
    };
    try {
      writeFileAtomic(file, "committed", { io: postIo });
      throw new Error("expected directory sync failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicWriteError);
      expect(error).toMatchObject({ code: "ATOMIC_DIRECTORY_SYNC_FAILED", committed: true });
    }
    expect(fs.readFileSync(file, "utf8")).toBe("committed");
  });
});
