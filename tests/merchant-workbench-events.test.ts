import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WorkbenchEventProjectionStore } from "../src/http/merchant-management/event-projection.js";
import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";
import { WorkbenchReconciliationStore } from "../src/http/merchant-management/reconciliation-worker.js";
import { MerchantFeedStore } from "../src/merchant/feed-store.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";

const MERCHANT = "merchant-events";
const NOW = "2026-09-21T12:00:00.000Z";

describe("Workbench authoritative event projection", () => {
  it("merges redacted domain facts with a signed, merchant-bound cursor", () => {
    const db = new DatabaseSync(":memory:");
    new WorkbenchConfirmationStore({ db, now: () => NOW });
    new WorkbenchReconciliationStore({ db, now: () => NOW });
    const feed = new MerchantFeedStore({ db, cursorKey: randomBytes(32), now: () => NOW });
    const promotions = new MerchantPromotionStore({ db, now: () => NOW });
    const events = new WorkbenchEventProjectionStore({ db, cursorKey: randomBytes(32) });

    db.prepare(
      `INSERT INTO workbench_approval_decisions
       (merchant_id, candidate_id, approval_generation, decision, actor_id, confirmation_id,
        operation_id, action_digest, decided_at)
       VALUES (?, 'candidate-1', 1, 'approve', 'owner-1', 'confirmation-1',
               'operation-1', ?, ?)`,
    ).run(MERCHANT, `sha256:${"a".repeat(64)}`, NOW);
    db.prepare(
      `INSERT INTO workbench_approval_operations
       (operation_id, merchant_id, candidate_id, approval_generation, status, created_at, updated_at)
       VALUES ('operation-1', ?, 'candidate-1', 1, 'succeeded', ?, ?)`,
    ).run(MERCHANT, NOW, NOW);
    feed.publish(MERCHANT, {
      kind: "service_notice",
      title: "Public update",
      body: "No private values",
      audience: "public",
    });
    promotions.createDraft(MERCHANT, {
      skuRefs: ["sku-1"],
      rule: {
        kind: "limited_price",
        unit_price: { currency: "CNY", amount_minor: "9999" },
      },
      audience: "public",
      starts: "2026-09-21T12:00:00Z",
      ends: "2026-09-22T12:00:00Z",
      timezone: "UTC",
    });
    db.prepare(
      `INSERT INTO workbench_alerts
       (alert_id, merchant_id, category, resource, episode, severity, summary, created_at)
       VALUES ('alert-1', ?, 'operation_unknown', 'operation-1', 'episode-1',
               'warning', 'Review required', ?)`,
    ).run(MERCHANT, NOW);

    const first = events.list(MERCHANT, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = events.list(MERCHANT, { cursor: first.next_cursor!, limit: 10 });
    expect(second.items.length).toBeGreaterThan(0);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((event) => event.event_type))).toEqual(
      new Set([
        "approval.decided",
        "operation.status",
        "broadcast.published",
        "promotion.revised",
        "alert.created",
      ]),
    );
    const serialized = JSON.stringify(all);
    expect(serialized).not.toMatch(/action_digest|snapshot_json|floor|token|password/u);
    expect(() => events.list(MERCHANT, { cursor: `${first.next_cursor}tampered` })).toThrow(
      /cursor/u,
    );
    expect(() => events.list("other-merchant", { cursor: first.next_cursor! })).toThrow(/binding/u);
    db.close();
  });
});
