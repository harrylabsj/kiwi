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
 * 云端托管名片的 **Buyer 侧解析**（设计 v0.1.2 §12.1；M3）。
 *
 * 云端商家的名片不再由商家自己的进程现发，而是托管在 Catalog 的**稳定读地址**上；
 * Runtime 把「哪台机器、哪把钥匙、哪个端点正代表这个商家」以**绑定声明**的形式
 * 交给 Catalog 签发。Buyer 因此要同时读两份东西并证明它们说的是同一件事：
 *
 *   GET {catalog}/v1/agents/{id}/agent-card.json   → Agent Card（公开读）
 *   GET {catalog}/v1/agents/{id}/runtime-binding    → 绑定声明 + 治理状态（公开读）
 *
 * 三条纪律（本模块存在的理由）：
 *
 * 1. **独立凭据范围**：这两个读地址都是公开读，**不带任何商家凭证**。本类刻意
 *    不接受 `authToken` / `buyerId`——名片是"任何人都能核验"的公开事实，一旦
 *    读取需要商家凭据，验证就退化成"相信持有凭据的那个人"。
 * 2. **信任根来自本地预配置**：`kid → 公钥` 必须由调用方从受控来源提供
 *    （`BindingTrustStore`），**绝不**根据声明里的任意 URL 去下载（见 verify.ts）。
 * 3. **声明必须描述 Buyer 实际连的那个商家**：`card_url` 必须等于本次实际读取的
 *    URL、`a2a_endpoint` 必须是名片自己声明的接口之一——否则拒绝，不返回"部分可信"。
 *
 * 出站加固与 `catalog-source` 其余客户端一致（不跟随重定向、超时覆盖 body 读取、
 * 响应体上限），错误统一为 `CatalogSourceError` / `BindingRejectionError`。
 */

import type { KeyObject } from "node:crypto";

import { validateAgentCard } from "../agent-card/validate.js";
import { assertSafeTargetUrl } from "../../a2a/client/url-policy.js";
import type { AgentCard } from "../agent-card/types.js";
import { CatalogSourceError } from "./errors.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";
import { validateBaseUrl } from "./source.js";
import { PRODUCT_VERSION } from "../../product-cli.js";
import { validateBindingClaims, type BindingClaims } from "../../trust/binding/claims.js";
import {
  jwkThumbprint,
  publicKeyThumbprint,
  signingKeyThumbprint,
} from "../../trust/binding/thumbprint.js";
import {
  trustCacheKey,
  verifyBindingClaims,
  type BindingTrustStore,
  type VerifyBindingRefusalCode,
} from "../../trust/binding/verify.js";
import type { JsonWebKey } from "../../trust/identity/jwk.js";
import type { SigningKey } from "../../trust/identity/keys.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** 声明被拒（签名/发行者/时间窗/与观测事实不符/危险目标）。绝不降级为"部分可信"。 */
export class BindingRejectionError extends CatalogSourceError {
  /** 拒绝码，供调用方分流处置（如 EXPIRED 可重取，BAD_SIGNATURE 应告警）。 */
  readonly refusalCode:
    | VerifyBindingRefusalCode
    | "ISSUER_MISMATCH"
    | "RESPONSE_INVALID"
    | "UNSAFE_TARGET";

  constructor(refusalCode: BindingRejectionError["refusalCode"], message: string) {
    super("binding_rejected", message);
    this.name = "BindingRejectionError";
    this.refusalCode = refusalCode;
  }
}

/** 公开读地址的响应：304（重验证命中）或 200（新名片）。 */
export type PublishedCardRead =
  | { readonly notModified: true; readonly etag: string }
  | { readonly notModified: false; readonly card: AgentCard; readonly etag: string };

/** `GET /v1/agents/{id}/runtime-binding` 的响应体（Catalog 签发）。 */
export interface CloudBindingDocument {
  readonly claims: BindingClaims;
  readonly claims_jws: string;
  readonly issuer_kid: string;
  readonly issuer_thumbprint: string;
  readonly governance: { readonly publication_state: string };
  /** 公开元数据：Buyer 的信任缓存按 (来源, revision, binding_version, 端点) 索引。 */
  readonly card_revision: number | null;
  readonly card_etag: string | null;
}

export interface CloudCardDeps {
  /** Catalog 公开读地址的根 URL。 */
  baseUrl: string;
  /** **本地预配置**的 Catalog 发行者可信密钥（kid → 公钥）。 */
  trust: BindingTrustStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  /**
   * 信任缓存键的"来源"分量。缺省用规范化后的 baseUrl；显式提供是为了让同一
   * Catalog 的不同环境/租户不互相串味。
   */
  sourceId?: string;
  /**
   * **仅受控本地集成/测试**：放行 loopback 目标（生产必须是 false，缺省即 false）。
   *
   * 与 `A2AClientOptions.allowPrivateRanges` 同一性质的开闸：它只影响"字面
   * loopback"这一条判定，DNS 解析到内网的目标仍由连接时复查兜底。任何把它设为
   * true 的生产配置都等于关掉 T035 的一半，必须显式承担。
   */
  allowLoopbackTargets?: boolean;
}

/** 解析结果：名片 + 已验签的绑定声明 + 信任缓存键。 */
export interface CloudAgentResolution {
  readonly agentId: string;
  readonly card: AgentCard;
  readonly claims: BindingClaims;
  readonly issuerKid: string;
  readonly issuerThumbprint: string;
  readonly cardRevision: number | null;
  /** Catalog 承诺的 Card ETag（= 公开读地址响应体的 ETag）。 */
  readonly cardEtag: string | null;
  /** Buyer 实际应当连接的 A2A 端点：由**声明背书**，且必须是名片声明过的接口。 */
  readonly endpoint: string;
  readonly publicationState: string;
  /** 信任缓存键（§12.1）。 */
  readonly trustKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 名片里所有 JSONRPC 绑定的端点 URL。
 *
 * 返回**集合**而非"第一个"：一张名片可以声明多个 JSONRPC 接口（多区域/多版本），
 * 声明只需指向其中任何一个。挑"第一个"再去比对会把合法名片误判为端点不符。
 */
export function jsonRpcEndpoints(card: AgentCard): string[] {
  const urls = card.supportedInterfaces
    .filter((entry) => entry.protocolBinding === "JSONRPC")
    .map((entry) => entry.url)
    .filter((url): url is string => typeof url === "string" && url !== "");
  if (urls.length === 0) {
    throw new CatalogSourceError(
      "contract_violation",
      "Agent Card 没有 JSONRPC 绑定的 supportedInterfaces 条目（无法确定 A2A 端点）",
    );
  }
  return urls;
}

/** 逐字段深比较（不依赖键序——两处 JSON 可能由不同实现序列化）。 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameJson(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) {
      return false;
    }
    return keysA.every((key) => sameJson(a[key], b[key]));
  }
  return false;
}

/** 手写校验绑定文档外壳（claims 本身由 validateBindingClaims 完整校验）。 */
function parseCloudBindingDocument(raw: unknown): CloudBindingDocument {
  if (!isRecord(raw)) {
    throw new CatalogSourceError(
      "response_invalid",
      "runtime-binding response must be a JSON object",
    );
  }
  if (typeof raw["claims_jws"] !== "string" || raw["claims_jws"] === "") {
    throw new CatalogSourceError(
      "response_invalid",
      'runtime-binding response is missing non-empty string field "claims_jws"',
    );
  }
  if (typeof raw["issuer_kid"] !== "string" || raw["issuer_kid"] === "") {
    throw new CatalogSourceError(
      "response_invalid",
      'runtime-binding response is missing non-empty string field "issuer_kid"',
    );
  }
  const claimsCheck = validateBindingClaims(raw["claims"]);
  if (!claimsCheck.ok) {
    throw new CatalogSourceError(
      "contract_violation",
      `runtime-binding claims 不符合 schema：${claimsCheck.errors.join("；")}`,
    );
  }
  const governance = raw["governance"];
  const revision = raw["card_revision"];
  const etag = raw["card_etag"];
  return {
    claims: claimsCheck.claims,
    claims_jws: raw["claims_jws"],
    issuer_kid: raw["issuer_kid"],
    issuer_thumbprint: typeof raw["issuer_thumbprint"] === "string" ? raw["issuer_thumbprint"] : "",
    governance: {
      publication_state: isRecord(governance) ? String(governance["publication_state"] ?? "") : "",
    },
    card_revision: typeof revision === "number" && Number.isInteger(revision) ? revision : null,
    card_etag: typeof etag === "string" && etag !== "" ? etag : null,
  };
}

/** 由验签视图算指纹（SigningKey / KeyObject / JWK 三种形态都归到同一口径）。 */
export function trustedKeyThumbprint(key: SigningKey | JsonWebKey | KeyObject): string {
  if (typeof (key as SigningKey).keyid === "string") return signingKeyThumbprint(key as SigningKey);
  if (typeof (key as KeyObject).export === "function") return publicKeyThumbprint(key as KeyObject);
  return jwkThumbprint(key as JsonWebKey);
}

export class CloudCardSource {
  private readonly baseUrl: string;
  private readonly deps: CloudCardDeps;
  private readonly sourceId: string;

  constructor(deps: CloudCardDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    this.deps = deps;
    this.sourceId = deps.sourceId ?? this.baseUrl;
  }

  /** 公开读地址（绝对 URL）——同时是绑定声明里 `card_url` 的比对基准。 */
  cardUrl(agentId: string): string {
    return `${this.baseUrl}${this.cardPath(agentId)}`;
  }

  private cardPath(agentId: string): string {
    return `/v1/agents/${encodeURIComponent(this.requireAgentId(agentId))}/agent-card.json`;
  }

  private requireAgentId(agentId: string): string {
    const trimmed = String(agentId ?? "").trim();
    if (trimmed === "") {
      throw new CatalogSourceError("invalid_input", "agentId must be a non-empty string");
    }
    if (trimmed.includes("/") || trimmed.includes("..")) {
      throw new CatalogSourceError("invalid_input", `agentId 含非法字符：${trimmed}`);
    }
    return trimmed;
  }

  /**
   * 公开读一次请求。**不带任何凭据**——这是本模块的核心约束（见文件头）。
   *
   * 顺序上先判 304：`redirect: "manual"` 下 304 也落在 3xx 区间，先走
   * `isRedirectResponse` 会把"条件请求命中"误判成"对端试图重定向"。
   */
  private async getPublic(
    requestPath: string,
    extraHeaders: Array<[string, string]> = [],
  ): Promise<{ status: number; etag: string; json: unknown }> {
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.baseUrl}${requestPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": `kiwi-buyer/${PRODUCT_VERSION}`,
            ...Object.fromEntries(extraHeaders),
          },
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const detail = err instanceof Error ? err.message : String(err);
        throw new CatalogSourceError(
          "request_failed",
          name === "AbortError"
            ? `catalog request timed out after ${timeoutMs}ms: ${url}`
            : `catalog request failed: ${url} (${detail})`,
        );
      }
      const etag = response.headers.get("etag") ?? "";
      if (response.status === 304) {
        return { status: 304, etag, json: undefined };
      }
      if (isRedirectResponse(response)) {
        throw new CatalogSourceError(
          "request_failed",
          `catalog request must not follow redirects (HTTP ${response.status} from ${url})`,
        );
      }
      if (!response.ok) {
        throw new CatalogSourceError(
          "request_failed",
          `catalog request returned HTTP ${response.status} from ${url}`,
        );
      }
      let json: unknown;
      try {
        json = await readJsonBody(response, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new CatalogSourceError(
            "request_failed",
            `catalog request timed out after ${timeoutMs}ms while reading response: ${url}`,
          );
        }
        throw new CatalogSourceError(
          "response_invalid",
          err instanceof SafeHttpError && err.code === "response_too_large"
            ? `catalog response from ${url}: ${err.message}`
            : `catalog response from ${url} is not valid JSON`,
        );
      }
      return { status: response.status, etag, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 读取已发布名片（公开读，无凭据）。
   *
   * `ifNoneMatch` 传入上次的 ETag 可做条件请求：Catalog 命中即回 304（无 body），
   * 调用方沿用缓存的 Card —— 这正是 §12.1 "信任缓存 + 重验证" 的读侧。
   */
  async fetchPublishedCard(
    agentId: string,
    options: { ifNoneMatch?: string } = {},
  ): Promise<PublishedCardRead> {
    const extra: Array<[string, string]> =
      options.ifNoneMatch !== undefined ? [["if-none-match", options.ifNoneMatch]] : [];
    const { status, etag, json } = await this.getPublic(this.cardPath(agentId), extra);
    if (status === 304) {
      if (etag === "") {
        throw new CatalogSourceError(
          "response_invalid",
          "catalog returned 304 without an ETag（无法确认缓存对应的表示）",
        );
      }
      return { notModified: true, etag };
    }
    return { notModified: false, card: validateAgentCard(json), etag };
  }

  /** 读取 Catalog 签发的绑定声明（公开读，无凭据）。 */
  async fetchRuntimeBinding(agentId: string): Promise<CloudBindingDocument> {
    const path = `/v1/agents/${encodeURIComponent(this.requireAgentId(agentId))}/runtime-binding`;
    const { json } = await this.getPublic(path);
    return parseCloudBindingDocument(json);
  }

  /**
   * 完整解析：读名片 + 读声明 + 验签 + 与观测事实逐项比对。
   *
   * 任一环失败即抛（`BindingRejectionError` / `CatalogSourceError`），**不返回部分
   * 可信的结果**——Buyer 拿到的 `CloudAgentResolution` 意味着"这份名片确实由
   * 持有该 Runtime 钥匙的那台机器代表，且这就是我读到的那个商家"。
   */
  async resolveCloudAgent(
    agentId: string,
    options: { cachedCardEtag?: string; cachedCard?: AgentCard } = {},
  ): Promise<CloudAgentResolution> {
    const id = this.requireAgentId(agentId);
    const cardUrl = this.cardUrl(id);
    // §12.1 的"重验证"：带上上次的 ETag 做条件请求，Catalog 回 304 就复用缓存名片
    // （省掉一次完整 body），但**绑定声明照常重新读取并重新验签**——304 只说明名片
    // 内容没变，不说明"上次验过的声明现在仍然有效"。
    const conditional = options.cachedCardEtag !== undefined && options.cachedCard !== undefined;
    const [card, binding] = await Promise.all([
      this.fetchPublishedCard(id, conditional ? { ifNoneMatch: options.cachedCardEtag } : {}),
      this.fetchRuntimeBinding(id),
    ]);
    let resolvedCard: AgentCard;
    if (card.notModified) {
      if (!conditional || options.cachedCard === undefined) {
        // 未带 If-None-Match 却收到 304：对端行为异常。
        throw new CatalogSourceError(
          "response_invalid",
          "catalog returned 304 for an unconditional GET",
        );
      }
      resolvedCard = options.cachedCard;
    } else {
      resolvedCard = card.card;
    }
    const endpoints = jsonRpcEndpoints(resolvedCard);

    // 1) 验签 + 完整 claims 校验 + 与观测事实比对（agent_id / card_url）。
    const verified = verifyBindingClaims(binding.claims_jws, {
      trust: this.deps.trust,
      expected: { agentId: id, cardUrl },
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
    });
    if (!verified.ok) {
      throw new BindingRejectionError(
        verified.code,
        `绑定声明被拒（${verified.code}）：${verified.reason}`,
      );
    }
    const verifiedClaims = verified.claims;

    // 2) 外壳与已验签负载必须一致（响应被拼装过即拒）。
    if (!sameJson(verifiedClaims, binding.claims)) {
      throw new BindingRejectionError(
        "RESPONSE_INVALID",
        "runtime-binding 的 claims 字段与已验签的 claims_jws 负载不一致（响应被拼装）",
      );
    }

    // 3) 声明背书的端点必须是**这张名片自己声明过的** JSONRPC 接口之一。
    if (!endpoints.includes(verifiedClaims.a2a_endpoint)) {
      throw new BindingRejectionError(
        "ENDPOINT_MISMATCH",
        `声明背书端点 ${verifiedClaims.a2a_endpoint} 不在名片声明的 JSONRPC 接口内（${endpoints.join(", ")}）`,
      );
    }

    // 3b) T035：声明与名片声明的目标都必须是**公网可达的 https 目标**。
    //     私网/metadata/loopback/内嵌凭据目标一律拒绝——"声明里写了就直接连"正是
    //     SSRF 的入口。`allowLoopback` 显式关掉：这两份输入都来自不可信的对端。
    for (const [label, value] of [
      ["a2a_endpoint", verifiedClaims.a2a_endpoint],
      ["runtime_origin", verifiedClaims.runtime_origin],
      ...endpoints.map((url, index) => [`supportedInterfaces[${index}].url`, url] as const),
    ] as ReadonlyArray<readonly [string, string]>) {
      try {
        assertSafeTargetUrl(value, { allowLoopback: this.deps.allowLoopbackTargets ?? false });
      } catch (err) {
        throw new BindingRejectionError(
          "UNSAFE_TARGET",
          `${label} 不是可安全连接的目标（${value}）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 4) 外壳报告的发行者必须与 JWS 头里的 kid 一致（选钥匙的是 JWS 头，不是外壳；
    //    两处不一致说明响应被拼装过）。
    if (binding.issuer_kid !== verified.issuer_kid) {
      throw new BindingRejectionError(
        "RESPONSE_INVALID",
        `runtime-binding 的 issuer_kid=${binding.issuer_kid} 与已验签 JWS 头的 kid=${verified.issuer_kid} 不一致`,
      );
    }

    // 5) 该 kid 必须是**我们本地信任的那把钥匙**（Catalog 换了发行者身份要看得出）。
    const trustedKey = this.deps.trust.resolveIssuerKey(verified.issuer_kid);
    if (trustedKey === undefined) {
      throw new BindingRejectionError("UNKNOWN_ISSUER", `未知发行者 kid=${verified.issuer_kid}`);
    }
    let trustedThumbprint: string;
    try {
      trustedThumbprint = trustedKeyThumbprint(trustedKey);
    } catch (err) {
      throw new BindingRejectionError(
        "RESPONSE_INVALID",
        `可信发行者公钥无法计算指纹：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (binding.issuer_thumbprint !== "" && binding.issuer_thumbprint !== trustedThumbprint) {
      throw new BindingRejectionError(
        "ISSUER_MISMATCH",
        `Catalog 报告的发行者指纹 ${binding.issuer_thumbprint} 与本地可信钥匙 ${trustedThumbprint} 不一致`,
      );
    }

    // 6) 治理状态：撤回的名片即便声明仍在有效期内也不得使用。
    if (binding.governance.publication_state === "WITHDRAWN") {
      throw new BindingRejectionError("REVOKED", "名片已撤回（publication_state=WITHDRAWN）");
    }

    return {
      agentId: id,
      card: resolvedCard,
      claims: verifiedClaims,
      issuerKid: verified.issuer_kid,
      issuerThumbprint: trustedThumbprint,
      cardRevision: binding.card_revision,
      cardEtag: binding.card_etag,
      endpoint: verifiedClaims.a2a_endpoint,
      publicationState: binding.governance.publication_state,
      trustKey: trustCacheKey({
        source: this.sourceId,
        agentId: id,
        cardRevision: binding.card_revision ?? 0,
        bindingVersion: verifiedClaims.binding_version,
        endpoint: verifiedClaims.a2a_endpoint,
      }),
    };
  }
}

/**
 * 信任缓存（§12.1）：按 `trustCacheKey` 索引已验签的解析结果。
 *
 * 两条不变量：
 *   - **键含商家身份**：`(来源, agentId, card revision, binding_version, 端点)`——
 *     绝不按 Catalog hostname 索引所有商家（那会把不同商家混成一个身份）；
 *   - **有效期不长于声明自身的有效期**：声明过期即缓存过期，绝不把"曾经验过"
 *     当成"现在仍然有效"。
 */
export class CloudBindingTrustCache {
  /**
   * 时钟可注入：过期判定绝不能依赖真实墙钟，否则夹具的短有效期声明会在
   * 真实时间越过过期点后让测试定时失败（2026-09-21 实测踩中）。
   */
  constructor(private readonly clock: () => Date = () => new Date()) {}

  private readonly entries = new Map<
    string,
    { resolution: CloudAgentResolution; expiresAtMs: number }
  >();
  /** agentId → 最近一次的缓存键：重验证入口只知道 agentId，需要一个反查索引。 */
  private readonly latestByAgent = new Map<string, string>();

  set(resolution: CloudAgentResolution): void {
    const expiresAtMs = Date.parse(resolution.claims.expires_at);
    this.entries.set(resolution.trustKey, {
      resolution,
      expiresAtMs: Number.isNaN(expiresAtMs) ? 0 : expiresAtMs,
    });
    this.latestByAgent.set(resolution.agentId, resolution.trustKey);
  }

  get(trustKey: string, now: Date = this.clock()): CloudAgentResolution | undefined {
    const entry = this.entries.get(trustKey);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= now.getTime()) {
      this.entries.delete(trustKey);
      if (this.latestByAgent.get(entry.resolution.agentId) === trustKey) {
        this.latestByAgent.delete(entry.resolution.agentId);
      }
      return undefined;
    }
    return entry.resolution;
  }

  /** 该商家最近一次**未过期**的解析结果（用于条件重验证，不代表结果仍然可信）。 */
  latestFor(agentId: string, now: Date = this.clock()): CloudAgentResolution | undefined {
    const key = this.latestByAgent.get(agentId);
    return key === undefined ? undefined : this.get(key, now);
  }

  get size(): number {
    return this.entries.size;
  }
}
