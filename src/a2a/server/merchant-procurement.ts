import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentDigest } from "../../negotiation/jcs.js";
import {
  asRecord, conditionMatches, COSTS_KEY, REQUIREMENTS_KEY, RESPONSE_KEY, validTimestamp,
  type Requirement, type RequirementKind, type RequirementValue,
} from "../../buyer-core/procurement/requirements.js";
import type { QuoteCosts } from "../../buyer-core/procurement/quote-normalizer.js";

export interface MerchantProcurementFacts {
  version: string;
  model?: string;
  destination?: string;
  values?: Partial<Record<RequirementKind, RequirementValue>> & { specifications?: Record<string, RequirementValue> };
  native_basis: "net" | "gross";
  goods_tax_bps?: number;
  freight?: { included: true } | { included: false; amount_minor: number; tax: "net" | "gross"; tax_bps?: number };
  no_other_fees: boolean;
}
export type MerchantProcurementProvider = (sku: string) => MerchantProcurementFacts | undefined;

export function fileProcurementProvider(path: string): MerchantProcurementProvider {
  const filename = resolve(path);
  return sku => {
    try {
      const raw = asRecord(JSON.parse(readFileSync(filename, "utf8")));
      const facts = asRecord(raw[sku]) as unknown as MerchantProcurementFacts;
      if (typeof facts.version !== "string" || !facts.version.trim() || !["net", "gross"].includes(facts.native_basis)) return undefined;
      return facts;
    } catch { return undefined; }
  };
}

const allowed = new Set(["invoice", "payment", "delivery", "warranty", "specification"]);
const scalar = (v: unknown): v is RequirementValue => typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));
const amount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const tax = (v: unknown): v is number => amount(v) && v <= 10000;

export function readProcurementProjection(requestedTerms: unknown) {
  const input = asRecord(asRecord(requestedTerms)[REQUIREMENTS_KEY]);
  if (input.schema_version !== 1 || typeof input.projection_digest !== "string" ||
      !Array.isArray(input.requirements) || input.requirements.length > 20) return undefined;
  const requirements = input.requirements.map(asRecord);
  if (!requirements.every(v => typeof v.id === "string" && allowed.has(String(v.kind)) &&
    ["hard", "soft"].includes(String(v.strength)) && scalar(v.requested) &&
    (v.comparison === undefined || ["eq", "min", "max"].includes(String(v.comparison)))) ||
    new Set(requirements.map(v => v.id)).size !== requirements.length ||
    contentDigest({ schema_version: 1, requirements }) !== input.projection_digest) return undefined;
  return { schema_version: 1, projection_digest: input.projection_digest, requirements };
}

export interface ProcurementQuoteContext {
  projection: NonNullable<ReturnType<typeof readProcurementProjection>>;
  facts_digest: string;
  arrival?: string;
}

export function merchantProcurementTerms(
  facts: MerchantProcurementFacts | undefined, projection: ReturnType<typeof readProcurementProjection>,
  input: { price: number; currency: string; quantity: number; unit: string; arrival?: string; stock?: number },
) {
  if (!projection) return {};
  const evidenceVersion = typeof facts?.version === "string" ? facts.version : undefined;
  const values = facts?.values;
  const requirements = projection.requirements.map(item => {
    const kind = String(item.kind) as RequirementKind;
    const actual = kind === "specification" ? values?.specifications?.[String(item.id)] :
      kind === "delivery" && validTimestamp(item.requested) ? input.arrival : values?.[kind];
    if (!scalar(actual) || !evidenceVersion) return { requirement_id: item.id, status: "unknown" };
    const requirement: Requirement = { id: String(item.id), kind, value: item.requested as RequirementValue,
      comparison: item.comparison as Requirement["comparison"], hardness: item.strength === "hard" ? "hard" : "soft", disclose: true, source: evidenceVersion };
    return { requirement_id: item.id, status: conditionMatches(requirement, actual) ? "confirmed" : "deviation",
      value: actual, source_version: evidenceVersion };
  });
  const response = { schema_version: 1, request_projection_digest: projection.projection_digest, requirements,
    source_version: evidenceVersion, arrives_by: input.arrival,
    destination: typeof facts?.destination === "string" ? facts.destination : undefined,
    model: typeof facts?.model === "string" ? facts.model : undefined,
    available_quantity: input.stock };
  if (!facts || input.currency !== "CNY" || !Number.isSafeInteger(input.quantity) || !amount(input.price)) return { [RESPONSE_KEY]: response };
  const freight = facts.freight;
  const charges: NonNullable<QuoteCosts["charges"]> = [];
  if (freight?.included === true) charges.push({ id: "freight", kind: "freight", scope: "order", amount_minor: 0, included: true, tax: "gross" });
  if (freight?.included === false && amount(freight.amount_minor) && ["net", "gross"].includes(freight.tax)) {
    charges.push({ id: "freight", kind: "freight", scope: "order", amount_minor: freight.amount_minor, included: false,
      tax: freight.tax, tax_bps: tax(freight.tax_bps) ? freight.tax_bps : undefined });
  }
  const costs: QuoteCosts = { currency: "CNY", mode: "components", quantity: input.quantity, unit: input.unit,
    native_basis: facts.native_basis, complete: facts.no_other_fees === true && charges.length > 0,
    goods: { id: "goods", kind: "goods", scope: "per_unit", amount_minor: input.price, tax: facts.native_basis,
      tax_bps: tax(facts.goods_tax_bps) ? facts.goods_tax_bps : undefined }, charges };
  return { [RESPONSE_KEY]: response, price_terms: { [COSTS_KEY]: costs } };
}
