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
 * 发送证据（设计 v0.1.1 §8.1 发送状态域、§11.2 record_delivery）。
 *
 * 四种状态独立维护，绝不相互推导（I06）：本版唯一可写入的是
 * REPORTED_SENT——操作者自述「已发送」，必须引用操作者提供的证据
 * （evidence_ref：发送截图/邮件引用/会话内声明记录）。RECEIPT_VERIFIED
 * 只能来自目标渠道回执验证（后续接入）；DELIVERY_UNKNOWN 表示状态不可
 * 判定。模型不能提升证据等级，也不能把「已导出」写成「已发送」。
 */

import { RfqError, type DeliveryStatus } from "./types.js";
import type { RfqDeliveryRow, RfqRepository } from "./repository.js";

export const DELIVERY_CHANNELS = ["manual_wechat", "manual_email", "manual_other", "integrated_channel"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export interface DeliveryRecordInput {
  quoteId: string;
  quoteRevision: number;
  releaseId?: string;
  channel: DeliveryChannel;
  /** 操作者提供的证据引用（非空；指向操作者上传/引用的证据，不指向模型自述）。 */
  evidenceRef: string;
  actor: string;
}

/** 记录操作者自述发送（首版唯一入口；证据等级固定 REPORTED_SENT）。 */
export function recordReportedDelivery(repo: RfqRepository, input: DeliveryRecordInput): RfqDeliveryRow {
  if (input.evidenceRef.trim() === "") {
    throw new RfqError("validation", "record_delivery 必须引用操作者提供的证据（evidence_ref 不能为空）");
  }
  if (input.actor.trim() === "") {
    throw new RfqError("auth", "发送记录需要具名操作者");
  }
  const row: RfqDeliveryRow = {
    delivery_id: `dlv_${crypto.randomUUID()}`,
    merchant_id: repo.merchantId,
    quote_id: input.quoteId,
    quote_revision: input.quoteRevision,
    release_id: input.releaseId ?? null,
    status: "REPORTED_SENT",
    channel: input.channel,
    evidence_ref: input.evidenceRef,
    recorded_by: input.actor,
    recorded_at: new Date().toISOString(),
  };
  return repo.createDelivery(row);
}

/** 渠道回执验证（后续接入；首版 fail-closed——没有可信回执就没有该状态）。 */
export function recordVerifiedReceipt(): never {
  throw new RfqError(
    "unsupported_term",
    "渠道回执验证尚未接入（首版无 RECEIPT_VERIFIED 写入通道）；不接受模型自报 verified",
  );
}

/** 状态推导禁用检查（I06 的显式实现；仅供内部一致性测试引用）。 */
export function cannotDerive(_from: DeliveryStatus, _to: DeliveryStatus): false {
  return false;
}
