/**
 * computeHandoffMetrics 测试（架构 rev1.4.1 §35A.8 / 完成定义 #21）。
 *
 * 覆盖：
 * - 空事件 → 全 0 率、time_to_handoff null；
 * - 正常链路 → agreement_to_handoff_rate=1、launch/opened 率、中位时长；
 * - 部分转化 → 0.5 率（2 协议 1 交付）；
 * - reported_external_conversion 恒 null（无权威交易集成，§17 标注）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HandoffEventStore,
  HandoffIdempotencyStore,
  computeHandoffMetrics,
  createHandoffCandidate,
  executeHandoff,
} from "../src/handoff/index.js";

const IDENTITY = { sender_identity: "principal:buyer-1", counterparty_identity: "merchant:acme", actor: "buyer" as const };
const CAPABILITY = { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" };
const NOW = "2026-08-07T09:00:00Z";
const AGREED = { items: [] };

function env(dir: string) {
  return {
    ledger: new HandoffEventStore({ dir, now: () => NOW }),
    idempotency: new HandoffIdempotencyStore({ dir, now: () => NOW }),
  };
}

function candidate(negotiationId: string) {
  return createHandoffCandidate({
    agreement_id: `agr_${negotiationId}`,
    negotiation_id: negotiationId,
    agreed_terms: AGREED,
    destination: { type: "external_checkout_url", ref: "https://acme.example/checkout/1" },
    display_summary: { merchant: "Acme", summary: "200 units" },
    policy_version: "handoff-policy/1",
    expires_at: "2026-08-08T12:00:00Z",
  });
}

async function deliver(dir: string, negotiationId: string): Promise<void> {
  const e = env(dir);
  const c = candidate(negotiationId);
  e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
  e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
  await executeHandoff({
    candidate: c,
    ledger: e.ledger,
    idempotency: e.idempotency,
    identity: IDENTITY,
    capability: CAPABILITY,
    approval: async () => ({ approved: true }),
    agreementReader: async () => ({ agreement_id: c.agreement_id, negotiation_id: c.negotiation_id, agreed_terms: AGREED }),
    now: () => NOW,
  });
}

function collect(dir: string) {
  const ledger = new HandoffEventStore({ dir, now: () => NOW });
  const byNegotiation = new Map<string, ReturnType<HandoffEventStore["events"]>>();
  for (const nid of ledger.listNegotiations()) byNegotiation.set(nid, ledger.events(nid));
  return computeHandoffMetrics(byNegotiation);
}

describe("computeHandoffMetrics", () => {
  it("空事件 → 全 0 率、time_to_handoff null、external conversion null", () => {
    const metrics = computeHandoffMetrics(new Map());
    expect(metrics.candidates_created).toBe(0);
    expect(metrics.agreement_to_handoff_rate).toBe(0);
    expect(metrics.time_to_handoff_seconds).toBeNull();
    expect(metrics.reported_external_conversion).toBeNull();
  });

  it("1 协议 1 交付 → 全 1 率 + launch/opened 率", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-metrics-"));
    await deliver(dir, "neg_1");
    const metrics = collect(dir);
    expect(metrics.negotiations_with_candidates).toBe(1);
    expect(metrics.candidates_created).toBe(1);
    expect(metrics.handoffs_delivered).toBe(1);
    expect(metrics.agreement_to_handoff_rate).toBe(1);
    expect(metrics.negotiation_to_handoff_rate).toBe(1);
    expect(metrics.handoff_launch_rate).toBe(0);
    expect(metrics.opened_confirmed_rate).toBe(0);
    expect(metrics.time_to_handoff_seconds).toBe(0); // created 与 delivered 同刻
    expect(metrics.reported_external_conversion).toBeNull();
  });

  it("2 协议 1 交付 → 0.5 率；launch 不计 opened", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-metrics-"));
    await deliver(dir, "neg_1");
    const e = env(dir);
    const c = candidate("neg_2");
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    const metrics = collect(dir);
    expect(metrics.candidates_created).toBe(2);
    expect(metrics.handoffs_delivered).toBe(1);
    expect(metrics.agreement_to_handoff_rate).toBe(0.5);
    expect(metrics.negotiation_to_handoff_rate).toBe(0.5);
  });
});
