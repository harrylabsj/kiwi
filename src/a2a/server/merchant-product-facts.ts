/** Internal source facts. No new public KNP/Listing schema is introduced. */
export interface ProductSourceEvidence {
  system: string;
  /** An upstream version or explicitly declared content-derived version, never read time. */
  source_version?: string;
  table_digest?: string;
  updated_at?: string;
  retrieved_at?: string;
}

export interface ResolvedProductFacts {
  priceMinor: number;
  currency: string;
  unit?: string;
  stock?: number;
  handoff_destination?: string;
  valid_until?: string;
  source_evidence?: ProductSourceEvidence;
  title?: string;
  note?: string;
}

export interface QuoteSourceSnapshot extends ResolvedProductFacts {
  sku: string;
  quantity: number;
  policy_digest: string;
  promotion: Record<string, unknown>;
}

export function checkedProductStock(stock: unknown): number | undefined {
  if (stock === undefined) return undefined;
  if (typeof stock !== "number" || !Number.isSafeInteger(stock) || stock < 0) {
    throw new TypeError("Invalid source stock fact");
  }
  return stock;
}

export function checkedSourceEvidence(value: unknown): ProductSourceEvidence | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid source evidence");
  const raw = value as Record<string, unknown>;
  if (typeof raw.system !== "string" || raw.system.trim() === "") throw new TypeError("Missing source system");
  const result: ProductSourceEvidence = { system: raw.system };
  for (const key of ["source_version", "table_digest", "updated_at", "retrieved_at"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string" || raw[key].trim() === "") throw new TypeError("Invalid source evidence field");
      result[key] = raw[key];
    }
  }
  return result;
}

/** Observation times/table-wide digest are provenance, not quote-value equality. */
export function quoteFactsStillValid(snapshot: QuoteSourceSnapshot, current: ResolvedProductFacts, nowMs: number): boolean {
  if (snapshot.stock === undefined || current.stock === undefined || current.stock < snapshot.quantity) return false;
  if (snapshot.unit === undefined || snapshot.unit !== current.unit || snapshot.priceMinor !== current.priceMinor || snapshot.currency !== current.currency || snapshot.title !== current.title) return false;
  if (snapshot.handoff_destination !== current.handoff_destination || snapshot.valid_until !== current.valid_until) return false;
  if (current.valid_until !== undefined && (!Number.isFinite(Date.parse(current.valid_until)) || Date.parse(current.valid_until) <= nowMs)) return false;
  if (snapshot.source_evidence === undefined || current.source_evidence === undefined) return false;
  return snapshot.source_evidence?.system === current.source_evidence?.system && snapshot.source_evidence?.source_version === current.source_evidence?.source_version;
}

/** Recover only complete, original hash-linked ledger snapshots; no new source lookup. */
export function recoverQuoteSourceSnapshot(value: unknown): QuoteSourceSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as QuoteSourceSnapshot;
  if (typeof v.sku !== "string" || v.sku.trim() === "" || !Number.isSafeInteger(v.quantity) || v.quantity <= 0 || typeof v.unit !== "string" || v.unit.trim() === "" || !Number.isSafeInteger(v.priceMinor) || v.priceMinor < 0 || typeof v.currency !== "string" || v.currency.trim() === "" || typeof v.policy_digest !== "string" || v.promotion === null || typeof v.promotion !== "object") return undefined;
  try { checkedProductStock(v.stock); checkedSourceEvidence(v.source_evidence); } catch { return undefined; }
  return v;
}
