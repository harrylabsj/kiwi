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
 * Kiwi v0.7.0 Transaction Handoff — HandoffPackage（WP1 交接工件）。
 *
 * HandoffPackage 是把一个 KNP/1.0 `AcceptedNonbindingAgreement`（基线 §15/§16）
 * 交给外部交易系统（UCP Checkout / AP2）前的安全交接工件。它携带协商达成所需的
 * 全部商业事实，并做一次独立的内容寻址校验：
 *
 *   terms_digest = RFC 8785 JCS + SHA-256 重算（src/negotiation/jcs.ts）
 *                  MUST 等于 agreement 携带的 terms_digest
 *   重算不一致 → 构造 fail-closed（HandoffError code=terms_digest_mismatch）
 *
 * 明确语义（基线 §3.4 / §15 / §16）：HandoffPackage 不是订单、不含支付授权、
 * 不代表库存预留。它只是「非绑定共识 → 交易系统」的交接载体；订单/支付/预留等
 * 副作用必须发生在外部交易系统，且没有用户显式授权绝不 complete 任何 checkout。
 */

import {
  KNP_PROTOCOL_VERSION,
  requireNonEmptyString,
  requireObject,
  requireDigest,
  requireIsoTimestamp,
  validateTermSet,
} from "../negotiation/domain/common.js";
import type { TermSet } from "../negotiation/domain/common.js";
import { validateIdentifier } from "../negotiation/domain/identifiers.js";
import type { AcceptedNonbindingAgreement } from "../negotiation/domain/objects.js";
import { contentDigest } from "../negotiation/jcs.js";
import { HandoffError } from "./errors.js";

/** WP1 交接工件版本。能力版本（capability_version）与它正交。 */
export const HANDOFF_PACKAGE_VERSION = "1.0" as const;

/** 双侧身份快照：agreement 只表达 buyer|merchant 角色，身份字符串由构造方提供。 */
export interface HandoffIdentitySnapshot {
  buyer_identity: string;
  merchant_identity: string;
}

/**
 * HandoffPackage 承载字段。
 *
 * - agreed_terms：完整 TermSet（结构校验过，非引用）；terms_digest 是对它的
 *   内容寻址，两者必须一致。
 * - semantics：显式复述 KNP/1.0 无副作用约束 —— 交易系统必须把它当「交接工件」
 *   而非订单/支付指令。
 */
export interface HandoffPackage {
  type: "handoff_package";
  package_version: typeof HANDOFF_PACKAGE_VERSION;
  agreement_id: string;
  negotiation_id: string;
  accepted_offer_id: string;
  agreed_terms: TermSet;
  /** contentDigest(agreed_terms)，必须等于 agreement.terms_digest。 */
  terms_digest: string;
  identity: HandoffIdentitySnapshot;
  /** 交易侧能力版本（如 UCP checkout capability 版本），opaque 字符串。 */
  capability_version: string;
  protocol_version: typeof KNP_PROTOCOL_VERSION;
  /** 交接工件创建时间（可注入时钟），RFC 3339。 */
  created_at: string;
  semantics: {
    /** 交接工件不是订单（基线 §15：creates_order=false）。 */
    creates_order: false;
    /** 交接工件不含支付授权（authorizes_payment=false）。 */
    authorizes_payment: false;
    /** 交接工件不代表库存预留（reserves_inventory=false）。 */
    reserves_inventory: false;
  };
}

export interface HandoffPackageInput {
  agreement: AcceptedNonbindingAgreement;
  identity: HandoffIdentitySnapshot;
  /** 交易侧能力版本，如 `ucp.checkout/1`。 */
  capability_version: string;
  /** 覆盖 KNP protocol_version（缺省 1.0）。 */
  protocol_version?: string;
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  created_at?: string;
}

function validateIdentitySnapshot(value: unknown): HandoffIdentitySnapshot {
  const obj = requireObject(value, "identity");
  return {
    buyer_identity: validateIdentifier(obj.buyer_identity, "identity/buyer_identity"),
    merchant_identity: validateIdentifier(obj.merchant_identity, "identity/merchant_identity"),
  };
}

/**
 * 从 AcceptedNonbindingAgreement 构造 HandoffPackage。
 *
 * 构造即校验（fail-closed）：
 *   1. agreement 结构字段逐一校验；
 *   2. 副作用 flag 必须为 false（KNP/1.0 §16，防御性复核）；
 *   3. 用 agreed_terms 重算 JCS+SHA-256 digest，必须等于 agreement.terms_digest，
 *      否则抛 HandoffError(terms_digest_mismatch)。
 *
 * 返回值是独立拷贝 —— agreed_terms 经 validateTermSet 归一化，调用方后续改动
 * agreement 不会污染 package。
 */
export function createHandoffPackage(input: HandoffPackageInput): HandoffPackage {
  const agreement = input.agreement;
  const agreementId = validateIdentifier(agreement.agreement_id, "agreement.agreement_id");
  const negotiationId = validateIdentifier(agreement.negotiation_id, "agreement.negotiation_id");
  const acceptedOfferId = validateIdentifier(
    agreement.accepted_offer_id,
    "agreement.accepted_offer_id",
  );
  const agreedTerms = validateTermSet(agreement.agreed_terms, "agreement.agreed_terms");
  const agreementDigest = requireDigest(agreement.terms_digest, "agreement.terms_digest");

  // KNP/1.0 §16：Agreement 不得带任何交易副作用（防御性复核，防类型绕过）。
  if (
    agreement.creates_order !== false ||
    agreement.reserves_inventory !== false ||
    agreement.authorizes_payment !== false
  ) {
    throw new HandoffError(
      "invalid_agreement",
      "agreement MUST carry creates_order=false / reserves_inventory=false / authorizes_payment=false (KNP/1.0 §16)",
    );
  }

  const identity = validateIdentitySnapshot(input.identity);
  const capabilityVersion = requireNonEmptyString(input.capability_version, "capability_version");
  const protocolVersion = input.protocol_version ?? KNP_PROTOCOL_VERSION;
  if (protocolVersion !== KNP_PROTOCOL_VERSION) {
    throw new HandoffError(
      "invalid_input",
      `unsupported protocol_version ${protocolVersion}; handoff binds to ${KNP_PROTOCOL_VERSION}`,
      "protocol_version",
    );
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  requireIsoTimestamp(createdAt, "created_at");

  // 重算 digest：contentDigest 走 RFC 8785 JCS + SHA-256（与 agreement 同源）。
  const recomputed = contentDigest(agreedTerms);
  if (recomputed !== agreementDigest) {
    throw new HandoffError(
      "terms_digest_mismatch",
      `agreed_terms digest mismatch: recomputed ${recomputed}, agreement carries ${agreementDigest}`,
      "terms_digest",
    );
  }

  return {
    type: "handoff_package",
    package_version: HANDOFF_PACKAGE_VERSION,
    agreement_id: agreementId,
    negotiation_id: negotiationId,
    accepted_offer_id: acceptedOfferId,
    agreed_terms: agreedTerms,
    terms_digest: recomputed,
    identity,
    capability_version: capabilityVersion,
    protocol_version: KNP_PROTOCOL_VERSION,
    created_at: createdAt,
    semantics: {
      creates_order: false,
      authorizes_payment: false,
      reserves_inventory: false,
    },
  };
}

/** 从已构造的 package 重算 terms_digest 并比对；false 表示工件被篡改。 */
export function verifyHandoffPackageDigest(pkg: HandoffPackage): boolean {
  if (pkg.type !== "handoff_package" || pkg.package_version !== HANDOFF_PACKAGE_VERSION) {
    return false;
  }
  return contentDigest(pkg.agreed_terms) === pkg.terms_digest;
}

/**
 * 基础结构守卫：从不可信输入解析 HandoffPackage 前的形状检查（对齐 ledger 的
 * isLedgerEvent 做法）。内容一致性由 verifyHandoffPackageDigest 单独校验。
 */
export function isHandoffPackage(value: unknown): value is HandoffPackage {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const semantics = obj.semantics as Record<string, unknown> | undefined;
  return (
    obj.type === "handoff_package" &&
    obj.package_version === HANDOFF_PACKAGE_VERSION &&
    typeof obj.agreement_id === "string" &&
    typeof obj.negotiation_id === "string" &&
    typeof obj.terms_digest === "string" &&
    typeof obj.capability_version === "string" &&
    typeof obj.created_at === "string" &&
    obj.identity !== null &&
    typeof obj.identity === "object" &&
    semantics !== null &&
    typeof semantics === "object" &&
    semantics.creates_order === false &&
    semantics.authorizes_payment === false &&
    semantics.reserves_inventory === false
  );
}
