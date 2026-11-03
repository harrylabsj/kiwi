/**
 * Explicit, loss-free unit spellings shared by the merchant RFQ handler and the
 * reception paths.
 *
 * Only a closed one-to-one set is canonicalised here: `box` and `盒` denote the
 * same selling unit. This never turns `个`/`件` into a box, never applies a
 * package factor, and never changes quantity, unit price or totals. Merchant
 * `unit_aliases` and `unit_package_factors` remain authoritative and are
 * checked before this fallback.
 */
export function normalizeUnitToken(unit: string): string {
  return unit.trim().normalize("NFKC").toLowerCase();
}

/** Canonical spelling for a known one-to-one unit; unknown units stay as-is. */
export function canonicalUnitToken(unit: string): string {
  const normalized = normalizeUnitToken(unit);
  return normalized === "盒" ? "box" : normalized;
}

/** True only when the two spellings are the explicit box/盒 equivalence. */
export function unitsAreCanonicalAliases(a: string, b: string): boolean {
  const left = canonicalUnitToken(a);
  const right = canonicalUnitToken(b);
  return left === "box" && right === "box";
}

/**
 * Normalize config keys/values to the canonical 1:1 spelling map.
 *
 * Keys that collapse under NFKC/lowercase/box-盒 canonicalisation must agree:
 * `{ BOX: "box", "盒": "box" }` is redundant and accepted, while
 * `{ BOX: "box", "盒": "piece" }` is a conflicting configuration and throws.
 * Never silently let object insertion order choose the winner.
 */
export function normalizeUnitAliasMap(
  aliases: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [alias, canonical] of Object.entries(aliases ?? {})) {
    const key = canonicalUnitToken(alias);
    const value = canonicalUnitToken(canonical);
    if (Object.hasOwn(normalized, key) && normalized[key] !== value) {
      throw new Error(
        `conflicting normalized unit alias for "${key}": "${normalized[key]}" vs "${value}"`,
      );
    }
    normalized[key] = value;
  }
  return normalized;
}

/**
 * Normalize package-factor keys (BOX / ＢＯＸ / box / 盒 -> box).
 *
 * Same canonical key + same factor is accepted as redundant; different factors
 * are rejected instead of silently keeping the last object entry.
 */
export function normalizeUnitFactorMap(
  factors: Record<string, number> | undefined,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [unit, factor] of Object.entries(factors ?? {})) {
    const key = canonicalUnitToken(unit);
    if (Object.hasOwn(normalized, key) && normalized[key] !== factor) {
      throw new Error(
        `conflicting normalized unit package factor for "${key}": ${normalized[key]} vs ${factor}`,
      );
    }
    normalized[key] = factor;
  }
  return normalized;
}
