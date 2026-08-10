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
 * ShoppingCliCommerceDataSource —— shopping-cli 商品开放层 adapter
 * （shopping-cli data hub v0.2.1 §3/#5：shopping-cli 可作为 Merchant
 * CommerceDataSource，完成定义 #5）。
 *
 * 端点契约（shopping-cli 仓 route_registry）：
 *   GET {baseUrl}/products/{sku}        → {product: {...}}
 *   GET {baseUrl}/search/products?limit= → {results: [...]}
 *
 * 字段语义：
 *   - shopping-cli 的 `price` 以「元」为单位（float）→ 转换为
 *     `price_minor`（minor units，KNP Money 约定；两位小数假设，文档注明）；
 *   - 权威语义 UPSTREAM_PROXY（数据权威在 shopping-cli 侧，Kiwi 只读）。
 */

import { CommerceError, type CommerceDataSource, type CommerceField, type ProductFact, type ProductSearchQuery } from "./data-source.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../net/safe-http.js";
import { toMinorUnits as losslessToMinorUnits } from "../protocol/legacy-shopping-negotiation/money.js";
import type { CommerceHealth } from "./types.js";

export interface ShoppingCliCommerceDataSourceDeps {
  /** shopping-cli 服务根 URL（http/https，无 userinfo/query/fragment）。 */
  baseUrl: string;
  /** 可选的 bearer 凭证（merchants 角色只读 token）。 */
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
    throw new CommerceError("invalid_input", `shopping-cli baseUrl is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CommerceError("invalid_input", `shopping-cli baseUrl must use http or https (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new CommerceError("invalid_input", "shopping-cli baseUrl must not embed credentials (userinfo)");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CommerceError(
      "invalid_input",
      "shopping-cli baseUrl must not contain query or fragment (paths are appended to it)",
    );
  }
  return value.replace(/\/+$/, "");
}

interface ShoppingCliProductWire {
  sku?: unknown;
  merchant_id?: unknown;
  title?: unknown;
  price?: unknown;
  currency?: unknown;
  stock?: unknown;
  delivery_attributes?: unknown;
}

/** shopping-cli price（元）→ price_minor（minor units，两位小数假设）。
 * 审查 P2-P：复用 legacy-shopping-negotiation/money.ts 的 lossless 原语——
 * 此前 Math.round(price*100) 静默吞掉精度损失（19.995 → 19.99、
 * 19.999 → 20.00），错误价格进入 merchant offer terms（谈判路径严格执行
 * lossless，数据源路径不执行）。lossy → fail-closed（返回 undefined，
 * 价格事实缺省，绝不静默抹平；调用方回退演示价并注记）。 */
function toMinorUnits(price: unknown): number | undefined {
  if (typeof price !== "number") return undefined;
  const converted = losslessToMinorUnits(price, 2);
  return converted.lossless ? converted.amount_minor : undefined;
}

function parseProduct(raw: unknown, path: string): ProductFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CommerceError("request_failed", `shopping-cli product at ${path} is not an object`);
  }
  const obj = raw as ShoppingCliProductWire;
  const sku = obj.sku;
  if (typeof sku !== "string" || sku.length === 0) {
    throw new CommerceError("request_failed", `shopping-cli product at ${path} is missing sku`);
  }
  const priceMinor = toMinorUnits(obj.price);
  return {
    sku,
    ...(typeof obj.title === "string" && obj.title !== "" ? { title: obj.title } : {}),
    ...(priceMinor !== undefined ? { price_minor: priceMinor } : {}),
    ...(typeof obj.currency === "string" && obj.currency !== "" ? { currency: obj.currency } : {}),
    ...(typeof obj.stock === "number" && Number.isInteger(obj.stock) ? { stock: obj.stock } : {}),
  };
}

/** shopping-cli 商品开放层数据源（UPSTREAM_PROXY，source="shopping-cli"）。 */
export class ShoppingCliCommerceDataSource implements CommerceDataSource {
  private readonly baseUrl: string;
  private readonly deps: ShoppingCliCommerceDataSourceDeps;

  constructor(deps: ShoppingCliCommerceDataSourceDeps) {
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
        // 出站加固：绝不跟随重定向（3xx 目标不经过校验，且可能转发 Bearer 头）。
        redirect: "manual",
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
          ? `shopping-cli request timed out after ${timeoutMs}ms: ${url}`
          : `shopping-cli request failed: ${url} (${detail})`,
      );
    }
    if (isRedirectResponse(response)) {
      throw new CommerceError(
        "request_failed",
        `shopping-cli request must not follow redirects (HTTP ${response.status} from ${url})`,
      );
    }
    if (response.status === 404) {
      // 404 = 资源不存在：getProduct 的"未知 SKU → undefined"接口承诺
      //（composite 次要源靠它跳过自身不收录的 SKU，而不是整体抛错）。
      return null;
    }
    if (!response.ok) {
      throw new CommerceError("request_failed", `shopping-cli request returned HTTP ${response.status} from ${url}`);
    }
    let raw: unknown;
    try {
      // 响应体读取在超时覆盖内 + 大小上限（出站加固）。
      raw = await readJsonBody(response, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new CommerceError(
          "request_failed",
          `shopping-cli request timed out after ${timeoutMs}ms while reading response: ${url}`,
        );
      }
      throw new CommerceError(
        "request_failed",
        err instanceof SafeHttpError && err.code === "response_too_large"
          ? `shopping-cli response from ${url}: ${err.message}`
          : `shopping-cli response from ${url} is not valid JSON`,
      );
    } finally {
      clearTimeout(timer);
    }
    return raw;
  }

  async getProduct(sku: string): Promise<ProductFact | undefined> {
    if (typeof sku !== "string" || sku.length === 0) {
      throw new CommerceError("invalid_input", "sku must be a non-empty string");
    }
    const raw = await this.getJson(`/products/${encodeURIComponent(sku)}`);
    if (raw === null) return undefined; // 404 → 未知 SKU（接口承诺）
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new CommerceError("request_failed", "shopping-cli get product response must be an object");
    }
    const body = raw as Record<string, unknown>;
    if (body.product === undefined) {
      throw new CommerceError("request_failed", 'shopping-cli get product response is missing field "product"');
    }
    return parseProduct(body.product, `/products/${sku}`);
  }

  async getProducts(query: ProductSearchQuery = {}): Promise<ProductFact[]> {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 100));
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    // wire 参数名与 shopping-cli /search/products 一致（FastAPI 与 fallback 两分支只认 query）
    if (query.query !== undefined && query.query !== "") params.set("query", query.query);
    const raw = await this.getJson(`/search/products?${params.toString()}`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CommerceError("request_failed", "shopping-cli search products response must be an object");
    }
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body.results)) {
      throw new CommerceError(
        "request_failed",
        'shopping-cli search products response is missing array field "results"',
      );
    }
    return body.results.map((element, i) => parseProduct(element, `/search/products/${i}`));
  }

  async getInventory(sku: string): Promise<CommerceField<number> | undefined> {
    const product = await this.getProduct(sku);
    if (product?.stock === undefined) return undefined;
    return { value: product.stock, authority: "UPSTREAM_PROXY", source: "shopping-cli" };
  }

  async getPrice(
    sku: string,
  ): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined> {
    const product = await this.getProduct(sku);
    if (product?.price_minor === undefined || product.currency === undefined) return undefined;
    return {
      value: { currency: product.currency, amount_minor: product.price_minor },
      authority: "UPSTREAM_PROXY",
      source: "shopping-cli",
    };
  }

  async getPublicListing(): Promise<Record<string, unknown>> {
    const products = await this.getProducts({ limit: 100 });
    return { source: "shopping-cli", count: products.length, products };
  }

  async health(): Promise<CommerceHealth> {
    try {
      await this.getJson("/health");
      return { ok: true, service: "shopping-cli-commerce-data-source", version: "1" };
    } catch (err) {
      return {
        ok: false,
        service: "shopping-cli-commerce-data-source",
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
