import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { proveMerchantCredentialConsumer } from "../src/merchant-runtime/credential-consumer-proof.js";

const dirs: string[] = [];
const previousToken = process.env.SHOPPING_MERCHANT_TOKEN;
const previousCommerceUrl = process.env.KIWI_COMMERCE_URL;
const profile = {
  agent_id: "seller-a",
  commerce: { base_url: "https://shopping.example", token_env: "SHOPPING_MERCHANT_TOKEN", backend: "local_marketplace" },
} as never;
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-consumer-proof-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  if (previousToken === undefined) delete process.env.SHOPPING_MERCHANT_TOKEN;
  else process.env.SHOPPING_MERCHANT_TOKEN = previousToken;
  if (previousCommerceUrl === undefined) delete process.env.KIWI_COMMERCE_URL;
  else process.env.KIWI_COMMERCE_URL = previousCommerceUrl;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("consumer proof guards", () => {
  it("refuses when commerce.token_env is still the Catalog owner token", async () => {
    // profile 没拆分时（commerce.token_env == catalog owner token），拿它去调
    // shopping-cli 只会 403；必须直接返回 false，而不是反复请求。
    process.env.KIWI_MERCHANT_TOKEN = "catalog-secret";
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("must not call shopping-cli");
    };
    const result = await proveMerchantCredentialConsumer({
      profile: {
        agent_id: "seller-a",
        commerce: { base_url: "https://shopping.example", token_env: "KIWI_MERCHANT_TOKEN", backend: "local_marketplace" },
        merchant_public: { merchant_token_env: "KIWI_MERCHANT_TOKEN" },
      } as never,
      dataDir: fixture(),
      fetchImpl: fetchImpl as never,
    });
    expect(result.ok).toBe(false);
    delete process.env.KIWI_MERCHANT_TOKEN;
  });

  it("keeps a gateway sub-path prefix on the private-config request", async () => {
    process.env.SHOPPING_MERCHANT_TOKEN = "shopping_merchant_proof-secret-0123456789";
    process.env.KIWI_COMMERCE_URL = "http://[::1]:8765/gateway";
    const seen: string[] = [];
    const result = await proveMerchantCredentialConsumer({
      profile: profile as never,
      dataDir: fixture(),
      fetchImpl: (async (input: URL | string | Request) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ merchant_id: "seller-a" }), { status: 200, headers: { "content-type": "application/json" } });
      }) as never,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["http://[::1]:8765/gateway/merchants/seller-a/private-config"]);
  });
});

describe("merchant credential consumer proof", () => {
  it("attests only after the child token is accepted by the protected endpoint for its merchant", async () => {
    const dir = fixture();
    process.env.SHOPPING_MERCHANT_TOKEN = "shopping_merchant_child-secret";
    delete process.env.KIWI_COMMERCE_URL;
    let requestedUrl = "";
    let authorization = "";
    const proof = await proveMerchantCredentialConsumer({
      profile,
      dataDir: dir,
      now: () => new Date("2026-10-28T00:00:00.000Z"),
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ ok: true, merchant_id: "seller-a" }));
      },
    });
    expect(proof.ok).toBe(true);
    expect(requestedUrl).toBe("https://shopping.example/merchants/seller-a/private-config");
    expect(authorization).toBe("Bearer shopping_merchant_child-secret");
    const saved = JSON.parse(readFileSync(path.join(dir, "runtime", "merchant-credential-consumer.json"), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ merchant_id: "seller-a", token_env: "SHOPPING_MERCHANT_TOKEN", pid: process.pid, checked_at: "2026-10-28T00:00:00.000Z" });
    expect(saved.credential_fingerprint).toBe(proof.ok ? proof.credentialFingerprint : "");
    expect(JSON.stringify(saved)).not.toContain("child-secret");
  });

  it("does not write proof for an unauthorized or wrong-merchant response", async () => {
    const dir = fixture();
    process.env.SHOPPING_MERCHANT_TOKEN = "shopping_merchant_child-secret";
    delete process.env.KIWI_COMMERCE_URL;
    const unauthorized = await proveMerchantCredentialConsumer({ profile, dataDir: dir, fetchImpl: async () => new Response("{}", { status: 403 }) });
    expect(unauthorized.ok).toBe(false);
    expect(existsSync(path.join(dir, "runtime", "merchant-credential-consumer.json"))).toBe(false);
    const mismatch = await proveMerchantCredentialConsumer({ profile, dataDir: dir, fetchImpl: async () => new Response(JSON.stringify({ merchant_id: "other" })) });
    expect(mismatch.ok).toBe(false);
    expect(existsSync(path.join(dir, "runtime", "merchant-credential-consumer.json"))).toBe(false);
  });
});
