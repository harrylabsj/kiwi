/** Promotion business-time parsing with explicit IANA-zone and DST ambiguity checks. */

export const PROMOTION_TIME_RULE_VERSION = "kiwi-promotion-time/1";

export class PromotionTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionTimeError";
  }
}

export interface PromotionBoundary {
  input: string;
  instant: string;
  offset: string;
  timezone: string;
  rule_version: typeof PROMOTION_TIME_RULE_VERSION;
}

export function parsePromotionBoundary(input: {
  value: string;
  timezone: string;
  /** Date-only end values mean the end of that local calendar day. */
  dateEndInclusive?: boolean;
}): PromotionBoundary {
  const value = String(input.value ?? "").trim();
  const timezone = requireTimeZone(input.timezone);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  let instant: Date;
  if (dateOnly !== null) {
    let parts = validLocalParts(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      0,
      0,
      0,
    );
    if (input.dateEndInclusive === true) parts = nextCalendarDay(parts);
    instant = resolveLocalInstant(parts, timezone);
  } else if (hasExplicitOffset(value)) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new PromotionTimeError("promotion boundary is not RFC 3339");
    instant = new Date(ms);
    const explicit =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
        value,
      );
    if (explicit === null) throw new PromotionTimeError("promotion boundary is not RFC 3339");
    const statedLocal = validLocalParts(
      Number(explicit[1]),
      Number(explicit[2]),
      Number(explicit[3]),
      Number(explicit[4]),
      Number(explicit[5]),
      Number(explicit[6] ?? 0),
    );
    if (!sameLocalParts(formatLocalParts(instant, timezone), statedLocal)) {
      throw new PromotionTimeError(
        "promotion timestamp offset does not match the selected timezone at that local time",
      );
    }
  } else {
    const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (local === null) {
      throw new PromotionTimeError(
        "promotion boundary must be a date, local date-time, or RFC 3339 timestamp",
      );
    }
    instant = resolveLocalInstant(
      validLocalParts(
        Number(local[1]),
        Number(local[2]),
        Number(local[3]),
        Number(local[4]),
        Number(local[5]),
        Number(local[6] ?? 0),
      ),
      timezone,
    );
  }
  return {
    input: value,
    instant: instant.toISOString(),
    offset: formatOffset(zoneOffsetMinutes(instant, timezone)),
    timezone,
    rule_version: PROMOTION_TIME_RULE_VERSION,
  };
}

export function promotionIsActive(startsAt: string, endsAt: string, now: string | Date): boolean {
  const current = typeof now === "string" ? Date.parse(now) : now.getTime();
  return Date.parse(startsAt) <= current && current < Date.parse(endsAt);
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function requireTimeZone(value: string): string {
  const timezone = String(value ?? "").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new PromotionTimeError("promotion timezone must be a valid IANA time zone");
  }
  return timezone;
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function validLocalParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): LocalParts {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new PromotionTimeError("promotion local date-time fields are invalid");
  }
  const normalized = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== day
  ) {
    throw new PromotionTimeError("promotion local calendar date is invalid");
  }
  return { year, month, day, hour, minute, second };
}

function nextCalendarDay(parts: LocalParts): LocalParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function resolveLocalInstant(target: LocalParts, timezone: string): Date {
  const naive = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  const matches: number[] = [];
  // IANA offsets are minute-granular for the supported modern promotion horizon.
  for (let offsetMinutes = -18 * 60; offsetMinutes <= 18 * 60; offsetMinutes += 1) {
    const candidate = naive - offsetMinutes * 60_000;
    if (sameLocalParts(formatLocalParts(new Date(candidate), timezone), target)) {
      matches.push(candidate);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    throw new PromotionTimeError("promotion local time does not exist in the selected timezone");
  }
  if (unique.length > 1) {
    throw new PromotionTimeError(
      "promotion local time is ambiguous in the selected timezone; provide an explicit offset",
    );
  }
  return new Date(unique[0]!);
}

function formatLocalParts(date: Date, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values["year"]!,
    month: values["month"]!,
    day: values["day"]!,
    hour: values["hour"]!,
    minute: values["minute"]!,
    second: values["second"]!,
  };
}

function sameLocalParts(left: LocalParts, right: LocalParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function zoneOffsetMinutes(date: Date, timezone: string): number {
  const local = formatLocalParts(date, timezone);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
