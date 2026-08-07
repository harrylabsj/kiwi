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
 * Kiwi v1.1 Transaction Handoff（WP1）—— 域模型与授权接缝。
 *
 * 基线 §3.4 / §43：订单/支付发生在外部交易系统（UCP Checkout，business 是
 * Merchant of Record）；Kiwi 只做「非绑定共识 → 交易系统」的安全交接。本包只
 * 提供交接工件、交易系统适配接缝、AP2 授权接缝与完成门禁，不创建订单、不处理
 * 原始支付凭据、不实现真实 UCP Checkout / AP2（分别属于 WP2 / 外部系统）。
 *
 * 两层关系（术语对齐决策，KTH rev0.3）：
 *   外层 —— KTH 候选链：Agreement → HandoffCandidate（candidate.ts，
 *   不可变 + event-sourced 生命周期 lifecycle.ts/ledger.ts）→ 交付观察
 *   （delivery 状态，Phase 2）。
 *   内层 —— UCP checkout session 适配：HandoffPackage/HandoffSession/
 *   HandoffChannel（package.ts/channel.ts，v1.0 WP1 工件，不重命名保留）。
 *   `ucp_checkout`/`ucp_order` 目的地走内层；URL/PO/quote/contact 目的地
 *   走外层交付。
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

// ── KTH/0.1 rev0.3（v1.1 WP-C1）──────────────────────────────────────────

export {
  DESTINATION_TYPES,
  isDestinationType,
  validateDestination,
  type Destination,
  type DestinationType,
} from "./destination.js";

export {
  computeCandidateDigest,
  createHandoffCandidate,
  isHandoffCandidate,
  validateHandoffCandidate,
  verifyHandoffCandidateDigest,
  type HandoffCandidate,
  type HandoffCandidateInput,
  type HandoffDisplaySummary,
} from "./candidate.js";

export {
  HANDOFF_CANDIDATE_EVENT_KINDS,
  HANDOFF_CANDIDATE_LIFECYCLE_STATES,
  foldCandidateLifecycle,
  isHandoffCandidateEventKind,
  isTerminalLifecycleState,
  transitionCandidateLifecycle,
  type HandoffCandidateEventKind,
  type HandoffCandidateLifecycleState,
} from "./lifecycle.js";

export {
  HANDOFF_DELIVERY_EVENT_KINDS,
  HandoffEventStore,
  type HandoffDeliveryEventKind,
  type HandoffEventInput,
  type HandoffEventStoreOptions,
} from "./ledger.js";
