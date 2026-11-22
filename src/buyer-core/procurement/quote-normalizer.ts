import { asRecord } from "./requirements.js";

export interface QuoteCosts {
  currency: "CNY";
  mode: "components" | "direct_total";
  complete: boolean;
  quantity: number;
  unit: string;
  goods?: CostLine;
  charges?: CostLine[];
  total_minor?: number;
  native_basis?: "net" | "gross";
  deposit_minor?: number;
  pack_multiple?: number;
  min_quantity?: number;
  max_quantity?: number;
}
export interface CostLine {
  id: string;
  kind: "goods" | "freight" | "fee" | "discount";
  scope: "per_unit" | "order";
  included?: boolean;
  eligible?: boolean;
  amount_minor: number;
  tax: "gross" | "net" | "unknown";
  tax_minor?: number;
  tax_bps?: number;
  rounding?: "half_up";
}

function safe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function amount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("AMOUNT_OUT_OF_RANGE");
  return Number(value);
}

function gross(line: CostLine, quantity: number): bigint | undefined {
  if (!safe(line.amount_minor) || !["order", "per_unit"].includes(line.scope)) throw new RangeError("INVALID_AMOUNT");
  const base = BigInt(line.amount_minor) * BigInt(line.scope === "per_unit" ? quantity : 1);
  if (line.tax === "gross") return base;
  if (line.tax !== "net") return undefined;
  if (line.tax_minor !== undefined) {
    if (!safe(line.tax_minor)) throw new RangeError("INVALID_TAX_AMOUNT");
    return base + BigInt(line.tax_minor);
  }
  if (line.tax_bps === undefined) return undefined;
  if (!safe(line.tax_bps) || line.tax_bps > 10000) throw new RangeError("INVALID_TAX_RATE");
  const tax = base * BigInt(line.tax_bps);
  if (tax % 10000n !== 0n && line.rounding !== "half_up") return undefined;
  return base + (tax + (line.rounding === "half_up" ? 5000n : 0n)) / 10000n;
}

export function normalizeCosts(raw: unknown, quantity?: number, unit?: string, nativeItem?: unknown) {
  const input = asRecord(raw) as Partial<QuoteCosts>;
  const missing: string[] = [];
  const conflicts: string[] = [];
  let known: number | null = null;
  let total: number | null = null;
  let scenario: { quantity: number; extra: number; cash_total_minor: number | null } | undefined;
  const declared = safe(input.total_minor) ? input.total_minor : null;

  try {
    if (input.currency !== "CNY" || (input.mode !== "direct_total" && input.mode !== "components")) {
      return { known_amount_minor: known, cash_total_minor: total, missing: ["costs"], conflicts };
    }
    for (const value of [input.total_minor, input.deposit_minor, input.min_quantity, input.max_quantity, input.pack_multiple]) {
      if (value !== undefined && !safe(value)) throw new RangeError("INVALID_AMOUNT");
    }
    if (quantity === undefined || unit === undefined || input.unit !== unit ||
        !safe(input.quantity) || input.quantity === 0) missing.push("quantity_unit");
    const priced = input.quantity;
    if (priced === undefined || !safe(priced) || priced === 0) {
      return { known_amount_minor: known, cash_total_minor: total, missing, conflicts };
    }
    if (quantity !== priced || (input.min_quantity ?? 0) > priced || (input.max_quantity ?? Infinity) < priced) missing.push("quantity_applicability");
    if (input.complete !== true) missing.push("all_required_fees");
    if ((input.deposit_minor ?? 0) > 0) missing.push("refundable_deposit_terms");
    if (input.pack_multiple === 0) throw new RangeError("INVALID_PACK_MULTIPLE");
    if (input.pack_multiple && quantity !== undefined && quantity % input.pack_multiple !== 0) {
      const packed = amount(((BigInt(quantity) + BigInt(input.pack_multiple) - 1n) / BigInt(input.pack_multiple)) * BigInt(input.pack_multiple));
      missing.push("pack_multiple");
      scenario = { quantity: packed, extra: packed - quantity, cash_total_minor: null };
    }

    const item = asRecord(nativeItem);
    if (nativeItem !== undefined) {
      const nativePrice = asRecord(item.unit_price);
      const nativeQuantity = asRecord(item.quantity);
      const goods = input.goods;
      if (priced !== nativeQuantity.value || input.unit !== nativeQuantity.unit || nativePrice.currency !== "CNY") conflicts.push("native_quantity_or_currency");
      if (input.mode === "components") {
        if (!goods || !safe(nativePrice.amount_minor) || (input.native_basis !== "net" && input.native_basis !== "gross")) {
          missing.push("native_goods_basis");
        } else {
          const native = BigInt(nativePrice.amount_minor) * BigInt(priced);
          const stated = input.native_basis === "gross" ? gross(goods, priced) :
            goods.tax === "net" && safe(goods.amount_minor) ? BigInt(goods.amount_minor) * BigInt(goods.scope === "per_unit" ? priced : 1) : undefined;
          if (stated !== native) conflicts.push("native_goods_amount");
        }
      }
    }

    if (input.mode === "direct_total") {
      if (declared === null) missing.push("declared_total");
      if (input.goods !== undefined || input.charges?.length) conflicts.push("mixed_cost_modes");
      if (!missing.includes("quantity_applicability")) known = declared;
    } else {
      if (!input.goods) missing.push("goods");
      const lines = [...(input.goods ? [input.goods] : []), ...(input.charges ?? [])];
      const ids = new Set<string>();
      let sum = 0n;
      let knownLines = 0;
      let scenarioSum = 0n;
      for (const line of lines) {
        if (!line.id || ids.has(line.id)) throw new RangeError("DUPLICATE_FEE");
        ids.add(line.id);
        const isGoods = line === input.goods;
        if (isGoods ? line.kind !== "goods" || line.included === true : !["freight", "fee", "discount"].includes(line.kind)) throw new RangeError("INVALID_FEE_KIND");
        if (!isGoods && line.included === undefined) {
          missing.push(`inclusion:${line.id}`);
          continue;
        }
        if (!safe(line.amount_minor)) throw new RangeError("INVALID_AMOUNT");
        if (line.included === true) continue;
        if (line.kind === "discount" && line.eligible !== true) {
          if (line.eligible === undefined) missing.push(`eligibility:${line.id}`);
          continue;
        }
        const charge = gross(line, priced);
        if (charge === undefined) {
          missing.push(`tax_or_amount:${line.id}`);
          continue;
        }
        const sign = line.kind === "discount" ? -1n : 1n;
        sum += sign * charge;
        knownLines++;
        if (scenario !== undefined && line.scope === "per_unit") scenarioSum += sign * (gross(line, scenario.quantity) ?? 0n);
      }
      if (knownLines && !missing.includes("quantity_applicability")) known = amount(sum);
      if (scenario && knownLines && lines.every(line => line.scope === "per_unit" && line.kind !== "discount") &&
          input.complete === true && missing.every(reason => reason === "pack_multiple") &&
          scenario.quantity <= (input.max_quantity ?? Infinity)) scenario.cash_total_minor = amount(scenarioSum);
      if (declared !== null && !missing.length && BigInt(declared) !== sum) conflicts.push("declared_total_disagrees");
    }
    if (!missing.length && !conflicts.length) total = known;
  } catch (error) {
    conflicts.push(error instanceof RangeError ? error.message : "INVALID_COSTS");
  }
  return { known_amount_minor: known, cash_total_minor: total, stated_total_minor: declared, deposit_minor: input.deposit_minor,
    missing, conflicts, ...(scenario === undefined ? {} : { scenario }) };
}
