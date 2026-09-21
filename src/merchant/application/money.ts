/** Workbench v0.1.1 exact money boundary (design §4.4 / WB-042—043). */

export const WORKBENCH_CURRENCY_TABLE_VERSION = "kiwi-workbench-currency-v1-2026-09-21";

/** Conversion metadata pinned for contract vectors. Operating support is separately allowlisted. */
export const WORKBENCH_CURRENCY_EXPONENTS = Object.freeze({
  CNY: 2,
  JPY: 0,
  KWD: 3,
} as const);

/** First production operating scope. JPY/KWD remain mandatory conversion vectors, not enabled markets. */
export const WORKBENCH_SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["CNY"]);

export const MAX_KNP_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MINOR_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAJOR_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export interface ExactMoney {
  currency: string;
  amount_minor: string;
  currency_table_version: typeof WORKBENCH_CURRENCY_TABLE_VERSION;
}

export class WorkbenchMoneyError extends Error {
  readonly code:
    | "MONEY_FORMAT_INVALID"
    | "MONEY_CURRENCY_UNKNOWN"
    | "MONEY_CURRENCY_UNSUPPORTED"
    | "MONEY_PRECISION_UNRECOVERABLE"
    | "MONEY_RANGE_EXCEEDED";

  constructor(code: WorkbenchMoneyError["code"], message: string) {
    super(message);
    this.name = "WorkbenchMoneyError";
    this.code = code;
  }
}

export function currencyExponentExact(currency: string): number {
  const normalized = normalizeCurrency(currency);
  const exponent = WORKBENCH_CURRENCY_EXPONENTS[
    normalized as keyof typeof WORKBENCH_CURRENCY_EXPONENTS
  ];
  if (exponent === undefined) {
    throw new WorkbenchMoneyError(
      "MONEY_CURRENCY_UNKNOWN",
      `currency ${normalized} is absent from ${WORKBENCH_CURRENCY_TABLE_VERSION}`,
    );
  }
  return exponent;
}

export function assertWorkbenchCurrencySupported(currency: string): string {
  const normalized = normalizeCurrency(currency);
  currencyExponentExact(normalized);
  if (!WORKBENCH_SUPPORTED_CURRENCIES.has(normalized)) {
    throw new WorkbenchMoneyError(
      "MONEY_CURRENCY_UNSUPPORTED",
      `currency ${normalized} is a conversion vector but is not enabled for Workbench v1 operations`,
    );
  }
  return normalized;
}

export function parseExactMoney(value: unknown, options: { requireOperatingSupport?: boolean } = {}): ExactMoney {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkbenchMoneyError("MONEY_FORMAT_INVALID", "money must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["currency"] !== "string" || typeof record["amount_minor"] !== "string") {
    throw new WorkbenchMoneyError(
      "MONEY_FORMAT_INVALID",
      "currency and amount_minor must both be strings",
    );
  }
  const currency =
    options.requireOperatingSupport === true
      ? assertWorkbenchCurrencySupported(record["currency"])
      : normalizeCurrency(record["currency"]);
  currencyExponentExact(currency);
  const amountMinor = record["amount_minor"];
  if (!MINOR_PATTERN.test(amountMinor)) {
    throw new WorkbenchMoneyError(
      "MONEY_FORMAT_INVALID",
      "amount_minor must be a non-negative decimal integer string without leading zeros",
    );
  }
  const amount = BigInt(amountMinor);
  if (amount > MAX_KNP_MINOR) {
    throw new WorkbenchMoneyError(
      "MONEY_RANGE_EXCEEDED",
      `amount_minor exceeds the locked KNP safe integer boundary ${MAX_KNP_MINOR}`,
    );
  }
  return {
    currency,
    amount_minor: amount.toString(),
    currency_table_version: WORKBENCH_CURRENCY_TABLE_VERSION,
  };
}

/** Exact decimal text from an authoritative source → minor integer string. Never accepts Number/exponent form. */
export function decimalMajorToMinor(currency: string, decimal: string): ExactMoney {
  const normalized = normalizeCurrency(currency);
  const exponent = currencyExponentExact(normalized);
  const match = MAJOR_PATTERN.exec(String(decimal ?? ""));
  if (match === null) {
    throw new WorkbenchMoneyError(
      "MONEY_FORMAT_INVALID",
      "major amount must be a non-negative plain decimal string",
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) {
    throw new WorkbenchMoneyError(
      "MONEY_PRECISION_UNRECOVERABLE",
      `${normalized} allows ${exponent} fractional digits, got ${fraction.length}`,
    );
  }
  const scale = 10n ** BigInt(exponent);
  const whole = BigInt(match[1] ?? "0") * scale;
  const fractional = fraction === "" ? 0n : BigInt(fraction.padEnd(exponent, "0"));
  const amount = whole + fractional;
  if (amount > MAX_KNP_MINOR) {
    throw new WorkbenchMoneyError("MONEY_RANGE_EXCEEDED", "converted amount exceeds KNP safe range");
  }
  return {
    currency: normalized,
    amount_minor: amount.toString(),
    currency_table_version: WORKBENCH_CURRENCY_TABLE_VERSION,
  };
}

/**
 * Historical Number has already lost its original decimal token and is never auto-repaired. The caller must
 * reread an authoritative decimal string or quarantine the record.
 */
export function rejectLegacyNumberMoney(currency: string, value: number): never {
  normalizeCurrency(currency);
  if (!Number.isFinite(value)) {
    throw new WorkbenchMoneyError("MONEY_FORMAT_INVALID", "legacy amount is not finite");
  }
  throw new WorkbenchMoneyError(
    "MONEY_PRECISION_UNRECOVERABLE",
    "legacy JSON Number cannot prove its original decimal precision; reread or reimport the authoritative token",
  );
}

/** Exact non-negative half-up division, used by the one deterministic pricing service. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new WorkbenchMoneyError(
      "MONEY_FORMAT_INVALID",
      "half-up division requires a non-negative numerator and positive denominator",
    );
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function multiplyMinor(
  money: ExactMoney,
  multiplierNumerator: bigint,
  multiplierDenominator: bigint,
): ExactMoney {
  const parsed = parseExactMoney(money);
  const amount = divideHalfUp(
    BigInt(parsed.amount_minor) * multiplierNumerator,
    multiplierDenominator,
  );
  if (amount > MAX_KNP_MINOR) {
    throw new WorkbenchMoneyError("MONEY_RANGE_EXCEEDED", "calculated amount exceeds KNP safe range");
  }
  return { ...parsed, amount_minor: amount.toString() };
}

function normalizeCurrency(currency: string): string {
  const text = String(currency ?? "");
  if (!/^[A-Z]{3}$/.test(text)) {
    throw new WorkbenchMoneyError("MONEY_FORMAT_INVALID", "currency must be a three-letter uppercase code");
  }
  return text;
}
