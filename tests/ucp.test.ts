/**
 * UCP Profile WP1 测试（基线 §3.2 / §25 / §8.3 / §43）。
 *
 * 覆盖：
 *   - validateUcpProfile：合法 profile（含 a2a transport）、三段式 namespace 拒绝、
 *     origin 绑定越权拒绝（按条目丢弃并记录，不连带整份 profile 失败）、transport 枚举、
 *     a2a endpoint MUST 指向 Agent Card URL、version 日期格式、未知字段 forward-compat 保留；
 *   - UcpResolver：HTTPS only、不跟随重定向、超时、Cache-Control 校验、按 Cache-Control
 *     缓存（60s 地板）、错误码映射、SSRF 复用 url-policy、按条目拒绝结果透传；
 *   - Kiwi vendor capability 构造器：example.kiwi.shopping.negotiation + 完整 vendor profile。
 */
import { describe, expect, it } from "vitest";
import {
  UcpError,
  UcpResolver,
  buildKiwiNegotiationCapability,
  buildKiwiVendorProfile,
  parseCacheControl,
  validateUcpProfile,
} from "../src/discovery/ucp/index.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

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
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 合法 profile：com.example.* → authority example.com；含 rest + a2a transport。 */
function validProfile(
  overrides: Record<string, unknown> = {},
  ucpOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const baseUcp = {
    version: "2026-04-08",
    services: {
      "com.example.shopping": [
        {
          version: "1.0",
          spec: "https://example.com/specs/shopping.json",
          transport: "rest",
          endpoint: "https://example.com/api",
          schema: "https://example.com/schemas/shopping.json",
        },
        {
          version: "1.0",
          spec: "https://example.com/specs/shopping-a2a.json",
          transport: "a2a",
          endpoint: "https://example.com/.well-known/agent-card.json",
        },
      ],
    },
    capabilities: {
      "com.example.shopping.negotiation": [
        {
          version: "1.0",
          spec: "https://example.com/specs/negotiation.json",
          schema: "https://example.com/schemas/negotiation.json",
        },
      ],
    },
  };
  return { signing_keys: [{ kty: "EC", kid: "k1" }], ...overrides, ucp: { ...baseUcp, ...ucpOverrides } };
}

describe("validateUcpProfile", () => {
  it("accepts a valid profile with rest + a2a transports; preserves forward-compat unknown fields", () => {
    const result = validateUcpProfile(
      validProfile({ x_extra: { keep: true } }, { x_flag: "keep-me" }),
    );
    expect(result.rejected).toEqual([]);
    expect(result.profile.ucp.version).toBe("2026-04-08");

    const services = result.profile.ucp.services!["com.example.shopping"]!;
    expect(services).toHaveLength(2);
    expect(services[0]?.transport).toBe("rest");
    expect(services[1]?.transport).toBe("a2a");
    expect(services[1]?.endpoint).toBe("https://example.com/.well-known/agent-card.json");
    expect(result.profile.ucp.capabilities!["com.example.shopping.negotiation"]).toHaveLength(1);

    // forward-compat：未知字段原样保留
    expect(result.profile.x_extra).toEqual({ keep: true });
    expect(result.profile.ucp.x_flag).toBe("keep-me");
    expect(result.profile.signing_keys).toEqual([{ kty: "EC", kid: "k1" }]);
  });

  it("preserves forward-compat unknown fields inside a capability entry", () => {
    const result = validateUcpProfile(
      validProfile(
        {},
        {
          capabilities: {
            "com.example.shopping.negotiation": [
              {
                version: "1.0",
                spec: "https://example.com/x",
                schema: "https://example.com/y",
                x_note: "future-field",
              },
            ],
          },
        },
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.profile.ucp.capabilities?.["com.example.shopping.negotiation"]?.[0]?.x_note).toBe(
      "future-field",
    );
  });

  it("rejects a non-object / missing ucp / bad ucp.version date as profile_malformed", () => {
    expect(() => validateUcpProfile("nope")).toThrow(UcpError);
    expect(() => validateUcpProfile(null)).toThrow(UcpError);
    expect(() => validateUcpProfile([])).toThrow(UcpError);
    expect(() => validateUcpProfile({})).toThrow(/ucp/);
    expect(() => validateUcpProfile({ ucp: {} })).toThrow(/version/);
    expect(() => validateUcpProfile({ ucp: { version: "2026-13-45" } })).toThrow(/version/);
    expect(() => validateUcpProfile({ ucp: { version: "2026-02-30" } })).toThrow(/version/);
    expect(() => validateUcpProfile({ ucp: { version: "1.0" } })).toThrow(/version/);
    expect(() =>
      validateUcpProfile({ ucp: { version: "2026-04-08", services: "nope" } }),
    ).toThrow(/services/);
  });

  it("rejects non-three-role namespaces per entry (drop + record), keeping the rest", () => {
    const result = validateUcpProfile({
      ucp: {
        version: "2026-04-08",
        services: {
          // 1 label → 无 reverse-domain，非法 service 名
          shopping: [{ version: "1.0", spec: "https://example.com/x", transport: "rest" }],
          "com.example.shopping": [
            {
              version: "1.0",
              spec: "https://example.com/x",
              transport: "rest",
              endpoint: "https://example.com/api",
            },
          ],
        },
        capabilities: {
          // 2 labels → 无 reverse-domain，非法 capability 名
          "shopping.negotiation": [
            { version: "1.0", spec: "https://example.com/x", schema: "https://example.com/y" },
          ],
          // reverse-domain 仅 1 label（com）→ 非法
          "com.example.negotiation": [
            { version: "1.0", spec: "https://com/x", schema: "https://com/y" },
          ],
          "com.example.shopping.negotiation": [
            { version: "1.0", spec: "https://example.com/x", schema: "https://example.com/y" },
          ],
        },
      },
    });
    expect(result.rejected.map((r) => r.code)).toEqual([
      "namespace_invalid",
      "namespace_invalid",
      "namespace_invalid",
    ]);
    expect(result.rejected.map((r) => r.name)).toEqual([
      "shopping",
      "shopping.negotiation",
      "com.example.negotiation",
    ]);
    expect(result.profile.ucp.services).toEqual({ "com.example.shopping": expect.any(Array) });
    expect(result.profile.ucp.capabilities?.["com.example.shopping.negotiation"]).toHaveLength(1);
    expect(result.profile.ucp.capabilities?.["shopping.negotiation"]).toBeUndefined();
  });

  it("drops a capability whose spec/schema origin does not match the namespace authority", () => {
    const result = validateUcpProfile({
      ucp: {
        version: "2026-04-08",
        capabilities: {
          // authority = evil.com；spec origin = example.com → spec_origin_mismatch
          "com.evil.shopping.negotiation": [
            {
              version: "1.0",
              spec: "https://example.com/specs/negotiation.json",
              schema: "https://evil.com/schemas/negotiation.json",
            },
          ],
          "com.example.shopping.negotiation": [
            {
              version: "1.0",
              spec: "https://example.com/specs.json",
              schema: "https://example.com/schema.json",
            },
          ],
        },
      },
    });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe("spec_origin_mismatch");
    expect(result.rejected[0]?.name).toBe("com.evil.shopping.negotiation");
    // 越权 capability 被剔除，合法 capability 保留——profile 不连带失败
    expect(result.profile.ucp.capabilities?.["com.evil.shopping.negotiation"]).toBeUndefined();
    expect(result.profile.ucp.capabilities?.["com.example.shopping.negotiation"]).toHaveLength(1);
  });

  it("drops a service whose schema origin overreaches; keeps other valid services", () => {
    const result = validateUcpProfile({
      ucp: {
        version: "2026-04-08",
        services: {
          "com.example.shopping": [
            {
              version: "1.0",
              spec: "https://example.com/specs.json",
              transport: "rest",
              endpoint: "https://example.com/api",
              schema: "https://evil.example.com/schema.json",
            },
          ],
          "com.example.fulfillment": [
            {
              version: "1.0",
              spec: "https://example.com/specs-fulfillment.json",
              transport: "rest",
              endpoint: "https://example.com/fulfillment",
            },
          ],
        },
      },
    });
    expect(result.rejected[0]?.code).toBe("schema_origin_mismatch");
    expect(result.profile.ucp.services?.["com.example.shopping"]).toBeUndefined();
    expect(result.profile.ucp.services?.["com.example.fulfillment"]).toHaveLength(1);
  });

  it("rejects unsupported transports and a2a services without an https Agent Card endpoint", () => {
    const result = validateUcpProfile({
      ucp: {
        version: "2026-04-08",
        services: {
          "com.example.shopping": [
            // 非法 transport
            { version: "1.0", spec: "https://example.com/x", transport: "grpc" },
            // a2a 缺 endpoint
            { version: "1.0", spec: "https://example.com/x", transport: "a2a" },
            // a2a endpoint 非 HTTPS
            {
              version: "1.0",
              spec: "https://example.com/x",
              transport: "a2a",
              endpoint: "http://example.com/card.json",
            },
            // 合法 a2a（endpoint 指向 Agent Card URL）
            {
              version: "1.0",
              spec: "https://example.com/x",
              transport: "a2a",
              endpoint: "https://example.com/.well-known/agent-card.json",
            },
          ],
        },
      },
    });
    expect(result.rejected.map((r) => r.code)).toEqual([
      "transport_unsupported",
      "a2a_endpoint_required",
      "endpoint_invalid",
    ]);
    expect(result.profile.ucp.services?.["com.example.shopping"]).toHaveLength(1);
    expect(result.profile.ucp.services?.["com.example.shopping"]?.[0]?.endpoint).toBe(
      "https://example.com/.well-known/agent-card.json",
    );
  });

  it("accepts extends as string or string[] and rejects other shapes", () => {
    const result = validateUcpProfile({
      ucp: {
        version: "2026-04-08",
        capabilities: {
          "com.example.shopping.negotiation": [
            {
              version: "1.0",
              spec: "https://example.com/x",
              schema: "https://example.com/y",
              extends: "dev.ucp.shopping.checkout",
            },
          ],
          "com.example.shopping.order": [
            {
              version: "1.0",
              spec: "https://example.com/x",
              schema: "https://example.com/y",
              extends: ["dev.ucp.order.create"],
            },
          ],
          "com.example.shopping.cart": [
            { version: "1.0", spec: "https://example.com/x", schema: "https://example.com/y", extends: 5 },
          ],
        },
      },
    });
    expect(result.rejected.map((r) => r.code)).toEqual(["extends_invalid"]);
    expect(result.profile.ucp.capabilities?.["com.example.shopping.negotiation"]?.[0]?.extends).toBe(
      "dev.ucp.shopping.checkout",
    );
    expect(result.profile.ucp.capabilities?.["com.example.shopping.order"]?.[0]?.extends).toEqual([
      "dev.ucp.order.create",
    ]);
    expect(result.profile.ucp.capabilities?.["com.example.shopping.cart"]).toBeUndefined();
  });

  it("accepts a profile with no services or capabilities", () => {
    const result = validateUcpProfile({ ucp: { version: "2026-04-08" } });
    expect(result.rejected).toEqual([]);
    expect(result.profile.ucp.version).toBe("2026-04-08");
  });
});

describe("parseCacheControl", () => {
  it("accepts public max-age>=60 and rejects everything else", () => {
    expect(parseCacheControl("public, max-age=300").ok).toBe(true);
    expect(parseCacheControl("public, max-age=60").ok).toBe(true);
    expect(parseCacheControl("max-age=300, public").ok).toBe(true);
    expect(parseCacheControl("Public, Max-Age=120").ok).toBe(true);
    expect(parseCacheControl(null).ok).toBe(false);
    expect(parseCacheControl("").ok).toBe(false);
    expect(parseCacheControl("public, max-age=30").ok).toBe(false);
    expect(parseCacheControl("public").ok).toBe(false);
    expect(parseCacheControl("max-age=300").ok).toBe(false);
    expect(parseCacheControl("private, max-age=300").ok).toBe(false);
    expect(parseCacheControl("no-store, max-age=300").ok).toBe(false);
  });
});

describe("Kiwi vendor capability builder", () => {
  it("builds example.kiwi.shopping.negotiation as a Vendor Root Capability (§25.2)", () => {
    const { name, declaration } = buildKiwiNegotiationCapability();
    expect(name).toBe("example.kiwi.shopping.negotiation");
    expect(declaration.version).toBe("1.0");
    expect(declaration.spec).toBe("https://kiwi.example/a2a/extensions/negotiation/1.0");
    expect(declaration.schema).toBe("https://kiwi.example/schemas/negotiation/1.0/schema.json");
    expect(declaration.extends).toBeUndefined();
  });

  it("builds a full vendor profile that passes UCP validation (self-consistent)", () => {
    const profile = buildKiwiVendorProfile({
      agentCardUrl: "https://kiwi.example/.well-known/agent-card.json",
    });
    const result = validateUcpProfile(profile);
    expect(result.rejected).toEqual([]);
    expect(result.profile.ucp.services?.["example.kiwi.shopping"]?.[0]?.transport).toBe("a2a");
    expect(result.profile.ucp.services?.["example.kiwi.shopping"]?.[0]?.endpoint).toBe(
      "https://kiwi.example/.well-known/agent-card.json",
    );
    expect(
      result.profile.ucp.capabilities?.["example.kiwi.shopping.negotiation"]?.[0]?.spec,
    ).toBe("https://kiwi.example/a2a/extensions/negotiation/1.0");
  });

  it("custom authority + namespace pair stays self-consistent (placeholders MUST be replaced together)", () => {
    const profile = buildKiwiVendorProfile({
      agentCardUrl: "https://acme.test/.well-known/agent-card.json",
      authority: "acme.test",
      serviceName: "test.acme.shopping",
      capabilityName: "test.acme.shopping.negotiation",
    });
    const result = validateUcpProfile(profile);
    expect(result.rejected).toEqual([]);
  });
});

describe("UcpResolver", () => {
  it("fetches and validates a profile over HTTPS with redirect: manual, then serves cache hits", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse(validProfile(), 200, { "cache-control": "public, max-age=300" }),
    );
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });

    const first = await resolver.resolve({ domain: "merchant.example" });
    expect(first.cached).toBe(false);
    expect(first.profile.ucp.version).toBe("2026-04-08");
    expect(first.ttlMs).toBe(300_000);
    expect(first.source).toBe("domain:merchant.example");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://merchant.example/.well-known/ucp");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.headers.accept).toBe("application/json");

    const second = await resolver.resolve({ domain: "merchant.example" });
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1); // 命中缓存，不再抓取
  });

  it("rejects non-HTTPS URLs before fetching (profile_not_https)", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(validProfile()));
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });
    await expect(
      resolver.resolve({ profileUrl: "http://merchant.example/.well-known/ucp" }),
    ).rejects.toMatchObject({ code: "profile_not_https" });
    expect(calls).toHaveLength(0);
  });

  it("rejects 3xx redirects and never follows them", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse(validProfile(), 302, { location: "https://evil.example/.well-known/ucp" }),
    );
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });
    await expect(
      resolver.resolve({ profileUrl: "https://merchant.example/.well-known/ucp" }),
    ).rejects.toMatchObject({ code: "profile_redirect" });
    expect(calls).toHaveLength(1); // 只请求一次，未跟随
  });

  it("enforces Cache-Control: public max-age>=60 (profile_cache_control)", async () => {
    const cases: { headers: Record<string, string> }[] = [
      { headers: {} }, // 缺 header
      { headers: { "cache-control": "max-age=300" } }, // 缺 public
      { headers: { "cache-control": "public, max-age=30" } }, // max-age < 60
      { headers: { "cache-control": "private, max-age=300" } }, // private
      { headers: { "cache-control": "no-store, max-age=300" } }, // no-store
      { headers: { "cache-control": "public" } }, // 缺 max-age
    ];
    for (const c of cases) {
      const { fetchImpl } = stubFetch(() => jsonResponse(validProfile(), 200, c.headers));
      const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });
      const err = await resolver
        .resolve({ profileUrl: "https://merchant.example/.well-known/ucp" })
        .catch((e: unknown) => e);
      expect(err, JSON.stringify(c.headers)).toBeInstanceOf(UcpError);
      expect((err as UcpError).code).toBe("profile_cache_control");
    }
  });

  it("maps network failure and timeout to profile_unreachable", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });
    const err = await resolver
      .resolve({ profileUrl: "https://merchant.example/.well-known/ucp" })
      .catch((e: unknown) => e);
    expect((err as UcpError).code).toBe("profile_unreachable");
  });

  it("maps timeout to profile_unreachable", async () => {
    const fetchImpl = (async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true, timeoutMs: 20 });
    const err = await resolver
      .resolve({ profileUrl: "https://merchant.example/.well-known/ucp" })
      .catch((e: unknown) => e);
    expect((err as UcpError).code).toBe("profile_unreachable");
  });

  it("maps non-2xx status to profile_bad_status and invalid JSON to profile_malformed", async () => {
    const badStatus = new UcpResolver({
      fetchImpl: stubFetch(() => new Response("boom", { status: 500 })).fetchImpl,
      skipDnsCheck: true,
    });
    const err1 = await badStatus
      .resolve({ profileUrl: "https://merchant.example/.well-known/ucp" })
      .catch((e: unknown) => e);
    expect((err1 as UcpError).code).toBe("profile_bad_status");

    const badJson = new UcpResolver({
      fetchImpl: stubFetch(() =>
        new Response("not json", { status: 200, headers: { "cache-control": "public, max-age=300" } }),
      ).fetchImpl,
      skipDnsCheck: true,
    });
    const err2 = await badJson
      .resolve({ profileUrl: "https://merchant.example/.well-known/ucp" })
      .catch((e: unknown) => e);
    expect((err2 as UcpError).code).toBe("profile_malformed");
  });

  it("maps a schema-invalid profile to profile_malformed", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ ucp: { version: "nope" } }, 200, { "cache-control": "public, max-age=300" }),
    );
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });
    const err = await resolver
      .resolve({ profileUrl: "https://merchant.example/.well-known/ucp" })
      .catch((e: unknown) => e);
    expect((err as UcpError).code).toBe("profile_malformed");
  });

  it("rejects SSRF-unsafe targets via url-policy (unsafe_target)", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(validProfile()));
    const resolver = new UcpResolver({ fetchImpl });
    const err = await resolver
      .resolve({ profileUrl: "https://192.168.1.1/.well-known/ucp" })
      .catch((e: unknown) => e);
    expect((err as UcpError).code).toBe("unsafe_target");
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid input (both / neither domain and profileUrl)", async () => {
    const resolver = new UcpResolver({
      fetchImpl: stubFetch(() => jsonResponse(validProfile())).fetchImpl,
      skipDnsCheck: true,
    });
    await expect(
      resolver.resolve({ domain: "a.example", profileUrl: "https://b.example/.well-known/ucp" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolver.resolve({})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("surfaces per-entry rejections from validation in the result (not a hard failure)", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(
        {
          ucp: {
            version: "2026-04-08",
            capabilities: {
              "com.evil.shopping.negotiation": [
                {
                  version: "1.0",
                  spec: "https://example.com/x",
                  schema: "https://evil.com/y",
                },
              ],
            },
          },
        },
        200,
        { "cache-control": "public, max-age=60" },
      ),
    );
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });
    const result = await resolver.resolve({ profileUrl: "https://merchant.example/.well-known/ucp" });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe("spec_origin_mismatch");
    expect(result.profile.ucp.capabilities?.["com.evil.shopping.negotiation"]).toBeUndefined();
  });

  it("caches with the Cache-Control TTL (60s floor) and refetches after expiry", async () => {
    let fakeNow = 1_000_000_000_000;
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse(validProfile(), 200, { "cache-control": "public, max-age=60" }),
    );
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true, now: () => fakeNow });

    const first = await resolver.resolve({ profileUrl: "https://merchant.example/.well-known/ucp" });
    expect(first.cached).toBe(false);
    expect(first.ttlMs).toBe(60_000);

    const second = await resolver.resolve({ profileUrl: "https://merchant.example/.well-known/ucp" });
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);

    fakeNow += 60_000 + 1; // 越过首次过期边界（expiresAt = fetchedAt + 60_000，严格 > 判过期）
    const third = await resolver.resolve({ profileUrl: "https://merchant.example/.well-known/ucp" });
    expect(third.cached).toBe(false);
    expect(calls).toHaveLength(2);

    fakeNow += 1; // 仍在新 TTL 内 → 命中缓存
    const fourth = await resolver.resolve({ profileUrl: "https://merchant.example/.well-known/ucp" });
    expect(fourth.cached).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("caches per-URL and clearCache empties the store", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse(validProfile(), 200, { "cache-control": "public, max-age=300" }),
    );
    const resolver = new UcpResolver({ fetchImpl, skipDnsCheck: true });

    await resolver.resolve({ profileUrl: "https://a.example/.well-known/ucp" });
    await resolver.resolve({ profileUrl: "https://b.example/.well-known/ucp" });
    expect(calls).toHaveLength(2);

    await resolver.resolve({ profileUrl: "https://a.example/.well-known/ucp" });
    expect(calls).toHaveLength(2); // a 命中缓存

    resolver.clearCache();
    await resolver.resolve({ profileUrl: "https://a.example/.well-known/ucp" });
    expect(calls).toHaveLength(3);
  });
});
