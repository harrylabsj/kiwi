/** Design-only private seam. No issuer, executor, approval or receipt implementation. */
export interface OwnerOperatorProofBinding {
  readonly operationId: string;
  readonly merchantId: string;
  readonly principal: string;
  readonly candidateId: string;
  readonly actionDigest: string;
  readonly sku: string;
  readonly expectedMoneyAuthorityVersion: number;
}
/** Future host verifier must verify real committed WebAuthn evidence; JSON labels grant nothing. */
export interface OwnerCommittedProofVerifier {
  verify(binding: OwnerOperatorProofBinding, evidence: unknown): Promise<boolean>;
}
export type OwnerAuthoritativeReceipt =
  | {
      readonly status: "unknown";
      readonly reason: "not_found" | "unavailable" | "binding_mismatch" | "incomplete";
    }
  | {
      readonly status: "applied";
      readonly binding: OwnerOperatorProofBinding;
      readonly resultingMoneyAuthorityVersion: number;
    };
/** 404 maps to unknown, never not_applied. No write/double-claim method is defined. */
export interface OwnerAsyncReceiptReader {
  read(binding: OwnerOperatorProofBinding): Promise<OwnerAuthoritativeReceipt>;
}
