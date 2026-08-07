/**
 * Kiwi v0.7.0 Transaction Handoff（WP3）— OrderRecord tests。
 *
 * 覆盖（对齐工作包验收清单）：
 *  - 从 completed checkout 的 order 字段摄取（order id / permalink_url /
 *    line_items / status / terms_digest + 溯源 agreement/session）；
 *  - 只读查询面：get / list / findByTermsDigest / findByAgreement / count；
 *  - 类型层面不可变证据：readonly 字段赋值是类型错误；store 无公开 mutator
 *    （delete/update/insert/upsert/remove）—— 由 `@ts-expect-error` + tsc 校验；
 *  - 溯源链一致：agreement → session → order digest 相同；
 *  - 本地存储权限：目录 0700 / 数据库文件 0600。
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import { createHandoffPackage } from "../src/handoff/package.js";
import { ManualHandoffChannel } from "../src/handoff/channel.js";
import {
  ingestOrderRecord,
  openOrderRecordStore,
  type OrderRecord,
  type OrderRecordSource,
  type OrderRecordStore,
} from "../src/handoff/order-record.js";
import { AGREEMENT_ID, NEGOTIATION_ID, OFFER_ID_3, SKU } from "./negotiation-helpers.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-08-06T12:00:00Z";
const CLOCK = () => NOW;

const TERMS: TermSet = {
  items: [
    {
      sku: SKU,
      quantity: { value: 200, unit: "piece" },
      unit_price: { currency: "CNY", amount_minor: 85000 },
    },
  ],
  fulfillment_terms: { delivery_before: "2026-08-20T18:00:00Z" },
  valid_until: "2026-08-07T12:00:00Z",
};

const IDENTITY = { buyer_identity: "buyer-001", merchant_identity: "merchant-001" };

function makeAgreement(terms: TermSet = TERMS): AcceptedNonbindingAgreement {
  return {
    type: "accepted_nonbinding_agreement",
    agreement_id: AGREEMENT_ID,
    negotiation_id: NEGOTIATION_ID,
    accepted_offer_id: OFFER_ID_3,
    agreed_terms: structuredClone(terms),
    terms_digest: contentDigest(terms),
    accepted_by: ["buyer", "merchant"],
    created_at: "2026-08-05T12:30:00Z",
    binding_effect: "nonbinding",
    creates_order: false,
    reserves_inventory: false,
    authorizes_payment: false,
  };
}

function makePackage(terms: TermSet = TERMS): ReturnType<typeof createHandoffPackage> {
  return createHandoffPackage({
    agreement: makeAgreement(terms),
    identity: IDENTITY,
    capability_version: "ucp.checkout/1",
    created_at: NOW,
  });
}

function orderSource(overrides: Record<string, unknown> = {}): OrderRecordSource {
  return {
    order_id: (overrides.order_id as string) ?? "ord_1001",
    permalink_url: "https://merchant.example/orders/ord_1001",
    line_items: [
      { sku: SKU, quantity: 200, unit_price: { currency: "CNY", amount_minor: 85000 } },
    ],
    status: "confirmed",
    terms_digest: contentDigest(TERMS),
    currency: "CNY",
    total_minor: 17000000,
    agreement_id: AGREEMENT_ID,
    negotiation_id: NEGOTIATION_ID,
    session_ref: (overrides.session_ref as string) ?? "hs_order_test",
    ...overrides,
  } as OrderRecordSource;
}

function tempDbPath(): string {
  const dir = path.join(os.tmpdir(), `kiwi-order-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "orders", "state.sqlite");
}

// ---------------------------------------------------------------------------
// 1. 摄取与只读查询
// ---------------------------------------------------------------------------

describe("OrderRecord ingestion", () => {
  it("ingests order facts and exposes them through read-only queries", () => {
    const store = openOrderRecordStore({ dbPath: ":memory:" });
    try {
      const ingested = ingestOrderRecord(store, orderSource(), CLOCK);
      expect(ingested.order_id).toBe("ord_1001");
      expect(ingested.permalink_url).toBe("https://merchant.example/orders/ord_1001");
      expect(ingested.line_items[0]).toMatchObject({ sku: SKU, quantity: 200 });
      expect(ingested.status).toBe("confirmed");
      expect(ingested.terms_digest).toBe(contentDigest(TERMS));
      expect(ingested.currency).toBe("CNY");
      expect(ingested.total_minor).toBe(17000000);
      expect(ingested.agreement_id).toBe(AGREEMENT_ID);
      expect(ingested.negotiation_id).toBe(NEGOTIATION_ID);
      expect(ingested.session_ref).toBe("hs_order_test");
      expect(ingested.recorded_at).toBe(NOW);

      expect(store.get("ord_1001")).toEqual(ingested);
      expect(store.count()).toBe(1);
      expect(store.list()).toHaveLength(1);
      expect(store.findByTermsDigest(contentDigest(TERMS))).toHaveLength(1);
      expect(store.findByAgreement(AGREEMENT_ID)).toHaveLength(1);
      expect(store.get("ord_missing")).toBeUndefined();
      expect(store.findByTermsDigest(contentDigest({ items: [] }))).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("re-ingesting the same order_id is idempotent (single row)", () => {
    const store = openOrderRecordStore({ dbPath: ":memory:" });
    try {
      ingestOrderRecord(store, orderSource(), CLOCK);
      ingestOrderRecord(store, orderSource({ status: "fulfilled" }), CLOCK);
      expect(store.count()).toBe(1);
      expect(store.get("ord_1001")?.status).toBe("fulfilled");
    } finally {
      store.close();
    }
  });

  it("validates the source fail-closed (bad URL / bad digest / empty id)", () => {
    const store = openOrderRecordStore({ dbPath: ":memory:" });
    try {
      expect(() => ingestOrderRecord(store, orderSource({ permalink_url: "not-a-url" }), CLOCK)).toThrow(
        /permalink_url/,
      );
      expect(() =>
        ingestOrderRecord(store, orderSource({ terms_digest: "not-a-digest" }), CLOCK),
      ).toThrow(/sha256/);
      expect(() => ingestOrderRecord(store, orderSource({ order_id: "" }), CLOCK)).toThrow(/order_id/);
      expect(store.count()).toBe(0);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 溯源链：agreement → session → order digest 一致
// ---------------------------------------------------------------------------

describe("OrderRecord provenance chain", () => {
  it("order terms_digest matches the session and agreement digests", () => {
    const channel = new ManualHandoffChannel({ now: CLOCK });
    const created = channel.createSession(makePackage());
    if (created.status !== "ok") throw new Error("create failed");
    const session = created.session;

    // agreement → package → session digests agree.
    expect(session.current_terms_digest).toBe(contentDigest(TERMS));
    expect(session.package.terms_digest).toBe(contentDigest(TERMS));
    expect(session.package.agreement_id).toBe(AGREEMENT_ID);

    // completed checkout order facts carry the same digest + session/agreement provenance.
    const store = openOrderRecordStore({ dbPath: ":memory:" });
    try {
      const order = ingestOrderRecord(
        store,
        orderSource({ session_ref: session.session_ref }),
        CLOCK,
      );
      expect(order.terms_digest).toBe(session.current_terms_digest);
      expect(order.agreement_id).toBe(session.package.agreement_id);
      expect(order.session_ref).toBe(session.session_ref);

      // Query back by provenance.
      expect(store.findByAgreement(AGREEMENT_ID)[0]?.session_ref).toBe(session.session_ref);
      expect(store.findByTermsDigest(order.terms_digest)[0]?.order_id).toBe("ord_1001");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 类型层面不可变证据
// ---------------------------------------------------------------------------

describe("OrderRecord immutability", () => {
  it("store exposes no public mutator methods (runtime check)", () => {
    const store = openOrderRecordStore({ dbPath: ":memory:" });
    try {
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
      for (const name of ["insert", "update", "delete", "upsert", "remove", "ingest"]) {
        expect(surface).not.toContain(name);
      }
    } finally {
      store.close();
    }
  });
});

// Type-level evidence (enforced by `npm run typecheck`): the following two
// `@ts-expect-error` directives MUST have a real type error beneath them. If a
// readonly field becomes writable, or a public mutator is added to
// OrderRecordStore, the directive becomes unused and typecheck fails.
const _readonlyOrder: OrderRecord = {
  order_id: "ord_typecheck",
  permalink_url: "https://merchant.example/orders/ord_typecheck",
  line_items: [],
  status: "confirmed",
  terms_digest: contentDigest(TERMS),
  agreement_id: AGREEMENT_ID,
  negotiation_id: NEGOTIATION_ID,
  session_ref: "hs_typecheck",
  recorded_at: NOW,
};
// @ts-expect-error — OrderRecord fields are readonly at the type level.
const _mutateReadonlyField: string = (_readonlyOrder.order_id = "changed");
// @ts-expect-error — OrderRecordStore exposes read-only queries only; delete must not exist.
const _noDeleteMutator: OrderRecordStore["delete"] = undefined as never;

// ---------------------------------------------------------------------------
// 4. 本地存储权限 0700/0600
// ---------------------------------------------------------------------------

describe("OrderRecord local storage permissions", () => {
  it("creates the directory 0700 and the database file 0600", () => {
    const dbPath = tempDbPath();
    const store = openOrderRecordStore({ dbPath });
    try {
      ingestOrderRecord(store, orderSource(), CLOCK);
    } finally {
      store.close();
    }
    const dirMode = statSync(path.dirname(dbPath)).mode & 0o777;
    const fileMode = statSync(dbPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    rmSync(path.dirname(path.dirname(dbPath)), { recursive: true, force: true });
  });

  it("tightens pre-existing permissions back to 0700/0600", () => {
    const dbPath = tempDbPath();
    // Simulate a dir/file left at loose permissions by another tool.
    const dbDir = path.dirname(dbPath);
    mkdirSync(dbDir, { recursive: true, mode: 0o755 });
    chmodSync(dbDir, 0o755);
    const store = openOrderRecordStore({ dbPath });
    try {
      ingestOrderRecord(store, orderSource(), CLOCK);
    } finally {
      store.close();
    }
    expect(statSync(dbDir).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    rmSync(path.dirname(path.dirname(dbPath)), { recursive: true, force: true });
  });
});
