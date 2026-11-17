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
 * TOP2 客户记忆域类型（设计 v1.1 §9–§12 / M3）。
 *
 * P0 只启用 organization / agent_scope；person / verified_person 由服务层拒绝。
 * 记忆、证据、事件与历史索引独立于 owner Principal Memory；所有时间 RFC3339
 * UTC，所有读取带 merchant + subject 作用域。
 */

import type { ActorCapability } from "../context-governance/types.js";

export type CustomerMemoryErrorCode =
  | "validation"
  | "access_denied"
  | "not_found"
  | "version_conflict"
  | "confirmation_invalid"
  | "confirmation_expired"
  | "confirmation_consumed"
  | "grant_unavailable"
  | "source_unavailable"
  | "schema_unavailable"
  | "unavailable";

export class CustomerMemoryError extends Error {
  readonly code: CustomerMemoryErrorCode;
  readonly reason: string;

  constructor(code: CustomerMemoryErrorCode, reason: string, message: string) {
    super(message);
    this.name = "CustomerMemoryError";
    this.code = code;
    this.reason = reason;
  }
}

export const CUSTOMER_SUBJECT_KINDS = [
  "organization",
  "agent_scope",
  "person",
  "verified_person",
] as const;
export type CustomerSubjectKind = (typeof CUSTOMER_SUBJECT_KINDS)[number];
export const P0_SUBJECT_KINDS: ReadonlySet<CustomerSubjectKind> = new Set([
  "organization",
  "agent_scope",
]);

export const MEMORY_STATES = [
  "candidate",
  "active",
  "needs_review",
  "superseded",
  "deleted",
  "expired",
] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

export const MEMORY_SOURCE_KINDS = ["explicit", "observed", "inferred"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export const MEMORY_NAMESPACES = [
  "preference",
  "constraint",
  "requirement",
  "communication",
  "region",
] as const;
export type MemoryNamespace = (typeof MEMORY_NAMESPACES)[number];

export interface CustomerSubject {
  readonly subject_id: string;
  readonly merchant_id: string;
  readonly subject_kind: CustomerSubjectKind;
  readonly status: "ACTIVE" | "REVOKED";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SubjectBinding {
  readonly binding_id: string;
  readonly merchant_id: string;
  readonly subject_id: string;
  readonly actor_id: string;
  readonly issuer: string;
  readonly assurance_class: string;
  readonly binding_epoch: number;
  readonly status: "ACTIVE" | "REVOKED";
  readonly expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CustomerMemory {
  readonly memory_id: string;
  readonly merchant_id: string;
  readonly subject_id: string;
  readonly resource_scope_id: string;
  readonly namespace: MemoryNamespace;
  readonly key: string;
  readonly value_ref: string;
  readonly value_type: string;
  readonly state: MemoryState;
  readonly source_kind: MemorySourceKind;
  readonly source_refs: readonly string[];
  readonly confidence: number | null;
  readonly confirmed_by: string | null;
  readonly confirmed_at: string | null;
  readonly last_confirmed_at: string | null;
  readonly valid_from: string;
  readonly expires_at: string;
  readonly policy_version: string;
  readonly version: number;
  readonly grant_id: string;
  readonly grant_epoch: number;
  readonly data_epoch: number;
  readonly erase_scope_id: string;
  readonly purge_at: string;
  readonly superseded_by: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface HistoryHit {
  readonly document_ref: string;
  readonly source_version: number;
  readonly historical: true;
  readonly is_current: false;
  readonly kind: string;
  readonly sku?: string;
  readonly occurred_at: string;
  readonly snippet: string;
}

export type HistorySearchResult =
  | {
      readonly status: "ok";
      readonly hits: readonly HistoryHit[];
      readonly next_cursor?: string;
    }
  | { readonly status: "no_match"; readonly hits: readonly [] }
  | { readonly status: "unavailable"; readonly reason: string };

/** 能力检查：customer:self 走客户自助；memory:write/read 走管理/worker。 */
export function requireCapability(
  actorCapabilities: readonly string[],
  capability: ActorCapability,
  reason = "capability_missing",
): void {
  if (!actorCapabilities.includes(capability)) {
    throw new CustomerMemoryError("access_denied", reason, `actor 缺少 ${capability}`);
  }
}
