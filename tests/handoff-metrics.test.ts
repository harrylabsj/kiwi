/**
 * computeHandoffMetrics 测试（架构 rev1.4.1 §35A.8 / 完成定义 #21）。
 *
 * 覆盖：
 * - 空事件 → 全 0 率、time_to_handoff null；
 * - 正常链路 → agreement_to_handoff_rate=1、launch/opened 率、中位时长；
 * - 部分转化 → 0.5 率（2 协议 1 交付）；
 * - reported_external_conversion 恒 null（无权威交易集成，§17 标注）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HandoffEventStore,
  HandoffIdempotencyStore,
  computeHandoffMetrics,
  createHandoffCandidate,
  executeHandoff,
  type MarketplaceListingSnapshot,
} from "../src/handoff/index.js";
import { buildMarketplaceSourceBinding } from "../src/handoff/launch-marketplace-policy.js";

const IDENTITY = { sender_identity: "principal:buyer-1", counterparty_identity: "merchant:acme", actor: "buyer" as const };
const CAPABILITY = { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" };
const NOW = "2026-08-07T09:00:00Z";
const AGREED = { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] };
// A651 包四强制门：URL 目的地用三平台形态 + 可信 listing/context fixture
// （原交付断言保留；opaque 平台 ID ≠ 协议 SKU）。
const DEST_REF = "https://item.taobao.com/item.htm?id=100301440825";
const TRUSTED_LISTING: MarketplaceListingSnapshot = {
  listing_id: "list-001",
  listing_type: "product",
  owner_agent_id: "acme-owner",
  merchant_id: "merchant-acme",
  source_product_ref: "SKU-001",
  handoff_destination_ref: DEST_REF,
  listing_digest: "digest-001",
  publication_state: "ACTIVE",
  listing_freshness_state: "FRESH",
  fresh_until: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

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
    destination: { type: "external_checkout_url", ref: DEST_REF },
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
    launchContext: {
      binding: buildMarketplaceSourceBinding({
        catalogOrigin: "https://catalog.test",
        listing: TRUSTED_LISTING,
        taskId: `task-${negotiationId}`,
        negotiationId: c.negotiation_id,
        agreementId: c.agreement_id,
        termsDigest: c.terms_digest,
        candidateDigest: c.candidate_digest,
        observedAt: NOW,
      }),
      readSource: async () => TRUSTED_LISTING,
      catalogOrigin: "https://catalog.test",
      taskId: `task-${negotiationId}`,
      agreedSku: "SKU-001",
      ownerAgentId: "acme-owner",
    },
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
    const dir = trackedMkdtemp("kiwi-metrics-");
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
    const dir = trackedMkdtemp("kiwi-metrics-");
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
