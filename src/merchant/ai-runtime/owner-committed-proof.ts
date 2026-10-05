/** Private committed WebAuthn adapter. A JSON label is never an execution capability. */
import { DatabaseSync } from "node:sqlite";
import { WorkbenchConfirmationStore } from "../../http/merchant-management/webauthn-confirmation.js";
import { WriteApprovalCandidateStore, contentHash } from "../../agent/merchant/action-candidate.js";
import { parseExactMoney } from "../application/money.js";
import { EXACT_PRODUCT_TOOLS } from "../exact-product-executors.js";
import type { OwnerOperatorProofBinding } from "./owner-business-proof-contract.js";

export interface OwnerBusinessBinding extends OwnerOperatorProofBinding {
  actorId: string;
  upstreamMerchantId: string;
  authoritySource: string;
  subjectSource: string;
  approvalGeneration: number;
  expiresAt: string;
  kind: typeof EXACT_PRODUCT_TOOLS.updateMoney;
  currency: string;
  amountMinor: string;
  currencyTableVersion: string;
  arguments: Record<string, unknown>;
  preconditions: Record<string, unknown>;
}
declare const brand: unique symbol;
export interface OwnerCommittedPermit {
  readonly [brand]: true;
}
export interface OwnerSubjectAuthority {
  source: string;
  /** Trusted registration/authorization authority, not an actor=principal default. */
  resolve(
    merchantId: string,
    actorId: string,
  ):
    | {
        principal: string;
        upstreamMerchantId: string;
        generation: number;
        expiresAt: string;
        revoked: boolean;
      }
    | undefined;
}
export class OwnerCommittedProofAuthority {
  private readonly permits = new WeakMap<object, OwnerBusinessBinding>();
  constructor(
    private readonly options: {
      confirmations: WorkbenchConfirmationStore;
      confirmationDb: DatabaseSync;
      candidates: WriteApprovalCandidateStore;
      subject: OwnerSubjectAuthority;
      merchantId: string;
      principal: string;
      authoritySource: string;
      now?: () => string;
    },
  ) {
    this.options = { ...options, subject: { ...options.subject } };
    if (
      !(options.confirmations instanceof WorkbenchConfirmationStore) ||
      !(options.confirmationDb instanceof DatabaseSync) ||
      !(options.candidates instanceof WriteApprovalCandidateStore) ||
      !options.subject.source ||
      !options.authoritySource ||
      options.candidates.ownerBinding?.merchantId !== options.merchantId ||
      options.candidates.ownerBinding?.principal !== options.principal
    )
      throw new Error("proof_authority_missing");
  }
  private verify(binding: OwnerBusinessBinding): void {
    const o = this.options;
    const now = Date.parse(o.now?.() ?? new Date().toISOString());
    const subject = o.subject.resolve(o.merchantId, binding.actorId);
    const candidate = o.candidates.get(binding.candidateId);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(Date.parse(binding.expiresAt)) ||
      Date.parse(binding.expiresAt) <= now ||
      !subject ||
      subject.revoked ||
      subject.principal !== o.principal ||
      subject.upstreamMerchantId !== binding.upstreamMerchantId ||
      subject.generation !== binding.approvalGeneration ||
      !Number.isFinite(Date.parse(subject.expiresAt)) ||
      Date.parse(subject.expiresAt) <= now ||
      binding.merchantId !== o.merchantId ||
      binding.principal !== o.principal ||
      binding.authoritySource !== o.authoritySource ||
      binding.subjectSource !== o.subject.source ||
      !binding.operationId ||
      !binding.actorId ||
      !binding.upstreamMerchantId ||
      !Number.isSafeInteger(binding.approvalGeneration) ||
      binding.approvalGeneration < 1 ||
      !Number.isSafeInteger(binding.expectedMoneyAuthorityVersion) ||
      binding.expectedMoneyAuthorityVersion < 1 ||
      !candidate ||
      !Number.isFinite(Date.parse(candidate.expires_at)) ||
      Date.parse(binding.expiresAt) > Date.parse(candidate.expires_at) ||
      candidate.principal_id !== o.principal ||
      candidate.tool !== EXACT_PRODUCT_TOOLS.updateMoney ||
      binding.kind !== candidate.tool ||
      contentHash(candidate.arguments) !== contentHash(binding.arguments) ||
      contentHash(candidate.preconditions) !== contentHash(binding.preconditions) ||
      binding.actionDigest !==
        contentHash({ arguments: candidate.arguments, preconditions: candidate.preconditions }) ||
      !o.confirmations.hasUsableCredential(o.merchantId, binding.actorId) ||
      !o.confirmations.verifyCommittedDecision({
        operationId: binding.operationId,
        candidateId: binding.candidateId,
        actorId: binding.actorId,
        decision: "approve",
        actionDigest: binding.actionDigest,
      })
    )
      throw new Error("committed_proof_invalid");
    const money = parseExactMoney(binding.arguments.money, { requireOperatingSupport: true });
    if (
      binding.arguments.sku !== binding.sku ||
      binding.arguments.expected_authority_version !== binding.expectedMoneyAuthorityVersion ||
      money.currency !== binding.currency ||
      money.amount_minor !== binding.amountMinor ||
      money.currency_table_version !== binding.currencyTableVersion ||
      binding.preconditions.merchant_id !== binding.merchantId ||
      binding.preconditions.principal !== binding.principal ||
      binding.preconditions.sku !== binding.sku ||
      binding.preconditions.authority_version !== binding.expectedMoneyAuthorityVersion ||
      binding.preconditions.currency !== binding.currency ||
      binding.preconditions.currency_table_version !== binding.currencyTableVersion
    )
      throw new Error("proof_target_mismatch");
    const committed = o.confirmationDb
      .prepare(
        `
      SELECT d.merchant_id, d.actor_id, d.candidate_id, d.approval_generation, d.action_digest,
             r.expected_version, r.expires_at, r.consumed_at, r.operation_id,
             r.merchant_id request_merchant, r.actor_id request_actor, r.candidate_id request_candidate,
             r.approval_generation request_generation, r.action_digest request_digest, r.decision request_decision
      FROM workbench_approval_decisions d JOIN workbench_confirmation_requests r ON r.confirmation_id=d.confirmation_id
      WHERE d.operation_id=? AND d.decision='approve'`,
      )
      .get(binding.operationId) as Record<string, unknown> | undefined;
    if (
      !committed ||
      committed.merchant_id !== binding.merchantId ||
      committed.actor_id !== binding.actorId ||
      committed.candidate_id !== binding.candidateId ||
      committed.approval_generation !== binding.approvalGeneration ||
      committed.action_digest !== binding.actionDigest ||
      committed.expected_version !== binding.expectedMoneyAuthorityVersion ||
      committed.operation_id !== binding.operationId ||
      committed.request_merchant !== binding.merchantId ||
      committed.request_actor !== binding.actorId ||
      committed.request_candidate !== binding.candidateId ||
      committed.request_generation !== binding.approvalGeneration ||
      committed.request_digest !== binding.actionDigest ||
      committed.request_decision !== "approve" ||
      typeof committed.consumed_at !== "string" ||
      committed.expires_at !== binding.expiresAt
    )
      throw new Error("committed_record_binding_mismatch");
    // Snapshot is read from the actual committed transaction, never caller evidence.
    const stored = o.confirmations.authorizationSnapshotForOperation(binding.operationId);
    if (contentHash(stored) !== contentHash(binding)) throw new Error("proof_snapshot_mismatch");
  }
  issue(operationId: string): OwnerCommittedPermit {
    const data = this.options.confirmations.authorizationSnapshotForOperation(operationId);
    if (!data || data.operationId !== operationId) throw new Error("committed_snapshot_missing");
    const binding = structuredClone(data) as unknown as OwnerBusinessBinding;
    this.verify(binding);
    // Only a real committed approve may transition the pending owner candidate.
    if (this.options.candidates.get(binding.candidateId)?.status === "pending_approval")
      this.options.candidates.markApproved(binding.candidateId);
    const permit = Object.freeze({}) as OwnerCommittedPermit;
    this.permits.set(permit, binding);
    return permit;
  }
  inspect(permit: OwnerCommittedPermit): OwnerBusinessBinding {
    const binding = this.permits.get(permit);
    if (!binding) throw new Error("committed_permit_required");
    this.verify(binding);
    return structuredClone(binding);
  }
  assertClaimed(binding: OwnerBusinessBinding): void {
    this.verify(binding);
    if (
      this.options.candidates.get(binding.candidateId)?.status !== "approved" ||
      this.options.candidates.executionWasClaimed(binding.candidateId) !== true
    )
      throw new Error("candidate_not_claimed");
  }
  verifyPersisted(binding: OwnerBusinessBinding): void {
    this.verify(binding);
  }
}
