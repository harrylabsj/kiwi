/**
 * KTH 交付观察状态测试（rev0.3 §9；完成定义 #19、完成标准 12）。
 *
 * 覆盖：
 * - DELIVERED → LAUNCHED 迁移；LAUNCHED 不代表页面加载（§36-28）；
 * - OPENED_CONFIRMED 证据门：四类允许证据，无证据的 launch 永不
 *   OPENED_CONFIRMED；证据 handoff_id 不匹配拒绝；
 * - 非法证据种类（button-click/openURL 成功/计时/UA 猜测）拒绝；
 * - deliveryState 从 Ledger 事件投影；终态不可逆。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HandoffEventStore,
  createHandoffCandidate,
  deliveryState,
  recordLaunch,
  recordOpenEvidence,
  validateOpenEvidence,
  type HandoffCandidate,
} from "../src/handoff/index.js";

const IDENTITY = { sender_identity: "principal:buyer-1", counterparty_identity: "merchant:acme", actor: "buyer" as const };
const CAPABILITY = { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" };

function store(): HandoffEventStore {
  return new HandoffEventStore({ dir: mkdtempSync(path.join(tmpdir(), "kiwi-delivery-")) });
}

function candidate(): HandoffCandidate {
  return createHandoffCandidate({
    agreement_id: "agr_01JABC",
    negotiation_id: "neg_01JABC",
    agreed_terms: { items: [] },
    destination: { type: "external_checkout_url", ref: "https://acme.example/checkout/abc" },
    display_summary: { merchant: "Acme", summary: "200 units" },
    policy_version: "handoff-policy/1",
    expires_at: "2026-08-08T12:00:00Z",
  });
}

function deliveredDeps(ledger: HandoffEventStore, c: HandoffCandidate, handoffId: string) {
  return { ledger, candidate: c, handoff_id: handoffId, identity: IDENTITY, capability: CAPABILITY };
}

describe("deliveryState 投影", () => {
  it("DELIVERED → LAUNCHED 迁移（事件驱动）", () => {
    const ledger = store();
    const c = candidate();
    ledger.appendDeliveryEvent({ kind: "handoff_delivered", candidate: c, handoff_id: "hnd_01", identity: IDENTITY, capability: CAPABILITY });
    expect(deliveryState(ledger.eventsForHandoff(c.negotiation_id, "hnd_01"))).toBe("DELIVERED");
    ledger.appendDeliveryEvent({ kind: "handoff_launched", candidate: c, handoff_id: "hnd_01", identity: IDENTITY, capability: CAPABILITY });
    expect(deliveryState(ledger.eventsForHandoff(c.negotiation_id, "hnd_01"))).toBe("LAUNCHED");
  });

  it("候选事件不影响交付状态", () => {
    const ledger = store();
    const c = candidate();
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    expect(deliveryState(ledger.eventsForCandidate(c.negotiation_id, c.handoff_candidate_id))).toBeUndefined();
  });
});

describe("OPENED_CONFIRMED 证据门", () => {
  it("四类允许证据均可触发 OPENED_CONFIRMED", () => {
    for (const kind of ["local_callback", "merchant_callback", "platform_callback", "verified_return_uri"] as const) {
      const ledger = store();
      const c = candidate();
      const deps = deliveredDeps(ledger, c, "hnd_01");
      ledger.appendDeliveryEvent({
        kind: "handoff_delivered",
        candidate: c,
        handoff_id: "hnd_01",
        identity: IDENTITY,
        capability: CAPABILITY,
      });
      recordLaunch(deps);
      recordOpenEvidence({ ...deps, evidence: { kind, handoff_id: "hnd_01", at: "2026-08-07T10:00:00Z" } });
      expect(deliveryState(ledger.eventsForHandoff(c.negotiation_id, "hnd_01"))).toBe("OPENED_CONFIRMED");
    }
  });

  it("无证据的 launch 永不成为 OPENED_CONFIRMED", () => {
    const ledger = store();
    const c = candidate();
    recordLaunch(deliveredDeps(ledger, c, "hnd_01"));
    expect(deliveryState(ledger.eventsForHandoff(c.negotiation_id, "hnd_01"))).toBe("LAUNCHED");
  });

  it("非证据推断（button click / openURL 成功 / 计时 / UA 猜测）拒绝", () => {
    for (const bogus of ["button_click", "openurl_success", "elapsed_timer", "ua_guess"]) {
      expect(() =>
        validateOpenEvidence({ kind: bogus, handoff_id: "hnd_01", at: "2026-08-07T10:00:00Z" }),
      ).toThrow(/unsupported open evidence kind/);
    }
  });

  it("证据 handoff_id 与交付不匹配 → 拒绝（防跨 handoff 冒用）", () => {
    const ledger = store();
    const c = candidate();
    expect(() =>
      recordOpenEvidence({
        ...deliveredDeps(ledger, c, "hnd_01"),
        evidence: { kind: "local_callback", handoff_id: "hnd_EVIL", at: "2026-08-07T10:00:00Z" },
      }),
    ).toThrow(/does not match/);
  });

  it("证据时间戳必须 RFC 3339", () => {
    expect(() =>
      validateOpenEvidence({ kind: "local_callback", handoff_id: "hnd_01", at: "yesterday" }),
    ).toThrow(/timestamp|RFC 3339/);
  });
});
