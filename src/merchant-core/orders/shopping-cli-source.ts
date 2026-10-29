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
 * shopping-cli 私有订单/成本读取客户端（v0.2 §17.2）。
 *
 * 只读消费 shopping-cli 的 `/v1/merchant/*` 面；商家身份与 Bearer token 由
 * 调用方注入，路由正文不自行声明商家。真实来源的字段/凭据仍由 M0 冻结，
 * 这里只固定传输形状与失败语义。
 */

import { OrderFactError } from "./model.js";

export interface ShoppingCliOrderSourceOptions {
  baseUrl: string;
  merchantId: string;
  token: string;
  /** 受信订单连接器凭据；仅用于 `external_verified` 写入。 */
  connectorToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class ShoppingCliOrderSource {
  private readonly baseUrl: string;
  private readonly merchantId: string;
  private readonly token: string;
  private readonly connectorToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ShoppingCliOrderSourceOptions) {
    if (!options.baseUrl.startsWith("https://") && !options.baseUrl.startsWith("http://")) {
      throw new OrderFactError("validation", "shopping-cli baseUrl 必须是 http(s) 地址");
    }
    if (options.merchantId.trim() === "" || options.token.trim() === "") {
      throw new OrderFactError("validation", "shopping-cli merchantId/token 不能为空");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.merchantId = options.merchantId;
    this.token = options.token;
    this.connectorToken = options.connectorToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async listOrders(input: { limit?: number; offset?: number } = {}): Promise<unknown> {
    const query = new URLSearchParams({
      merchant_id: this.merchantId,
      limit: String(input.limit ?? 50),
      offset: String(input.offset ?? 0),
    });
    return this.request("GET", `/v1/merchant/orders?${query.toString()}`);
  }

  async getOrder(externalOrderId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/v1/merchant/orders/${encodeURIComponent(externalOrderId)}?merchant_id=${encodeURIComponent(this.merchantId)}`,
    );
  }

  /** 受信连接器写入 external_verified；缺 connectorToken 时 fail-closed。 */
  async recordVerifiedOrder(input: Record<string, unknown>): Promise<unknown> {
    if (this.connectorToken === undefined || this.connectorToken.trim() === "") {
      throw new OrderFactError("validation", "connectorToken 未配置，不能写入 external_verified");
    }
    return this.request(
      "POST",
      "/v1/merchant/orders/verified",
      { ...input, merchant_id: this.merchantId },
      this.connectorToken,
    );
  }

  async recordRefund(externalOrderId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request(
      "POST",
      `/v1/merchant/orders/${encodeURIComponent(externalOrderId)}/refunds`,
      { ...input, merchant_id: this.merchantId },
    );
  }

  async saveCostSnapshot(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/v1/merchant/cost-snapshots", {
      ...input,
      merchant_id: this.merchantId,
    });
  }

  async getCostSnapshot(snapshotId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/v1/merchant/cost-snapshots/${encodeURIComponent(snapshotId)}?merchant_id=${encodeURIComponent(this.merchantId)}`,
    );
  }

  async registerSourceContract(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/v1/merchant/source-contracts", {
      ...input,
      merchant_id: this.merchantId,
    });
  }

  async getSourceContract(sourceNamespace: string, sourceAccountId: string): Promise<unknown> {
    return this.request(
      "GET",
      `/v1/merchant/source-contracts/${encodeURIComponent(sourceNamespace)}/${encodeURIComponent(sourceAccountId)}?merchant_id=${encodeURIComponent(this.merchantId)}`,
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    authToken: string = this.token,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${authToken}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        let code = `http_${response.status}`;
        let message = "shopping-cli request failed";
        try {
          const payload = (await response.json()) as ErrorBody;
          if (typeof payload.error?.code === "string") code = payload.error.code;
          if (typeof payload.error?.message === "string") message = payload.error.message;
        } catch {
          // 非 JSON 错误体：保留状态码，不猜测内容。
        }
        throw new OrderFactError("validation", `${code}: ${message}`);
      }
      return await response.json();
    } catch (err) {
      if (err instanceof OrderFactError) throw err;
      throw new OrderFactError(
        "validation",
        `shopping-cli 请求失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
