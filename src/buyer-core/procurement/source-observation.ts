import { contentDigest } from "../../negotiation/jcs.js";
import { asRecord, COSTS_KEY, RESPONSE_KEY, type Basis, validTimestamp } from "./requirements.js";

export type Coverage = "completed" | "partial" | "timeout" | "error" | "not_searched";
export type PriceKind = "KNP_OFFER" | "SUPPLIER_QUOTE" | "CHECKOUT_SNAPSHOT" | "PAGE_REFERENCE" | "IMPORTED_REFERENCE";
export interface Evidence {
  reference: string;
  captured_at: string;
  location?: string;
  freshness_due_at?: string;
  valid_until?: string;
  account_scope?: string;
}
export interface ObservedProduct {
  model?: string;
  values?: Record<string, string | number | boolean>;
  supplier_ref?: string;
  verified_kiwi_merchant_id?: string;
  stock_quantity?: number;
  arrived_by?: string;
  destination?: string;
}
export interface Source {
  id: string;
  channel: "kiwi" | "ecommerce";
  name: string;
  variant: string;
  merchant_id?: string;
  inquiry_available?: boolean;
  evidence: Evidence;
  product?: ObservedProduct;
  price_kind: PriceKind;
  costs?: unknown;
  version: string;
  basis_digest: string;
  replaces_source_id?: string;
  task_id?: string;
  candidate_id?: string;
}
export interface Observation {
  source: Source;
  price_kind: PriceKind;
  digest: string;
  evidence: Evidence;
  product?: ObservedProduct;
  costs?: unknown;
  native_item?: unknown;
  native_fulfillment?: unknown;
  projection_digest?: string;
  response?: Record<string, unknown>;
  transmission: "NOT_SENT" | "PREPARED" | "RECEIPTED" | "UNKNOWN";
  observed_at: string;
  expired: boolean;
  verified: boolean;
  native_current?: boolean;
}

export function observe(source: Source, candidate: Record<string, unknown> | undefined, at: string, projection?: string, state?: Observation["transmission"]): Observation {
  const provenance = asRecord(candidate?.provenance);
  const terms = asRecord(provenance.latest_agreed_terms);
  const item = asRecord(Array.isArray(terms.items) ? terms.items[0] : undefined);
  const validUntil = typeof terms.valid_until === "string" ? terms.valid_until :
    typeof provenance.valid_until === "string" ? provenance.valid_until : candidate?.expires_at;
  const native = source.channel === "kiwi" && candidate?.status === "succeeded" &&
    candidate.merchant_id === source.merchant_id && item.sku === source.variant &&
    Array.isArray(terms.items) && terms.items.length === 1 &&
    provenance.latest_terms_digest === contentDigest(terms) && typeof provenance.merchant_reply_id === "string";
  let observedAt = source.evidence.captured_at;
  if (native && typeof provenance.reply_text === "string") {
    try {
      const replyTime = asRecord(JSON.parse(provenance.reply_text)).created_at;
      if (validTimestamp(replyTime)) observedAt = replyTime;
    } catch { /* Retain the discovery timestamp if the old record has no structured reply. */ }
  }
  const evidence = native ? { reference: `${source.task_id}/${candidate.candidate_id}/${provenance.merchant_reply_id}`,
    captured_at: observedAt, ...(validTimestamp(validUntil) ? { valid_until: validUntil } : {}) } : source.evidence;
  const expired = [evidence.valid_until, evidence.freshness_due_at].some(due => validTimestamp(due) && Date.parse(due) <= Date.parse(at));
  return {
    source, price_kind: native ? "KNP_OFFER" : source.price_kind,
    digest: native ? String(provenance.latest_terms_digest) : source.version,
    evidence, observed_at: evidence.captured_at,
    product: native && typeof asRecord(terms[RESPONSE_KEY]).model === "string" ? { ...source.product, model: String(asRecord(terms[RESPONSE_KEY]).model) } : source.product,
    costs: native ? asRecord(terms.price_terms)[COSTS_KEY] : source.costs,
    native_item: native ? item : undefined,
    native_fulfillment: native ? terms.fulfillment_terms : undefined,
    projection_digest: projection,
    response: native ? asRecord(terms[RESPONSE_KEY]) : undefined,
    transmission: native ? "RECEIPTED" : state ?? "NOT_SENT",
    expired,
    verified: native || source.price_kind === "SUPPLIER_QUOTE",
    native_current: native ? validTimestamp(validUntil) : undefined,
  };
}

export function sourceVersion(source: Omit<Source, "version">): Source {
  return { ...source, version: contentDigest(source) };
}

export function missingBasis(basis: Basis): string[] {
  return [
    ...(basis.selection_mode === "exact_item" && !basis.model ? ["model"] : []),
    ...(basis.selection_mode === "spec_based" && !basis.requirements.some(r => r.kind === "specification" && r.hardness === "hard") ? ["specification"] : []),
    ...(basis.quantity === undefined ? ["quantity"] : []),
    ...(!basis.unit ? ["unit"] : []),
    ...(!basis.destination ? ["destination"] : []),
    ...(!basis.delivery_before ? ["delivery_before"] : []),
  ];
}
