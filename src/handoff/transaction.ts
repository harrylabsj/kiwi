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

import { HandoffError } from "./errors.js";
import { contentDigest, sha256Hex } from "../negotiation/jcs.js";
import { assertNoForbiddenContent } from "../negotiation/ledger/event.js";
import { generateId } from "../negotiation/domain/identifiers.js";
import { CommerceError } from "../commerce/data-source.js";
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
  /** 目的地探测瞬时失败（超时/网络/HEAD 405）：候选保持 READY，可重试。 */
  | { kind: "probe_failed"; reason: string }
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

/**
 * 审查 P1-06：执行锁作用域按 **destination**——同一 (agreement_id,
 * destination_type, destination_ref) 的任何候选共享同一把锁。此前按
 * candidate_id 加锁，两个**不同候选**指向同一 destination 时并发执行会双双
 * 通过 §10.1 协议级去重（check-then-act，双方都还没交付）→ 双投递到同一
 * 目的地。destination 级锁把这些执行串行化：第二个看到首个的 delivered 事件
 * → already_delivered。同一候选必然落在同一 destination 锁上，候选级幂等
 * （§10.1 lookup→record）同样被保护。
 *
 * 锁键：`dest:<agreement_id>:<destination_type>:<sha256(ref) 前 16>`——ref 可能
 * 是长 URL，直接进文件名会超出文件系统 255 字节限制，取定长哈希。
 */
export function destinationLockKey(candidate: {
  agreement_id: string;
  destination_type: string;
  destination_ref: string;
}): string {
  const refHash = sha256Hex(candidate.destination_ref).slice(0, 16);
  return `dest:${candidate.agreement_id}:${candidate.destination_type}:${refHash}`;
}

/**
 * 从 Ledger 事件流驱动执行（含生命周期/重验/幂等/落链）。
 * 整个流程按 destination 互斥（§10.1 并发保护 + 审查 P1-06）：lookup→(await)
 * →record 的 check-then-act 在无锁时两个并发执行会双双通过幂等检查、同一候选
 * 交付两次；不同候选指向同一 destination 也会双双通过协议级去重。锁在幂等
 * 存储上（JSONL 与锁文件同目录，跨进程共享 dir 时同样互斥）。
 */
export async function executeHandoff(input: ExecuteHandoffInput): Promise<ExecuteHandoffResult> {
  return input.idempotency.withCandidateLock(
    destinationLockKey(input.candidate),
    () => executeHandoffUnlocked(input),
  );
}

async function executeHandoffUnlocked(input: ExecuteHandoffInput): Promise<ExecuteHandoffResult> {
  const { candidate, ledger, idempotency } = input;
  // 惰性清理（评审项 L2）：prune 此前无调用方——幂等行永久保留，磁盘随
  // 候选数无界增长。执行是低频操作，顺带清理过期行（保留期 ≥7 天不变）。
  try {
    idempotency.prune();
  } catch {
    // 清理失败不影响执行（fail-safe 方向；下次执行再试）。
  }
  const negotiationId = candidate.negotiation_id;
  const events = ledger.events(negotiationId);
  const candidateEvents = events.filter((e) => e.handoff_candidate_id === candidate.handoff_candidate_id);
  const state = foldCandidateLifecycle(candidateEvents);
  const now = input.now ?? (() => new Date().toISOString());

  // ── 0.5 幂等（§10.1）─────────────────────────────────────────────────
  // 候选级幂等优先于 H3 目标级去重：同候选同 digest → already_delivered；
  // 同候选**异 digest**（内容篡改/重建不匹配）→ handoff_idempotency_conflict
  // fail-closed，绝不放行二次交付（KTH §10.1 具名错误）。
  const prior = idempotency.lookup(candidate.handoff_candidate_id, candidate.candidate_digest);
  if (prior !== undefined) {
    if (prior.status === "conflict") {
      throw new HandoffError(
        "handoff_idempotency_conflict",
        `handoff candidate ${candidate.handoff_candidate_id} was already delivered with a different digest; refusing execution (content tampering or rebuild mismatch)`,
      );
    }
    return { kind: "already_delivered", handoff_id: prior.handoff_id };
  }

  // ── 0.6 协议级去重（评审项 H3）──────────────────────────────────────
  // 同一 (agreement_id, destination_type, destination_ref) 已交付过 →
  // already_delivered。创建期检查（buyer-tools priorDelivery）拦不住双候选
  // 双批准：候选 A 创建时 B 尚未交付，两者都通过创建期检查；执行期幂等键
  // (candidate_id, digest) 对每个候选都是新键。以链上事实为准——第一个
  // 交付落链后，任何后续候选执行（含不同候选并发执行）都命中此检查，
  // 且不触发无谓的 approval/重验。
  const priorDestination = events.find(
    (e) =>
      e.event_kind === "handoff_delivered" &&
      e.agreement_id === candidate.agreement_id &&
      (e.destination as { type?: unknown } | undefined)?.type === candidate.destination_type &&
      (e.destination as { ref?: unknown } | undefined)?.ref === candidate.destination_ref,
  );
  if (priorDestination !== undefined) {
    return { kind: "already_delivered", handoff_id: priorDestination.handoff_id ?? "unknown" };
  }

  // ── 1. 生命周期门 ────────────────────────────────────────────────────
  if (state === "REJECTED") return { kind: "rejected", reason: "candidate was rejected" };
  if (state === "STALE") return { kind: "stale", reason: "candidate is stale" };
  if (state === "EXPIRED") return { kind: "expired", reason: "candidate already expired" };
  if (state === "CONSUMED") {
    const consumed = events.find(
      (e) => e.handoff_candidate_id === candidate.handoff_candidate_id && e.handoff_id !== undefined,
    );
    const handoffId = consumed?.handoff_id ?? "unknown";
    // 中间态恢复（评审项 M1）：consumed 已落、delivered 缺失（两次 append
    // 之间崩溃）时，补落 delivered + 幂等记录——否则重试永远报"已交付"
    // 但审计链上无交付证据（deliveryState 投影 undefined、metrics 缺失、
    // TUI 列表显示 delivery "?"）。恢复的 delivered 以候选 destination_ref
    // 为兜底（首次执行的 URL 探测结果已不可得；type/ref 是候选审计事实，
    // final_url 是展示字段，缺失可接受）。
    const deliveredExists = events.some(
      (e) => e.event_kind === "handoff_delivered" && e.handoff_id === handoffId,
    );
    if (!deliveredExists && handoffId !== "unknown") {
      ledger.appendDeliveryEvent({
        kind: "handoff_delivered",
        candidate,
        handoff_id: handoffId,
        identity: input.identity,
        capability: input.capability,
        destination: { final_url: candidate.destination_ref },
        occurred_at: now(),
      });
      idempotency.record(candidate.handoff_candidate_id, candidate.candidate_digest, handoffId);
    }
    return { kind: "already_delivered", handoff_id: handoffId };
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
  // fail-closed 过期门：不可解析的时间戳（Date.parse 为 NaN）绝不视为
  // "未过期"——NaN < x 恒 false 会让候选永不过期直接交付。与 completion.ts
  // 的守卫一致：NaN 一律按过期处理。
  const expiresMs = Date.parse(candidate.expires_at);
  const nowMs = Date.parse(now());
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs) || expiresMs < nowMs) {
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
      // 瞬时探测失败（超时/网络/HEAD 405）可重试，不置终态 STALE（评审项
      // M2：此前一次 15s 超时即永久废掉候选——目的地内容并未变化，断网期间
      // 每次重试都新建候选再置 stale，候选/事件堆积）。安全拒绝（scheme/
      // host/DNS 保留网段 → invalid_input）仍是终态——内容确实不可用。
      if (err instanceof CommerceError && err.code === "request_failed") {
        // 审查 P2-F：交付失败在 handoff 创建前落 handoff_delivery_failed
        // 审计事件（KTH rev0.3 §9）。此前该 kind 无状态映射，append 必抛
        // schemaError，失败交付审计缺失（3 处声明、0 处产生）。
        ledger.append({
          kind: "handoff_delivery_failed",
          candidate,
          identity: input.identity,
          capability: input.capability,
          outcome: {
            kind: "error",
            code: "request_failed",
            message: err.message,
          },
          occurred_at: now(),
        });
        return { kind: "probe_failed", reason: err.message };
      }
      return stale(
        input,
        candidate,
        now,
        `destination invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  // 预检（评审项 M1 加固）：consumed 落链前先验证 delivered 内容可落账
  //（禁词扫描）。若 delivered 因 ledger_forbidden_content 失败，此时 consumed
  // 已落链，会形成"已消费但无交付证据"的中间态（恢复路径虽能补，但可预
  // 见的失败应发生在 consumed 之前）。
  const deliveredDestination: Record<string, unknown> = {
    type: candidate.destination_type,
    ref: candidate.destination_ref,
    ...(finalUrl !== undefined ? { final_url: finalUrl } : {}),
  };
  assertNoForbiddenContent(deliveredDestination, "destination");

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
