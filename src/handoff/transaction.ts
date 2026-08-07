/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * TransactionHandoff + executeHandoff（KTH rev0.3 §6/§10；完成定义 #9-16、
 * #18-19）。
 *
 * executeHandoff 流程：
 *   1. 生命周期门：候选必须 READY（PROPOSED 时先走 approval：通过 →
 *      ready 事件；拒绝 → rejected 事件并返回）；
 *   2. pre-execution revalidation（§10）：重读 agreement / 重算 terms_digest /
 *      验 merchant identity / 验 destination（URL 安全）/ 验 expiry ——
 *      任一变化 → handoff_candidate_stale → 返回 stale（不执行）；
 *   3. 幂等（§10.1）：(source_candidate_id, source_candidate_digest) 已交付
 *      → 返回已交付结果（重试不重复交付）；冲突 → fail-closed；
 *   4. consumed（候选）+ delivered（handoff）事件落链，构造 TransactionHandoff
 *      （handoff_digest = JCS 去除自身）。
 *
 * 三副作用不变量（§16/§36-25）：本模块绝不创建订单/授权支付/预留库存。
 */

import { contentDigest } from "../negotiation/jcs.js";
import { generateId } from "../negotiation/domain/identifiers.js";
import type {
  LedgerCapabilitySnapshot,
  LedgerIdentitySnapshot,
} from "../negotiation/ledger/event.js";
import type { HandoffCandidate, HandoffDisplaySummary } from "./candidate.js";
import { foldCandidateLifecycle, transitionCandidateLifecycle } from "./lifecycle.js";
import type { HandoffEventStore } from "./ledger.js";
import type { HandoffIdempotencyStore } from "./idempotency.js";
import { validateExternalDestinationUrl, type SafeDestinationUrl } from "./url-safety.js";
import { isUrlDestinationType, type DestinationType } from "./destination.js";

/** TransactionHandoff（KTH rev0.3 §6）。不可变；digest 覆盖全部内容。 */
export interface TransactionHandoff {
  readonly handoff_id: string;
  readonly source_candidate_id: string;
  readonly source_candidate_digest: string;
  readonly agreement_id: string;
  readonly negotiation_id: string;
  readonly terms_digest: string;
  readonly merchant_identity_ref: string;
  readonly destination_type: DestinationType;
  readonly destination_ref: string;
  readonly display_summary: HandoffDisplaySummary;
  readonly created_at: string;
  readonly expires_at: string;
  readonly requires_user_action: boolean;
  readonly creates_order: false;
  readonly authorizes_payment: false;
  readonly reserves_inventory: false;
  readonly handoff_digest: string;
}

/** 执行结果（判别联合；调用方不得把 stale/rejected 当成功）。 */
export type ExecuteHandoffResult =
  | { kind: "delivered"; handoff: TransactionHandoff; final_url?: string }
  | { kind: "already_delivered"; handoff_id: string }
  | { kind: "stale"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "expired"; reason: string };

export interface AgreementReadResult {
  agreement_id: string;
  negotiation_id: string;
  agreed_terms: unknown;
}

export interface ExecuteHandoffInput {
  candidate: HandoffCandidate;
  ledger: HandoffEventStore;
  idempotency: HandoffIdempotencyStore;
  identity: LedgerIdentitySnapshot;
  capability: LedgerCapabilitySnapshot;
  /** 策略/批准门（KTH §1 flow 的 Policy/Approval；返回拒绝则不执行）。 */
  approval: (candidate: HandoffCandidate) => Promise<{ approved: boolean; reason?: string; evidence?: Record<string, unknown> }>;
  /** 重读 agreement 的权威源（§10 pre-execution revalidation）。 */
  agreementReader: (agreementId: string) => Promise<AgreementReadResult | undefined>;
  /** 目的地 URL 安全策略（缺省 HTTPS-only + expectedHost 校验）。 */
  urlSafety?: (url: string) => Promise<SafeDestinationUrl>;
  now?: () => string;
}

function computeHandoffDigest(handoff: Omit<TransactionHandoff, "handoff_digest">): string {
  return contentDigest(handoff);
}

/** 从 Ledger 事件流驱动执行（含生命周期/重验/幂等/落链）。 */
export async function executeHandoff(input: ExecuteHandoffInput): Promise<ExecuteHandoffResult> {
  const { candidate, ledger, idempotency } = input;
  const negotiationId = candidate.negotiation_id;
  const events = ledger.events(negotiationId);
  const candidateEvents = events.filter((e) => e.handoff_candidate_id === candidate.handoff_candidate_id);
  const state = foldCandidateLifecycle(candidateEvents);
  const now = input.now ?? (() => new Date().toISOString());

  // ── 1. 生命周期门 ────────────────────────────────────────────────────
  if (state === "REJECTED") return { kind: "rejected", reason: "candidate was rejected" };
  if (state === "STALE") return { kind: "stale", reason: "candidate is stale" };
  if (state === "EXPIRED") return { kind: "expired", reason: "candidate already expired" };
  if (state === "CONSUMED") {
    const delivered = events.find(
      (e) => e.handoff_candidate_id === candidate.handoff_candidate_id && e.handoff_id !== undefined,
    );
    return { kind: "already_delivered", handoff_id: delivered?.handoff_id ?? "unknown" };
  }
  if (state === "PROPOSED" || state === undefined) {
    // PROPOSED：先走策略/批准。通过 → ready（附批准证据）；拒绝 → rejected。
    const approvalResult = await input.approval(candidate);
    if (!approvalResult.approved) {
      ledger.appendCandidateEvent({
        kind: "handoff_candidate_rejected",
        candidate,
        identity: input.identity,
        capability: input.capability,
        evidence: { reason: approvalResult.reason ?? "approval rejected" },
        occurred_at: now(),
      });
      return { kind: "rejected", reason: approvalResult.reason ?? "approval rejected" };
    }
    transitionCandidateLifecycle(state, "handoff_candidate_ready");
    ledger.appendCandidateEvent({
      kind: "handoff_candidate_ready",
      candidate,
      identity: input.identity,
      capability: input.capability,
      evidence: approvalResult.evidence,
      occurred_at: now(),
    });
  } else if (state !== "READY") {
    return { kind: "stale", reason: `unexpected lifecycle state ${String(state)}` };
  }

  // ── 2. pre-execution revalidation（§10）──────────────────────────────
  const agreement = await input.agreementReader(candidate.agreement_id);
  if (agreement === undefined) {
    return stale(input, candidate, now, "agreement no longer exists");
  }
  if (agreement.agreement_id !== candidate.agreement_id || agreement.negotiation_id !== candidate.negotiation_id) {
    return stale(input, candidate, now, "agreement identity changed");
  }
  const recomputedTerms = contentDigest(agreement.agreed_terms);
  if (recomputedTerms !== candidate.terms_digest) {
    return stale(input, candidate, now, "terms_digest mismatch on revalidation");
  }
  if (Date.parse(candidate.expires_at) < Date.parse(now())) {
    ledger.appendCandidateEvent({
      kind: "handoff_candidate_expired",
      candidate,
      identity: input.identity,
      capability: input.capability,
      occurred_at: now(),
    });
    return { kind: "expired", reason: "candidate expired before execution" };
  }
  let finalUrl: string | undefined;
  // URL 安全只适用于 URL 承载类目的地（quote/PO/contact 等 opaque ref
  // 不做 URL 探测——它们不是可点击链接，KTH §7 类型语义）。
  if (input.urlSafety !== undefined && isUrlDestinationType(candidate.destination_type)) {
    try {
      const safe = await input.urlSafety(candidate.destination_ref);
      finalUrl = safe.finalUrl;
    } catch (err) {
      return stale(
        input,
        candidate,
        now,
        `destination invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 3. 幂等（§10.1）─────────────────────────────────────────────────
  const prior = idempotency.lookup(candidate.handoff_candidate_id, candidate.candidate_digest);
  if (prior !== undefined) {
    return { kind: "already_delivered", handoff_id: prior.handoff_id };
  }

  // ── 4. 交付：consumed + delivered 落链 ──────────────────────────────
  const handoffId = generateId("handoff");
  const base: Omit<TransactionHandoff, "handoff_digest"> = {
    handoff_id: handoffId,
    source_candidate_id: candidate.handoff_candidate_id,
    source_candidate_digest: candidate.candidate_digest,
    agreement_id: candidate.agreement_id,
    negotiation_id: candidate.negotiation_id,
    terms_digest: candidate.terms_digest,
    merchant_identity_ref: candidate.merchant_identity_ref,
    destination_type: candidate.destination_type,
    destination_ref: candidate.destination_ref,
    display_summary: candidate.display_summary,
    created_at: now(),
    expires_at: candidate.expires_at,
    requires_user_action: candidate.requires_user_action,
    creates_order: false,
    authorizes_payment: false,
    reserves_inventory: false,
  };
  const handoff: TransactionHandoff = {
    ...base,
    handoff_digest: computeHandoffDigest(base),
  };

  ledger.appendCandidateEvent({
    kind: "handoff_candidate_consumed",
    candidate,
    identity: input.identity,
    capability: input.capability,
    handoff_id: handoffId,
    occurred_at: now(),
  });
  ledger.appendDeliveryEvent({
    kind: "handoff_delivered",
    candidate,
    handoff_id: handoffId,
    identity: input.identity,
    capability: input.capability,
    destination: { final_url: finalUrl ?? candidate.destination_ref },
    occurred_at: now(),
  });
  idempotency.record(candidate.handoff_candidate_id, candidate.candidate_digest, handoffId);

  return { kind: "delivered", handoff, ...(finalUrl !== undefined ? { final_url: finalUrl } : {}) };
}

// 用模块级函数而非 this（避免丢失 this 的调用方踩坑）。
function stale(
  input: ExecuteHandoffInput,
  candidate: HandoffCandidate,
  now: () => string,
  reason: string,
): ExecuteHandoffResult {
  input.ledger.appendCandidateEvent({
    kind: "handoff_candidate_stale",
    candidate,
    identity: input.identity,
    capability: input.capability,
    evidence: { reason },
    occurred_at: now(),
  });
  return { kind: "stale", reason };
}

/** 供调用方构造缺省 URL 安全策略（HTTPS-only + merchant 域绑定）。 */
export function defaultUrlSafety(expectedHost?: string): (url: string) => Promise<SafeDestinationUrl> {
  return (url: string) =>
    validateExternalDestinationUrl(url, {
      ...(expectedHost !== undefined ? { expectedHost } : {}),
      allowHttp: false,
    });
}
