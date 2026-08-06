/**
 * Kiwi v1.1 Transaction Handoff（WP1）—— 域模型与授权接缝。
 *
 * 基线 §3.4 / §43：订单/支付发生在外部交易系统（UCP Checkout，business 是
 * Merchant of Record）；Kiwi 只做「非绑定共识 → 交易系统」的安全交接。本包只
 * 提供交接工件、交易系统适配接缝、AP2 授权接缝与完成门禁，不创建订单、不处理
 * 原始支付凭据、不实现真实 UCP Checkout / AP2（分别属于 WP2 / 外部系统）。
 */

export {
  HandoffError,
  HANDOFF_ERROR_CODES,
  type HandoffErrorCode,
} from "./errors.js";

export {
  HANDOFF_PACKAGE_VERSION,
  createHandoffPackage,
  verifyHandoffPackageDigest,
  isHandoffPackage,
  type HandoffIdentitySnapshot,
  type HandoffPackage,
  type HandoffPackageInput,
} from "./package.js";

export {
  HANDOFF_SESSION_STATUSES,
  ManualHandoffChannel,
  type HandoffChannel,
  type HandoffResult,
  type HandoffSession,
  type HandoffSessionStatus,
  type ManualHandoffChannelOptions,
} from "./channel.js";

export {
  CONFIRMATION_EVIDENCE_KINDS,
  FailClosedAuthorizationProvider,
  createPaymentAuthorization,
  createUserConfirmationEvidence,
  digestTerms,
  newAuthorizationId,
  type AuthorizeCheckoutInput,
  type AuthorizeCheckoutResult,
  type AuthorizationProvider,
  type ConfirmationEvidenceKind,
  type CreateIntentMandateInput,
  type CreateIntentMandateResult,
  type PaymentAuthorization,
  type PaymentAuthorizationInput,
  type UserConfirmationEvidence,
  type UserConfirmationEvidenceInput,
  type VerifyIntentMandateInput,
  type VerifyIntentMandateResult,
} from "./authorization.js";

export {
  COMPLETION_GATE_FAILURE_CODES,
  evaluateCompletionGate,
  isStructurallyValidAuthorization,
  type CompletionGateContext,
  type CompletionGateDecision,
  type CompletionGateFailureCode,
} from "./completion.js";
