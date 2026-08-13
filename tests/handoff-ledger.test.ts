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
import {mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  return trackedMkdtemp("kiwi-handoff-");
}

function candidate(overrides: Partial<Parameters<typeof createHandoffCandidate>[0]> = {}): HandoffCandidate {
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
    ...overrides,
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

  it("惰性过期清扫：过期候选落 expired 事件，未过期/已终态不受影响（评审项 L1）", () => {
    const ledger = new HandoffEventStore({ dir: storeDir() });
    const expired = candidate(); // expires_at 2026-08-08
    const fresh = candidate({ expires_at: "2099-01-01T00:00:00Z" });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: expired, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: fresh, identity: IDENTITY, capability: CAPABILITY });
    // 已终态候选（CONSUMED）不受清扫影响
    const consumed = candidate();
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: consumed, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_consumed", candidate: consumed, identity: IDENTITY, capability: CAPABILITY, handoff_id: "hnd_01" });

    const swept = ledger.sweepExpiredCandidates("2026-08-09T00:00:00Z");
    expect(swept).toBe(1); // 只有 expired 候选
    expect(
      ledger.eventsForCandidate(expired.negotiation_id, expired.handoff_candidate_id).map((e) => e.event_kind),
    ).toContain("handoff_candidate_expired");
    // 未过期与已终态：无 expired 事件
    expect(
      ledger.eventsForCandidate(fresh.negotiation_id, fresh.handoff_candidate_id).some((e) => e.event_kind === "handoff_candidate_expired"),
    ).toBe(false);
    expect(
      ledger.eventsForCandidate(consumed.negotiation_id, consumed.handoff_candidate_id).some((e) => e.event_kind === "handoff_candidate_expired"),
    ).toBe(false);

    // 幂等：再次清扫不重复落链
    expect(ledger.sweepExpiredCandidates("2026-08-10T00:00:00Z")).toBe(0);
  });

  it("K-M13: 链损坏时过期清扫 fail-closed（抛错而非静默吞掉）", () => {
    const dir = storeDir();
    const ledger = new HandoffEventStore({ dir });
    const expired = candidate(); // expires_at 过去
    ledger.appendCandidateEvent({
      kind: "handoff_candidate_created",
      candidate: expired,
      identity: IDENTITY,
      capability: CAPABILITY,
    });
    // 篡改链（改首行字段）→ 下次 append 走 verifyChain 抛 ledger_chain_corrupt
    const ledgerDir = path.join(dir, "ledger");
    const files = readdirSync(ledgerDir).filter((f) => f.endsWith(".jsonl"));
    const target = path.join(ledgerDir, files[0]!);
    const lines = readFileSync(target, "utf-8").trim().split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), terms_digest: "sha256:deadbeef" });
    writeFileSync(target, `${lines.join("\n")}\n`);
    // K-M13 修复前：空 catch 静默吞掉，候选永久停在中间态且无日志；
    // 修复后：链损坏类错误 fail-closed 抛出。
    expect(() => ledger.sweepExpiredCandidates("2026-08-09T00:00:00Z")).toThrow();
  });
});

/** 评审项 L6：mkdtemp 目录跟踪清理（此前每次运行在 /tmp 残留）。 */
const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sweepExpiredHandoffs（审查 P3：delivery 域 EXPIRED 发射）", () => {
  it("DELIVERED/LAUNCHED 且打开时限已过的 handoff 落 handoff_expired", () => {
    const ledger = new HandoffEventStore({ dir: storeDir(), now: () => "2026-08-09T00:00:00Z" });
    const expired = candidate(); // expires_at 2026-08-08T12:00:00Z（已过）
    const fresh = candidate({ expires_at: "2026-08-10T00:00:00Z" }); // 未过
    for (const c of [expired, fresh]) {
      ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY });
      ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY });
      ledger.appendDeliveryEvent({
        kind: "handoff_delivered",
        candidate: c,
        handoff_id: c.handoff_candidate_id,
        identity: IDENTITY,
        capability: CAPABILITY,
        destination: { final_url: "https://acme.example/checkout/abc" },
      });
    }
    // OPENED_CONFIRMED（已确认打开，不再适用打开时限）不应被清扫
    const confirmed = candidate({ expires_at: "2026-08-08T12:00:00Z" });
    ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: confirmed, identity: IDENTITY, capability: CAPABILITY });
    ledger.appendDeliveryEvent({
      kind: "handoff_delivered",
      candidate: confirmed,
      handoff_id: confirmed.handoff_candidate_id,
      identity: IDENTITY,
      capability: CAPABILITY,
      destination: { final_url: "https://acme.example/checkout/def" },
    });
    ledger.appendDeliveryEvent({
      kind: "handoff_opened_confirmed",
      candidate: confirmed,
      handoff_id: confirmed.handoff_candidate_id,
      identity: IDENTITY,
      capability: CAPABILITY,
      evidence: { kind: "local_callback", handoff_id: confirmed.handoff_candidate_id, at: "2026-08-07T10:00:00Z" },
    });

    const swept = ledger.sweepExpiredHandoffs("2026-08-09T00:00:00Z");
    expect(swept).toBe(1); // 只有过期且未确认打开的 delivered
    const events = ledger.events(expired.negotiation_id);
    const expiredEvent = events.filter(
      (e) => e.event_kind === "handoff_expired" && e.handoff_id === expired.handoff_candidate_id,
    );
    expect(expiredEvent).toHaveLength(1);
    expect(
      events.some(
        (e) => e.event_kind === "handoff_expired" && e.handoff_id === fresh.handoff_candidate_id,
      ),
    ).toBe(false);
    expect(
      events.some(
        (e) => e.event_kind === "handoff_expired" && e.handoff_id === confirmed.handoff_candidate_id,
      ),
    ).toBe(false);

    // 幂等：已终态（EXPIRED）不再重复清扫
    expect(ledger.sweepExpiredHandoffs("2026-08-10T00:00:00Z")).toBe(0);
  });
});
