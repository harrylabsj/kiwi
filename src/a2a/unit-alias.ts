/**
 * Explicit, loss-free unit spellings shared by the merchant RFQ handler and the
 * reception paths.
 *
 * Only a closed one-to-one set is canonicalised here: `box` and `盒` denote the
 * same selling unit. This never turns `个`/`件` into a box. Package factors are
 * applied only by `resolveUnitConversion` when the source unit is explicitly
 * the configured `default_unit`; same-unit requests stay 1:1. Merchant
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
    if (!Number.isSafeInteger(factor) || factor <= 0) {
      throw new Error(
        `invalid normalized unit package factor for "${key}": ${String(factor)}; expected a positive safe integer`,
      );
    }
    if (Object.hasOwn(normalized, key) && normalized[key] !== factor) {
      throw new Error(
        `conflicting normalized unit package factor for "${key}": ${normalized[key]} vs ${factor}`,
      );
    }
    normalized[key] = factor;
  }
  return normalized;
}

export interface UnitConversionPolicy {
  aliases: Record<string, string>;
  packageFactors: Record<string, number>;
  defaultUnit?: string;
  /** Legacy public-constructor form: factors without unitDefaultUnit. */
  legacyFactorTarget?: boolean;
}

/**
 * Build a normalized unit policy. Conflicting normalized alias/factor keys
 * throw here, before serving a request.
 */
export function unitConversionPolicy(input: {
  aliases?: Record<string, string>;
  packageFactors?: Record<string, number>;
  defaultUnit?: string;
}): UnitConversionPolicy {
  return {
    aliases: normalizeUnitAliasMap(input.aliases),
    packageFactors: normalizeUnitFactorMap(input.packageFactors),
    ...(input.defaultUnit !== undefined
      ? { defaultUnit: canonicalUnitToken(input.defaultUnit) }
      : {}),
    ...(input.defaultUnit === undefined && input.packageFactors !== undefined
      ? { legacyFactorTarget: true }
      : {}),
  };
}

export type UnitResolution =
  | { kind: "identity"; unit: string }
  | { kind: "alias"; unit: string }
  | { kind: "factor"; unit: string; factor: number }
  | {
      kind: "mismatch";
      reason: "missing_product_unit" | "ambiguous_factor" | "alias_conflict" | "no_match";
    };

/**
 * Resolve a requested unit against the source unit.
 *
 * - same source/request unit (including box/盒) is always 1:1, even when a
 *   package factor exists for that spelling;
 * - a package factor is applied ONLY when the source unit is the configured
 *   `default_unit` (the factor's target) and the requested unit is the package
 *   spelling;
 * - a factor for any other source unit is ambiguous and rejected rather than
 *   guessed; alias/factor conflicts are rejected too.
 */
export function resolveUnitConversion(
  policy: UnitConversionPolicy,
  productUnit: string | undefined,
  requestedUnit: string,
): UnitResolution {
  if (productUnit === undefined || productUnit.trim() === "") {
    return { kind: "mismatch", reason: "missing_product_unit" };
  }
  const productSpelling = normalizeUnitToken(productUnit);
  const requestedSpelling = normalizeUnitToken(requestedUnit);
  const product = canonicalUnitToken(productUnit);
  const requested = canonicalUnitToken(requestedUnit);
  const hasAlias = Object.hasOwn(policy.aliases, requested);
  const aliasTarget = policy.aliases[requested];
  const factor = policy.packageFactors[requested];

  // Exact spelling (after NFKC/case normalization) is always 1:1. This is the
  // strongest evidence: do not let an alias/factor reinterpret it.
  if (productSpelling === requestedSpelling) {
    return { kind: "identity", unit: product };
  }

  if (product !== requested) {
    if (factor !== undefined) {
      const factorTargetApplies =
        policy.defaultUnit === undefined
          ? policy.legacyFactorTarget === true
          : product === policy.defaultUnit;
      if (!factorTargetApplies) {
        return { kind: "mismatch", reason: "ambiguous_factor" };
      }
      if (hasAlias) {
        if (factor === 1 && aliasTarget === product) {
          return { kind: "alias", unit: product };
        }
        return { kind: "mismatch", reason: "alias_conflict" };
      }
      return { kind: "factor", unit: product, factor };
    }

    if (hasAlias) {
      if (aliasTarget !== product) return { kind: "mismatch", reason: "no_match" };
      if (policy.defaultUnit !== undefined && aliasTarget !== policy.defaultUnit) {
        return { kind: "mismatch", reason: "alias_conflict" };
      }
      return { kind: "alias", unit: product };
    }

    return { kind: "mismatch", reason: "no_match" };
  }

  // Different original spellings that fold to the same canonical unit
  // (`box` vs `盒`). Explicit configuration may distinguish packaging meaning;
  // do not blindly overwrite it with the built-in 1:1 alias.
  // Different original spellings that fold to the same canonical unit. A
  // non-1 factor whose target is the source/default unit is an explicit
  // package interpretation (e.g. default box + factor 盒:12), so apply it
  // instead of silently choosing the built-in 1:1 alias.
  const factorTargetsSource = policy.defaultUnit !== undefined && product === policy.defaultUnit;
  if (factor !== undefined) {
    const legacyFactor = policy.defaultUnit === undefined && policy.legacyFactorTarget === true;
    if (factorTargetsSource || legacyFactor) {
      if (hasAlias && aliasTarget !== product) {
        return { kind: "mismatch", reason: "alias_conflict" };
      }
      return { kind: "factor", unit: product, factor };
    }
    if (hasAlias && aliasTarget !== product) {
      return { kind: "mismatch", reason: "alias_conflict" };
    }
    return { kind: "identity", unit: product };
  }

  if (hasAlias) {
    if (aliasTarget !== product) return { kind: "mismatch", reason: "alias_conflict" };
    return { kind: "alias", unit: product };
  }

  return { kind: "identity", unit: product };

}

/**
 * Safe quantity * package factor. Returns undefined instead of allowing a
 * non-safe integer (precision loss/Infinity) to reach stock or totals.
 */
export function multiplyQuantitySafe(quantity: number, factor: number): number | undefined {
  const product = quantity * factor;
  return Number.isSafeInteger(product) && product > 0 ? product : undefined;
}
