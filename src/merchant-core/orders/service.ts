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
 * 订单事实服务（v0.2 §11–§13 / FR19–FR27）。
 *
 * 人工/CSV 申报只生成 `manual_report`/`csv_import`；只有受信来源返回有效
 * 事实后才升级为 `external_verified`。归因、退款与贡献分别独立记录。
 */

import { calculateContribution } from "../contribution/calculate.js";
import type { ContributionRepository } from "../contribution/repository.js";
import type { ContributionInput } from "../contribution/types.js";
import {
  OrderFactError,
  type AttributionInput,
  type ExternalOrderIdentity,
  type OrderLineFact,
  type OrderStreamContract,
  type RefundFact,
} from "./model.js";
import type { OrderRecordV2, OrderRepository } from "./repository.js";

export interface OrderSourceContract {
  source_namespace: string;
  source_account_id: string;
  ordering: "monotonic" | "unorderable";
  version_scope: string;
  event_id_scope: string;
  supports_watermark: boolean;
}

export function validateOrderSourceContract(contract: OrderSourceContract): void {
  for (const [name, value] of Object.entries(contract)) {
    if (typeof value === "string" && value.trim() === "") {
      throw new OrderFactError("validation", `source contract ${name} 不能为空`);
    }
  }
  if (contract.ordering !== "monotonic" && contract.ordering !== "unorderable") {
    throw new OrderFactError("validation", "source contract ordering 非法");
  }
  if (typeof contract.supports_watermark !== "boolean") {
    throw new OrderFactError("validation", "source contract supports_watermark 必须是布尔值");
  }
}

export interface ManualOrderReportInput {
  identity: ExternalOrderIdentity;
  lines: OrderLineFact[];
  currency?: string;
  total_minor?: number;
  payment_status?: string;
  fulfillment_status?: string;
  observed_at: string;
  reported_by: string;
  evidence_ref?: string;
}

export interface MerchantOrderServiceOptions {
  orders: OrderRepository;
  contributions: ContributionRepository;
}

export class MerchantOrderService {
  private readonly orders: OrderRepository;
  private readonly contributions: ContributionRepository;

  constructor(options: MerchantOrderServiceOptions) {
    this.orders = options.orders;
    this.contributions = options.contributions;
  }

  /** 人工/CSV 申报：只记申报事实，绝不升级为外部已核实。 */
  recordManualReport(input: ManualOrderReportInput): OrderRecordV2 {
    if (input.reported_by.trim() === "") {
      throw new OrderFactError("validation", "reported_by 不能为空");
    }
    if (!Number.isFinite(Date.parse(input.observed_at))) {
      throw new OrderFactError("validation", "observed_at 必须是可解析时间");
    }
    return this.orders.createOrder({
      identity: input.identity,
      evidenceSource: "manual_report",
      ...(input.payment_status !== undefined ? { paymentStatus: input.payment_status } : {}),
      ...(input.fulfillment_status !== undefined
        ? { fulfillmentStatus: input.fulfillment_status }
        : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.total_minor !== undefined ? { totalMinor: input.total_minor } : {}),
      observedAt: input.observed_at,
      lines: input.lines,
    }).order;
  }

  listOrders(merchantId: string): OrderRecordV2[] {
    return this.orders.listOrders(merchantId);
  }

  getOrder(merchantId: string, recordId: string): OrderRecordV2 | undefined {
    return this.orders.getOrder(merchantId, recordId);
  }

  /** 只有受信来源返回有效事实才升级；凭证缺省/无效时保持人工申报状态。 */
  verifyWithSourceFact(input: {
    merchantId: string;
    recordId: string;
    verified: boolean;
    source_version: string;
    verified_at: string;
  }): OrderRecordV2 {
    const order = this.orders.getOrder(input.merchantId, input.recordId);
    if (order === undefined) throw new OrderFactError("validation", "order not found");
    if (!input.verified) return order;
    if (input.source_version.trim() === "") {
      throw new OrderFactError("validation", "verified fact 必须带 source_version");
    }
    if (!Number.isFinite(Date.parse(input.verified_at))) {
      throw new OrderFactError("validation", "verified_at 必须是可解析时间");
    }
    return this.orders.updateEvidence(input.merchantId, input.recordId, {
      evidenceSource: "external_verified",
      sourceVersion: input.source_version,
      verifiedAt: input.verified_at,
    });
  }

  appendSourceEvent(input: {
    merchantId: string;
    recordId: string;
    event: Parameters<OrderRepository["appendEvent"]>[0]["incoming"];
    contract: OrderStreamContract;
  }): { inserted: boolean; status: string } {
    return this.orders.appendEvent({
      merchantId: input.merchantId,
      recordId: input.recordId,
      incoming: input.event,
      contract: input.contract,
    });
  }

  attribute(recordId: string, allocations: AttributionInput[]): ReturnType<OrderRepository["replaceAttributions"]> {
    return this.orders.replaceAttributions(recordId, allocations);
  }

  recordRefund(input: {
    merchantId: string;
    recordId: string;
    refund: RefundFact;
  }): { status: string; totalMinor: number } {
    return this.orders.mergeRefund(input.merchantId, input.recordId, input.refund);
  }

  /** 读取当前退款总额并计算贡献；成本快照可由调用方先行保存。 */
  assessContribution(input: {
    merchantId: string;
    recordId: string;
    contribution: ContributionInput;
    costSnapshotId?: string;
  }): ReturnType<ContributionRepository["saveAssessment"]> {
    const assessment = calculateContribution(input.contribution);
    return this.contributions.saveAssessment({
      merchantId: input.merchantId,
      refKind: "order",
      refId: input.recordId,
      assessment,
      ...(input.costSnapshotId !== undefined ? { costSnapshotId: input.costSnapshotId } : {}),
    });
  }
}
