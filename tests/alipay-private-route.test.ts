import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createAlipayCollectionHttp, hasAlipayReadSignature } from "../src/cloud/alipay-collection-http.js";
import { generateA2aSigningIdentity, resolveA2aSignatureResolver } from "../src/a2a/signing-key.js";
import { HttpMessageSigner, HttpMessageSignatureVerifier, InMemoryNonceStore } from "../src/trust/identity/index.js";
import { createNativeAlipayReader, openPrivateAlipayView } from "../src/agent/alipay-native-view.js";
import * as pinnedTransport from "../src/merchant-gateway/pinned-fetch.js";

const version = "29cb1970-8520-402a-bde0-ea46cc6a666d";
const fields = { negotiationId: "neg-1", offerId: "offer-1", version, agreementId: "agreement-1", termsDigest: `sha256:${"a".repeat(64)}` };
const collection = { enabled: true, version, recipient: "测试商户", account: "demo@example.invalid" };

test("公开落地页不泄露资料，只有匹配协议的验签买家能查看，换绑后旧入口关闭", async () => {
  let active = collection;
  const merchant = generateA2aSigningIdentity("merchant.example");
  const firstBuyer = generateA2aSigningIdentity("buyer-1");
  const secondBuyer = generateA2aSigningIdentity("buyer-2");
  const advertisedOrigin = "https://merchant.example";
  const privatePath = "/buyer/v1/collection/alipay";
  const verifier = new HttpMessageSignatureVerifier({
    resolver: resolveA2aSignatureResolver(merchant, [firstBuyer, secondBuyer]),
    scheme: "https", expectedAuthority: "merchant.example", authoritySource: "declared", nonceStore: new InMemoryNonceStore(),
  });
  const handlers = createAlipayCollectionHttp({
    merchantId: "merchant-1",
    verifyBuyer: async (req, body) => {
      if (!hasAlipayReadSignature(req.headers["signature-input"])) return undefined;
      const result = await verifier.verify({ method: req.method ?? "", url: req.url ?? "", headers: req.headers,
        body, scheme: "http", remoteAddress: req.socket.remoteAddress, authorizationHeader: req.headers.authorization });
      return result.authenticated && result.identityVerified === true && result.identity !== undefined
        ? { merchantId: "merchant-1", buyerPrincipalId: result.identity } : undefined;
    },
    lookup: (input) => input.buyerPrincipalId === "buyer-1" && input.agreementId === fields.agreementId
      ? { version, totalMinor: 12345, currency: "CNY", expiresAt: "2099-01-01T00:00:00Z" } : undefined,
    current: () => active,
  });
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/collect/")) handlers.landing(req, res);
    else handlers.privateDetails(req, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test address");
    const origin = `http://127.0.0.1:${address.port}`;
    const landing = `${origin}/collect/alipay/neg-1/offer-1/${version}`;
    const get = await fetch(landing);
    expect(get.status).toBe(200);
    expect(await get.text()).not.toContain(collection.account);
    expect((await fetch(`${landing}-unknown`, { method: "HEAD" })).status).toBe(200);
    const payload = JSON.stringify(fields);
    const sign = (buyer: typeof firstBuyer, body = payload, nonce: string | null = randomBytes(16).toString("hex")) => {
      return new HttpMessageSigner({ keyid: buyer.keyid, algorithm: buyer.algorithm, privateKey: buyer.privateKeyPem,
        ...(nonce === null ? {} : { nonce }) }).sign({
        method: "POST", url: `${advertisedOrigin}${privatePath}`, body: Buffer.from(body), headers: { "content-type": "application/json" },
      });
    };
    const request = (signed?: Record<string, string>, body = payload) => fetch(`${origin}${privatePath}`, {
      method: "POST", body,
      headers: { "content-type": "application/json", ...signed },
    });
    expect((await request()).status).toBe(404);
    expect((await request(sign(firstBuyer, payload, null))).status).toBe(404);
    expect((await request(sign(secondBuyer))).status).toBe(404);
    const wrong = JSON.stringify({ ...fields, agreementId: "wrong" });
    expect((await request(sign(firstBuyer), wrong)).status).toBe(404);
    expect((await request(sign(firstBuyer, wrong), wrong)).status).toBe(404);
    const signed = sign(firstBuyer);
    const res = await request(signed);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ recipient: collection.recipient, account: collection.account, totalMinor: 12345 });
    expect((await request(signed)).status).toBe(404);
    active = { ...collection, version: "replacement", account: "replacement@example.invalid" };
    expect((await request(sign(firstBuyer))).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("原生读取器经钉住的连接签名读取，仅展示与报价绑定的 JSON 响应", async () => {
  const identity = generateA2aSigningIdentity("buyer-native-test");
  const origin = "https://merchant.example";
  const expiresAt = "2099-01-01T00:00:00Z";
  const verifier = new HttpMessageSignatureVerifier({
    resolver: resolveA2aSignatureResolver(identity), scheme: "https", expectedAuthority: "merchant.example",
    nonceStore: new InMemoryNonceStore(),
  });
  const input = { origin, binding: fields, totalMinor: 12345, expiresAt };
  let details = { version, recipient: collection.recipient, account: collection.account, totalMinor: 12345, currency: "CNY", expiresAt };
  const fetchPinned = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(`${origin}/buyer/v1/collection/alipay`);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(fields), redirect: "error" });
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    expect(hasAlipayReadSignature(headers["signature-input"])).toBe(true);
    expect(await verifier.verify({ method: "POST", url: "/buyer/v1/collection/alipay",
      scheme: "https", body: Buffer.from(String(init?.body)), headers: { ...headers, host: "merchant.example" },
      remoteAddress: undefined, authorizationHeader: undefined,
    })).toMatchObject({ authenticated: true, identityVerified: true });
    return Response.json(details);
  });
  const factory = vi.spyOn(pinnedTransport, "createPinnedFetch").mockReturnValue(fetchPinned);
  const launch = vi.fn(async (url: string) => {
    const page = await fetch(url);
    expect(await page.text()).toContain("¥123.45");
  });
  try {
    const reader = createNativeAlipayReader(identity, launch);
    expect(factory).toHaveBeenCalledWith({ timeoutMs: 5000, maxResponseBytes: 768 * 1024 });
    await expect(reader(input)).resolves.toBeUndefined();
    details = { ...details, totalMinor: 12346 };
    await expect(reader(input)).rejects.toThrow("collection_unavailable");
    await expect(reader({ ...input, origin: "http://merchant.example" })).rejects.toThrow();
    expect(fetchPinned).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    factory.mockRestore();
  }
});

test("私有浏览器页不会被 HEAD 探测消费，仅显示一次，不缓存且转义商家资料", async () => {
  await openPrivateAlipayView({ ...collection, recipient: "<测试商户>", totalMinor: 12345, expiresAt: "2099-01-01T00:00:00Z", currency: "CNY" }, async (url) => {
    expect((await fetch(url, { method: "HEAD" })).status).toBe(404);
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toBe("no-store");
    const page = await resp.text();
    expect(page).toContain("&lt;测试商户&gt;");
    expect(page).toContain("¥123.45");
    expect(page).toContain(collection.account);
    await expect(fetch(url)).rejects.toThrow();
  });
});
