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
 * 商家连接器入口 → kiwi-catalog 商家公开资料客户端（写侧，凭据为 `cmt_…`）。
 *
 *   POST {base}/v1/merchant-publications                （action=draft|publish）
 *   GET  {base}/v1/merchant-publications/{id}
 *   POST {base}/v1/merchant-publications/{id}/withdraw
 *
 * 契约来源：kiwi-catalog 仓 kiwi_catalog/services/merchant_publications.py 的
 * validate_payload / public_projection（schema v29+，M0 工作包 A）。
 *
 * 硬边界：
 *   - merchant_id 由目录按凭据绑定决定，**客户端永远不传**；
 *   - 本客户端只把 `action=draft` 用于常规保存；`publish` 只应由商家在门户
 *     确认页触发（入口不替商家确认，见第 1 版设计 §3.3 / §4 执行控制）；
 *   - 出站加固与既有 catalog 客户端一致：不跟随重定向、超时、响应字段校验。
 */

import { PRODUCT_VERSION } from "../product-cli.js";
import { isRedirectResponse, readJsonBody } from "../net/safe-http.js";
import { CatalogSourceError } from "../discovery/catalog-source/errors.js";
import { validateBaseUrl } from "../discovery/catalog-source/source.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** 商家公开资料（目录公开投影；写路径同样返回该投影）。 */
export interface MerchantPublicationView {
  readonly publication_id: string;
  readonly merchant_id: string;
  readonly merchant_display_name: string;
  readonly title: string;
  readonly category: string;
  readonly summary: string;
  readonly shop_platform: string;
  readonly shop_url: string;
  readonly faq: ReadonlyArray<{ question: string; answer: string }>;
  readonly source_kind: string;
  readonly status: string;
  readonly version: number;
  readonly published_at: string;
  readonly expires_at: string;
  readonly updated_at: string;
  readonly inquiry_available: false;
}

export interface PublicationDraftInput {
  merchantDisplayName: string;
  title: string;
  category?: string;
  summary?: string;
  shopPlatform?: string;
  shopUrl?: string;
  faq?: ReadonlyArray<{ question: string; answer: string }>;
  expiresAt?: string;
}

export interface PublicationSaveResult {
  readonly publication: MerchantPublicationView;
  readonly created: boolean;
  readonly idempotent: boolean;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogSourceError(
      "response_invalid",
      `merchant-publications response is missing object field "${field}"`,
    );
  }
  return value as Record<string, unknown>;
}

function asString(record: Record<string, unknown>, field: string): string {
  return typeof record[field] === "string" ? (record[field] as string) : "";
}

function toPublication(value: unknown): MerchantPublicationView {
  const record = asRecord(value, "publication");
  const faq = Array.isArray(record.faq)
    ? record.faq.map((item) => {
        const entry = asRecord(item, "publication.faq[]");
        return { question: asString(entry, "question"), answer: asString(entry, "answer") };
      })
    : [];
  const publicationId = asString(record, "publication_id");
  const merchantId = asString(record, "merchant_id");
  if (publicationId === "" || merchantId === "") {
    throw new CatalogSourceError(
      "response_invalid",
      "merchant-publications response is missing publication_id or merchant_id",
    );
  }
  if (record.inquiry_available !== false) {
    // 第 0 版公开资料恒不可实时询价；为 true 视为协议级违规（不得向上传播）。
    throw new CatalogSourceError(
      "contract_violation",
      "merchant-publications projected inquiry_available must be false",
    );
  }
  return {
    publication_id: publicationId,
    merchant_id: merchantId,
    merchant_display_name: asString(record, "merchant_display_name"),
    title: asString(record, "title"),
    category: asString(record, "category"),
    summary: asString(record, "summary"),
    shop_platform: asString(record, "shop_platform"),
    shop_url: asString(record, "shop_url"),
    faq,
    source_kind: asString(record, "source_kind"),
    status: asString(record, "status"),
    version: typeof record.version === "number" ? record.version : 0,
    published_at: asString(record, "published_at"),
    expires_at: asString(record, "expires_at"),
    updated_at: asString(record, "updated_at"),
    inquiry_available: false,
  };
}

export interface MerchantPublicationClientDeps {
  /** Catalog 服务根 URL。 */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class MerchantPublicationClient {
  private readonly baseUrl: string;
  private readonly deps: MerchantPublicationClientDeps;

  constructor(deps: MerchantPublicationClientDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    this.deps = deps;
  }

  /** 保存草稿（action=draft；发布不由入口执行）。 */
  async saveDraft(token: string, input: PublicationDraftInput): Promise<PublicationSaveResult> {
    const body = await this.request(token, "POST", "/v1/merchant-publications", {
      action: "draft",
      merchant_display_name: input.merchantDisplayName,
      title: input.title,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.shopPlatform !== undefined ? { shop_platform: input.shopPlatform } : {}),
      ...(input.shopUrl !== undefined ? { shop_url: input.shopUrl } : {}),
      ...(input.faq !== undefined ? { faq: input.faq } : {}),
      ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
    });
    return {
      publication: toPublication(body.publication),
      created: body.created === true,
      idempotent: body.idempotent === true,
    };
  }

  async getPublication(token: string, publicationId: string): Promise<MerchantPublicationView> {
    const body = await this.request(
      token,
      "GET",
      `/v1/merchant-publications/${encodeURIComponent(publicationId)}`,
    );
    return toPublication(body.publication);
  }

  async withdraw(token: string, publicationId: string): Promise<MerchantPublicationView> {
    const body = await this.request(
      token,
      "POST",
      `/v1/merchant-publications/${encodeURIComponent(publicationId)}/withdraw`,
      {},
    );
    return toPublication(body.publication);
  }

  private async request(
    token: string,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof token !== "string" || token.trim() === "") {
      throw new CatalogSourceError(
        "invalid_input",
        "merchant publication request requires a merchant credential",
      );
    }
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let raw: unknown;
    try {
      try {
        response = await fetchImpl(url, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            authorization: `Bearer ${token}`,
            "user-agent": `kiwi-merchant-entry/${PRODUCT_VERSION}`,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const detail = err instanceof Error ? err.message : String(err);
        throw new CatalogSourceError(
          "request_failed",
          name === "AbortError"
            ? `kiwi-catalog merchant request timed out after ${timeoutMs}ms: ${url}`
            : `kiwi-catalog merchant request failed: ${url} (${detail})`,
        );
      }
      if (isRedirectResponse(response)) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog merchant request must not follow redirects (HTTP ${response.status} from ${url})`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new CatalogSourceError(
          "session_rejected",
          `kiwi-catalog rejected the merchant credential (HTTP ${response.status} from ${url})`,
        );
      }
      if (!response.ok) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog merchant request returned HTTP ${response.status} from ${url}`,
        );
      }
      try {
        raw = await readJsonBody(response, { signal: controller.signal });
      } catch {
        throw new CatalogSourceError(
          "response_invalid",
          `kiwi-catalog merchant response from ${url} is not valid JSON`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    const envelope = asRecord(raw, "envelope");
    if (envelope.ok !== true) {
      throw new CatalogSourceError(
        "response_invalid",
        `merchant-publications response is not ok: ${
          typeof envelope.error === "string" ? envelope.error : "unknown error"
        }`,
      );
    }
    return envelope;
  }
}
