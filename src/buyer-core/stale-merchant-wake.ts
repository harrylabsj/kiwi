/**
 * On-demand wake probe for a WorkBuddy-hosted merchant that has gone stale.
 *
 * A public GET to the host is intentionally only a wake signal: it never
 * changes catalog state. Freshness can recover only after the merchant's
 * runtime sends its own signed heartbeat to the catalog. The caller re-reads
 * the catalog and must still see fresh before allowing a quote.
 */
import type { MerchantRecord } from "./service.js";
import { assertResolvableTargetUrl, assertSafeTargetUrl } from "../a2a/client/url-policy.js";

export interface StaleMerchantWakeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test-only escape hatch; production must keep public-range protections. */
  allowPrivateRanges?: boolean;
  skipDnsCheck?: boolean;
}

const WORKBUDDY_HOST_SUFFIX = ".app.workbuddy.host";
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function isWorkBuddyHost(hostname: string): boolean {
  return hostname === "app.workbuddy.host" || hostname.endsWith(WORKBUDDY_HOST_SUFFIX);
}

export class WorkBuddyStaleMerchantWake {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;

  constructor(options: StaleMerchantWakeOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.allowPrivateRanges = options.allowPrivateRanges === true;
    this.skipDnsCheck = options.skipDnsCheck === true;
  }

  /** Return true only when a wake request was actually sent. */
  async wake(record: MerchantRecord): Promise<boolean> {
    if (record.agent_card_url === undefined || record.agent_card_url === "") return false;
    let cardUrl: URL;
    try {
      cardUrl = assertSafeTargetUrl(record.agent_card_url, {
        allowPrivateRanges: this.allowPrivateRanges,
        allowLoopback: false,
      });
      await assertResolvableTargetUrl(cardUrl, {
        allowPrivateRanges: this.allowPrivateRanges,
        skipDnsCheck: this.skipDnsCheck,
      });
    } catch {
      return false;
    }
    const card = await this.getJson(cardUrl);
    if (card === undefined) return false;

    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
    const candidates = [
      ...interfaces.flatMap((value) =>
        typeof value === "object" && value !== null && typeof value.url === "string"
          ? [value.url]
          : [],
      ),
      ...(typeof card.url === "string" ? [card.url] : []),
    ];
    for (const raw of candidates) {
      let endpoint: URL;
      try {
        endpoint = assertSafeTargetUrl(raw, {
          allowPrivateRanges: this.allowPrivateRanges,
          allowLoopback: false,
        });
        if (!isWorkBuddyHost(endpoint.hostname)) continue;
        if (endpoint.username !== "" || endpoint.password !== "") continue;
        if (endpoint.search !== "") continue; // never carry sharecode or other secrets
        await assertResolvableTargetUrl(endpoint, {
          allowPrivateRanges: this.allowPrivateRanges,
          skipDnsCheck: this.skipDnsCheck,
        });
      } catch {
        continue;
      }
      const wakeUrl = new URL("/livez", endpoint.origin);
      try {
        const response = await this.fetchWithTimeout(wakeUrl, {
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json" },
        });
        // Any HTTP status (including 403/404) only means the request reached
        // the platform gateway. It does NOT prove the application cold-started
        // or that a heartbeat was emitted; the caller must re-read the catalog
        // and a real merchant heartbeat is the only freshness authority.
        await response.body?.cancel().catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async getJson(url: URL): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.fetchWithTimeout(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const body = (await response.json()) as unknown;
      return body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchWithTimeout(url: URL, init: FetchInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
