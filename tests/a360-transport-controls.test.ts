import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
const pinProbe = vi.hoisted(() => ({ ca: undefined as string | undefined, seen: [] as (https.RequestOptions & { headers: http.OutgoingHttpHeaders })[] }));
vi.mock("node:https", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:https")>();
  return {
    ...real,
    request: (options: https.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      pinProbe.seen.push({ ...options } as https.RequestOptions & { headers: http.OutgoingHttpHeaders });
      return real.request({ ...options, host: "127.0.0.1", ca: pinProbe.ca }, callback);
    },
  };
});
let m: typeof import("../src/merchant-gateway/pinned-fetch.js") &
  typeof import("../src/a2a/client/client.js") &
  typeof import("../src/handoff/ucp-checkout/client.js") &
  typeof import("../src/commerce/http-client.js") &
  typeof import("../src/counterparty/a2a-direct/index.js") &
  typeof import("../src/counterparty/shopping-cli-hosted/index.js") &
  typeof import("../src/fanout/orchestrator.js") &
  typeof import("../src/discovery/merchant-subscriptions.js");
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "a360-transport-"));
  dirs.push(d);
  return d;
}
beforeAll(async () => {
  const base = process.env.A360_TRANSPORT_SOURCE ?? process.cwd();
  // Real source imports, replacing only TLS physical fixture routing. No production
  // source, policy, certificate check, or parser is replaced.
  m = {
    ...(await import(path.join(base, "src/merchant-gateway/pinned-fetch.ts"))),
    ...(await import(path.join(base, "src/a2a/client/client.ts"))),
    ...(await import(path.join(base, "src/handoff/ucp-checkout/client.ts"))),
    ...(await import(path.join(base, "src/commerce/http-client.ts"))),
    ...(await import(path.join(base, "src/counterparty/a2a-direct/index.ts"))),
    ...(await import(path.join(base, "src/counterparty/shopping-cli-hosted/index.ts"))),
    ...(await import(path.join(base, "src/fanout/orchestrator.ts"))),
    ...(await import(path.join(base, "src/discovery/merchant-subscriptions.ts"))),
  };
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of cleanups.splice(0)) await c();
  pinProbe.seen = [];
});
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
async function server(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  tls?: https.ServerOptions,
) {
  const s = tls ? https.createServer(tls, handler) : http.createServer(handler);
  s.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  );
  return { port: (s.address() as import("node:net").AddressInfo).port, url: `http://127.0.0.1:${(s.address() as import("node:net").AddressInfo).port}` };
}
async function waitFor(f: () => boolean) {
  const end = Date.now() + 1200;
  while (!f()) {
    if (Date.now() > end) throw Error("fixture barrier timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function direct(url: string) {
  return new m.A2ADirectChannel({
    url,
    timeoutMs: 800,
    signer: { keyid: "fixture", sign: () => ({}) },
  }).open({ negotiation_id: "neg_transport", sender_identity: "buyer", identity: "merchant" });
}
describe("A360 transport 3-31 upload body contract", () => {
  it("rejects unsupported init and Request-owned body before any network call; string body still exact", async () => {
    let requests = 0,
      body = "";
    const s = await server((req, res) => {
      requests++;
      req.on("data", (b) => (body += b));
      req.on("end", () => res.end("{}"));
    });
    const f = m.createPinnedFetch();
    for (const value of [
      Buffer.from([0, 255]),
      new URLSearchParams({ a: "b" }),
      new Blob(["x"]),
      new ReadableStream(),
    ])
      await expect(f(s.url, { method: "POST", body: value })).rejects.toThrow(/unsupported.*body/i);

    expect(requests).toBe(0);
    const sent = '{"nonascii":"中文","n":1}';
    expect(await (await f(s.url, { method: "POST", body: sent })).text()).toBe("{}");
    expect(body).toBe(sent);
    expect(requests).toBe(1);
  });
  it("Request-owned upload is explicitly rejected before connection rather than silently empty", async () => {
    let calls = 0;
    const s = await server((_req, res) => {
      calls++;
      res.end("{}");
    });
    const f = m.createPinnedFetch();
    await expect(f(new Request(s.url, { method: "POST", body: "request-owned" }))).rejects.toThrow(
      /Request body/,
    );
    expect(calls).toBe(0);
  });
});
describe("A360 transport 3-13 default clients pinned TLS", () => {
  it.each(["a2a", "ucp"])(
    "%s default connects via single validated address preserving Host/SNI and real hostname certificate checks",
    async (kind) => {
      const d = dir();
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          path.join(d, "key.pem"),
          "-out",
          path.join(d, "cert.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=merchant.fixture.test",
          "-addext",
          "subjectAltName=DNS:merchant.fixture.test",
        ],
        { stdio: "ignore" },
      );
      const cert = fs.readFileSync(path.join(d, "cert.pem"), "utf8");
      pinProbe.ca = cert;
      const observed: { host?: string; sni?: string | false | null }[] = [];
      const s = await server(
        (req, res) => {
          let raw = "";
          req.on("data", (c) => (raw += c));
          req.on("end", () => {
            observed.push({ host: req.headers.host, sni: (req.socket as import("node:tls").TLSSocket).servername });
            res.setHeader("content-type", "application/json");
            if (req.url?.includes("checkout-sessions"))
              res.end(
                JSON.stringify({
                  ucp: { status: "success", version: "2026-04-08" },
                  status: "incomplete",
                  session_id: "cs_test",
                  line_items: [
                    { sku: "SKU", quantity: 1, unit_price: { currency: "CNY", amount_minor: 1 } },
                  ],
                  expires_at: "2026-10-09T00:00:00Z",
                }),
              );
            else
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: JSON.parse(raw).id,
                  result: { task: { id: "task", status: { state: "completed" } } },
                }),
              );
          });
        },
        { key: fs.readFileSync(path.join(d, "key.pem")), cert },
      );
      vi.stubGlobal("fetch", () => {
        throw Error("native fetch would re-resolve");
      });
      let lookups = 0;
      const resolveIp = async () => {
        lookups++;
        return lookups === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
      };
      const url = `https://merchant.fixture.test:${s.port}`;
      if (kind === "a2a")
        expect((await new m.A2AClient({ url, version: "0.3", resolveIp }).getTask("task")).id).toBe(
          "task",
        );
      else
        expect(
          (await new m.UcpCheckoutHttpClient({ endpoint: url, resolveIp }).getSession("cs_test"))
            .kind,
        ).toBe("ok");
      expect(lookups).toBe(1);
      expect(
        pinProbe.seen.every(
          (x) =>
            x.host === "93.184.216.34" &&
            x.servername === "merchant.fixture.test" &&
            x.headers.host === `merchant.fixture.test:${s.port}` &&
            x.rejectUnauthorized !== false,
        ),
      ).toBe(true);
      expect(observed).toHaveLength(1);
      expect(observed.every((x) => x.sni === "merchant.fixture.test")).toBe(true);
      await expect(
        new m.A2AClient({
          url: `https://wrong.fixture.test:${s.port}`,
          resolveIp: async () => ["93.184.216.34"],
        }).getTask("task"),
      ).rejects.toThrow(/certificate|hostname|altnames/i);
      expect(observed).toHaveLength(1);
    },
  );
  it("default policy rejects private DNS before TLS socket; injected transport retains explicit boundary", async () => {
    const before = pinProbe.seen.length;
    await expect(
      new m.A2AClient({
        url: "https://merchant.fixture.test",
        resolveIp: async () => ["127.0.0.1"],
      }).getTask("task"),
    ).rejects.toThrow(/loopback/);
    expect(pinProbe.seen.length).toBe(before);
    await expect(
      m.resolvePinnedAddress("merchant.fixture.test", async () => ["another.hostname.test"]),
    ).rejects.toThrow(/不是 IP/);
    let calls = 0;
    const client = new m.A2AClient({
      url: "https://merchant.fixture.test",
      skipDnsCheck: true,
      fetchImpl: async (_u: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls++;
        return Response.json({
          jsonrpc: "2.0",
          id: JSON.parse(init!.body as string).id,
          result: { task: { id: "task", status: { state: "completed" } } },
        });
      },
    });
    expect((await client.getTask("task")).id).toBe("task");
    expect(calls).toBe(1);
  });
});
describe("A360 transport 3-22 actual read deadline cancellation", () => {
  it.each(["a2a", "hosted"])(
    "%s real handle closes a drip response within total fanout wait budget",
    async (kind) => {
      let opened = 0,
        closed = 0;
      const s = await server((_req, res) => {
        opened++;
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        const drip = setInterval(() => res.write(" "), 10);
        res.once("close", () => {
          closed++;
          clearInterval(drip);
        });
      });
      let h: import("../src/counterparty/channel.js").ChannelHandle;
      if (kind === "a2a") h = await direct(s.url);
      else {
        const c = new m.HttpCommerceClient({ baseUrl: s.url, token: "synthetic", timeoutMs: 800 });
        c.claimMessage = async () => ({
          claimed: true,
          status: "processing",
          attempts: 1,
          idempotency_key: "fixture",
        });
        c.abandonClaim = async () => ({ status: "abandoned" } as Awaited<ReturnType<typeof c.abandonClaim>>);
        h = await new m.ShoppingCliHostedChannel({ client: c }).open({
          negotiation_id: "neg_transport",
          sender_identity: "buyer",
          identity: "merchant",
          remote: { conversation_id: "conv", message_id: 1 },
        });
      }
      const ref = {
        negotiation_id: "neg_transport",
        task_id: "task",
        conversation_id: "conv",
        message_id: 1,
      };
      const fan = new m.FanoutOrchestrator({ pollIntervalMs: 5 } as unknown as ConstructorParameters<typeof m.FanoutOrchestrator>[0]) as unknown as { waitForOffer(handle: import("../src/counterparty/channel.js").ChannelHandle, ref: object, timeoutMs: number, messageId: string, negotiationId: string): Promise<{ kind: string }> };
      const start = Date.now();
      try {
        expect(await fan.waitForOffer(h, ref, 70, "msg", "neg_transport")).toEqual({
          kind: "timeout",
        });
        expect(Date.now() - start).toBeLessThan(450);
        await waitFor(() => closed === 1);
        expect(opened).toBe(1);
      } finally {
        await h.close();
      }
    },
  );
  it("deadline during resolver wait prevents any later socket despite a late DNS result", async () => {
    let nativeCalls = 0;
    vi.stubGlobal("fetch", async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      nativeCalls++;
      return Response.json({
        jsonrpc: "2.0",
        id: JSON.parse(init!.body as string).id,
        result: { task: { id: "task", status: { state: "completed" } } },
      });
    });
    const before = pinProbe.seen.length;
    const parent = new AbortController();
    let resolved = false;
    const resolveIp = () =>
      new Promise<string[]>((r) =>
        setTimeout(() => {
          resolved = true;
          r(["93.184.216.34"]);
        }, 80),
      );
    const c = new m.A2AClient({
      url: "https://merchant.fixture.test",
      version: "0.3",
      resolveIp,
      timeoutMs: 800,
    });
    const result = c.getTask("task", { signal: parent.signal, timeoutMs: 40 });
    setTimeout(() => parent.abort(), 15);
    await expect(result).rejects.toThrow();
    await waitFor(() => resolved);
    expect(nativeCalls).toBe(0);
    expect(pinProbe.seen.length).toBe(before);
  });
  it("parent abort affects only its real A2A request, while sibling and old no-options call succeed", async () => {
    let cancelledClosed = false;
    const s = await server((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const q = JSON.parse(raw);
        if (q.params.id === "cancel") {
          res.writeHead(200);
          res.write("{");
          res.once("close", () => (cancelledClosed = true));
        } else
          setTimeout(
            () =>
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: q.id,
                  result: { task: { id: q.params.id, status: { state: "completed" } } },
                }),
              ),
            60,
          );
      });
    });
    const c = new m.A2AClient({ url: s.url, timeoutMs: 800, version: "0.3" }),
      p = new AbortController();
    const start = Date.now();
    const cancelled = c
      .getTask("cancel", { signal: p.signal, timeoutMs: 300 })
      .catch((e: unknown) => e);
    const normal = c.getTask("normal");
    setTimeout(() => p.abort(), 25);
    expect(await cancelled).toBeInstanceOf(Error);
    expect(Date.now() - start).toBeLessThan(450);
    expect((await normal).id).toBe("normal");
    await waitFor(() => cancelledClosed);
  });
});
describe("A360 transport client failure compatibility", () => {
  it("default DNS refusal preserves original unsafe_target classification for both clients", async () => {
    const opts = { resolveIp: async () => ["127.0.0.1"] };
    await expect(
      new m.A2AClient({ url: "https://merchant.fixture.test", ...opts }).getTask("task"),
    ).rejects.toMatchObject({ kind: "unsafe_target" });
    expect(
      await new m.UcpCheckoutHttpClient({
        endpoint: "https://merchant.fixture.test",
        ...opts,
      }).getSession("cs"),
    ).toMatchObject({ kind: "error", code: "unsafe_target" });
  });
  it("UCP fetch rejection does not leave its deadline timer behind", async () => {
    vi.useFakeTimers();
    try {
      const client = new m.UcpCheckoutHttpClient({
        endpoint: "https://merchant.fixture.test",
        skipDnsCheck: true,
        fetchImpl: async () => {
          throw Error("synthetic network");
        },
      });
      expect((await client.getSession("cs")).kind).toBe("error");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("A360 transport completed JSON with unfinished body", () => {
  it.each(["a2a", "commerce"])(
    "%s refuses a valid JSON prefix whose body only ends through cancellation",
    async (kind) => {
      let cancelled = false;
      const fetchImpl = async (_u: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Response(
          new ReadableStream({
            start(x) {
              const payload =
                kind === "a2a"
                  ? {
                      jsonrpc: "2.0",
                      id: JSON.parse(init!.body as string).id,
                      result: { task: { id: "task", status: { state: "completed" } } },
                    }
                  : { ok: true };
              x.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      const client =
        kind === "a2a"
          ? new m.A2AClient({
              url: "https://merchant.fixture.test",
              version: "0.3",
              skipDnsCheck: true,
              fetchImpl,
              timeoutMs: 800,
            })
          : new m.HttpCommerceClient({
              baseUrl: "https://merchant.fixture.test",
              token: "synthetic",
              fetchImpl,
              timeoutMs: 800,
            });
      const result =
        kind === "a2a"
          ? (client as import("../src/a2a/client/client.js").A2AClient).getTask("task", { timeoutMs: 35 })
          : (client as unknown as { request(method: string, path: string, body: undefined, controls: { timeoutMs: number }): Promise<unknown> }).request("GET", "/fixture", undefined, { timeoutMs: 35 });
      await expect(result).rejects.toThrow(/timed out/);
      expect(cancelled).toBe(true);
    },
  );
});
describe("A360 transport 2-19 feed bounds", () => {
  function client(fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof m.MerchantSubscriptionClient>[0]> & { origin?: string } = {}) {
    const d = dir();
    const c = new m.MerchantSubscriptionClient({
      dbPath: path.join(d, "feed.sqlite"),
      resolver: {
        resolve: async () => ({
          origin: options.origin ?? "https://merchant.fixture.test",
          bearerToken: "synthetic",
        }),
      },
      fetchImpl,
      ...options,
    }) as unknown as Omit<import("../src/discovery/merchant-subscriptions.js").MerchantSubscriptionClient, never> & { db: import("node:sqlite").DatabaseSync; applySnapshot(endpoint: import("../src/discovery/merchant-subscriptions.js").MerchantSubscriptionEndpoint, merchantId: string): Promise<void> };
    cleanups.push(() => c.close());
    return c;
  }
  it.each(["headers", "drip"])(
    "real native feed fetch fixture cancels %s socket at request budget",
    async (mode) => {
      let opened = 0,
        closed = 0;
      const s = await server((_req, res) => {
        opened++;
        let timer: ReturnType<typeof setInterval> | undefined;
        if (mode === "drip") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{");
          timer = setInterval(() => res.write(" "), 5);
        }
        const ceiling = setTimeout(() => res.end("}"), 600);
        res.once("close", () => {
          closed++;
          clearInterval(timer);
          clearTimeout(ceiling);
        });
      });
      const c = client(
        (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          fetch(String(url).replace("https://merchant.fixture.test", s.url), init),
        { timeoutMs: 55 },
      );
      const start = Date.now();
      await expect(c.follow("m")).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(450);
      await waitFor(() => closed === 1);
      expect(opened).toBe(1);
    },
  );
  it("hanging response body is physically cancelled on the shared request deadline", async () => {
    let cancelled = false;
    const c = client(
      async () =>
        new Response(
          new ReadableStream({
            start(x) {
              x.enqueue(new TextEncoder().encode("{"));
              setTimeout(() => {
                try {
                  x.close();
                } catch { /* Expected fixture cleanup failure retains the original assertions. */ }
              }, 600);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      { timeoutMs: 40 },
    );
    const t = Date.now();
    await expect(c.follow("m")).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(350);
    expect(cancelled).toBe(true);
  });
  it("oversized chunked response cancels before accumulating beyond cap", async () => {
    let cancelled = false;
    const c = client(
      async () =>
        new Response(
          new ReadableStream({
            start(x) {
              x.enqueue(new Uint8Array(65));
              setTimeout(() => {
                try {
                  x.close();
                } catch { /* Expected fixture cleanup failure retains the original assertions. */ }
              }, 600);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      { maxResponseBytes: 64 },
    );
    await expect(c.follow("m")).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });
  it.each([0, -1, 0.5, null, "1"])(
    "snapshot classifies next_offset %s and commits only a complete valid snapshot",
    async (next) => {
      let pages = 0;
      const c = client(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/snapshot"))
          return Response.json({ snapshot_id: "s", high_water_cursor: "new" });
        pages++;
        if (pages > 1) throw Error("fixture ceiling: bad offset accepted");
        return Response.json({ items: [{ broadcast_id: "new", revision: 1 }], next_offset: next });
      });
      if (next === null) {
        await c.applySnapshot(
          { origin: "https://merchant.fixture.test", bearerToken: "synthetic" },
          "m",
        );
        expect(pages).toBe(1);
        return;
      }
      await expect(
        c.applySnapshot({ origin: "https://merchant.fixture.test", bearerToken: "synthetic" }, "m"),
      ).rejects.toThrow();
      expect(pages).toBe(1);
      expect(c.db.prepare("SELECT count(*) n FROM buyer_merchant_feed_events").get()!.n).toBe(0);
    },
  );
  it("public getUpdates performs full snapshot and cursor update atomically; invalid snapshot leaves previous data", async () => {
    for (const duplicate of [false, true]) {
      let reset = false,
        pages = 0;
      const c = client(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith("/snapshot"))
          return Response.json({ snapshot_id: "s", high_water_cursor: "water" });
        if (url.includes("/snapshots/"))
          return Response.json({
            items: [{ broadcast_id: duplicate ? "same" : `b${pages}`, revision: 1 }],
            next_offset: pages++ === 0 ? 1 : null,
          });
        if (!reset) {
          reset = true;
          return Response.json({ code: "FEED_RESET_REQUIRED" }, { status: 409 });
        }
        return Response.json({ events: [], next_cursor: "after" });
      });
      c.db
        .prepare(
          "INSERT INTO buyer_merchant_subscriptions VALUES ('m','active',NULL,NULL,'prior','t','t')",
        )
        .run();
      c.db
        .prepare(
          "INSERT INTO buyer_merchant_feed_events VALUES ('m','old','snapshot','old',1,'{}','t')",
        )
        .run();
      if (duplicate) {
        await expect(c.getUpdates()).rejects.toThrow();
        expect(c.db.prepare("SELECT event_id FROM buyer_merchant_feed_events").all()).toEqual([
          { event_id: "old" },
        ]);
        expect(
          c.db.prepare("SELECT feed_cursor FROM buyer_merchant_subscriptions").get()!.feed_cursor,
        ).toBe("prior");
      } else {
        expect(await c.getUpdates()).toHaveLength(1);
        expect(c.db.prepare("SELECT count(*) n FROM buyer_merchant_feed_events").get()!.n).toBe(2);
        expect(
          c.db.prepare("SELECT feed_cursor FROM buyer_merchant_subscriptions").get()!.feed_cursor,
        ).toBe("after");
      }
    }
  });
  it("snapshot infinite forward pages and excessive item totals are bounded, normal multi-page commit remains", async () => {
    for (const huge of [false, true]) {
      let pages = 0;
      const c = client(async (input: Parameters<typeof fetch>[0]) =>
        String(input).endsWith("/snapshot")
          ? Response.json({ snapshot_id: "s", high_water_cursor: "new" })
          : Response.json({
              items: huge
                ? Array.from({ length: 10001 }, (_, i) => ({ broadcast_id: `b${i}` }))
                : [],
              next_offset: ++pages,
            }),
      );
      await expect(
        c.applySnapshot({ origin: "https://merchant.fixture.test", bearerToken: "synthetic" }, "m"),
      ).rejects.toThrow(/page limit|item limit/);
      expect(pages).toBeLessThanOrEqual(200);
      expect(c.db.prepare("SELECT count(*) n FROM buyer_merchant_feed_events").get()!.n).toBe(0);
    }
    let page = 0;
    const c = client(async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/snapshot")
        ? Response.json({ snapshot_id: "s", high_water_cursor: "new" })
        : Response.json({
            items: [{ broadcast_id: `b${page}`, revision: 1 }],
            next_offset: page++ === 0 ? 1 : null,
          }),
    );
    await c.applySnapshot(
      { origin: "https://merchant.fixture.test", bearerToken: "synthetic" },
      "m",
    );
    expect(c.db.prepare("SELECT count(*) n FROM buyer_merchant_feed_events").get()!.n).toBe(2);
  });
});
