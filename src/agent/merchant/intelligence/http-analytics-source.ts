/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { readJsonBody, SafeHttpError, isRedirectResponse } from "../../../net/safe-http.js";
import type { MerchantAnalyticsSource } from "./types.js";
import type { MetricSeries, MetricValue, DataLimitation } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export interface HttpMerchantAnalyticsSourceOptions {
  /** HTTPS is required for remote services; HTTP is allowed only on loopback. */
  baseUrl: string;
  /** Kept in memory for the request only; never included in error messages. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class MerchantAnalyticsHttpError extends Error {
  readonly status?: number;
  readonly code: "configuration" | "transport" | "protocol" | "auth" | "unavailable";

  constructor(
    code: MerchantAnalyticsHttpError["code"],
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "MerchantAnalyticsHttpError";
    this.code = code;
    this.status = status;
  }
}

function assertBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MerchantAnalyticsHttpError("configuration", "analytics baseUrl must be a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new MerchantAnalyticsHttpError("configuration", "analytics baseUrl must not contain credentials");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MerchantAnalyticsHttpError("configuration", "analytics baseUrl must use http or https");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase())) {
    throw new MerchantAnalyticsHttpError("configuration", "analytics baseUrl must use HTTPS for remote hosts");
  }
  return value.replace(/\/+$/, "");
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MerchantAnalyticsHttpError("protocol", message);
  }
  return value as Record<string, unknown>;
}

function requireMerchant(value: unknown, expected: string): void {
  if (value !== expected) {
    throw new MerchantAnalyticsHttpError("protocol", "analytics response merchant_id mismatch");
  }
}

function limitations(value: unknown): DataLimitation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new MerchantAnalyticsHttpError("protocol", "analytics limitations must be an array");
  const result = value.filter((item): item is DataLimitation =>
    item !== null && typeof item === "object" &&
    typeof (item as { source?: unknown }).source === "string" &&
    typeof (item as { note?: unknown }).note === "string",
  );
  if (result.length !== value.length) throw new MerchantAnalyticsHttpError("protocol", "analytics limitation item is invalid");
  return result;
}

function metricValues(value: unknown): MetricValue[] {
  if (!Array.isArray(value)) throw new MerchantAnalyticsHttpError("protocol", "analytics metrics must be an array");
  if (value.length > 1_000) throw new MerchantAnalyticsHttpError("protocol", "analytics metrics exceed 1000 items");
  const names = new Set<string>();
  return value.map((item) => {
    const metric = object(item, "analytics metric must be an object");
    if (
      typeof metric.name !== "string" || metric.name.length === 0 || metric.name.length > 80 ||
      (metric.value !== null && (typeof metric.value !== "number" || !Number.isFinite(metric.value))) ||
      (metric.unit !== "count" && metric.unit !== "percent" && metric.unit !== "minor_currency") ||
      typeof metric.observed_at !== "string" || metric.observed_at.length === 0 ||
      (metric.currency !== undefined && typeof metric.currency !== "string") ||
      (metric.note !== undefined && typeof metric.note !== "string")
    ) throw new MerchantAnalyticsHttpError("protocol", `analytics metric ${String(metric.name)} is invalid`);
    if (names.has(metric.name)) throw new MerchantAnalyticsHttpError("protocol", `analytics metric ${metric.name} is duplicated`);
    names.add(metric.name);
    return metric as unknown as MetricValue;
  });
}

function metricSeries(value: unknown, expected: { metric: string; period: string; granularity: "day" | "week" | "month" }): MetricSeries {
  const series = object(value, "analytics series must be an object");
  if (
    series.metric !== expected.metric || series.period !== expected.period || series.granularity !== expected.granularity ||
    (series.unit !== "count" && series.unit !== "percent" && series.unit !== "minor_currency") ||
    !Array.isArray(series.points) || series.points.length > 10_000 ||
    (series.currency !== undefined && typeof series.currency !== "string") ||
    (series.note !== undefined && typeof series.note !== "string")
  ) throw new MerchantAnalyticsHttpError("protocol", "analytics series metadata is invalid");
  for (const point of series.points) {
    const item = object(point, "analytics series point must be an object");
    if (typeof item.date !== "string" || item.date.length === 0 || item.date.length > 32 ||
      typeof item.value !== "number" || !Number.isFinite(item.value)) {
      throw new MerchantAnalyticsHttpError("protocol", "analytics series point is invalid");
    }
  }
  return series as unknown as MetricSeries;
}

/**
 * Generic server-side adapter for order, sales, campaign or advertising
 * services. The remote service is never exposed to the model as a tool.
 *
 * Contract:
 *   GET /v1/merchant/analytics/metrics?merchant_id=...&period=7d
 *     -> { ok: true, merchant_id, metrics, limitations? }
 *   GET /v1/merchant/analytics/series?merchant_id=...&metric=...&period=7d&granularity=day
 *     -> { ok: true, merchant_id, series: MetricSeries }
 * A 404 on the series endpoint means the source does not provide that metric.
 */
export class HttpMerchantAnalyticsSource implements MerchantAnalyticsSource {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HttpMerchantAnalyticsSourceOptions) {
    this.baseUrl = assertBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
    this.maxResponseBytes = Math.max(1_024, Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 8 * 1024 * 1024));
  }

  private async request(path: string, query: Record<string, string>): Promise<{ status: number; payload: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "application/json",
            ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
          },
          signal: controller.signal,
        });
      } catch (error) {
        throw new MerchantAnalyticsHttpError("transport", `analytics request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (isRedirectResponse(response)) {
        throw new MerchantAnalyticsHttpError("transport", "analytics endpoint must not redirect", response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new MerchantAnalyticsHttpError("auth", "analytics authorization failed", response.status);
      }
      if (response.status === 404) return { status: response.status, payload: {} };
      let payload: unknown;
      try {
        payload = await readJsonBody(response, { maxBytes: this.maxResponseBytes, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw new MerchantAnalyticsHttpError("transport", "analytics request timed out while reading response");
        if (error instanceof SafeHttpError && error.code === "response_too_large") {
          throw new MerchantAnalyticsHttpError("protocol", "analytics response exceeds the configured size limit");
        }
        throw new MerchantAnalyticsHttpError("protocol", "analytics response is not valid JSON");
      }
      const body = object(payload, "analytics response must be an object");
      if (!response.ok || body.ok === false) throw new MerchantAnalyticsHttpError("unavailable", "analytics service returned an error", response.status);
      if (body.ok !== true) throw new MerchantAnalyticsHttpError("protocol", "analytics response must set ok=true", response.status);
      return { status: response.status, payload: body };
    } finally {
      clearTimeout(timer);
    }
  }

  async getMetrics(input: { merchant_id: string; period: string }): Promise<{ metrics: MetricValue[]; limitations?: DataLimitation[] }> {
    const { payload } = await this.request("/v1/merchant/analytics/metrics", input);
    requireMerchant(payload.merchant_id, input.merchant_id);
    return {
      metrics: metricValues(payload.metrics),
      ...(payload.limitations === undefined ? {} : { limitations: limitations(payload.limitations) }),
    };
  }

  async queryMetric(input: { merchant_id: string; metric: string; period: string; granularity: "day" | "week" | "month" }): Promise<MetricSeries | undefined> {
    const { status, payload } = await this.request("/v1/merchant/analytics/series", input);
    if (status === 404) return undefined;
    requireMerchant(payload.merchant_id, input.merchant_id);
    return metricSeries(payload.series, input);
  }
}
