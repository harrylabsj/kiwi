/**
 * RFC 9421 HTTP Message Signatures 测试。
 *
 * 覆盖：
 *   - 已知答案向量（Ed25519 确定性：signature-base 构造 + 签名精确匹配；
 *     ES256：signature-base 构造精确匹配 + 64B r||s 验签往返）；
 *   - Signature-Input / Signature 解析与格式化往返；
 *   - HttpMessageSigner + verifyHttpMessageSignature 双算法往返；
 *   - 篡改任一 covered component 拒绝（body / method / authority / target-uri）；
 *   - content-digest 与 body 不一致拒绝；
 *   - 过期 / 未来 created 拒绝；
 *   - 未知 keyid 拒绝；
 *   - nonce 复用 → replay_detected。
 */

import { describe, expect, it } from "vitest";
import { createHash, createPrivateKey, sign as nodeSign } from "node:crypto";
import {
  HttpMessageSigner,
  InMemoryNonceStore,
  buildSignatureBase,
  contentDigestHeader,
  formatSignatureInput,
  parseSignatureHeader,
  parseSignatureInput,
  resolveFromSigningKeys,
  serializeParams,
  verifyContentDigest,
  verifyHttpMessageSignature,
} from "../src/trust/identity/index.js";
import type { SigningKey } from "../src/trust/identity/index.js";

// ---------------------------------------------------------------------------
// 已知答案向量 —— 固定密钥 + 固定请求
// ---------------------------------------------------------------------------

const ED25519_SEED = Buffer.from(
  "e90b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
  "hex",
);
const ED25519_PUBLIC_X = "70unY03oy6rp20mv0AvfklFpbVJVy8s_jwN6egnPjQY";

const ED25519_REQUEST = {
  method: "POST",
  url: "http://127.0.0.1:43210/a2a",
  authority: "127.0.0.1:43210",
  body: Buffer.from(
    '{"jsonrpc":"2.0","id":"r1","method":"message/send","params":{"message":{"role":"agent","parts":[]}}}',
    "utf8",
  ),
};
const ED25519_CONTENT_DIGEST = "sha-256=:xZvCoEVLQtdXljCUfMwa1N9KavIXA6Sv9kOHhLBDecU=:";
const ED25519_SIGNATURE_BASE =
  '"@method": POST\n' +
  '"@target-uri": http://127.0.0.1:43210/a2a\n' +
  '"@authority": 127.0.0.1:43210\n' +
  '"content-digest": sha-256=:xZvCoEVLQtdXljCUfMwa1N9KavIXA6Sv9kOHhLBDecU=:\n' +
  '"@signature-params": ("@method" "@target-uri" "@authority" "content-digest");created=1723000000;keyid="test-ed25519";alg="ed25519"\n';
const ED25519_SIGNATURE_B64 =
  "xLEqsF0GiF73TT+pGh83SPD/rmhlX5Y0WGqFWdcbfZmlY+ZZJm72OZIEtjfcbBldzDGseV4Ko3KA2zSMYQ2ZCw==";

const ES256_PRIVATE_JWK = {
  kty: "EC",
  x: "17gKSkw4wIeyYj5zNN6lvkSRTo_IQRzXnjHOzJ-x8ho",
  y: "QAn6EZ89YXrJ9XmHgQrvJCgKk3EXcCAg4AEWqhWHLMU",
  crv: "P-256",
  d: "GM9IQsSLaasL7HMeW-zzPjlYK067CXbXbk_EFz8jOt0",
} as const;
const ES256_PUBLIC_JWK = {
  kty: "EC",
  x: "17gKSkw4wIeyYj5zNN6lvkSRTo_IQRzXnjHOzJ-x8ho",
  y: "QAn6EZ89YXrJ9XmHgQrvJCgKk3EXcCAg4AEWqhWHLMU",
  crv: "P-256",
} as const;

const ES256_REQUEST = {
  method: "POST",
  url: "https://merchant.example/a2a",
  authority: "merchant.example",
  body: Buffer.from(
    '{"jsonrpc":"2.0","id":"r2","method":"tasks/get","params":{"id":"task_1"}}',
    "utf8",
  ),
};
const ES256_CONTENT_DIGEST = "sha-256=:fEp+w8RIhrwEkirkgUX9Li6e+FKt9twZAJW+O/bLGjs=:";
const ES256_SIGNATURE_BASE =
  '"@method": POST\n' +
  '"@target-uri": https://merchant.example/a2a\n' +
  '"@authority": merchant.example\n' +
  '"content-digest": sha-256=:fEp+w8RIhrwEkirkgUX9Li6e+FKt9twZAJW+O/bLGjs=:\n' +
  '"@signature-params": ("@method" "@target-uri" "@authority" "content-digest");created=1723000000;keyid="test-es256";alg="ecdsa-p256-sha256"\n';

function ed25519SigningKey(): SigningKey {
  return {
    keyid: "test-ed25519",
    algorithm: "ed25519",
    jwk: { kty: "OKP", crv: "Ed25519", x: ED25519_PUBLIC_X },
  };
}

function es256SigningKey(): SigningKey {
  return {
    keyid: "test-es256",
    algorithm: "es256",
    jwk: { ...ES256_PUBLIC_JWK },
  };
}

/** 附加 alice 密钥（roundtrip / 篡改测试的签名方与验证方一致）。 */
function aliceKey(): SigningKey {
  return {
    keyid: "alice",
    algorithm: "ed25519",
    jwk: { kty: "OKP", crv: "Ed25519", x: ED25519_PUBLIC_X },
  };
}

describe("RFC 9421 known-answer vectors", () => {
  it("Ed25519: builds the exact signature base (construction KAT)", () => {
    const base = buildSignatureBase({
      method: ED25519_REQUEST.method,
      targetUri: ED25519_REQUEST.url,
      authority: ED25519_REQUEST.authority,
      headers: { "content-digest": ED25519_CONTENT_DIGEST },
      components: ["@method", "@target-uri", "@authority", "content-digest"],
      params: { created: 1723000000, keyid: "test-ed25519", algorithm: "ed25519" },
    });
    expect(base).toBe(ED25519_SIGNATURE_BASE);
  });

  it("Ed25519: HttpMessageSigner produces the exact signature (signing KAT)", () => {
    const signer = new HttpMessageSigner({
      keyid: "test-ed25519",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
    });
    const headers = signer.sign({
      method: ED25519_REQUEST.method,
      url: ED25519_REQUEST.url,
      body: ED25519_REQUEST.body,
      headers: {},
    });
    expect(headers["content-digest"]).toBe(ED25519_CONTENT_DIGEST);
    expect(headers["signature-input"]).toBe(
      'sig1=("@method" "@target-uri" "@authority" "content-digest");created=1723000000;keyid="test-ed25519";alg="ed25519"',
    );
    expect(headers["signature"]).toBe(`sig1=:${ED25519_SIGNATURE_B64}:`);
  });

  it("Ed25519: verifies the known signature", () => {
    const result = verifyHttpMessageSignature({
      method: ED25519_REQUEST.method,
      targetUri: ED25519_REQUEST.url,
      authority: ED25519_REQUEST.authority,
      headers: {
        "content-type": "application/json",
        "content-digest": ED25519_CONTENT_DIGEST,
        "signature-input":
          'sig1=("@method" "@target-uri" "@authority" "content-digest");created=1723000000;keyid="test-ed25519";alg="ed25519"',
        signature: `sig1=:${ED25519_SIGNATURE_B64}:`,
      },
      body: ED25519_REQUEST.body,
      resolver: resolveFromSigningKeys([ed25519SigningKey()]),
      now: () => 1723000000,
    });
    expect(result).toMatchObject({ ok: true, keyid: "test-ed25519", algorithm: "ed25519" });
  });

  it("ES256: builds the exact signature base and verifies a roundtrip", () => {
    const base = buildSignatureBase({
      method: ES256_REQUEST.method,
      targetUri: ES256_REQUEST.url,
      authority: ES256_REQUEST.authority,
      headers: { "content-digest": ES256_CONTENT_DIGEST },
      components: ["@method", "@target-uri", "@authority", "content-digest"],
      params: { created: 1723000000, keyid: "test-es256", algorithm: "ecdsa-p256-sha256" },
    });
    expect(base).toBe(ES256_SIGNATURE_BASE);

    const signer = new HttpMessageSigner({
      keyid: "test-es256",
      algorithm: "es256",
      privateKey: { ...ES256_PRIVATE_JWK },
      created: 1723000000,
    });
    const headers = signer.sign({
      method: ES256_REQUEST.method,
      url: ES256_REQUEST.url,
      body: ES256_REQUEST.body,
      headers: {},
    });
    expect(headers["content-digest"]).toBe(ES256_CONTENT_DIGEST);
    // ECDSA 签名随机化：不断言精确字节，断言 r||s 长度与验签往返。
    const sig = headers["signature"] ?? "";
    const b64 = /^sig1=:(.*):$/.exec(sig)?.[1] ?? "";
    expect(Buffer.from(b64, "base64").length).toBe(64);

    const result = verifyHttpMessageSignature({
      method: ES256_REQUEST.method,
      targetUri: ES256_REQUEST.url,
      authority: ES256_REQUEST.authority,
      headers: { "content-type": "application/json", ...headers },
      body: ES256_REQUEST.body,
      resolver: resolveFromSigningKeys([es256SigningKey()]),
      now: () => 1723000000,
    });
    expect(result).toMatchObject({ ok: true, keyid: "test-es256", algorithm: "es256" });
  });
});

describe("Signature-Input / Signature 解析与格式化", () => {
  it("formats then parses a signature-input entry (roundtrip)", () => {
    const formatted = formatSignatureInput("sig1", ["@method", "content-digest"], {
      created: 1723000000,
      nonce: 'n"1',
      keyid: "key-1",
      algorithm: "ed25519",
    });
    const parsed = parseSignatureInput(formatted);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      label: "sig1",
      components: ["@method", "content-digest"],
      params: {
        created: 1723000000,
        nonce: 'n"1',
        keyid: "key-1",
        algorithm: "ed25519",
      },
    });
  });

  it("rejects malformed signature-input and unknown parameters", () => {
    expect(() => parseSignatureInput('sig1=(@method);created=abc')).toThrow();
    expect(() => parseSignatureInput('sig1=("@method");bogus="x"')).toThrow();
    expect(() => parseSignatureInput("sig1=(@method)")).toThrow(); // 组件必须带引号
  });

  it("parses the Signature header into label → bytes", () => {
    const parsed = parseSignatureHeader("sig1=:QUJD: sig2=:REVG:");
    expect(parsed["sig1"]?.toString("utf8")).toBe("ABC");
    expect(parsed["sig2"]?.toString("utf8")).toBe("DEF");
  });

  it("serializes params in RFC 9421 canonical order", () => {
    expect(
      serializeParams({
        tag: "app-1",
        keyid: "k",
        nonce: "n",
        created: 1,
        expires: 2,
        algorithm: "ed25519",
      }),
    ).toBe(';created=1;expires=2;nonce="n";keyid="k";alg="ed25519";tag="app-1"');
  });
});

describe("content-digest（RFC 9530）", () => {
  it("computes and verifies the sha-256 content digest", () => {
    const body = Buffer.from('{"hello":"world"}', "utf8");
    const header = contentDigestHeader(body);
    expect(header).toBe(
      `sha-256=:${createHash("sha256").update(body).digest("base64")}:`,
    );
    expect(verifyContentDigest(body, header)).toBe(true);
    expect(verifyContentDigest(Buffer.from("tampered"), header)).toBe(false);
    expect(verifyContentDigest(body, "sha-256=:bm90aGluZw==:")).toBe(false);
  });
});

describe("HttpMessageSigner + verifyHttpMessageSignature 往返", () => {
  it("signs and verifies with Ed25519", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
    });
    const body = Buffer.from('{"a":1}', "utf8");
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body, headers: {} });
    const result = verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body,
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000,
    });
    expect(result.ok).toBe(true);
  });

  it("signs and verifies with ES256", () => {
    const signer = new HttpMessageSigner({
      keyid: "test-es256",
      algorithm: "es256",
      privateKey: { ...ES256_PRIVATE_JWK },
      created: 1723000000,
    });
    const body = Buffer.from('{"b":2}', "utf8");
    const headers = signer.sign({ method: "POST", url: "http://b.test/x", body, headers: {} });
    const result = verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://b.test/x",
      authority: "b.test",
      headers,
      body,
      resolver: resolveFromSigningKeys([es256SigningKey()]),
      now: () => 1723000000,
    });
    expect(result.ok).toBe(true);
  });
});

describe("篡改任一 covered component 拒绝（fail-closed）", () => {
  const signer = new HttpMessageSigner({
    keyid: "alice",
    algorithm: "ed25519",
    privateKey: ED25519_SEED,
    created: 1723000000,
  });
  const body = Buffer.from('{"msg":"payload"}', "utf8");
  const headers = signer.sign({
    method: "POST",
    url: "http://a.test/neg",
    body,
    headers: { "content-type": "application/json" },
  });

  function verifyWith(overrides: {
    method?: string;
    targetUri?: string;
    authority?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  }) {
    return verifyHttpMessageSignature({
      method: overrides.method ?? "POST",
      targetUri: overrides.targetUri ?? "http://a.test/neg",
      authority: overrides.authority ?? "a.test",
      headers: overrides.headers ?? headers,
      body: overrides.body ?? body,
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000,
    });
  }

  it("rejects a tampered body (content-digest mismatch)", () => {
    const result = verifyWith({ body: Buffer.from('{"msg":"EVIL"}', "utf8") });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
  });

  it("rejects a tampered method (@method covered)", () => {
    expect(verifyWith({ method: "GET" }).ok).toBe(false);
  });

  it("rejects a tampered authority (@authority covered)", () => {
    expect(verifyWith({ authority: "evil.test" }).ok).toBe(false);
  });

  it("rejects a tampered target-uri (@target-uri covered)", () => {
    expect(verifyWith({ targetUri: "http://a.test/other" }).ok).toBe(false);
  });

  it("rejects a dropped content-digest header", () => {
    const { "content-digest": _cd, ...without } = headers;
    const result = verifyWith({ headers: without });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
  });
});

describe("时间窗口 / 重放 / keyid", () => {
  it("rejects an expired signature (expires in the past)", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
      expires: 1723000300,
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body: Buffer.from("x"), headers: {} });
    const result = verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.from("x"),
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000601, // 超过 expires + skew(300)
    });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
  });

  it("rejects a created-in-the-future signature", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000600,
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body: Buffer.from("x"), headers: {} });
    const result = verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.from("x"),
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000, // created(1723000600) > now + skew(300)
    });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
  });

  it("rejects a signature without created even far in the future (K-M17)", () => {
    // 手工构造「无 created」的合法签名：signature-input 与签名 base 都不含
    // created（RFC 9421 §2.2 要求 created 必选）。修复前 created 缺失时时间窗
    // 检查整体跳过——now 拉到 10 年后该签名仍验签通过（捕获后可永久重放）；
    // 修复后必须 fail-closed。
    const method = "POST";
    const targetUri = "http://a.test/";
    const authority = "a.test";
    const body = Buffer.from("x");
    const components = ["@method", "@target-uri", "@authority", "content-digest"];
    const params = { keyid: "alice", algorithm: "ed25519" }; // 无 created
    const headers = { "content-digest": contentDigestHeader(body) };
    const base = buildSignatureBase({ method, targetUri, authority, headers, components, params });
    const privateKey = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: ED25519_SEED.toString("base64url"), x: ED25519_PUBLIC_X },
      format: "jwk",
    });
    const signature = nodeSign(null, Buffer.from(base, "utf8"), privateKey);
    const signedHeaders = {
      ...headers,
      "signature-input": formatSignatureInput("sig1", components, params),
      "signature": `sig1=:${signature.toString("base64")}:`,
    };
    const result = verifyHttpMessageSignature({
      method,
      targetUri,
      authority,
      headers: signedHeaders,
      body,
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000 + 10 * 365 * 24 * 3600, // 10 年后
    });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
    expect((result as { reason?: string }).reason).toContain("created");
  });

  it("rejects a signature too old without expires", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body: Buffer.from("x"), headers: {} });
    const result = verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.from("x"),
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723001000, // 超过 maxAge(900)
    });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
  });

  it("rejects an unknown keyid", () => {
    const signer = new HttpMessageSigner({
      keyid: "nobody",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body: Buffer.from("x"), headers: {} });
    const result = verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.from("x"),
      resolver: resolveFromSigningKeys([ed25519SigningKey()]),
      now: () => 1723000000,
    });
    expect(result).toMatchObject({ ok: false, code: "authorization_failed" });
  });

  it("rejects a signature reused nonce (replay_detected)", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      nonce: "nonce-42",
      created: 1723000000,
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body: Buffer.from("x"), headers: {} });
    const store = new InMemoryNonceStore();
    const base = {
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.from("x"),
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000,
      nonceStore: store,
    };
    expect(verifyHttpMessageSignature(base).ok).toBe(true);
    const replay = verifyHttpMessageSignature(base);
    expect(replay).toMatchObject({ ok: false, code: "replay_detected" });
  });

  it("验签失败的请求不消费 nonce：伪造签名无法刷 nonce（评审项 H6）", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      nonce: "nonce-42",
      created: 1723000000,
    });
    const store = new InMemoryNonceStore();
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body: Buffer.from("x"), headers: {} });
    const base = {
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.from("x"),
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000,
      nonceStore: store,
    };
    // 篡改 body：验签失败（content-digest 不匹配）——修复前 nonce 在验签
    // 前被消费，攻击者可用伪造签名刷入任意 nonce；修复后失败不消耗。
    const rejected = verifyHttpMessageSignature({ ...base, body: Buffer.from("y") });
    expect(rejected.ok).toBe(false);
    // 同 nonce 的合法请求仍首次通过 → 失败的验签没有消耗 nonce。
    expect(verifyHttpMessageSignature(base).ok).toBe(true);
  });

  it("InMemoryNonceStore 满额逐 key 淘汰最旧一条（评审项 H6：不清空全部）", () => {
    const store = new InMemoryNonceStore(2);
    expect(store.checkAndSet("a")).toBe(true);
    expect(store.checkAndSet("b")).toBe(true);
    // 满额：c 挤掉最旧的 a（此前整体 clear() 会让窗口内全部 nonce 失效）
    expect(store.checkAndSet("c")).toBe(true);
    expect(store.size).toBe(2);
    // a 已被挤出（FIFO 只淘汰最旧一条）→ 可再次使用；此时满额挤出 b
    expect(store.checkAndSet("a")).toBe(true);
    // c 仍在（复用拒绝）；b 已被挤出 → 新 key
    expect(store.checkAndSet("c")).toBe(false);
    expect(store.checkAndSet("b")).toBe(true);
  });
});

describe("最小组件集合强制（审查 BUG-06）", () => {
  const body = Buffer.from('{"a":1}', "utf8");
  const baseVerify = (headers: Record<string, string>, verifyBody: Buffer) =>
    verifyHttpMessageSignature({
      method: "POST",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: verifyBody,
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000,
    });

  it("带非空 body 的签名缺少 content-digest → 拒绝（body 不被绑定）", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
      // 攻击者/疏忽的对端只签方法头（此前完全合法）
      coveredComponents: ["@method", "@target-uri", "@authority"],
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body, headers: {} });
    const result = baseVerify(headers, body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("content-digest");
  });

  it("缺少 @authority → 拒绝", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
      coveredComponents: ["@method", "@target-uri", "content-digest"],
    });
    const headers = signer.sign({ method: "POST", url: "http://a.test/", body, headers: {} });
    const result = baseVerify(headers, body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("@authority");
  });

  it("无 body 请求不强制 content-digest（按请求形状）", () => {
    const signer = new HttpMessageSigner({
      keyid: "alice",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
      created: 1723000000,
      coveredComponents: ["@method", "@target-uri", "@authority"],
    });
    const headers = signer.sign({ method: "GET", url: "http://a.test/", body: Buffer.alloc(0), headers: {} });
    const result = verifyHttpMessageSignature({
      method: "GET",
      targetUri: "http://a.test/",
      authority: "a.test",
      headers,
      body: Buffer.alloc(0),
      resolver: resolveFromSigningKeys([aliceKey()]),
      now: () => 1723000000,
    });
    expect(result.ok).toBe(true);
  });
});
