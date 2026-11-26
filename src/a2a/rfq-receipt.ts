/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */

/** Kiwi 可选的只读 GetTask 查询：用原始 KNP 引用查已记录的 RFQ，而不是重发。 */
export const RFQ_RECEIPT_METADATA = "kiwi_rfq_receipt_v1";

export interface RfqReceiptRef {
  message_id: string;
  negotiation_id: string;
  wire_digest: string;
}

export function parseRfqReceiptRef(value: unknown): RfqReceiptRef | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { message_id, negotiation_id, wire_digest } = value as Partial<RfqReceiptRef>;
  const id = /^[A-Za-z0-9_:.-]{1,128}$/;
  if (typeof message_id !== "string" || !id.test(message_id) ||
      typeof negotiation_id !== "string" || !id.test(negotiation_id) ||
      typeof wire_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(wire_digest)) return undefined;
  return { message_id, negotiation_id, wire_digest };
}
