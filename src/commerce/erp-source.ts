/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * ErpCommerceDataSource —— HTTP ERP adapter（shopping-cli data hub
 * v0.2.1 §3/#7「至少一种 ERP / external business data adapter」）。
 *
 * 上游代理语义（UPSTREAM_PROXY）：字段权威在外部 ERP；Kiwi 只做
 * 读取与超时/HTTP 失败映射（fail-closed，不静默容错）。任何非 2xx /
 * 网络 / 超时 / 结构错误抛 CommerceError。
 */

import { CommerceError, type CommerceDataSource, type CommerceField, type ProductFact, type ProductSearchQuery } from "./data-source.js";
import type { CommerceHealth } from "./types.js";

export interface ErpCommerceDataSourceDeps {
  /** ERP 服务根 URL（http/https，无 userinfo/query/fragment）。 */
  baseUrl: string;
  /** 可选的 bearer 凭证。 */
  authToken?: string;
  /** 拉取超时 ms（默认 15000）。 */
  timeoutMs?: number;
  /** 注入 fetch（测试）。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CommerceError("invalid_input", `erp baseUrl is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CommerceError("invalid_input", `erp baseUrl must use http or https (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new CommerceError("invalid_input", "erp baseUrl must not embed credentials (userinfo)");
  }
  return value.replace(/\/+$/, "");
}

function parseProduct(raw: unknown, path: string): ProductFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CommerceError("request_failed", `erp product at ${path} is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const sku = obj.sku;
  if (typeof sku !== "string" || sku.length === 0) {
    throw new CommerceError("request_failed", `erp product at ${path} is missing sku`);
  }
  const fact: ProductFact = {
    sku,
    ...(typeof obj.title === "string" && obj.title !== "" ? { title: obj.title } : {}),
    ...(typeof obj.price_minor === "number" && Number.isInteger(obj.price_minor)
      ? { price_minor: obj.price_minor }
      : {}),
    ...(typeof obj.currency === "string" && obj.currency !== "" ? { currency: obj.currency } : {}),
    ...(typeof obj.stock === "number" && Number.isInteger(obj.stock) ? { stock: obj.stock } : {}),
    ...(typeof obj.delivery_lead_days === "number" && Number.isInteger(obj.delivery_lead_days)
      ? { delivery_lead_days: obj.delivery_lead_days }
      : {}),
  };
  return fact;
}

/** ERP 上游数据源（UPSTREAM_PROXY）。 */
export class ErpCommerceDataSource implements CommerceDataSource {
  private readonly baseUrl: string;
  private readonly deps: ErpCommerceDataSourceDeps;

  constructor(deps: ErpCommerceDataSourceDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    this.deps = deps;
  }

  private async getJson(requestPath: string): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.baseUrl}${requestPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(this.deps.authToken !== undefined
            ? { authorization: `Bearer ${this.deps.authToken}` }
            : {}),
        },
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const detail = err instanceof Error ? err.message : String(err);
      throw new CommerceError(
        "request_failed",
        name === "AbortError"
          ? `erp request timed out after ${timeoutMs}ms: ${url}`
          : `erp request failed: ${url} (${detail})`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new CommerceError("request_failed", `erp request returned HTTP ${response.status} from ${url}`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new CommerceError("request_failed", `erp response from ${url} is not valid JSON`);
    }
    return raw;
  }

  async getProduct(sku: string): Promise<ProductFact | undefined> {
    if (typeof sku !== "string" || sku.length === 0) {
      throw new CommerceError("invalid_input", "sku must be a non-empty string");
    }
    const raw = await this.getJson(`/products/${encodeURIComponent(sku)}`);
    if (raw === null) return undefined;
    return parseProduct(raw, `/products/${sku}`);
  }

  async getProducts(query: ProductSearchQuery = {}): Promise<ProductFact[]> {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 100));
    const params = new URLSearchParams();
    if (query.q !== undefined && query.q !== "") params.set("q", query.q);
    params.set("limit", String(limit));
    const raw = await this.getJson(`/products?${params.toString()}`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CommerceError("request_failed", "erp product list response must be an object");
    }
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body.results)) {
      throw new CommerceError("request_failed", 'erp product list response is missing array field "results"');
    }
    return body.results.map((element, i) => parseProduct(element, `/products/${i}`));
  }

  async getInventory(sku: string): Promise<CommerceField<number> | undefined> {
    const product = await this.getProduct(sku);
    if (product?.stock === undefined) return undefined;
    return {
      value: product.stock,
      authority: "UPSTREAM_PROXY",
      source: "erp",
    };
  }

  async getPrice(
    sku: string,
  ): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined> {
    const product = await this.getProduct(sku);
    if (product?.price_minor === undefined || product.currency === undefined) return undefined;
    return {
      value: { currency: product.currency, amount_minor: product.price_minor },
      authority: "UPSTREAM_PROXY",
      source: "erp",
    };
  }

  async getPublicListing(): Promise<Record<string, unknown>> {
    const products = await this.getProducts({ limit: 100 });
    return { source: "erp", count: products.length, products };
  }

  async health(): Promise<CommerceHealth> {
    try {
      await this.getJson("/health");
      return { ok: true, service: "erp-commerce-data-source", version: "1" };
    } catch (err) {
      return {
        ok: false,
        service: "erp-commerce-data-source",
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
