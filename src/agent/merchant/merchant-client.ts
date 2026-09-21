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
 * shopping-cli HTTP Merchant client (design §15.3/§15.4).
 *
 * Catalog/inventory/conversation reads and writes against the real gateway.
 * Tokens come from the CredentialBroker per scope: catalog writes and
 * merchant-scoped reads use the catalog credential, inventory writes use the
 * inventory credential. Tokens are attached per-request and never stored.
 *
 * Trade-off (fail-closed): shopping-cli 2.x has no listing pause/resume
 * endpoint (`active` is internal to the catalog), so pauseListing refuses
 * here with a clear message — the approval machinery still runs, only the
 * final write is refused.
 */

import type { CredentialBroker } from "./credential-broker.js";
import type {
  HumanReviewItem,
  ExactMerchantProduct,
  ExactMerchantProductInput,
  IncomingConsultation,
  InventorySnapshot,
  MerchantCatalogProduct,
  MerchantClient,
  MerchantProductInput,
  MerchantProductPatch,
} from "./types.js";
import {
  MerchantClientError,
  parseHumanReviewItem,
  parseExactMerchantProduct,
  parseIncomingConsultation,
  parseMerchantCatalogProduct,
} from "./types.js";
import { readJsonBody } from "../../net/safe-http.js";
import { writeFileAtomic } from "../../fs/atomic-write.js";
import {
  SHOPPING_CLI_LEGACY_VERIFIED,
  compatRangeText,
  versionInRange,
} from "../../product-compat.js";
import { PROTOCOL_VERSION } from "../../negotiation/types.js";

const REQUEST_TIMEOUT_MS = 10_000;
/** 响应体大小上限（审查 P2-H 配套项：此前无上限，恶意网关可回传巨量 body）。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HttpMerchantClient implements MerchantClient {
  private readonly baseUrl: string;
  private readonly broker: CredentialBroker;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, broker: CredentialBroker, options: { timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.broker = broker;
    // 审查 K-M1：超时可注入（测试用短超时验证 body 停滞不再永久挂起）。
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  // ---- HTTP plumbing -------------------------------------------------------

  private async request(
    method: "GET" | "POST" | "PATCH",
    pathname: string,
    options: { query?: Record<string, string>; body?: unknown; token?: string } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${pathname}${
      options.query ? `?${new URLSearchParams(options.query).toString()}` : ""
    }`;
    const controller = new AbortController();
    // 审查 K-M1：timer 在响应体读完才清理——此前 fetch 头到达即在 finally
    // clearTimeout，随后 await response.arrayBuffer() 不在任何超时覆盖内，
    // 对端停滞 body 会永久挂起该串行工具调用。readJsonBody 用同一 signal，
    // abort 会 cancel 底层流（挂起的 reader.read() 被中断）。
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        // 审查 P2-H：携带 Bearer token 的请求绝不跟随 3xx——重定向会把凭据
        // 转发到第三方域（同仓 http-connector.ts 同款纪律注释）。3xx 在
        // manual 模式下不进 response.ok，下方按非 2xx 处理（fail-closed）。
        redirect: "manual",
        headers: {
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      let payload: unknown;
      try {
        // 响应体大小上限 + 超时覆盖（审查 P2-H / K-M1）：readJsonBody 在
        // signal abort 时 cancel 流，挂起的 body 读不再永久阻塞。
        payload = await readJsonBody(response, {
          signal: controller.signal,
          maxBytes: MAX_RESPONSE_BYTES,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new MerchantClientError(
            "transient",
            `merchant request timed out after ${this.timeoutMs}ms while reading response: ${pathname}`,
          );
        }
        throw new MerchantClientError(
          "transient",
          `merchant returned non-JSON or oversized body (HTTP ${response.status}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (!response.ok) {
        const kind =
          response.status === 404
            ? "not_found"
            : response.status === 401 || response.status === 403
              ? "auth"
              : response.status >= 400 && response.status < 500
                ? "validation"
                : "transient";
        throw new MerchantClientError(kind, `merchant HTTP ${response.status} for ${pathname}`);
      }
      return payload;
    } catch (err) {
      if (err instanceof MerchantClientError) throw err;
      throw new MerchantClientError(
        "transient",
        `merchant request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Catalog credential token; missing scope -> fail closed. */
  private catalogToken(): string {
    const token = this.broker.resolve("catalog");
    if (token === undefined) {
      throw new MerchantClientError(
        "auth",
        "没有 catalog 作用域凭据（commerce.credentials.catalog.token_env 未配置）",
      );
    }
    return token;
  }

  // ---- catalog ---------------------------------------------------------------

  async listProducts(merchantId: string): Promise<MerchantCatalogProduct[]> {
    // Public search endpoint returns merchant_id per product; filter locally.
    // Real gateway has no merchant-owned product listing route.
    // include_out_of_stock=1：商家自查目录要看到全部在架商品（含缺货/暂停），
    // 买家搜索默认排除缺货的行为不适用于商家自己的商品清单。
    // 审查 P2-1：精确库存是私密 inventory——带 catalog 凭据（可解析时）读，
    // 网关按 owner 校验后返回本商家精确 stock；未配置凭据则匿名读（无 stock）。
    // 审查 P2：翻页聚合——此前硬编码 limit=100 无翻页，第 101+ 个商品对
    // CSV 导入的存量判定不可见（误判 create → 批准后逐行冲突）。
    const token = this.broker.resolve("catalog");
    const PAGE_LIMIT = 100;
    const MAX_PAGES = 50; // 5000 件保护上限
    const raw: unknown[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = (await this.request("GET", "/search/products", {
        query: {
          limit: String(PAGE_LIMIT),
          offset: String(offset),
          include_out_of_stock: "1",
        },
        ...(token !== undefined ? { token } : {}),
      })) as { results?: unknown };
      if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
        throw new MerchantClientError(
          "validation",
          "search/products response lacks a results array",
        );
      }
      raw.push(...payload.results);
      if (payload.results.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
    }
    return raw
      .map((p) => parseMerchantCatalogProduct(p))
      .filter((p) => p.merchant_id === merchantId);
  }

  async listExactProducts(merchantId: string): Promise<ExactMerchantProduct[]> {
    const items: ExactMerchantProduct[] = [];
    let offset = 0;
    for (let page = 0; page < 50; page += 1) {
      const payload = (await this.request("GET", "/v1/merchant/products/exact", {
        query: { merchant_id: merchantId, limit: "100", offset: String(offset) },
        token: this.catalogToken(),
      })) as { items?: unknown; next_offset?: unknown };
      if (!Array.isArray(payload.items)) {
        throw new MerchantClientError("validation", "exact product list response is invalid");
      }
      items.push(...payload.items.map(parseExactMerchantProduct));
      if (payload.next_offset === null || payload.next_offset === undefined) return items;
      if (typeof payload.next_offset !== "number" || !Number.isSafeInteger(payload.next_offset)) {
        throw new MerchantClientError("validation", "exact product next_offset is invalid");
      }
      offset = payload.next_offset;
    }
    throw new MerchantClientError("validation", "exact product pagination exceeded 5000 items");
  }

  async getExactProduct(merchantId: string, sku: string): Promise<ExactMerchantProduct> {
    const payload = (await this.request(
      "GET",
      `/v1/merchant/products/${encodeURIComponent(sku)}/exact`,
      {
        query: { merchant_id: merchantId },
        token: this.catalogToken(),
      },
    )) as { product?: unknown };
    return parseExactMerchantProduct(payload.product);
  }

  async createExactProduct(input: ExactMerchantProductInput): Promise<ExactMerchantProduct> {
    const payload = (await this.request("POST", "/v1/merchant/products/exact", {
      body: input,
      token: this.catalogToken(),
    })) as { product?: unknown };
    return parseExactMerchantProduct(payload.product);
  }

  async updateExactProductMoney(input: {
    merchant_id: string;
    sku: string;
    price_minor: string;
    currency_table_version: string;
    expected_authority_version: number;
  }): Promise<ExactMerchantProduct> {
    const payload = (await this.request(
      "PATCH",
      `/v1/merchant/products/${encodeURIComponent(input.sku)}/money`,
      {
        body: {
          merchant_id: input.merchant_id,
          price_minor: input.price_minor,
          currency_table_version: input.currency_table_version,
          expected_authority_version: input.expected_authority_version,
        },
        token: this.catalogToken(),
      },
    )) as { product?: unknown };
    return parseExactMerchantProduct(payload.product);
  }

  async getProduct(sku: string): Promise<MerchantCatalogProduct> {
    // 审查 P2-1：精确库存仅向商品所属商户本人开放——带 catalog 凭据
    // （可解析时）读，网关按 owner 校验；未配置凭据则匿名读（availability）。
    const token = this.broker.resolve("catalog");
    const payload = (await this.request(
      "GET",
      `/products/${encodeURIComponent(sku)}`,
      ...(token !== undefined ? [{ token }] : []),
    )) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "get product response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  async createProduct(input: MerchantProductInput): Promise<MerchantCatalogProduct> {
    const payload = (await this.request("POST", "/products", {
      body: {
        merchant_id: input.merchant_id,
        sku: input.sku,
        title: input.title,
        price: input.price,
        stock: input.stock,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.delivery_attributes !== undefined
          ? { delivery_attributes: input.delivery_attributes }
          : {}),
      },
      token: this.catalogToken(),
    })) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "create product response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  async updateProduct(sku: string, patch: MerchantProductPatch): Promise<MerchantCatalogProduct> {
    const payload = (await this.request("PATCH", `/products/${encodeURIComponent(sku)}`, {
      body: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.price !== undefined ? { price: patch.price } : {}),
        ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.delivery_attributes !== undefined
          ? { delivery_attributes: patch.delivery_attributes }
          : {}),
      },
      token: this.catalogToken(),
    })) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "update product response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  // ---- inventory --------------------------------------------------------------

  async getInventorySnapshot(sku: string): Promise<InventorySnapshot> {
    const product = await this.getProduct(sku);
    return { sku: product.sku, stock: product.stock, observed_at: new Date().toISOString() };
  }

  /** Inventory-scope write: PATCH only the stock field with the inventory token. */
  async updateInventory(sku: string, stock: number): Promise<MerchantCatalogProduct> {
    const token = this.broker.resolve("inventory");
    if (token === undefined) {
      throw new MerchantClientError(
        "auth",
        "没有 inventory 作用域凭据（commerce.credentials.inventory.token_env 未配置）",
      );
    }
    const payload = (await this.request("PATCH", `/products/${encodeURIComponent(sku)}`, {
      body: { stock },
      token,
    })) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError(
        "validation",
        "update inventory response lacks a product object",
      );
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  // ---- consultations & human review -------------------------------------------

  async listIncomingConsultations(merchantId: string): Promise<IncomingConsultation[]> {
    const payload = (await this.request(
      "GET",
      `/merchants/${encodeURIComponent(merchantId)}/conversations`,
      { token: this.catalogToken() },
    )) as { conversations?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.conversations)) {
      throw new MerchantClientError(
        "validation",
        "conversations response lacks a conversations array",
      );
    }
    return payload.conversations.map((c) => parseIncomingConsultation(c));
  }

  async getHumanReviewQueue(merchantId: string): Promise<HumanReviewItem[]> {
    const payload = (await this.request(
      "GET",
      `/merchants/${encodeURIComponent(merchantId)}/human-review`,
      { token: this.catalogToken() },
    )) as { reviews?: unknown; conversations?: unknown };
    // shopping-cli 2.x returns {conversations:[...]}; accept both shapes.
    const reviews = payload.reviews ?? payload.conversations;
    if (payload === null || typeof payload !== "object" || !Array.isArray(reviews)) {
      throw new MerchantClientError(
        "validation",
        "human-review response lacks a reviews/conversations array",
      );
    }
    return reviews.map((r) => parseHumanReviewItem(r));
  }

  /**
   * 语义选型（V2 §8.3 P0-3）：pauseListing = **销售状态**（暂停/恢复销售，
   *  catalog paused flag 语义），不是「catalog listing 撤回」，绝不用库存写零
   *  伪装下架。上游 shopping-cli 2.x 无该端点 → fail closed 报「不可得」
   *  （能力探测 listing_pause=false；审批候选仍会生成与记录，最终写入拒绝）。
   */
  async pauseListing(_sku: string, _paused: boolean): Promise<MerchantCatalogProduct> {
    throw new MerchantClientError(
      "validation",
      "shopping-cli 2.x 不提供 listing pause/resume 端点（active 为目录内部字段）；" +
        "该能力在真实 Connector 上 fail closed，只保留审批候选记录。",
    );
  }

  // ---- capability probe（V2 阶段一/P0-5；协议协商升级）------------------------

  /**
   * 读取网关协议通告（GET /capabilities，带 catalog 凭据）。返回协议版本清单；
   * 端点缺失/无权限/瞬时故障抛 MerchantClientError（保留 kind），由探测方
   * 按回退规则处理。响应 shape（shopping-cli core.capabilities_report）：
   * { ok, capabilities: { protocol_versions: string[], backend, capabilities } }。
   */
  private async fetchGatewayProtocolVersions(): Promise<string[]> {
    const payload = (await this.request("GET", "/capabilities", {
      token: this.catalogToken(),
    })) as { capabilities?: { protocol_versions?: unknown } };
    const inner = payload?.capabilities;
    const protocols = (inner as { protocol_versions?: unknown } | undefined)?.protocol_versions;
    if (!Array.isArray(protocols) || protocols.some((p) => typeof p !== "string")) {
      throw new MerchantClientError(
        "validation",
        "/capabilities 响应缺少 capabilities.protocol_versions 字符串数组",
      );
    }
    return protocols as string[];
  }

  /**
   * 能力探测（协议协商版）：GET /health 拿版本，GET /capabilities 拿协议通告，
   * Kiwi 需要 `shopping.negotiation/0.1` 在通告清单内才算兼容。fail-closed：
   * 网关故障、健康检查未过、协议不兼容或协商不可用且版本不可判定 → ok:false
   * 且 capabilities 全 false——调用方不得据此产生报价或返回编造数据。
   * 协商不可用（端点缺失/无权限/瞬时故障）时回退 legacy 已验证线（2.x 实测
   * 线，见 SHOPPING_CLI_LEGACY_VERIFIED）；3.x 网关都带 /capabilities，「3.x
   * 却协商不了」按不可判定 fail-closed。能力清单仍按 2.x/3.x 实测标定：
   * listing_pause / resolve_review 已知缺失（勿宣传；见 V2 计划 P0-3）。
   */
  async probeCapabilities(
    options: { now?: () => string; persistPath?: string } = {},
  ): Promise<MerchantCapabilityProbe> {
    const probedAt = (options.now ?? (() => new Date().toISOString()))();
    const unavailable: MerchantCapabilityProbe["capabilities"] = {
      catalog_read: false,
      catalog_write: false,
      inventory_write: false,
      listing_pause: false,
      resolve_review: false,
    };
    const calibrated: MerchantCapabilityProbe["capabilities"] = {
      catalog_read: true,
      catalog_write: true,
      inventory_write: true,
      // shopping-cli 2.x/3.x 已知缺失（实测标定；升级上游后重新探测标定）
      listing_pause: false,
      resolve_review: false,
    };
    let report: MerchantCapabilityProbe;
    try {
      const payload = (await this.request("GET", "/health")) as {
        ok?: unknown;
        version?: unknown;
      };
      const version = typeof payload.version === "string" ? payload.version : undefined;
      const healthy = payload.ok === true;
      if (!healthy) {
        report = {
          ok: false,
          probed_at: probedAt,
          verdict: "unhealthy",
          ...(version !== undefined ? { version } : {}),
          version_supported: false,
          capabilities: unavailable,
          error: `shopping-cli 健康检查未通过（ok !== true）`,
        };
      } else {
        // 协商优先：/capabilities 是兼容性的权威信号。
        let protocols: string[] | undefined;
        let negotiateFailure = "";
        try {
          protocols = await this.fetchGatewayProtocolVersions();
        } catch (err) {
          negotiateFailure = err instanceof Error ? err.message : String(err);
        }
        if (protocols !== undefined) {
          const compatible = protocols.includes(PROTOCOL_VERSION);
          report = {
            ok: compatible,
            probed_at: probedAt,
            verdict: compatible ? "compatible" : "incompatible",
            ...(version !== undefined ? { version } : {}),
            version_supported: compatible,
            protocol_versions: protocols,
            capabilities: compatible ? calibrated : unavailable,
            ...(compatible
              ? {}
              : {
                  error:
                    `shopping-cli 协议不兼容：网关通告 [${protocols.join(", ")}]，` +
                    `Kiwi 需要 ${PROTOCOL_VERSION}`,
                }),
          };
        } else {
          // 协商不可用 → 回退 legacy 已验证线（2.x 实测线内才放行）。
          const legacyOk =
            version !== undefined && versionInRange(version, SHOPPING_CLI_LEGACY_VERIFIED);
          report = {
            ok: legacyOk,
            probed_at: probedAt,
            verdict: legacyOk ? "legacy" : "indeterminate",
            ...(version !== undefined ? { version } : {}),
            version_supported: legacyOk,
            capabilities: legacyOk ? calibrated : unavailable,
            ...(legacyOk
              ? {}
              : {
                  error:
                    `无法经 /capabilities 协商协议（${negotiateFailure}）；` +
                    `版本 ${version ?? "未知"} 不在 legacy 已验证线（${compatRangeText(SHOPPING_CLI_LEGACY_VERIFIED)}），fail-closed`,
                }),
          };
        }
      }
    } catch (err) {
      report = {
        ok: false,
        probed_at: probedAt,
        verdict: "indeterminate",
        capabilities: unavailable,
        error: `shopping-cli 不可达：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (options.persistPath !== undefined) {
      // 审查 P2：原子写——health 轮询与一次性命令并发读同一文件，非原子写
      // 会产生撕裂读 → 假 critical 告警。
      writeFileAtomic(options.persistPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    return report;
  }
}

/**
 * 能力探测结果（V2 阶段一/P0-5；协议协商升级）：版本 + 协议通告 + 能力清单，
 * 落盘可查询。verdict 供启动方区分处置：incompatible = 硬拒绝（exit CONFIG）；
 * indeterminate/unhealthy = 警示不阻塞（网关可能仍在启动，健康面持续 fail-closed）。
 */
export interface MerchantCapabilityProbe {
  ok: boolean;
  probed_at: string;
  verdict: "compatible" | "incompatible" | "legacy" | "indeterminate" | "unhealthy";
  version?: string;
  /** 网关 /capabilities 通告的协议版本清单（协商成功时携带）。 */
  protocol_versions?: string[];
  /** 协商兼容或落在 legacy 已验证线（version 缺失或不支持 → false）。 */
  version_supported?: boolean;
  capabilities: {
    catalog_read: boolean;
    catalog_write: boolean;
    inventory_write: boolean;
    listing_pause: boolean;
    resolve_review: boolean;
  };
  error?: string;
}
