/**
 * M1 Buyer-owned supplier relationship tests（pull-relationship 设计 v0.1 §6/§8/§9.1）：
 * store CRUD 与状态流转、v5→v6 迁移、dueRelationships 过滤、observation digest
 * 去重；scheduler 到期拉取、指纹首记/变化 → review_required、listing diff kind、
 * transient/permanent 退避分类、jitter 范围、重启恢复、SSRF/redirect 拒绝不写
 * observation。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { SupplierScheduler } from "../src/agent/supplier/scheduler.js";
import {
  SupplierRelationshipStore,
  type SupplierRelationship,
} from "../src/agent/supplier/store.js";
import type { KiwiCatalogSource } from "../src/discovery/catalog-source/kiwi-source.js";

const T0 = "2026-08-05T12:00:00.000Z";
const PRINCIPAL = "buyer-agent:buyer-001";
const HOUR = 3600 * 1000;

const CARD_URL = "http://127.0.0.1:9001/.well-known/agent-card.json";
const UCP_URL = "http://127.0.0.1:9001/.well-known/ucp";

function agentCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ACME Industrial",
    description: "ACME merchant agent",
    provider: { organization: "ACME Corp" },
    version: "1.0.0",
    supportedInterfaces: [
      { url: "https://acme.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalogRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog_agent_id: "agent-1",
    principal_type: "merchant",
    merchant_id: "merchant-1",
    display_name: "ACME Industrial",
    canonical_domain: "acme.example",
    agent_card_url: CARD_URL,
    hosting_mode: "standalone",
    verification_level: "domain_verified",
    freshness_state: "fresh",
    administrative_state: "active",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function listingHit(
  listingId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    listing: {
      listing_id: listingId,
      listing_type: "product",
      owner_agent_id: "agent-1",
      merchant_id: "merchant-1",
      title: `listing ${listingId}`,
      category: "office-it",
      listing_digest: `sha256:${listingId}`,
      publication_state: "ACTIVE",
      listing_freshness_state: "FRESH",
      published_at: T0,
      updated_at: T0,
      fresh_until: "2026-08-06T12:00:00.000Z",
      ...overrides,
    },
    merchant: { merchant_id: "merchant-1", display_name: "ACME Industrial" },
    agent: {
      catalog_agent_id: "agent-1",
      verification_level: "domain_verified",
      freshness_state: "fresh",
      administrative_state: "active",
    },
    listing_freshness_state: "FRESH",
    authority: "discovery_projection",
    requires_direct_confirmation: true,
  };
}

function setup() {
  let clock = T0;
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'buyer-001', 'buyer', 'zh-CN', 'Asia/Shanghai', 2, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const store = new SupplierRelationshipStore({ db, principalId: PRINCIPAL, now: () => clock });
  return {
    db,
    store,
    now: () => clock,
    setNow: (t: string) => {
      clock = t;
    },
    after: (ms: number) => new Date(Date.parse(clock) + ms).toISOString(),
  };
}

function saveWatched(
  store: SupplierRelationshipStore,
  overrides: Partial<Parameters<SupplierRelationshipStore["saveRelationship"]>[0]> = {},
): SupplierRelationship {
  return store.saveRelationship({
    merchant_id: "merchant-1",
    canonical_domain: "acme.example",
    agent_card_url: CARD_URL,
    relationship_type: "watched",
    ...overrides,
  });
}

function makeScheduler(
  store: SupplierRelationshipStore,
  now: () => string,
  fetchFn: typeof fetch,
  extra: { catalogSource?: unknown; random?: () => number } = {},
): SupplierScheduler {
  return new SupplierScheduler({
    store,
    now,
    fetchFn,
    allowLoopback: true,
    ...(extra.catalogSource !== undefined
      ? { catalogSource: extra.catalogSource as KiwiCatalogSource }
      : {}),
    ...(extra.random !== undefined ? { random: extra.random } : {}),
  });
}

describe("supplier relationship store (§6)", () => {
  it("migrates v5 -> v6 and creates the three supplier tables", () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db, undefined, 5);
    expect(() => db.prepare("SELECT * FROM supplier_relationships").all()).toThrow();
    migrateMemorySchema(db);
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number;
    };
    expect(row.v).toBe(6);
    expect(db.prepare("SELECT * FROM supplier_relationships").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM supplier_observation_state").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM supplier_observations").all()).toEqual([]);
    db.close();
  });

  it("CRUD: save/get/list/updateStatus/updatePolicy", () => {
    const { store } = setup();
    const rel = saveWatched(store, { scope: { query: "dock" }, policy: { interval_seconds: 7200 } });
    expect(rel.relationship_id).toMatch(/^rel_/);
    expect(rel.status).toBe("active");
    expect(rel.consent_source).toBe("human_explicit");
    expect(rel.receipt_status).toBe("none");

    const fetched = store.getRelationship(rel.relationship_id);
    expect(fetched?.scope).toEqual({ query: "dock" });
    expect(fetched?.policy).toEqual({ interval_seconds: 7200 });

    const updated = store.updatePolicy(rel.relationship_id, {
      policy: { interval_seconds: 3600 },
      expires_at: "2026-11-03T12:00:00.000Z",
    });
    expect(updated.policy.interval_seconds).toBe(3600);
    expect(updated.expires_at).toBe("2026-11-03T12:00:00.000Z");

    store.updateStatus(rel.relationship_id, "paused");
    expect(store.getRelationship(rel.relationship_id)?.status).toBe("paused");
    expect(store.listRelationships().map((r) => r.relationship_id)).toContain(rel.relationship_id);

    store.updateStatus(rel.relationship_id, "deleted");
    const listed = store.listRelationships();
    expect(listed.find((r) => r.relationship_id === rel.relationship_id)).toBeUndefined();
    expect(
      store
        .listRelationships({ includeDeleted: true })
        .find((r) => r.relationship_id === rel.relationship_id)?.status,
    ).toBe("deleted");
  });

  it("rejects invalid type / expires_at and unknown ids", () => {
    const { store } = setup();
    expect(() =>
      store.saveRelationship({
        merchant_id: "m",
        canonical_domain: "d.example",
        agent_card_url: CARD_URL,
        relationship_type: "followed" as never,
      }),
    ).toThrow(/relationship_type/);
    expect(() => saveWatched(store, { expires_at: "not-a-date" })).toThrow(/RFC3339/);
    expect(() => store.updateStatus("rel_missing", "paused")).toThrow(/no relationship/);
  });

  it("dueRelationships: saved/paused/deleted 不轮询；未来 next_check_at 不到期", () => {
    const { store, now, after } = setup();
    const saved = store.saveRelationship({
      merchant_id: "m-saved",
      canonical_domain: "saved.example",
      agent_card_url: CARD_URL,
      relationship_type: "saved",
    });
    const watched = saveWatched(store);
    const paused = saveWatched(store, { merchant_id: "m-paused" });
    store.updateStatus(paused.relationship_id, "paused");
    const removed = saveWatched(store, { merchant_id: "m-removed" });
    store.updateStatus(removed.relationship_id, "deleted");

    // 从未检查过的 watched 关系立即到期；saved/paused/deleted 不出现。
    let due = store.dueRelationships(now(), 10);
    expect(due.map((r) => r.relationship_id)).toEqual([watched.relationship_id]);
    void saved;

    // 排到未来后不到期；时间过后重新到期。
    store.recordSourceSuccess(watched.relationship_id, "agent_card", {
      checked_at: now(),
      next_check_at: after(6 * HOUR),
      unchanged: false,
    });
    expect(store.dueRelationships(now(), 10)).toEqual([]);
    expect(
      store.dueRelationships(after(6 * HOUR + 1000), 10).map((r) => r.relationship_id),
    ).toEqual([watched.relationship_id]);

    // 退避窗口内不到期。
    store.recordSourceFailure(watched.relationship_id, "agent_card", {
      checked_at: now(),
      backoff_at: after(24 * HOUR),
    });
    expect(store.dueRelationships(after(7 * HOUR), 10)).toEqual([]);
  });

  it("addObservation dedup by (relationship, kind, content_digest)", () => {
    const { store, now } = setup();
    const rel = saveWatched(store);
    const input = {
      relationship_id: rel.relationship_id,
      kind: "listing_added" as const,
      source_type: "catalog_search" as const,
      payload: { listing_id: "L1" },
      content_digest: "sha256:abc",
      observed_at: now(),
    };
    const first = store.addObservation(input);
    const second = store.addObservation(input);
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.observation_id).toBe(first.observation_id);
    expect(store.listObservations(rel.relationship_id)).toHaveLength(1);
  });
});

describe("supplier scheduler (§7.1/§8/§9.1)", () => {
  it("due pull: records fingerprint on first success, schedules next check", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store);
    const fetchFn = async () => jsonResponse(agentCard());
    const scheduler = makeScheduler(store, now, fetchFn, { random: () => 0.5 });

    const result = await scheduler.tick();
    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.observations).toEqual([]); // 首次成功只记基线，不产生变化观察

    const state = store.getState(rel.relationship_id, "agent_card");
    expect(state?.last_verified_fingerprint).toMatch(/^sha256:/);
    expect(state?.last_success_at).toBe(now());
    expect(state?.next_check_at).toBe(after(6 * HOUR)); // 默认 interval 6h

    // 未到 next_check_at：不再拉取。
    setNow(after(HOUR));
    expect((await scheduler.tick()).checked).toBe(0);
  });

  it("fingerprint change -> review_required + profile_or_identity_changed, stops pulling", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store);
    let card = agentCard();
    const fetchFn = async () => jsonResponse(card);
    const scheduler = makeScheduler(store, now, fetchFn, { random: () => 0.5 });

    await scheduler.tick();
    const before = store.getState(rel.relationship_id, "agent_card")?.last_verified_fingerprint;
    expect(before).toBeDefined();

    // 身份承载字段变化（version 是指纹材料）。
    card = agentCard({ version: "2.0.0" });
    setNow(after(7 * HOUR));
    const result = await scheduler.tick();
    expect(result.checked).toBe(1);
    expect(store.getRelationship(rel.relationship_id)?.status).toBe("review_required");
    const obs = store.listObservations(rel.relationship_id);
    expect(obs.map((o) => o.kind)).toContain("profile_or_identity_changed");
    expect(result.notified).toHaveLength(1);

    // review_required 后不再自动拉取。
    setNow(after(30 * HOUR));
    expect((await scheduler.tick()).checked).toBe(0);
  });

  it("capability change (same identity) -> capability_changed observation", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store);
    let card = agentCard();
    const fetchFn = async () => jsonResponse(card);
    const scheduler = makeScheduler(store, now, fetchFn);

    await scheduler.tick();
    card = agentCard({ capabilities: { streaming: true } });
    setNow(after(7 * HOUR));
    const result = await scheduler.tick();
    expect(store.getRelationship(rel.relationship_id)?.status).toBe("active");
    const obs = store.listObservations(rel.relationship_id);
    expect(obs.map((o) => o.kind)).toEqual(["capability_changed"]);
    expect(result.observations).toHaveLength(1);
  });

  it("catalog listing diff produces fixed observation kinds (merged notify)", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store, { scope: { catalog_agent_id: "agent-1", query: "dock" } });
    let listings = [
      listingHit("L1", { commercial_hints: { availability_hint: "in_stock" } }),
      listingHit("L2"),
    ];
    const catalogSource = {
      getRecord: async () => catalogRecord(),
      searchListings: async () => listings,
    };
    const fetchFn = async () => jsonResponse(agentCard());
    const scheduler = makeScheduler(store, now, fetchFn, { catalogSource });

    // tick 1：建立基线，无 diff。
    const first = await scheduler.tick();
    expect(first.checked).toBe(1);
    expect(first.observations).toEqual([]);
    expect(store.getState(rel.relationship_id, "catalog_search")?.content_digest).toMatch(
      /^sha256:/,
    );

    // tick 2：L1 可用性+digest 变化、L2 下架、L3 新上架、record 转 stale。
    listings = [
      listingHit("L1", {
        listing_digest: "sha256:L1-v2",
        commercial_hints: { availability_hint: "out_of_stock" },
      }),
      listingHit("L3"),
    ];
    catalogSource.getRecord = async () => catalogRecord({ freshness_state: "stale" });
    setNow(after(7 * HOUR));
    const second = await scheduler.tick();
    const kinds = store.listObservations(rel.relationship_id).map((o) => o.kind);
    expect(kinds).toContain("listing_added");
    expect(kinds).toContain("listing_withdrawn");
    expect(kinds).toContain("listing_updated");
    expect(kinds).toContain("availability_hint_changed");
    expect(kinds).toContain("freshness_changed");
    expect(second.notified).toHaveLength(1); // 多条变化合并一次通知
    expect(second.observations.length).toBeGreaterThanOrEqual(5);
  });

  it("transient failure: exponential backoff with jitter inside ±10%", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store);
    const fetchFn = async (): Promise<Response> => {
      throw new Error("socket hang up");
    };
    const scheduler = makeScheduler(store, now, fetchFn, { random: () => 0.5 });

    const first = await scheduler.tick();
    expect(first.errors).toHaveLength(1);
    let state = store.getState(rel.relationship_id, "agent_card");
    expect(state?.failure_count).toBe(1);
    // attempts=1：2^0 × 6h = 6h（jitter 因子 1.0）。
    expect(state?.next_check_at).toBe(after(6 * HOUR));
    expect(store.listObservations(rel.relationship_id).map((o) => o.kind)).toEqual(["unreachable"]);

    // attempts=2：2^1 × 6h = 12h。
    setNow(after(7 * HOUR));
    await scheduler.tick();
    state = store.getState(rel.relationship_id, "agent_card");
    expect(state?.failure_count).toBe(2);
    expect(state?.next_check_at).toBe(new Date(Date.parse(now()) + 12 * HOUR).toISOString());

    // jitter 上界：random=1 → +10%。
    const { store: store2, now: now2, after: after2 } = setup();
    const rel2 = saveWatched(store2);
    const scheduler2 = makeScheduler(store2, now2, fetchFn, { random: () => 1 });
    await scheduler2.tick();
    expect(store2.getState(rel2.relationship_id, "agent_card")?.next_check_at).toBe(
      after2(Math.floor(6 * HOUR * 1.1)),
    );
    // jitter 下界：random=0 → -10%。
    const { store: store3, now: now3, after: after3 } = setup();
    const rel3 = saveWatched(store3);
    const scheduler3 = makeScheduler(store3, now3, fetchFn, { random: () => 0 });
    await scheduler3.tick();
    expect(store3.getState(rel3.relationship_id, "agent_card")?.next_check_at).toBe(
      after3(Math.floor(6 * HOUR * 0.9)),
    );
  });

  it("permanent failure (HTTP 404): flat 24h backoff", async () => {
    const { store, now, after } = setup();
    const rel = saveWatched(store);
    const fetchFn = async () => new Response("not found", { status: 404 });
    const scheduler = makeScheduler(store, now, fetchFn, { random: () => 0.5 });
    await scheduler.tick();
    const state = store.getState(rel.relationship_id, "agent_card");
    expect(state?.failure_count).toBe(1);
    expect(state?.next_check_at).toBe(after(24 * HOUR));
  });

  it("SSRF / redirect rejection: no observation, no fetch, permanent backoff", async () => {
    const { store, now, after } = setup();
    // link-local 云元数据地址：静态 SSRF 判定拒绝。
    const rel = saveWatched(store, { agent_card_url: "http://169.254.169.254/latest/meta-data" });
    let fetches = 0;
    const fetchFn = async (): Promise<Response> => {
      fetches += 1;
      return jsonResponse(agentCard());
    };
    const scheduler = makeScheduler(store, now, fetchFn, { random: () => 0.5 });
    const result = await scheduler.tick();
    expect(fetches).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(store.listObservations(rel.relationship_id)).toEqual([]);
    expect(store.getState(rel.relationship_id, "agent_card")?.next_check_at).toBe(after(24 * HOUR));

    // redirect 响应同样拒绝且不落 observation。
    const { store: store2, now: now2 } = setup();
    const rel2 = saveWatched(store2);
    const redirectFn = async () => new Response(null, { status: 302 });
    const scheduler2 = makeScheduler(store2, now2, redirectFn, { random: () => 0.5 });
    await scheduler2.tick();
    expect(store2.listObservations(rel2.relationship_id)).toEqual([]);
    expect(
      store2.getState(rel2.relationship_id, "agent_card")?.failure_count,
    ).toBe(1);
  });

  it("restart recovery: a new scheduler instance resumes from the database", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store);
    const fetchFn = async () => jsonResponse(agentCard());
    await makeScheduler(store, now, fetchFn).tick();

    // 新实例（模拟进程重启）：指纹已在库中，内容未变 → 无观察、间隔放慢 ×1.5。
    setNow(after(7 * HOUR));
    const resumed = makeScheduler(store, now, fetchFn);
    const result = await resumed.tick();
    expect(result.checked).toBe(1);
    expect(result.observations).toEqual([]);
    const state = store.getState(rel.relationship_id, "agent_card");
    expect(state?.unchanged_count).toBe(1);
    expect(state?.next_check_at).toBe(new Date(Date.parse(now()) + 9 * HOUR).toISOString());
  });

  it("ucp profile pulled when configured; change -> capability_changed", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store, { ucp_profile_url: UCP_URL });
    let profile: Record<string, unknown> = { capabilities: { rfq: true } };
    const fetchFn: typeof fetch = async (url) =>
      jsonResponse(url === UCP_URL ? profile : agentCard());
    const scheduler = makeScheduler(store, now, fetchFn);

    await scheduler.tick();
    expect(store.getState(rel.relationship_id, "ucp_profile")?.last_success_at).toBe(now());

    profile = { capabilities: { rfq: true, bulk_quote: true } };
    setNow(after(7 * HOUR));
    await scheduler.tick();
    const obs = store.listObservations(rel.relationship_id);
    expect(obs.filter((o) => o.kind === "capability_changed")).toHaveLength(1);
    expect(obs[0]?.source_type).toBe("ucp_profile");
  });

  it("expires_at passed -> status expired and no further pulls", async () => {
    const { store, now, after, setNow } = setup();
    const rel = saveWatched(store, { expires_at: after(2 * HOUR) });
    let fetches = 0;
    const fetchFn = async (): Promise<Response> => {
      fetches += 1;
      return jsonResponse(agentCard());
    };
    const scheduler = makeScheduler(store, now, fetchFn);
    await scheduler.tick();
    expect(fetches).toBe(1);

    setNow(after(3 * HOUR));
    const result = await scheduler.tick();
    expect(store.getRelationship(rel.relationship_id)?.status).toBe("expired");
    expect(result.checked).toBe(0);
    expect(fetches).toBe(1);
  });
});
