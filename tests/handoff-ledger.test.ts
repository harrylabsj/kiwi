/**
 * HandoffEventStore 测试（KTH rev0.3 §5.1/§12；完成定义 #18）。
 *
 * 覆盖：
 * - 候选生命周期事件落链 + eventsForCandidate 过滤；
 * - 交付观察事件 + eventsForHandoff；
 * - 链完整性：篡改检出（复用 LedgerStore verifyChain）；
 * - 禁词扫描：evidence 携带 secret 类 key → ledger_forbidden_content；
 * - 事件内容可重建候选（§18-13：lifecycle 从事件重建，不 mutate 候选）。
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HandoffEventStore,
  createHandoffCandidate,
  validateHandoffCandidate,
  type HandoffCandidate,
} from "../src/handoff/index.js";

const IDENTITY = {
  sender_identity: "principal:buyer-1",
  counterparty_identity: "merchant:acme",
  actor: "buyer" as const,
};
const CAPABILITY = {
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
};

function storeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "kiwi-handoff-"));
}

function candidate(): HandoffCandidate {
  return createHandoffCandidate({
    agreement_id: "agr_01JABC",
    negotiation_id: "neg_01JABC",
    agreed_terms: { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] },
    buyer_identity_ref: "principal:buyer-1",
    merchant_identity_ref: "merchant:acme",
    destination: { type: "external_checkout_url", ref: "https://acme.example/checkout/abc" },
    display_summary: { merchant: "Acme Merchant", summary: "200 units" },
    policy_version: "handoff-policy/1",
    expires_at: "2026-08-08T12:00:00Z",
  });
}

describe("HandoffEventStore", () => {
  it("候选生命周期事件落链并可过滤/投影", () => {
    const ledger = new HandoffEventStore({ dir: storeDir() });
    const c = candidate();
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY });

    const events = ledger.eventsForCandidate(c.negotiation_id, c.handoff_candidate_id);
    expect(events.map((e) => e.event_kind)).toEqual([
      "handoff_candidate_created",
      "handoff_candidate_ready",
    ]);
    expect(events[0]?.agreement_id).toBe("agr_01JABC");
    expect(events[0]?.terms_digest).toBe(c.terms_digest);
    expect(events[0]?.handoff_candidate_id).toBe(c.handoff_candidate_id);
  });

  it("交付观察事件绑定 handoff_id 并可过滤", () => {
    const ledger = new HandoffEventStore({ dir: storeDir() });
    const c = candidate();
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendDeliveryEvent({
      kind: "handoff_delivered",
      candidate: c,
      handoff_id: "hnd_01JABC",
      identity: IDENTITY,
      capability: CAPABILITY,
    });
    ledger.appendDeliveryEvent({
      kind: "handoff_launched",
      candidate: c,
      handoff_id: "hnd_01JABC",
      identity: IDENTITY,
      capability: CAPABILITY,
    });

    const handoffEvents = ledger.eventsForHandoff(c.negotiation_id, "hnd_01JABC");
    expect(handoffEvents.map((e) => e.event_kind)).toEqual(["handoff_delivered", "handoff_launched"]);
    expect(handoffEvents[0]?.handoff_id).toBe("hnd_01JABC");
  });

  it("OPENED_CONFIRMED 的 evidence 落链（可归属证据，KTH §9）", () => {
    const ledger = new HandoffEventStore({ dir: storeDir() });
    const c = candidate();
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendDeliveryEvent({
      kind: "handoff_delivered",
      candidate: c,
      handoff_id: "hnd_01JABC",
      identity: IDENTITY,
      capability: CAPABILITY,
    });
    ledger.appendDeliveryEvent({
      kind: "handoff_opened_confirmed",
      candidate: c,
      handoff_id: "hnd_01JABC",
      identity: IDENTITY,
      capability: CAPABILITY,
      evidence: { kind: "local_callback", handoff_id: "hnd_01JABC", at: "2026-08-07T10:00:00Z" },
    });

    const opened = ledger.eventsForHandoff(c.negotiation_id, "hnd_01JABC").find(
      (e) => e.event_kind === "handoff_opened_confirmed",
    );
    expect(opened?.evidence?.kind).toBe("local_callback");
    expect(opened?.evidence?.handoff_id).toBe("hnd_01JABC");
  });

  it("链完整性：篡改检出（verifyChain）", () => {
    const dir = storeDir();
    const ledger = new HandoffEventStore({ dir });
    const c = candidate();
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY });

    expect(ledger.verifyChain(c.negotiation_id).valid).toBe(true);

    const ledgerDir = path.join(dir, "ledger");
    const files = readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl"));
    const firstFile = files[0];
    if (firstFile === undefined) {
      throw new Error("no ledger file written");
    }
    const target = path.join(ledgerDir, firstFile);
    const lines = readFileSync(target, "utf-8").trim().split("\n");
    const firstLine = lines[0];
    if (firstLine === undefined) {
      throw new Error("ledger file is empty");
    }
    lines[0] = JSON.stringify({ ...JSON.parse(firstLine), terms_digest: "sha256:deadbeef" });
    writeFileSync(target, `${lines.join("\n")}\n`);

    const result = ledger.verifyChain(c.negotiation_id);
    expect(result.valid).toBe(false);
    expect(["tampered", "chain_break", "corrupt"]).toContain(result.error?.code);
  });

  it("事件内容可重建候选（§18-13：不 mutate 候选内容）", () => {
    const ledger = new HandoffEventStore({ dir: storeDir() });
    const c = candidate();
    const created = ledger.appendCandidateEvent({
      kind: "handoff_candidate_created",
      candidate: c,
      identity: IDENTITY,
      capability: CAPABILITY,
    });

    if (created.outcome.kind !== "ok" || created.outcome.result === undefined) {
      throw new Error("expected ok outcome with candidate result");
    }
    const embedded = created.outcome.result.candidate;
    const rebuilt = validateHandoffCandidate(embedded);
    expect(rebuilt.handoff_candidate_id).toBe(c.handoff_candidate_id);
    expect(rebuilt.candidate_digest).toBe(c.candidate_digest);
    // 重建与事件投影一致：created → PROPOSED。
    expect(ledger.eventsForCandidate(c.negotiation_id, c.handoff_candidate_id)).toHaveLength(1);
  });

  it("evidence 携带 secret 类 key → ledger_forbidden_content（禁词扫描）", () => {
    const ledger = new HandoffEventStore({ dir: storeDir() });
    const c = candidate();
    expect(() =>
      ledger.appendDeliveryEvent({
        kind: "handoff_delivered",
        candidate: c,
        handoff_id: "hnd_01JABC",
        identity: IDENTITY,
        capability: CAPABILITY,
        evidence: { api_key: "sk-live-123" },
      }),
    ).toThrow(/MUST NOT record evidence\.api_key/);
  });
});
