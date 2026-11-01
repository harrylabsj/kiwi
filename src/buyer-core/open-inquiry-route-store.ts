/** Public routing hints for restoring an account-free inquiry after restart.
 * Hints are not trusted: every use must re-verify the Catalog binding.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeTargetUrl } from "../a2a/client/url-policy.js";
import { writeFileAtomic } from "../fs/atomic-write.js";

export interface OpenInquiryRouteHint { agentId: string; merchantId: string; endpoint: string }

export class OpenInquiryRouteStore {
  private readonly file: string;
  private readonly origin: string;
  constructor(dataDir: string, catalogOrigin: string) {
    const url = assertSafeTargetUrl(catalogOrigin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
      throw new Error("invalid Catalog origin");
    this.origin = url.origin;
    this.file = path.join(dataDir, "open-inquiry-routes.json");
  }

  private valid(hint: OpenInquiryRouteHint): boolean {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(hint.agentId) || !hint.merchantId || hint.merchantId.length > 256) return false;
    try {
      const url = assertSafeTargetUrl(hint.endpoint);
      return url.protocol === "https:" && url.pathname === "/a2a" && !url.search && !url.hash && url.href === hint.endpoint;
    } catch { return false; }
  }

  private read(): OpenInquiryRouteHint[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; catalogOrigin?: unknown; routes?: unknown };
      if (data.version !== 1 || data.catalogOrigin !== this.origin || !Array.isArray(data.routes) || data.routes.length > 256) return [];
      return data.routes.filter((item): item is OpenInquiryRouteHint => item !== null && typeof item === "object" &&
        typeof item.agentId === "string" && typeof item.merchantId === "string" && typeof item.endpoint === "string" && this.valid(item));
    } catch { return []; }
  }

  get(endpoint: string): OpenInquiryRouteHint | undefined {
    const matches = this.read().filter((item) => item.endpoint === endpoint);
    return matches.length === 1 ? matches[0] : undefined;
  }

  remember(hint: OpenInquiryRouteHint): void {
    if (!this.valid(hint)) throw new Error("invalid open inquiry route hint");
    const existing = this.read();
    if (existing.some((item) => item.endpoint === hint.endpoint &&
        (item.agentId !== hint.agentId || item.merchantId !== hint.merchantId)))
      throw new Error("ambiguous open inquiry endpoint");
    const others = existing.filter((item) => item.endpoint !== hint.endpoint);
    const routes = [...others.slice(-255), { agentId: hint.agentId, merchantId: hint.merchantId, endpoint: hint.endpoint }];
    writeFileAtomic(this.file, JSON.stringify({ version: 1, catalogOrigin: this.origin, routes }), { mode: 0o600 });
  }
}
