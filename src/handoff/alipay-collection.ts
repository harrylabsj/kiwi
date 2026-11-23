import { assertSafeTargetUrl } from "../a2a/client/url-policy.js";
import { requireIsoTimestamp } from "../negotiation/domain/common.js";

export const ALIPAY_COLLECTION_TERM = "kiwi_alipay_collection";
export const ALIPAY_PRIVATE_DISPLAY_REQUIRED =
  "支付宝收款仅支持具有独立签名身份和私有显示能力的 Kiwi 买家终端；此宿主不能发起交接。";
export const ALIPAY_COLLECTION_NOTICE = "请核对支付宝收款人和金额，自行付款；Kiwi 不确认到账。";

export interface AlipayCollectionLink {
  url: string;
  origin: string;
  negotiationId: string;
  offerId: string;
  version: string;
}

export interface AlipayCollectionTerms {
  version: string;
  recipient_summary: string;
  total_minor: number;
  currency: "CNY";
  expires_at: string;
}

const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLLECTION_PATH = /^\/collect\/alipay\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/([0-9a-f-]{36})$/;

export function parseAlipayCollectionLink(value: string): AlipayCollectionLink | null {
  try {
    const url = assertSafeTargetUrl(value, { allowLoopback: false });
    const match = COLLECTION_PATH.exec(url.pathname);
    if (url.protocol !== "https:" || match === null || !VERSION.test(match[3]!) ||
        value !== `${url.origin}${url.pathname}`) return null;
    return { url: value, origin: url.origin, negotiationId: match[1]!, offerId: match[2]!, version: match[3]! };
  } catch {
    return null;
  }
}

/** A malformed/aliased collection URL still cannot enter ordinary handoff. */
export function isAlipayCollectionDestination(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let path: string;
  try {
    path = new URL(value, "https://invalid.example").pathname;
  } catch {
    path = value.split(/[?#]/, 1)[0]!;
  }
  // Decode ASCII escapes without ignoring the rest of the path on a malformed percent triplet.
  path = path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  try {
    path = new URL(`https://invalid.example/${path.replaceAll("\\", "/")}`).pathname;
  } catch {
    return false;
  }
  return /(?:^|\/)collect\/+alipay(?:\/|$)/i.test(path);
}

export function hasAlipayCollectionTerms(terms: unknown): boolean {
  return terms !== null && typeof terms === "object" && Object.hasOwn(terms, ALIPAY_COLLECTION_TERM);
}

export function isAlipayCollectionAgreement(terms: unknown, declaredDestination?: unknown): boolean {
  if (isAlipayCollectionDestination(declaredDestination) || hasAlipayCollectionTerms(terms)) return true;
  const record = terms as { handoff_destination?: unknown; items?: unknown } | null | undefined;
  return isAlipayCollectionDestination(record?.handoff_destination) ||
    (Array.isArray(record?.items) && record.items.some((item) => isAlipayCollectionDestination(item?.handoff_destination)));
}

export function parseAlipayCollectionTerms(terms: unknown): AlipayCollectionTerms | null {
  if (!hasAlipayCollectionTerms(terms)) return null;
  const value = (terms as Record<string, unknown>)[ALIPAY_COLLECTION_TERM];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, recipient_summary, total_minor, currency, expires_at } = value as Record<string, unknown>;
  if (Object.keys(value).length !== 5 || typeof version !== "string" || !VERSION.test(version) ||
      typeof recipient_summary !== "string" || !/^(?:\p{L})?\*{3}$/u.test(recipient_summary) ||
      typeof total_minor !== "number" || !Number.isSafeInteger(total_minor) || total_minor <= 0 || currency !== "CNY") return null;
  try {
    return { version, recipient_summary, total_minor, currency, expires_at: requireIsoTimestamp(expires_at, "expires_at") };
  } catch {
    return null;
  }
}
