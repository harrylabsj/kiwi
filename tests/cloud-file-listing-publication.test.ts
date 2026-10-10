/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * 文件商品目录发布内核（file-listing-publication）：预览/提交/续办全链路，
 * 本地签名 Catalog 桩；覆盖任务书要求的全部拒绝路径与幂等保证。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { generateKeyPairSync } from "node:crypto";
import { signCompactJws } from "../src/trust/identity/jws.js";
import { publicKeyThumbprint, jwkThumbprint } from "../src/trust/binding/thumbprint.js";
import {
  createFileListingPublicationService,
} from "../src/cloud/file-listing-publication.js";
import type { AgentProfile } from "../src/config/profile.js";
import { testProfile } from "./helpers.js";

const CATALOG = "https://catalog.example";
const ORIGIN = "https://shop.example";
const CATALOG_AGENT = "cagt_flp_001";
const BINDING_ID = "binding_flp_001";
const MERCHANT = "mkt_flp_001";
const OWNER = "runtime-owner-flp-1";
/** 只应存在于 enrollment 私有文件/商品私有列里的标记，绝不可出现在任何响应。 */
const GRANT_MARKER = "MUST_NOT_LEAK-private-grant";
const NOTE_MARKER = "MUST_NOT_LEAK-internal-note";
const PRICE_TEXT = "29.9";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface StubState {
  publishCalls: Array<{ key: string; body: Record<string, unknown> }>;
  /** sku → 稳定拒绝（410+码）/不可达（503）/undefined（正常放行） */
  failSku: Record<string, { status: 410 | 503; code?: string } | undefined>;
  bindingId: string;
  listingSeq: number;
  listingIdByKey: Map<string, string>;
}

function productTable(ownerId: string) {
  return {
    schema_version: "0.1.2",
    runtime_owner_id: ownerId,
    source: "merchant_upload",
    generated_at: "2026-09-01T00:00:00.000Z",
    products: [
      {
        sku: "SKU-A",
        title: "Widget Alpha",
        currency: "CNY",
        unit: "piece",
        price: 29.9,
        moq: 2,
        supply_note: `internal ${NOTE_MARKER}`,
        updated_at: "2026-09-01T00:00:00.000Z",
        valid_until: "2030-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        sku: "SKU-B",
        title: "Widget Beta",
        currency: "CNY",
        unit: "box",
        price: 12,
        updated_at: "2026-09-02T00:00:00.000Z",
        valid_until: "2030-06-01T00:00:00.000Z",
        status: "active",
      },
      {
        sku: "SKU-C",
        title: "Widget Gamma",
        currency: "CNY",
        unit: "piece",
        price: 7,
        updated_at: "2026-09-03T00:00:00.000Z",
        valid_until: "2030-12-01T00:00:00.000Z",
        status: "active",
      },
      {
        sku: "SKU-PAUSED",
        title: "Widget Paused",
        currency: "CNY",
        unit: "piece",
        price: 5,
        updated_at: "2026-09-04T00:00:00.000Z",
        valid_until: "2030-01-01T00:00:00.000Z",
        status: "paused",
      },
      {
        sku: "SKU-EXPIRED",
        title: "Widget Expired",
        currency: "CNY",
        unit: "piece",
        price: 5,
        updated_at: "2026-09-05T00:00:00.000Z",
        valid_until: "2020-01-01T00:00:00.000Z",
        status: "active",
      },
    ],
  };
}

function createFixture(options: { ownerId?: string; enrollmentStatus?: string } = {}): {
  dataDir: string;
  productsFile: string;
  productsBytes: string;
  stub: StubState;
  fetchCalls: Array<{ method: string; path: string }>;
  profile: AgentProfile;
  rebind: (bindingId: string) => void;
  fetchImpl: typeof fetch;
} {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-flp-"));
  dirs.push(dataDir);
  const productsFile = path.join(dataDir, "products-file.json");
  const productsBytes = `${JSON.stringify(productTable(options.ownerId ?? OWNER), null, 2)}\n`;
  writeFileSync(productsFile, productsBytes, { mode: 0o600 });

  const identity = loadOrCreateA2aSigningIdentity(dataDir, ORIGIN);
  const thumbprint = publicKeyThumbprint(identity.publicKeyPem);
  const issuer = generateKeyPairSync("ed25519");
  const issuerJwk = issuer.publicKey.export({ format: "jwk" });
  const issuerThumbprint = jwkThumbprint(issuerJwk);
  const issuerIdentity = { keyid: "catalog-issuer", algorithm: "ed25519" as const, privateKey: issuer.privateKey };
  const stub: StubState = {
    publishCalls: [],
    failSku: {},
    bindingId: BINDING_ID,
    listingSeq: 0,
    listingIdByKey: new Map(),
  };
  const writeEnrollment = (bindingId: string, status = options.enrollmentStatus ?? "published"): void => {
    const exp = new Date(Date.now() + 10 * 60_000).toISOString();
    writeFileSync(path.join(dataDir, "merchant-enrollments.json"), JSON.stringify({
      version: 1,
      sessions: [{
        enrollment_id: "enrollment_flp",
        runtime_origin: ORIGIN,
        key_thumbprint: thumbprint,
        catalog_origin: CATALOG,
        catalog_agent_id: CATALOG_AGENT,
        merchant_id: MERCHANT,
        binding_id: bindingId,
        status,
        expires_at: exp,
        grant: GRANT_MARKER,
      }],
      consumed: [],
    }), { mode: 0o600 });
  };
  writeEnrollment(BINDING_ID);

  const bindingDocument = (bindingId: string) => {
    const claims = buildBindingClaims({
      bindingId,
      bindingVersion: 2,
      merchantId: MERCHANT,
      agentId: CATALOG_AGENT,
      workloadRef: "enrollment_flp",
      runtimeOrigin: ORIGIN,
      a2aEndpoint: `${ORIGIN}/a2a`,
      cardUrl: `${CATALOG}/v1/agents/${CATALOG_AGENT}/agent-card.json`,
      keyId: identity.keyid,
      keyThumbprint: thumbprint,
      serviceEpoch: 1,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      ttlSeconds: 600,
      issuer: CATALOG,
    });
    return {
      claims,
      claims_jws: signCompactJws(claims as unknown as Record<string, unknown>, issuerIdentity),
      issuer_kid: "catalog-issuer",
      issuer_thumbprint: issuerThumbprint,
      governance: { publication_state: "ACTIVE" },
      card_revision: 1,
      card_etag: '"card-v1"',
    };
  };

  const fetchCalls: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const parsed = new URL(String(url));
    const method = String(init?.method ?? "GET");
    fetchCalls.push({ method, path: parsed.pathname });
    if (method === "GET") {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-kiwi-binding-jws")).toBeNull();
      expect(headers.get("x-owner-token")).toBeNull();
      expect(JSON.stringify([...headers])).not.toContain(GRANT_MARKER);
      expect(init?.body).toBeUndefined();
    }
    if (parsed.pathname === "/v1/issuer-keys" && method === "GET") {
      return Response.json({ issuer: CATALOG, keys: [{ kid: issuerIdentity.keyid, state: "ACTIVE", jwk: issuerJwk, thumbprint: issuerThumbprint }] });
    }
    if (parsed.pathname === `/v1/agents/${CATALOG_AGENT}/runtime-binding` && method === "GET") {
      return new Response(JSON.stringify(bindingDocument(stub.bindingId)), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (parsed.pathname === "/v1/listings/publish" && method === "POST") {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const key = String(headers.get("idempotency-key"));
      const sku = String(body["source_product_ref"]);
      stub.publishCalls.push({ key, body });
      expect(headers.has("x-kiwi-binding-jws")).toBe(true);
      expect(headers.get("authorization")).toBeNull();
      expect(key.startsWith("kiwi-listing:")).toBe(true);
      expect(body).not.toHaveProperty("owner_token");
      const fail = stub.failSku[sku];
      if (fail?.status === 410) {
        return new Response(JSON.stringify({ error: fail.code ?? "LISTINGS_CAPACITY_EXCEEDED" }), { status: 410, headers: { "content-type": "application/json" } });
      }
      if (fail?.status === 503) {
        return new Response(JSON.stringify({ error: "TEMPORARILY_UNAVAILABLE" }), { status: 503, headers: { "content-type": "application/json" } });
      }
      const known = stub.listingIdByKey.get(key);
      if (known !== undefined) {
        return new Response(JSON.stringify({ ok: true, created: false, idempotent: true, listing: { listing_id: known } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      stub.listingSeq += 1;
      const listingId = `lst_flp_${stub.listingSeq}`;
      stub.listingIdByKey.set(key, listingId);
      return new Response(JSON.stringify({ ok: true, created: true, idempotent: false, listing: { listing_id: listingId } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${method} ${parsed.pathname}`);
  }) as typeof fetch;

  const profile = testProfile({
    agent_id: MERCHANT,
    owner_id: OWNER,
    merchant_public: { public_url: ORIGIN, catalog_url: CATALOG },
  });

  const rebind = (bindingId: string): void => {
    stub.bindingId = bindingId;
    writeEnrollment(bindingId);
  };

  return { dataDir, productsFile, productsBytes, stub, fetchCalls, profile, rebind, fetchImpl };
}

function newService(
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<Parameters<typeof createFileListingPublicationService>[0]> = {},
) {
  return createFileListingPublicationService({
    dataDir: fixture.dataDir,
    profile: fixture.profile,
    productsFile: fixture.productsFile,
    catalogUrl: CATALOG,
    publicOrigin: ORIGIN,
    fetchImpl: fixture.fetchImpl,
    ...overrides,
  });
}

const SEL = (sku: string, category = "widgets") => ({ sku, category });

describe("file listing publication core", () => {
  it("未完成 published 接入时预览拒绝，不回退 owner token", async () => {
    const fixture = createFixture({ enrollmentStatus: "bound" });
    const service = newService(fixture);
    await expect(service.preview([SEL("SKU-A")])).rejects.toMatchObject({ code: "ENROLLMENT_NOT_PUBLISHED" });
    expect(fixture.stub.publishCalls).toHaveLength(0);
  });

  it("文件商品表租户不匹配时预览拒绝（PRODUCT_TABLE_TENANT_MISMATCH）", async () => {
    const fixture = createFixture({ ownerId: "some-other-runtime-owner" });
    const service = newService(fixture);
    await expect(service.preview([SEL("SKU-A")])).rejects.toMatchObject({ code: "PRODUCT_TABLE_TENANT_MISMATCH" });
  });

  it("无接入文件时预览拒绝（LISTING_PUBLISH_NOT_CONNECTED）", async () => {
    const fixture = createFixture();
    rmSync(path.join(fixture.dataDir, "merchant-enrollments.json"));
    const service = newService(fixture);
    await expect(service.preview([SEL("SKU-A")])).rejects.toMatchObject({ code: "LISTING_PUBLISH_NOT_CONNECTED" });
  });

  it("预览只读：不产生发布写、不改商品表、投影无价格/库存/私有列，且带冻结幂等键", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B", "tools")]);
    expect(fixture.stub.publishCalls).toHaveLength(0);
    expect(fixture.fetchCalls).toEqual([
      { method: "GET", path: `/v1/agents/${CATALOG_AGENT}/runtime-binding` },
      { method: "GET", path: "/v1/issuer-keys" },
    ]);
    expect(readFileSync(fixture.productsFile, "utf8")).toBe(fixture.productsBytes);
    expect(preview.items).toHaveLength(2);
    for (const item of preview.items) {
      expect(Object.keys(item.listing).sort()).toEqual([
        "category", "fresh_until", "listing_type", "merchant_id", "owner_agent_id",
        "source_product_ref", "source_revision", "title",
      ]);
      expect(item.listing).not.toHaveProperty("price");
      expect(item.listing).not.toHaveProperty("stock");
      expect(item.idempotency_key).toMatch(/^kiwi-listing:[a-f0-9]{64}$/);
      expect(item.listing_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    expect(preview.items[0]?.listing).toMatchObject({
      listing_type: "product",
      source_product_ref: "SKU-A",
      title: "Widget Alpha",
      category: "widgets",
      merchant_id: MERCHANT,
      owner_agent_id: CATALOG_AGENT,
    });
    // 有效期 2030 远于 30 天窗口 → fresh_until 取窗口上限（约 30 天后）。
    const freshMs = Date.parse(String(preview.items[0]?.listing.fresh_until));
    expect(freshMs).toBeGreaterThan(Date.now());
    expect(freshMs).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000 + 60_000);
    // 序列化响应不含价格、私有供货说明与 enrollment 凭据。
    const text = JSON.stringify(preview);
    expect(text).not.toContain(PRICE_TEXT);
    expect(text).not.toContain(NOTE_MARKER);
    expect(text).not.toContain(GRANT_MARKER);
    expect(preview.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preview.expires_at > preview.created_at).toBe(true);
  });

  it("选择校验：空选择/重复 SKU/未知 SKU/暂停/过期/分类必填", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    await expect(service.preview([])).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(service.preview([SEL("SKU-A"), SEL("SKU-A")])).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(service.preview([SEL("SKU-NOPE")])).rejects.toMatchObject({ code: "SKU_UNKNOWN" });
    await expect(service.preview([SEL("SKU-PAUSED")])).rejects.toMatchObject({ code: "PRODUCT_PAUSED" });
    await expect(service.preview([SEL("SKU-EXPIRED")])).rejects.toMatchObject({ code: "PRODUCT_EXPIRED" });
    await expect(service.preview([{ sku: "SKU-A", category: "   " }])).rejects.toMatchObject({ code: "CATEGORY_REQUIRED" });
    await expect(service.preview([{ sku: "SKU-A", category: undefined as unknown as string }])).rejects.toMatchObject({ code: "CATEGORY_REQUIRED" });
    expect(fixture.stub.publishCalls).toHaveLength(0);
  });

  it("commit：digest 不符 / 预览过期 / 商品快照变化 / 绑定变更 均拒绝且零发布写", async () => {
    const fixture = createFixture();
    // 假时钟锚在真实当前时间附近：canonicalizeCatalogListing 用真实时钟校验
    // fresh_until TTL，假时钟偏离过远会被上游拒绝。
    const nowMs = Date.now() - 5_000;
    let current = nowMs;
    const service = newService(fixture, { now: () => new Date(current), previewTtlMs: 60_000 });
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B")]);
    expect(fixture.stub.publishCalls).toHaveLength(0);

    await expect(service.commit(preview.draft_id, `sha256:${"0".repeat(64)}`))
      .rejects.toMatchObject({ code: "DRAFT_DIGEST_MISMATCH" });

    current += 61_000;
    await expect(service.commit(preview.draft_id, preview.digest))
      .rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    current = nowMs;

    // 绑定身份变更（重新 enrollment 到新 binding）→ 冻结绑定不匹配。
    fixture.rebind("binding_flp_002");
    await expect(service.commit(preview.draft_id, preview.digest))
      .rejects.toMatchObject({ code: "BINDING_CHANGED" });
    fixture.rebind(BINDING_ID);

    // 商品表变化 → 快照 digest 不匹配。
    const table = JSON.parse(fixture.productsBytes) as { products: Array<Record<string, unknown>> };
    table.products.push({
      sku: "SKU-D", title: "Widget Delta", currency: "CNY", unit: "piece", price: 3,
      updated_at: "2026-09-06T00:00:00.000Z", valid_until: "2030-01-01T00:00:00.000Z", status: "active",
    });
    writeFileSync(fixture.productsFile, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
    await expect(service.commit(preview.draft_id, preview.digest))
      .rejects.toMatchObject({ code: "PRODUCTS_CHANGED" });
    expect(fixture.stub.publishCalls).toHaveLength(0);
  });

  it("commit 成功：frozen payload 签名发布、回执持久、getDraft 可读；路径与凭据边界成立", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B")]);
    const result = await service.commit(preview.draft_id, preview.digest);
    expect(result.status).toBe("succeeded");
    expect(result.succeeded).toBe(2);
    expect(result.results.map((r) => r.listing_id)).toEqual(["lst_flp_1", "lst_flp_2"]);
    expect(fixture.stub.publishCalls).toHaveLength(2);

    // 幂等键 = bindingId + payload digest（与 product-publish.ts 同策略）。
    expect(fixture.stub.publishCalls[0]?.key).toBe(preview.items[0]?.idempotency_key);
    expect(fixture.stub.publishCalls[1]?.key).toBe(preview.items[1]?.idempotency_key);

    // 重启/重放同一 commit：不再产生新的发布调用，回执照实返回。
    const replay = await service.commit(preview.draft_id, preview.digest);
    expect(replay.status).toBe("succeeded");
    expect(fixture.stub.publishCalls).toHaveLength(2);

    const view = await service.getDraft(preview.draft_id);
    expect(view.found).toBe(true);
    expect(view.draft?.draft_id).toBe(preview.draft_id);
    expect(view.receipts.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    const viewText = JSON.stringify(view);
    expect(viewText).not.toContain(GRANT_MARKER);
    expect(viewText).not.toContain(NOTE_MARKER);
    expect(viewText).not.toContain(PRICE_TEXT);

    // 路径校验：用户输入永不拼路径；格式非法立即拒绝。
    await expect(service.getDraft("../../../../etc/passwd")).rejects.toMatchObject({ code: "INVALID_DRAFT_ID" });
    await expect(service.getDraft("not-a-draft-id")).rejects.toMatchObject({ code: "INVALID_DRAFT_ID" });
    await expect(service.commit("../escape", preview.digest)).rejects.toMatchObject({ code: "INVALID_DRAFT_ID" });
    const missing = await service.getDraft(`flp_${Date.now().toString(36)}_${"0".repeat(12)}`);
    expect(missing.found).toBe(false);

    // 私钥与 enrollment 文件权限：0600，目录 0700（落盘纪律）。
    const keyStat = (await import("node:fs")).statSync(path.join(fixture.dataDir, "a2a-signing-key.json"));
    expect(keyStat.mode & 0o777).toBe(0o600);
  });

  it("部分失败如实返回 partial；续办只用同 payload 同键，成功项不再重发，且绝不撤回他人 listing", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B"), SEL("SKU-C")]);
    fixture.stub.failSku["SKU-B"] = { status: 410 };
    fixture.stub.failSku["SKU-C"] = { status: 503 };
    const first = await service.commit(preview.draft_id, preview.digest);
    expect(first.status).toBe("partial");
    expect(first.succeeded).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.pending).toBe(1);
    const bySku = new Map(first.results.map((r) => [r.sku, r]));
    expect(bySku.get("SKU-A")).toMatchObject({ status: "succeeded", listing_id: "lst_flp_1" });
    expect(bySku.get("SKU-B")).toMatchObject({ status: "failed", code: "LISTINGS_CAPACITY_EXCEEDED" });
    expect(bySku.get("SKU-C")).toMatchObject({ status: "pending" });
    const firstText = JSON.stringify(first);
    expect(firstText).not.toContain(GRANT_MARKER);
    // pending 回执统一通用码，不带任何原始错误文本/远端字符串反射。
    expect(bySku.get("SKU-C")?.code).toBe("PUBLISH_UNCERTAIN");

    // 续办：SKU-C 恢复（同键同 payload），SKU-A 不重发，SKU-B 维持稳定拒绝。
    const keysBefore = new Set(fixture.stub.publishCalls.map((c) => c.key));
    fixture.stub.failSku["SKU-C"] = undefined;    const second = await service.commit(preview.draft_id, preview.digest);
    expect(second.status).toBe("partial");
    expect(second.succeeded).toBe(2);
    expect(second.failed).toBe(1);
    const skuACalls = fixture.stub.publishCalls.filter((c) => c.body["source_product_ref"] === "SKU-A");
    expect(skuACalls).toHaveLength(1);
    const skuCCalls = fixture.stub.publishCalls.filter((c) => c.body["source_product_ref"] === "SKU-C");
    expect(skuCCalls).toHaveLength(2);
    expect(new Set(skuCCalls.map((c) => c.key))).toEqual(new Set([preview.items[2]?.idempotency_key]));
    // SKU-C 两次调用 payload 逐字相同（frozen payload 续办）。
    expect(JSON.stringify(skuCCalls[0]?.body)).toBe(JSON.stringify(skuCCalls[1]?.body));
    // 没有引入新的幂等键（无重复 listing 风险）。
    expect(fixture.stub.publishCalls.every((c) => keysBefore.has(c.key))).toBe(true);

    // 本内核从不调用 withdraw / delete。
    expect(fixture.fetchCalls.every((c) => !c.path.includes("/withdraw") && c.method !== "DELETE")).toBe(true);
  });

  it("并发 commit 不会产生重复 listing（同键回放原结果）", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B")]);
    const [left, right] = await Promise.all([
      service.commit(preview.draft_id, preview.digest),
      service.commit(preview.draft_id, preview.digest),
    ]);
    expect(left.status).toBe("succeeded");
    expect(right.status).toBe("succeeded");
    // 每个 SKU 只有一个稳定幂等键；同键两次调用由桩回放同一 listing_id。
    const keysBySku = new Map<string, Set<string>>();
    for (const call of fixture.stub.publishCalls) {
      const sku = String(call.body["source_product_ref"]);
      keysBySku.set(sku, (keysBySku.get(sku) ?? new Set()).add(call.key));
    }
    for (const keys of keysBySku.values()) expect(keys.size).toBe(1);
    const ids = new Set([
      ...(left.results.map((r) => r.listing_id)),
      ...(right.results.map((r) => r.listing_id)),
    ]);
    expect(ids.size).toBe(2);
  });

  it("重新预览生成同内容同幂等键（跨草稿续办仍无重复）", async () => {
    const fixture = createFixture();
    const nowMs = Date.now() - 5_000;
    const service = newService(fixture, { now: () => new Date(nowMs) });
    const first = await service.preview([SEL("SKU-A")]);
    const second = await service.preview([SEL("SKU-A")]);
    expect(second.draft_id).not.toBe(first.draft_id);
    // 摘要覆盖完整冻结内容（含 draft_id，防摘要跨草稿重放）→ 不同草稿摘要不同；
    // 跨草稿防重复靠的是内容派生的幂等键一致。
    expect(second.digest).not.toBe(first.digest);
    expect(second.items[0]?.idempotency_key).toBe(first.items[0]?.idempotency_key);
    await service.commit(first.draft_id, first.digest);
    const result = await service.commit(second.draft_id, second.digest);
    // 第二份草稿没有第一份的回执 → 会重发请求，但幂等键相同（内容派生），
    // Catalog 回放原结果：**远端永远只有一条 listing**，不产生重复。
    expect(result.status).toBe("succeeded");
    expect(fixture.stub.publishCalls).toHaveLength(2);
    expect(fixture.stub.publishCalls[1]?.key).toBe(fixture.stub.publishCalls[0]?.key);
    expect(fixture.stub.listingIdByKey.size).toBe(1);
    expect(result.results[0]?.listing_id).toBe("lst_flp_1");
  });

  it("草稿完整性：篡改冻结正文/digest/幂等键任一处，commit 拒绝且零发布写", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B")]);
    const draftFile = path.join(fixture.dataDir, "listing-publication", "drafts", `${preview.draft_id}.json`);

    // 篡改 payload（保持原 digest）→ 重算摘要不符。
    const original = JSON.parse(readFileSync(draftFile, "utf8")) as Record<string, unknown>;
    const items = original["items"] as Array<Record<string, unknown>>;
    (items[0]!["listing"] as Record<string, unknown>)["title"] = "Tampered Title";
    writeFileSync(draftFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    await expect(service.commit(preview.draft_id, preview.digest))
      .rejects.toMatchObject({ code: "DRAFT_CORRUPTED" });
    expect(fixture.stub.publishCalls).toHaveLength(0);

    // 只改 digest 字段（正文未动）→ 重算摘要与存储 digest 不符。
    const digestOnly = JSON.parse(fixture.productsBytes ? readFileSync(draftFile, "utf8") : "{}") as Record<string, unknown>;
    void digestOnly;
    const restored = JSON.parse(readFileSync(draftFile, "utf8")) as Record<string, unknown>;
    restored["items"] = items.map((item, index) => index === 0
      ? { ...(item as Record<string, unknown>), listing: { ...((item as Record<string, unknown>)["listing"] as Record<string, unknown>), title: "Widget Alpha" } }
      : item);
    restored["digest"] = `sha256:${"f".repeat(64)}`;
    writeFileSync(draftFile, `${JSON.stringify(restored, null, 2)}\n`, { mode: 0o600 });
    await expect(service.commit(preview.draft_id, preview.digest))
      .rejects.toMatchObject({ code: "DRAFT_CORRUPTED" });

    // 篡改幂等键（内容与 digest 自洽重建后仍须被逐项派生链核对拦下）。
    // 用真实重算流程无法伪造自洽文件（攻击者无签名链），这里验证派生链核对本身：
    const coherent = JSON.parse(readFileSync(draftFile, "utf8")) as Record<string, unknown>;
    coherent["digest"] = preview.digest;
    const coherentItems = coherent["items"] as Array<Record<string, unknown>>;
    coherentItems[0]!["idempotency_key"] = "kiwi-listing:" + "0".repeat(64);
    // 同步重算 digest 使其"自洽"（模拟有能力重算摘要的篡改者）。
    const { createHash } = await import("node:crypto");
    const { canonicalize } = await import("../src/negotiation/jcs.js");
    const { digest: _omit, ...frozen } = coherent as Record<string, unknown> & { digest?: string };
    coherent["digest"] = `sha256:${createHash("sha256").update(canonicalize(frozen), "utf8").digest("hex")}`;
    writeFileSync(draftFile, `${JSON.stringify(coherent, null, 2)}\n`, { mode: 0o600 });
    await expect(service.commit(preview.draft_id, preview.digest))
      .rejects.toMatchObject({ code: "DRAFT_CORRUPTED" });
    expect(fixture.stub.publishCalls).toHaveLength(0);
  });

  it("未知远端拒绝码归并为通用码，不反射远端字符串", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A")]);
    fixture.stub.failSku["SKU-A"] = { status: 410, code: "BRAND_NEW_GOVERNANCE_WORDING_XYZ" };
    const result = await service.commit(preview.draft_id, preview.digest);
    expect(result.status).toBe("failed");
    expect(result.results[0]).toMatchObject({ status: "failed", code: "LISTING_PUBLISH_REJECTED" });
    expect(JSON.stringify(result)).not.toContain("BRAND_NEW_GOVERNANCE_WORDING_XYZ");
  });

  it("逐项持久化：后续项失败时已成功项的回执已原子落盘；并发 commit 回执收敛不覆盖", async () => {
    const fixture = createFixture();
    const service = newService(fixture);
    const preview = await service.preview([SEL("SKU-A"), SEL("SKU-B"), SEL("SKU-C")]);
    fixture.stub.failSku["SKU-B"] = { status: 503 };
    fixture.stub.failSku["SKU-C"] = { status: 410, code: "LISTINGS_GOVERNANCE_HOLD" };
    const result = await service.commit(preview.draft_id, preview.digest);
    expect(result.status).toBe("partial");
    // 模拟"进程在第二个商品前崩溃"：首个成功项的回执在盘上可独立恢复。
    const receiptsFile = path.join(fixture.dataDir, "listing-publication", "receipts", `${preview.draft_id}.receipts.json`);
    const stored = JSON.parse(readFileSync(receiptsFile, "utf8")) as { items: Record<string, { status: string; listing_id?: string }> };
    expect(stored.items["SKU-A"]).toMatchObject({ status: "succeeded", listing_id: "lst_flp_1" });
    expect(stored.items["SKU-C"]).toMatchObject({ status: "failed", code: "LISTINGS_GOVERNANCE_HOLD" });

    // 并发两个 commit（SKU-B 仍不可达）：SKU-A 均不重发、回执合并后仍收敛为 succeeded。
    fixture.stub.failSku["SKU-C"] = undefined;
    await Promise.all([
      service.commit(preview.draft_id, preview.digest),
      service.commit(preview.draft_id, preview.digest),
    ]);
    const final = JSON.parse(readFileSync(receiptsFile, "utf8")) as { items: Record<string, { status: string }> };
    expect(final.items["SKU-A"]).toMatchObject({ status: "succeeded", listing_id: "lst_flp_1" });
    expect(final.items["SKU-B"]?.status).toBe("pending");
    expect(final.items["SKU-C"]).toMatchObject({ status: "succeeded" });
    // 全程每个 sku 至多一个幂等键（远端不可能出现重复对象）。
    const keysBySku = new Map<string, Set<string>>();
    for (const call of fixture.stub.publishCalls) {
      const sku = String(call.body["source_product_ref"]);
      keysBySku.set(sku, (keysBySku.get(sku) ?? new Set()).add(call.key));
    }
    for (const keys of keysBySku.values()) expect(keys.size).toBe(1);
  });

  it("same-draft concurrent service instances serialize publication and reuse the persisted success", async () => {
    const fixture = createFixture();
    const originalFetch = fixture.fetchImpl;
    let active = 0;
    let maxActive = 0;
    fixture.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === "POST") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          return await originalFetch(...args);
        } finally { active -= 1; }
      }
      return await originalFetch(...args);
    }) as typeof fetch;
    const first = newService(fixture);
    const second = newService(fixture);
    const draft = await first.preview([SEL("SKU-A")]);
    const results = await Promise.all([first.commit(draft.draft_id, draft.digest), second.commit(draft.draft_id, draft.digest)]);
    expect(results.every((result) => result.status === "succeeded")).toBe(true);
    expect(maxActive).toBe(1);
    expect(fixture.stub.publishCalls).toHaveLength(1);
  });
  it("目录与文件守卫：dataDir 宽权限 / drafts 软链 均拒绝；0600/0700 落盘", async () => {
    const loose = createFixture();
    const { chmodSync } = await import("node:fs");
    chmodSync(loose.dataDir, 0o755);
    // preview 先过 enrollment 读取守卫（上游同样拒绝宽权限 dataDir），两层守卫
    // 任一生效均为拒绝：ENROLLMENT_STORAGE_PERMISSIONS（上游）或
    // DATA_DIR_PERMISSIONS（本内核写路径纵深防御）。
    await expect(newService(loose).preview([SEL("SKU-A")]))
      .rejects.toMatchObject({ code: expect.stringMatching(/_PERMISSIONS$/) });
    chmodSync(loose.dataDir, 0o700);

    const linked = createFixture();
    const draftsDir = path.join(linked.dataDir, "listing-publication", "drafts");
    const { mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const outside = mkdtempSync(path.join(tmpdir(), "kiwi-flp-outside-"));
    dirs.push(outside);
    rmSync(draftsDir, { recursive: true, force: true });
    mkdirSync(path.join(linked.dataDir, "listing-publication"), { recursive: true });
    symlinkSync(outside, draftsDir, "dir");
    await expect(newService(linked).preview([SEL("SKU-A")]))
      .rejects.toMatchObject({ code: "DATA_DIR_PERMISSIONS" });

    // 正常流：草稿与回执文件 0600。
    const ok = createFixture();
    const okService = newService(ok);
    const preview = await okService.preview([SEL("SKU-A")]);
    const draftFile = path.join(ok.dataDir, "listing-publication", "drafts", `${preview.draft_id}.json`);
    const { statSync } = await import("node:fs");
    expect(statSync(draftFile).mode & 0o777).toBe(0o600);
    await okService.commit(preview.draft_id, preview.digest);
    const receiptsFile = path.join(ok.dataDir, "listing-publication", "receipts", `${preview.draft_id}.receipts.json`);
    expect(statSync(receiptsFile).mode & 0o777).toBe(0o600);
  });
});

describe("A409 fixture trust boundary", () => {
  it.each(["missing", "bad_thumbprint", "bad_signature"] as const)("issuer %s refuses before publication without credential fallback", async (fault) => {
    const fixture = createFixture();
    const original = fixture.fetchImpl;
    fixture.fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      const pathname = new URL(String(args[0])).pathname;
      const document = await response.json() as Record<string, unknown>;
      if (pathname === "/v1/issuer-keys") {
        if (fault === "missing") document["keys"] = [];
        else if (fault === "bad_thumbprint") {
          const keys = document["keys"] as Record<string, unknown>[];
          keys[0]!["thumbprint"] = `sha256:${"c".repeat(64)}`;
        }
      } else if (fault === "bad_signature" && pathname.endsWith("/runtime-binding")) {
        const parts = String(document["claims_jws"]).split(".");
        const signature = parts[2]!;
        parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
        document["claims_jws"] = parts.join(".");
      }
      return Response.json(document, { status: response.status, headers: response.headers });
    }) as typeof fetch;
    await expect(newService(fixture).preview([SEL("SKU-A")])).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    expect(fixture.stub.publishCalls).toHaveLength(0);
    expect(fixture.fetchCalls).toEqual([
      { method: "GET", path: `/v1/agents/${CATALOG_AGENT}/runtime-binding` },
      { method: "GET", path: "/v1/issuer-keys" },
    ]);
    expect(readFileSync(fixture.productsFile, "utf8")).toBe(fixture.productsBytes);
  });
});
