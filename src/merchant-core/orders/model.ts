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
 * 外部订单事实模型（v0.2 §11–§12 / FR19–FR25）。
 *
 * 纯函数，不读外部源。三类结论分开：订单存在、订单归因、订单贡献——
 * 任一结论证据不足都不能拖累其余事实展示。事件去重、乱序、字段级权威
 * 合并与退款更正都在这里定义；真实来源契约仍由 M0 冻结。
 */

export interface ExternalOrderIdentity {
  merchant_id: string;
  source_namespace: string;
  source_account_id: string;
  external_order_id: string;
}

export interface ExternalRefundIdentity extends ExternalOrderIdentity {
  external_refund_id: string;
}

export type OrderDimension = "payment" | "fulfillment" | "refund" | "cancellation";

export interface OrderEvent {
  /** 来源事件 ID（同一来源账户内唯一）。 */
  event_id: string;
  identity: ExternalOrderIdentity;
  dimension: OrderDimension;
  /** 该维度权威流内的版本；真实来源必须保证可比较。 */
  source_version: string;
  occurred_at: string;
  observed_at: string;
  /** 原始状态值（不解释，只保存）。 */
  value: string;
  amount_minor?: number;
  refund_id?: string;
  /** 原始事件摘要（用于同版本异内容冲突检测）。 */
  raw_digest: string;
}

export interface OrderStreamContract {
  dimension: OrderDimension;
  /** monotonic：来源提供可比版本；unorderable：只能重读权威快照。 */
  ordering: "monotonic" | "unorderable";
  /** 版本作用域（例如 payment / fulfillment / refund），不跨流比较。 */
  version_scope: string;
}

export type MergeEventResult =
  | { status: "accepted"; current: OrderEvent }
  | { status: "duplicate"; current: OrderEvent }
  | { status: "stale"; current: OrderEvent }
  | { status: "conflict"; current: OrderEvent; reason: "same_version_different_content" }
  | { status: "unverified"; current?: OrderEvent; reason: "unorderable_source" | "different_version_scope" };

export interface OrderLineFact {
  line_id: string;
  sku: string;
  quantity: number;
  amount_minor: number;
}

export interface AttributionInput {
  order_line_id: string;
  opportunity_id: string;
  quantity: number;
  amount_minor: number;
  method: "handoff_reference" | "verified_source_reference" | "manual_confirmation";
  confirmed_by?: string;
}

export interface AttributionResult {
  allocations: Array<AttributionInput & { attribution_id: string }>;
  totals_by_opportunity: Record<string, { quantity: number; amount_minor: number }>;
  unassigned: Array<{ line_id: string; quantity: number; amount_minor: number }>;
}

export interface RefundFact {
  identity: ExternalRefundIdentity;
  amount_minor: number;
  /** 同一退款的状态/金额更正版本。 */
  version: number;
  status: "active" | "reversed";
}

export type RefundMergeResult =
  | { status: "inserted"; refunds: RefundFact[] }
  | { status: "corrected"; refunds: RefundFact[] }
  | { status: "duplicate"; refunds: RefundFact[] }
  | { status: "conflict"; refunds: RefundFact[]; reason: "same_version_different_amount" };

export class OrderFactError extends Error {
  readonly code: "validation" | "identity_conflict";
  constructor(code: "validation" | "identity_conflict", message: string) {
    super(message);
    this.name = "OrderFactError";
    this.code = code;
  }
}

function requireText(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new OrderFactError("validation", `${name} 必须是非空字符串（≤${max}）`);
  }
  return value;
}

function requireMinor(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderFactError("validation", `${name} 必须是非负安全整数`);
  }
  return value;
}

/** 复合外部订单身份（商家、来源命名空间、来源账户、外部订单 ID）。 */
export function orderIdentityKey(identity: ExternalOrderIdentity): string {
  return [
    requireText(identity.merchant_id, "merchant_id", 128),
    requireText(identity.source_namespace, "source_namespace", 64),
    requireText(identity.source_account_id, "source_account_id", 128),
    requireText(identity.external_order_id, "external_order_id", 256),
  ].join("\u0000");
}

/** 退款业务唯一键：订单复合身份 + 外部退款 ID。 */
export function refundIdentityKey(identity: ExternalRefundIdentity): string {
  return `${orderIdentityKey(identity)}\u0000${requireText(identity.external_refund_id, "external_refund_id", 256)}`;
}

/** 版本比较：纯数字按 BigInt，其余按字典序；真实契约应保证同作用域可比较。 */
export function compareSourceVersion(left: string, right: string): number {
  requireText(left, "left_version");
  requireText(right, "right_version");
  if (/^[0-9]+$/.test(left) && /^[0-9]+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 字段级权威合并：
 *  - 同事件 ID → duplicate；
 *  - 来源不可排序 → unverified（保持当前，重读权威快照）；
 *  - 版本作用域不同 → unverified（不跨流比较）；
 *  - 新版本 → accepted；旧版本 → stale；同版本异内容 → conflict。
 */
export function mergeOrderEvent(input: {
  current?: OrderEvent;
  incoming: OrderEvent;
  contract: OrderStreamContract;
}): MergeEventResult {
  const { current, incoming, contract } = input;
  if (incoming.dimension !== contract.dimension) {
    throw new OrderFactError("validation", "事件维度与来源契约不一致");
  }
  if (current === undefined) {
    return contract.ordering === "unorderable"
      ? { status: "unverified", reason: "unorderable_source" }
      : { status: "accepted", current: incoming };
  }
  if (orderIdentityKey(current.identity) !== orderIdentityKey(incoming.identity)) {
    throw new OrderFactError("identity_conflict", "事件不属于同一外部订单");
  }
  if (current.event_id === incoming.event_id) {
    return { status: "duplicate", current };
  }
  if (contract.ordering === "unorderable") {
    return { status: "unverified", current, reason: "unorderable_source" };
  }
  if (!current.raw_digest) {
    throw new OrderFactError("validation", "current.raw_digest 不能为空");
  }
  const comparison = compareSourceVersion(incoming.source_version, current.source_version);
  if (comparison > 0) return { status: "accepted", current: incoming };
  if (comparison < 0) return { status: "stale", current };
  if (incoming.raw_digest !== current.raw_digest) {
    return { status: "conflict", current, reason: "same_version_different_content" };
  }
  return { status: "duplicate", current };
}

/** 行级归因：每个订单行的数量/金额有上限，不能重复归因；剩余显式未分配。 */
export function allocateAttributions(
  lines: readonly OrderLineFact[],
  allocations: readonly AttributionInput[],
): AttributionResult {
  const byLine = new Map<string, OrderLineFact>();
  for (const line of lines) {
    requireText(line.line_id, "lines[].line_id", 128);
    if (byLine.has(line.line_id)) {
      throw new OrderFactError("validation", `重复订单行：${line.line_id}`);
    }
    requireMinor(line.quantity, "lines[].quantity");
    requireMinor(line.amount_minor, "lines[].amount_minor");
    byLine.set(line.line_id, line);
  }

  const usedQuantity = new Map<string, number>();
  const usedAmount = new Map<string, number>();
  const seenPair = new Set<string>();
  const totals: AttributionResult["totals_by_opportunity"] = {};
  const accepted: AttributionResult["allocations"] = [];

  for (const allocation of allocations) {
    const line = byLine.get(allocation.order_line_id);
    if (line === undefined) {
      throw new OrderFactError("validation", `归因引用了未知订单行：${allocation.order_line_id}`);
    }
    requireText(allocation.opportunity_id, "allocations[].opportunity_id", 128);
    const quantity = requireMinor(allocation.quantity, "allocations[].quantity");
    const amount = requireMinor(allocation.amount_minor, "allocations[].amount_minor");
    if (quantity === 0 && amount === 0) {
      throw new OrderFactError("validation", "归因数量与金额不能同时为 0");
    }
    const pair = `${allocation.order_line_id}\u0000${allocation.opportunity_id}`;
    if (seenPair.has(pair)) {
      throw new OrderFactError("validation", "同一订单行不能重复归因到同一机会");
    }
    seenPair.add(pair);
    const nextQuantity = (usedQuantity.get(line.line_id) ?? 0) + quantity;
    const nextAmount = (usedAmount.get(line.line_id) ?? 0) + amount;
    if (nextQuantity > line.quantity) {
      throw new OrderFactError("validation", `订单行 ${line.line_id} 数量归因超过上限`);
    }
    if (nextAmount > line.amount_minor) {
      throw new OrderFactError("validation", `订单行 ${line.line_id} 金额归因超过上限`);
    }
    usedQuantity.set(line.line_id, nextQuantity);
    usedAmount.set(line.line_id, nextAmount);
    accepted.push({
      ...allocation,
      attribution_id: `attr_${line.line_id}_${allocation.opportunity_id}`,
      ...(allocation.confirmed_by !== undefined
        ? { confirmed_by: requireText(allocation.confirmed_by, "allocations[].confirmed_by", 128) }
        : {}),
    });
    const current = totals[allocation.opportunity_id] ?? { quantity: 0, amount_minor: 0 };
    totals[allocation.opportunity_id] = {
      quantity: current.quantity + quantity,
      amount_minor: current.amount_minor + amount,
    };
  }

  const unassigned = lines.map((line) => ({
    line_id: line.line_id,
    quantity: line.quantity - (usedQuantity.get(line.line_id) ?? 0),
    amount_minor: line.amount_minor - (usedAmount.get(line.line_id) ?? 0),
  }));

  return { allocations: accepted, totals_by_opportunity: totals, unassigned };
}

/**
 * 退款合并：同一外部退款后续状态/金额更正更新投影，不作为新退款再次扣减。
 * 同版本异金额 → conflict（保持原值，进入待核实）。
 */
export function mergeRefund(
  existing: readonly RefundFact[],
  incoming: RefundFact,
): RefundMergeResult {
  const key = refundIdentityKey(incoming.identity);
  requireMinor(incoming.amount_minor, "refund.amount_minor");
  if (!Number.isSafeInteger(incoming.version) || incoming.version < 1) {
    throw new OrderFactError("validation", "refund.version 必须是正整数");
  }
  const index = existing.findIndex((refund) => refundIdentityKey(refund.identity) === key);
  if (index === -1) {
    return {
      status: "inserted",
      refunds: [...existing, { ...incoming }],
    };
  }
  const current = existing[index]!;
  if (incoming.version < current.version) {
    return { status: "duplicate", refunds: [...existing] };
  }
  if (incoming.version === current.version) {
    if (incoming.amount_minor !== current.amount_minor || incoming.status !== current.status) {
      return {
        status: "conflict",
        refunds: [...existing],
        reason: "same_version_different_amount",
      };
    }
    return { status: "duplicate", refunds: [...existing] };
  }
  const refunds = [...existing];
  refunds[index] = { ...incoming };
  return { status: "corrected", refunds };
}

/** 当前退款总额：同一退款 ID 只取最新版本，重放不重复扣减。 */
export function refundTotalMinor(refunds: readonly RefundFact[]): number {
  let total = 0;
  for (const refund of refunds) {
    if (refund.status === "active") total += requireMinor(refund.amount_minor, "refund.amount_minor");
  }
  if (!Number.isSafeInteger(total)) throw new OrderFactError("validation", "退款总额超出安全整数");
  return total;
}
