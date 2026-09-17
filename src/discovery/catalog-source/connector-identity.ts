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
 * CatalogConnectorIdentityClient —— kiwi-catalog 一次性身份授权（连接器侧）。
 *
 *   POST {baseUrl}/v1/connector-identity/requests
 *        {return_url, client_label?} → {ok, request:{request_id, expires_at}, login_url}
 *   POST {baseUrl}/v1/connector-identity/exchange
 *        {request_id, code}         → {ok, identity:{merchant_id, merchant_name}}
 *
 * 契约来源：kiwi-catalog 仓 kiwi_catalog/api/handlers/connector_identity.py
 * （schema v31；merchant-buddy 第 1 版设计 §3.2 / 商家连接器发布计划 §3.1）。
 * 调用方是**商家连接器**的远程入口——买方连接器（`kiwi-sourcing`，本地
 * stdio）不使用本接口。
 *
 * 硬边界（fail-closed，调用方不得吞掉错误）：
 *   - merchant_id 只能来自 exchange 的返回值——绝不从工具参数、URL 或
 *     客户端自述值推断（商家连接器入口的租户判定唯一来源）；
 *   - 出站加固与既有 catalog 客户端一致：不跟随重定向（3xx 可能转发凭据）、
 *     超时、响应大小上限、响应结构逐字段校验。
 *
 * connector token（`KIWI_CATALOG_CONNECTOR_TOKEN`）是入口与目录之间的机器
 * 凭据：它只够创建/兑换一次性授权请求，不能读写任何商家数据（目录侧在
 * 商家确认前不会为该请求绑定 merchant_id）。
 */

import { PRODUCT_VERSION } from "../../product-cli.js";
import { isRedirectResponse, readJsonBody } from "../../net/safe-http.js";
import { CatalogSourceError } from "./errors.js";
import { validateBaseUrl } from "./source.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** 授权请求（入口持有；login_url 是给商家浏览器打开的地址）。 */
export interface ConnectorIdentityRequest {
  readonly requestId: string;
  readonly loginUrl: string;
  readonly expiresAt: string;
}

/**
 * 身份兑换时同时签发的商家作用域凭据（目录侧 schema v32）。
 *
 * 入口用它代表**该商家**调用目录的商家接口（公开资料草稿/状态/撤回）；发布
 * 仍须商家在目录门户确认页批准，凭据本身不能把 draft 变成 published。
 */
export interface ConnectorMerchantCredential {
  readonly accessToken: string;
  readonly scope: string;
  readonly expiresAt: string;
}

/** 兑换结果：已验证的商家身份（唯一可信来源）+ 该商家的作用域凭据。 */
export interface ConnectorIdentity {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly credential: ConnectorMerchantCredential;
}

/**
 * 入口需要的身份能力。测试与部署可注入不同实现；生产实现是本文件的
 * HTTP 客户端。
 */
export interface CatalogIdentityProvider {
  createRequest(input: {
    returnUrl: string;
    clientLabel?: string;
  }): Promise<ConnectorIdentityRequest>;
  exchange(input: { requestId: string; code: string }): Promise<ConnectorIdentity>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CatalogSourceError(
      "response_invalid",
      `connector-identity response is missing non-empty string field "${field}"`,
    );
  }
  return value;
}

export interface CatalogConnectorIdentityDeps {
  /** Catalog 服务根 URL（http/https）。 */
  baseUrl: string;
  /** 连接器机器凭据（catalog 侧 KIWI_CATALOG_CONNECTOR_TOKEN）。 */
  connectorToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class CatalogConnectorIdentityClient implements CatalogIdentityProvider {
  private readonly baseUrl: string;
  private readonly connectorToken: string;
  private readonly deps: CatalogConnectorIdentityDeps;

  constructor(deps: CatalogConnectorIdentityDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    if (typeof deps.connectorToken !== "string" || deps.connectorToken.trim() === "") {
      throw new CatalogSourceError(
        "invalid_input",
        "connector-identity client requires a non-empty connector token",
      );
    }
    this.connectorToken = deps.connectorToken;
    this.deps = deps;
  }

  async createRequest(input: {
    returnUrl: string;
    clientLabel?: string;
  }): Promise<ConnectorIdentityRequest> {
    const body = await this.postJson("/v1/connector-identity/requests", {
      return_url: input.returnUrl,
      ...(input.clientLabel !== undefined ? { client_label: input.clientLabel } : {}),
    });
    const request = body.request;
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new CatalogSourceError(
        "response_invalid",
        'connector-identity response is missing object field "request"',
      );
    }
    const record = request as Record<string, unknown>;
    const loginUrl = nonEmptyString(body.login_url, "login_url");
    let parsedLoginUrl: URL;
    try {
      parsedLoginUrl = new URL(loginUrl);
    } catch {
      throw new CatalogSourceError(
        "response_invalid",
        "connector-identity login_url is not an absolute URL",
      );
    }
    if (parsedLoginUrl.protocol !== "https:" && parsedLoginUrl.protocol !== "http:") {
      throw new CatalogSourceError(
        "response_invalid",
        `connector-identity login_url must use http or https (got ${parsedLoginUrl.protocol})`,
      );
    }
    return {
      requestId: nonEmptyString(record.request_id, "request.request_id"),
      loginUrl,
      expiresAt: nonEmptyString(record.expires_at, "request.expires_at"),
    };
  }

  async exchange(input: { requestId: string; code: string }): Promise<ConnectorIdentity> {
    const body = await this.postJson("/v1/connector-identity/exchange", {
      request_id: input.requestId,
      code: input.code,
    });
    const identity = body.identity;
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
      throw new CatalogSourceError(
        "response_invalid",
        'connector-identity response is missing object field "identity"',
      );
    }
    const record = identity as Record<string, unknown>;
    const credential = body.credential;
    if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
      throw new CatalogSourceError(
        "response_invalid",
        'connector-identity response is missing object field "credential"',
      );
    }
    const credentialRecord = credential as Record<string, unknown>;
    return {
      merchantId: nonEmptyString(record.merchant_id, "identity.merchant_id"),
      // 商家名允许为空字符串（未填名称的账号），不做非空校验。
      merchantName: typeof record.merchant_name === "string" ? record.merchant_name : "",
      credential: {
        accessToken: nonEmptyString(credentialRecord.access_token, "credential.access_token"),
        scope: typeof credentialRecord.scope === "string" ? credentialRecord.scope : "",
        expiresAt: nonEmptyString(credentialRecord.expires_at, "credential.expires_at"),
      },
    };
  }

  private async postJson(
    requestPath: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.baseUrl}${requestPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let raw: unknown;
    try {
      try {
        response = await fetchImpl(url, {
          method: "POST",
          // 出站加固：绝不跟随重定向（3xx 目标不经过校验，且可能转发凭据）。
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${this.connectorToken}`,
            "user-agent": `kiwi-connector/${PRODUCT_VERSION}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const detail = err instanceof Error ? err.message : String(err);
        throw new CatalogSourceError(
          "request_failed",
          name === "AbortError"
            ? `kiwi-catalog connector request timed out after ${timeoutMs}ms: ${url}`
            : `kiwi-catalog connector request failed: ${url} (${detail})`,
        );
      }
      if (isRedirectResponse(response)) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog connector request must not follow redirects (HTTP ${response.status} from ${url})`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new CatalogSourceError(
          "session_rejected",
          `kiwi-catalog rejected the connector credential (HTTP ${response.status} from ${url})`,
        );
      }
      if (!response.ok) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog connector request returned HTTP ${response.status} from ${url}`,
        );
      }
      try {
        raw = await readJsonBody(response, { signal: controller.signal });
      } catch {
        throw new CatalogSourceError(
          "response_invalid",
          `kiwi-catalog connector response from ${url} is not valid JSON`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CatalogSourceError(
        "response_invalid",
        "connector-identity response must be a JSON object",
      );
    }
    const envelope = raw as Record<string, unknown>;
    if (envelope.ok !== true) {
      throw new CatalogSourceError(
        "response_invalid",
        `connector-identity response is not ok: ${typeof envelope.error === "string" ? envelope.error : "unknown error"}`,
      );
    }
    return envelope;
  }
}
