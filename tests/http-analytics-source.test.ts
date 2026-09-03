import { describe, expect, it } from "vitest";
import { HttpMerchantAnalyticsSource } from "../src/agent/merchant/intelligence/http-analytics-source.js";

type FetchCall = { url: string; headers: Record<string, string> };

function stubFetch(response: Response | ((call: FetchCall) => Response)): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const call = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    return typeof response === "function" ? response(call) : response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("HttpMerchantAnalyticsSource", () => {
  it("requests the documented endpoint and validates the merchant envelope", async () => {
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.url.includes("/metrics?")) {
        return new Response(JSON.stringify({
          ok: true,
          merchant_id: "merchant-001",
          metrics: [{ name: "gross_sales", value: 12345, unit: "minor_currency", currency: "CNY", observed_at: "2026-09-03T00:00:00Z" }],
          limitations: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        ok: true,
        merchant_id: "merchant-001",
        series: {
          metric: "gross_sales",
          unit: "minor_currency",
          currency: "CNY",
          period: "7d",
          granularity: "week",
          points: [{ date: "2026-08-31", value: 12345 }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const source = new HttpMerchantAnalyticsSource({
      baseUrl: "https://analytics.example.com/",
      token: "analytics-token",
      fetchImpl,
    });
    await expect(source.getMetrics({ merchant_id: "merchant-001", period: "7d" })).resolves.toMatchObject({
      metrics: [{ name: "gross_sales", value: 12345 }],
    });
    await expect(source.queryMetric({ merchant_id: "merchant-001", metric: "gross_sales", period: "7d", granularity: "week" })).resolves.toMatchObject({
      metric: "gross_sales",
      granularity: "week",
    });
    expect(calls[0]?.url).toBe("https://analytics.example.com/v1/merchant/analytics/metrics?merchant_id=merchant-001&period=7d");
    expect(calls[0]?.headers.authorization).toBe("Bearer analytics-token");
    expect(calls[1]?.url).toContain("/v1/merchant/analytics/series?");
    expect(calls[1]?.url).toContain("granularity=week");
  });

  it("fails closed on cross-merchant, redirect and malformed responses", async () => {
    const mismatch = stubFetch(new Response(JSON.stringify({ ok: true, merchant_id: "merchant-evil", metrics: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const source = new HttpMerchantAnalyticsSource({ baseUrl: "https://analytics.example.com", fetchImpl: mismatch.fetchImpl });
    await expect(source.getMetrics({ merchant_id: "merchant-001", period: "1d" })).rejects.toThrow(/merchant_id mismatch/);

    const redirect = stubFetch(new Response("", { status: 302, headers: { location: "https://evil.example" } }));
    const redirectSource = new HttpMerchantAnalyticsSource({ baseUrl: "https://analytics.example.com", fetchImpl: redirect.fetchImpl });
    await expect(redirectSource.getMetrics({ merchant_id: "merchant-001", period: "1d" })).rejects.toThrow(/must not redirect/);

    const malformed = stubFetch(new Response(JSON.stringify({ ok: true, merchant_id: "merchant-001", metrics: [{ name: "bad", value: "not-a-number", unit: "count", observed_at: "now" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const malformedSource = new HttpMerchantAnalyticsSource({ baseUrl: "https://analytics.example.com", fetchImpl: malformed.fetchImpl });
    await expect(malformedSource.getMetrics({ merchant_id: "merchant-001", period: "1d" })).rejects.toThrow(/metric bad is invalid/);
  });

  it("treats an unsupported series metric as unavailable and rejects unsafe URLs", async () => {
    const notFound = stubFetch(new Response(JSON.stringify({ ok: false }), { status: 404, headers: { "content-type": "application/json" } }));
    const source = new HttpMerchantAnalyticsSource({ baseUrl: "https://analytics.example.com", fetchImpl: notFound.fetchImpl });
    await expect(source.queryMetric({ merchant_id: "merchant-001", metric: "roas", period: "7d", granularity: "day" })).resolves.toBeUndefined();
    expect(() => new HttpMerchantAnalyticsSource({ baseUrl: "http://analytics.example.com" })).toThrow(/HTTPS/);
    expect(() => new HttpMerchantAnalyticsSource({ baseUrl: "https://user:pass@analytics.example.com" })).toThrow(/credentials/);
  });

  it("rejects duplicate metric names from one remote response", async () => {
    const duplicate = stubFetch(new Response(JSON.stringify({
      ok: true,
      merchant_id: "merchant-001",
      metrics: [
        { name: "roas", value: 1.2, unit: "percent", observed_at: "2026-09-03T00:00:00Z" },
        { name: "roas", value: 1.3, unit: "percent", observed_at: "2026-09-03T00:00:00Z" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const source = new HttpMerchantAnalyticsSource({ baseUrl: "https://analytics.example.com", fetchImpl: duplicate.fetchImpl });
    await expect(source.getMetrics({ merchant_id: "merchant-001", period: "1d" })).rejects.toThrow(/duplicated/);
  });
});
