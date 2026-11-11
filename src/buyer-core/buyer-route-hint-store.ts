/** Public route-recovery hints for a buyer process restart.
 *
 * A hint only remembers **who** to re-ask about, never a decision. Every use
 * must re-fetch the configured Catalog's public `buyer_access` projection and
 * re-validate the merchant identity before the route is allowed. A hint that
 * is stale, ambiguous or unreadable is not authorization: the caller must
 * fail closed.
 *
 * The file contains no share code, ciphertext, cookie, token or URL parameter.
 * It is deliberately separate from the relay route store: the relay store is
 * only created for the official Catalog with a verified binding trust anchor,
 * while this hint may be written for any explicitly selected route.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeTargetUrl } from "../a2a/client/url-policy.js";
import { writeFileAtomic } from "../fs/atomic-write.js";

export type BuyerRouteHintKind = "direct" | "relay";

export interface BuyerRouteHint {
  agentId: string;
  merchantId: string;
  /** Canonical merchant origin (scheme://host[:port]); no path/query. */
  origin: string;
  /** Last observed route kind. It is a hint for legacy fallback only. */
  kind: BuyerRouteHintKind;
}

const FILE_VERSION = 1;
const MAX_HINTS = 256;

function canonicalCatalogBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid buyer-route hint catalog base");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("invalid buyer-route hint catalog base");
  return url.href.replace(/\/+$/, "");
}

function validHint(hint: BuyerRouteHint): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(hint.agentId)) return false;
  if (typeof hint.merchantId !== "string" || hint.merchantId === "" || hint.merchantId.length > 256)
    return false;
  if (hint.kind !== "direct" && hint.kind !== "relay") return false;
  try {
    const url = assertSafeTargetUrl(hint.origin);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === hint.origin
    );
  } catch {
    return false;
  }
}

export class BuyerRouteHintStore {
  private readonly file: string;
  private readonly catalogBase: string;

  constructor(dataDir: string, catalogBase: string) {
    this.catalogBase = canonicalCatalogBase(catalogBase);
    this.file = path.join(dataDir, "buyer-route-hints.json");
  }

  private read(): BuyerRouteHint[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as {
        version?: unknown;
        catalogBase?: unknown;
        routes?: unknown;
      };
      if (
        data.version !== FILE_VERSION ||
        data.catalogBase !== this.catalogBase ||
        !Array.isArray(data.routes) ||
        data.routes.length > MAX_HINTS
      )
        return [];
      return data.routes.filter((item): item is BuyerRouteHint => {
        if (item === null || typeof item !== "object") return false;
        const candidate = item as Record<string, unknown>;
        const hint: BuyerRouteHint = {
          agentId: String(candidate["agentId"] ?? ""),
          merchantId: String(candidate["merchantId"] ?? ""),
          origin: String(candidate["origin"] ?? ""),
          kind: candidate["kind"] === "relay" ? "relay" : "direct",
        };
        return (
          candidate["kind"] === "direct" ||
          candidate["kind"] === "relay"
        ) && validHint(hint);
      });
    } catch {
      return [];
    }
  }

  /**
   * Unique hint for an origin. If two different merchants/agents share the
   * same origin, the hint is ambiguous and must not pick either one.
   */
  getByOrigin(origin: string): BuyerRouteHint | undefined {
    const matches = this.read().filter((item) => item.origin === origin);
    if (matches.length === 0) return undefined;
    const identities = new Set(matches.map((item) => `${item.agentId}\u0000${item.merchantId}`));
    if (identities.size !== 1) return undefined;
    // The same identity may have been remembered first as relay and later as
    // direct (or vice versa); the caller re-fetches the Catalog anyway, so the
    // most recent write wins only for the legacy fallback kind.
    return matches[matches.length - 1];
  }

  remember(hint: BuyerRouteHint): void {
    if (!validHint(hint)) throw new Error("invalid buyer-route hint");
    const existing = this.read();
    const others = existing.filter(
      (item) =>
        !(
          item.origin === hint.origin &&
          item.agentId === hint.agentId &&
          item.merchantId === hint.merchantId
        ),
    );
    if (others.length >= MAX_HINTS) throw new Error("buyer-route hint store is full");
    const routes = [...others, hint];
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: FILE_VERSION, catalogBase: this.catalogBase, routes }),
      { mode: 0o600 },
    );
  }
}
