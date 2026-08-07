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
 * KTH/0.1 交付观察状态（rev0.3 §9；架构 rev1.4.1 §36-27/28）。
 *
 * DELIVERED / LAUNCHED / OPENED_CONFIRMED / EXPIRED / REVOKED ——
 * 这些状态只描述「交接动作」，**绝不**伪装成 ORDER_CREATED / PAID /
 * FULFILLED（外部交易结果必须由外部 authority 明确回传）。
 *
 * 证据门：`LAUNCHED` 只表示成功请求 OS/browser/deep-link handler 启动
 * 目的地，不证明页面加载；`OPENED_CONFIRMED` 必须由**可归属证据**触发
 * （local_callback 绑定 handoff_id / merchant_callback / platform_callback /
 * verified_return_uri）。无证据永不 OPENED_CONFIRMED（完成定义 #19、
 * 完成标准 12）。明确拒绝：button click / openURL 成功 / 计时 / UA 猜测。
 */

import { requireIsoTimestamp, requireNonEmptyString, schemaError } from "../negotiation/domain/common.js";
import type {
  LedgerCapabilitySnapshot,
  LedgerEvent,
  LedgerIdentitySnapshot,
} from "../negotiation/ledger/event.js";
import type { HandoffCandidate } from "./candidate.js";
import type { HandoffDeliveryEventKind, HandoffEventStore } from "./ledger.js";

export const HANDOFF_DELIVERY_STATES = [
  "DELIVERED",
  "LAUNCHED",
  "OPENED_CONFIRMED",
  "EXPIRED",
  "REVOKED",
] as const;

export type HandoffDeliveryState = (typeof HANDOFF_DELIVERY_STATES)[number];

/** 允许的 OPENED_CONFIRMED 证据种类（KTH rev0.3 §9）。 */
export const OPEN_EVIDENCE_KINDS = [
  "local_callback",
  "merchant_callback",
  "platform_callback",
  "verified_return_uri",
] as const;

export type OpenEvidenceKind = (typeof OPEN_EVIDENCE_KINDS)[number];

/** 可归属打开证据：必须绑定 handoff_id + 时间戳。 */
export interface OpenEvidence {
  readonly kind: OpenEvidenceKind;
  readonly handoff_id: string;
  readonly at: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const DELIVERY_EVENT_TO_STATE: Readonly<Record<HandoffDeliveryEventKind, HandoffDeliveryState>> = {
  handoff_delivered: "DELIVERED",
  handoff_launched: "LAUNCHED",
  handoff_opened_confirmed: "OPENED_CONFIRMED",
  handoff_expired: "EXPIRED",
  handoff_revoked: "REVOKED",
  handoff_delivery_failed: "DELIVERED", // 失败交付不产生观察状态（回到前态）
};

/** 从 Ledger 交付事件投影交付状态（纯函数，最后事件胜出）。 */
export function deliveryState(
  events: readonly Pick<LedgerEvent, "event_kind" | "event_id">[],
): HandoffDeliveryState | undefined {
  let state: HandoffDeliveryState | undefined;
  for (const event of events) {
    if (!isHandoffDeliveryEventKind(event.event_kind)) continue;
    state = DELIVERY_EVENT_TO_STATE[event.event_kind];
  }
  return state;
}

export function isHandoffDeliveryEventKind(kind: string): kind is HandoffDeliveryEventKind {
  return (
    kind === "handoff_delivered" ||
    kind === "handoff_launched" ||
    kind === "handoff_opened_confirmed" ||
    kind === "handoff_expired" ||
    kind === "handoff_revoked" ||
    kind === "handoff_delivery_failed"
  );
}

/** 校验打开证据（fail-closed）：kind 白名单 + handoff_id 绑定 + RFC 3339。 */
export function validateOpenEvidence(value: unknown, path = "open_evidence"): OpenEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError(path, "open evidence must be an object");
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind;
  if (!(OPEN_EVIDENCE_KINDS as readonly string[]).includes(String(kind))) {
    throw schemaError(
      path,
      `unsupported open evidence kind "${String(kind)}" (allowed: ${OPEN_EVIDENCE_KINDS.join(", ")})`,
    );
  }
  return {
    kind: kind as OpenEvidenceKind,
    handoff_id: requireNonEmptyString(obj.handoff_id, `${path}/handoff_id`),
    at: requireIsoTimestamp(obj.at, `${path}/at`),
    ...(obj.details !== undefined ? { details: obj.details as Record<string, unknown> } : {}),
  };
}

export interface DeliveryEventDeps {
  ledger: HandoffEventStore;
  candidate: HandoffCandidate;
  handoff_id: string;
  identity: LedgerIdentitySnapshot;
  capability: LedgerCapabilitySnapshot;
  now?: () => string;
}

/**
 * 记录 LAUNCHED：只表示成功请求 OS/browser/deep-link handler 启动目的地，
 * 不证明页面加载（§36-28）。
 */
export function recordLaunch(deps: DeliveryEventDeps): void {
  deps.ledger.appendDeliveryEvent({
    kind: "handoff_launched",
    candidate: deps.candidate,
    handoff_id: deps.handoff_id,
    identity: deps.identity,
    capability: deps.capability,
    occurred_at: deps.now?.() ?? new Date().toISOString(),
  });
}

/**
 * 记录 OPENED_CONFIRMED —— 证据门：只有通过 validateOpenEvidence 的
 * 可归属证据才允许进入该状态；无证据的 launch 永不成为 OPENED_CONFIRMED。
 */
export function recordOpenEvidence(deps: DeliveryEventDeps & { evidence: unknown }): OpenEvidence {
  const evidence = validateOpenEvidence(deps.evidence);
  if (evidence.handoff_id !== deps.handoff_id) {
    throw schemaError(
      "open_evidence/handoff_id",
      `evidence handoff_id ${evidence.handoff_id} does not match ${deps.handoff_id}`,
    );
  }
  deps.ledger.appendDeliveryEvent({
    kind: "handoff_opened_confirmed",
    candidate: deps.candidate,
    handoff_id: deps.handoff_id,
    identity: deps.identity,
    capability: deps.capability,
    evidence: { ...evidence },
    occurred_at: deps.now?.() ?? new Date().toISOString(),
  });
  return evidence;
}

/** 记录 REVOKED（仅当目的地支持撤销；§9）。 */
export function recordRevoked(deps: DeliveryEventDeps, reason = "operator revocation"): void {
  deps.ledger.appendDeliveryEvent({
    kind: "handoff_revoked",
    candidate: deps.candidate,
    handoff_id: deps.handoff_id,
    identity: deps.identity,
    capability: deps.capability,
    evidence: { reason },
    occurred_at: deps.now?.() ?? new Date().toISOString(),
  });
}
