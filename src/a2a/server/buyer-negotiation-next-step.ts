/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */

/** 建议从买家明示数量构造新的 RFQ 参数，不属于当前报价条款。 */
export function nextQuantityRfq(input: {
  text: string; sku: string; quantity: number; unit: string; acceptsUnit: (unit: string) => boolean;
}): { kind: "new_rfq"; sku: string; quantity: { value: number; unit: string }; requires_buyer_confirmation: true } | undefined {
  const text = input.text.normalize("NFKC").slice(0, 1_000);
  const mentions = [...text.matchAll(/(?:如果(?:改买|改订|改为|改|买|订|采购|要|加到)?|换成|改为|加到|what if (?:we (?:buy|order) )?|if (?:we (?:buy|order) )?)\s*([1-9]\d{0,7})\s*(个|件|箱|盒|套|台|pieces?\b|units?\b|boxes?\b|sets?\b)/giu)];
  if (mentions.length !== 1) return undefined;
  const match = mentions[0]!;
  const alternative = Number(match[1]);
  if (!match[2] || !input.acceptsUnit(match[2]) || alternative === input.quantity || !Number.isSafeInteger(alternative)) return undefined;
  return { kind: "new_rfq", sku: input.sku, quantity: { value: alternative, unit: input.unit }, requires_buyer_confirmation: true };
}
