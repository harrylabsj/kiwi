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
 * 共享 Buyer Core 构建器（战略 v2.5 §6.3 单核心多包装）。
 *
 * MCP / HTTP / CLI / SDK 等包装都调用同一个 buildBuyerService：注入 merchant
 * index、quote fetcher、negotiator 与持久 store，返回 KiwiBuyerService。
 * 包装层只负责 manifest/tool description/路由，业务判断全部回到 buyer-core。
 */

import path from "node:path";
import { McpError } from "./errors.js";

import { assertNorthboundContractValid } from "../contracts/northbound-schema.js";
import { BuyerFollowsSource } from "../discovery/catalog-source/buyer-follows.js";
import { MerchantAccessSource } from "../discovery/catalog-source/merchant-access.js";
import { buildWorkbuddyDualAddress } from "../a2a/access/workbuddy-address.js";
import { loadOrCreateA2aSigningIdentity } from "../a2a/signing-key.js";
import { HttpMessageSigner } from "../trust/identity/index.js";
import { loadOpenInquirySigner } from "./open-inquiry-signer.js";
import { OpenInquirySource, type OpenInquiryRoute } from "../discovery/catalog-source/open-inquiry.js";
import { officialCatalogTrust } from "../discovery/catalog-source/official-catalog-trust.js";
import { KiwiCatalogSource } from "../discovery/catalog-source/kiwi-source.js";
import type { CatalogAgentRecord } from "../discovery/catalog-source/kiwi-record.js";
import { OpenInquiryRouteStore } from "./open-inquiry-route-store.js";
import { BuyerRouteHintStore } from "./buyer-route-hint-store.js";
import type { MerchantAccessResolver, MerchantAccessTransport } from "./a2a-quote-fetcher.js";
import { A2ANegotiator } from "./a2a-negotiator.js";
import { A2AQuoteFetcher } from "./a2a-quote-fetcher.js";
import { KiwiCatalogMerchantIndex, MarketplaceMerchantIndex } from "./merchant-index.js";
import { MarketplaceNegotiator } from "./negotiator.js";
import { MarketplaceQuoteFetcher } from "./quote-fetcher.js";
import { KiwiBuyerService, type BuyerFollowsClient, type MerchantRecord } from "./service.js";
import { TaskApprovalStore } from "./store.js";

/**
 * Strip trailing ASCII slashes without a backtracking regular expression.
 * The prior `/\/+$/` replacement was flagged by CodeQL as a polynomial
 * regular expression on long slash runs. This scans backward once.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

export interface BuyerServiceConfig {
  dbPath: string;
  principal: string;
  buyerAgentId: string;
  /**
   * 可选：只用于 catalog 用量统计的稳定买家标识（X-Buyer-Id）。缺省等于
   * buyerAgentId。分离出来是为了让 Host（如 WorkBuddy）在不改变本地任务
   * owner 的前提下，按安装实例区分「去重买家」——否则所有宿主实例共用
   * 一个常量身份，运营端买家数会恒为 1。
   */
  catalogBuyerId?: string;
  sessionId: string;
  /** Opaque HMAC owner supplied by an MCP/HTTP wrapper. */
  sessionOwner?: string;
  policy: Record<string, unknown>;
  catalogUrl?: string;
  marketplaceUrl?: string;
  buyerBootstrapToken?: string;
  /**
   * catalog 账号会话 token（M4 买家关注；cookie kiwi_session）。缺省时关注
   * 工具返回"需要先在 Kiwi 目录登录"的可解释引导，不伪造买家身份。
   */
  catalogSessionToken?: string;
  /** New merchant-authoritative follow/feed client. Takes precedence over legacy Catalog follows. */
  merchantSubscriptionsClient?: BuyerFollowsClient;
  /** A2A 出站 bearer（服务器为 signature 认证时匿名放行可省）。 */
  a2aBearerToken?: string;
  /** A2A 允许打到私网/保留网段（SSRF 逃生门；本地试点直连时开）。 */
  a2aAllowPrivateRanges?: boolean;
  /** A2A 跳过 DNS 保留网段复查（测试/本机直连）。 */
  a2aSkipDnsCheck?: boolean;
  /** A2A 单请求超时 ms。 */
  a2aTimeoutMs?: number;
  /** Merchant-visible first-RFQ message; test/acceptance only. */
  rfqPublicMessage?: string;
  /** Explicit recovery directory required for memory/URI database configurations. */
  protocolStateDir?: string;
  /**
   * 可选：Buyer 的 A2A 签名身份目录（B-05）。设置后每个出站 A2A 请求带
   * HTTP Message Signature（RFC 9421），WorkBuddy 商家的业务身份即来自它；
   * 商家需把该公钥加入自己的 `a2a-trusted-keys.json`。目录首次使用时生成密钥
   * 并持久化（0600），重启不换钥。
   */
  a2aSigningKeyDir?: string;
  /** Test/embedding override for on-demand stale-merchant wake probes. */
  staleWake?: (merchant: MerchantRecord) => Promise<boolean>;
}

/**
 * 构建 Buyer Core：store + merchant index + quote fetcher + negotiator。
 *
 * 执行 seam 接线（战略 v2.5 Phase 2）：
 * - marketplaceUrl 优先（试点向后兼容）→ MarketplaceMerchantIndex +
 *   MarketplaceQuoteFetcher + MarketplaceNegotiator（shopping-cli 直连）。
 * - 否则 catalogUrl → KiwiCatalogMerchantIndex（listings 感知发现）+ A2AQuoteFetcher
 *   + A2ANegotiator（catalog 发现 → A2A 直连 merchant 磋商）。
 */
export function buildBuyerService(config: BuyerServiceConfig): KiwiBuyerService {
  assertNorthboundContractValid("delegation-policy", config.policy, "delegation policy");
  if(config.catalogUrl!==undefined && config.marketplaceUrl===undefined && (!config.dbPath.trim() || /^file:/i.test(config.dbPath)))throw new McpError("invalid_params","empty/URI buyer database is unsupported; use a real path or :memory: with explicit protocolStateDir");
  let protocolStateDir=config.protocolStateDir;
  if(config.catalogUrl!==undefined && config.marketplaceUrl===undefined && protocolStateDir===undefined){
    if(!config.dbPath.trim() || config.dbPath===":memory:" || /^file:/i.test(config.dbPath))throw new McpError("invalid_params","memory/URI buyer database requires explicit protocolStateDir");
    protocolStateDir=path.join(path.dirname(path.resolve(config.dbPath)),"buyer-knp");
  }
  if(protocolStateDir!==undefined && !path.isAbsolute(protocolStateDir))throw new McpError("invalid_params","protocolStateDir must be an explicit absolute directory");
  const store = new TaskApprovalStore({ dbPath: config.dbPath });
  let merchantIndex;
  let quoteFetcher;
  let negotiator;
  let followsClient;
  if (config.marketplaceUrl !== undefined) {
    merchantIndex = new MarketplaceMerchantIndex({ baseUrl: config.marketplaceUrl });
    quoteFetcher = new MarketplaceQuoteFetcher({
      baseUrl: config.marketplaceUrl,
      buyerBootstrapToken: config.buyerBootstrapToken ?? "",
    });
    negotiator = new MarketplaceNegotiator({ baseUrl: config.marketplaceUrl });
  } else if (config.catalogUrl !== undefined) {
    // catalogBuyerId 默认回落到 buyerAgentId；Host 可显式传入仅用于统计的
    // 稳定实例标识，透传为 X-Buyer-Id 供 kiwi-catalog 做 distinct-buyer
    // 用量统计——不改变本地任务 owner（buyerAgentId）。
    const catalogBuyerId = config.catalogBuyerId ?? config.buyerAgentId;
    merchantIndex = new KiwiCatalogMerchantIndex({
      baseUrl: config.catalogUrl,
      buyerId: catalogBuyerId,
    });
    // M4 买家关注：仅在显式配置了 catalog 账号会话时接线；缺省不伪造身份，
    // 由 service 层返回"需要先在 Kiwi 目录登录"的可解释引导。
    if (config.merchantSubscriptionsClient !== undefined) {
      followsClient = config.merchantSubscriptionsClient;
    } else if (config.catalogSessionToken !== undefined && config.catalogSessionToken !== "") {
      followsClient = new BuyerFollowsSource({
        baseUrl: config.catalogUrl,
        sessionToken: config.catalogSessionToken,
        buyerId: catalogBuyerId,
      });
    }
    // WorkBuddy 平台门禁（B-01/B-02）：只有显式配置了目录会话时才可能取到
    // 分享码；没有会话时解析器返回 null，声明了 runtime_access 的商家会
    // fail-closed 为 access_unavailable（不静默降级为无码直连）。
    const accessSource =
      config.catalogSessionToken !== undefined && config.catalogSessionToken !== ""
        ? new MerchantAccessSource({
            baseUrl: config.catalogUrl,
            sessionToken: config.catalogSessionToken,
            buyerId: catalogBuyerId,
          })
        : undefined;
    const accessByOrigin = new Map<string, MerchantAccessTransport>();
    const catalogOrigin = stripTrailingSlashes(config.catalogUrl);
    const officialTrust = officialCatalogTrust(catalogOrigin);
    const openRouteStore = officialTrust && protocolStateDir ? new OpenInquiryRouteStore(protocolStateDir, catalogOrigin) : undefined;
    // Restart recovery hint: who to re-ask about, never a cached route decision.
    // It is available for any Catalog (not only the official one) because every
    // use re-fetches the configured Catalog's public projection without a
    // session; the relay itself remains official-trust-only.
    const routeHintStore = protocolStateDir !== undefined
      ? new BuyerRouteHintStore(protocolStateDir, catalogOrigin)
      : undefined;
    const publicCatalog = routeHintStore !== undefined
      ? new KiwiCatalogSource({ baseUrl: catalogOrigin })
      : undefined;
    // A protocol directory may be shared by several configured buyers. Their
    // session keys must remain distinct because merchant task ownership is
    // bound to the self-certifying public key, not the local task ID.
    const openSource = officialTrust && protocolStateDir ? new OpenInquirySource({ catalogOrigin,
      trust: officialTrust, signer: loadOpenInquirySigner(protocolStateDir, config.principal, config.buyerAgentId),
      timeoutMs: config.a2aTimeoutMs }) : undefined;
    const relayWired = openSource !== undefined && openRouteStore !== undefined;
    const openTransport = (openInquiry: OpenInquiryRoute): MerchantAccessTransport => ({ sendUrlFor: (url) => url, openInquiry });
    const transportFor = (secret: string): MerchantAccessTransport => ({
      sendUrlFor: (signUrl: string) => buildWorkbuddyDualAddress(signUrl, secret).sendUrl,
    });
    // 目录明确 404（无 active 分享码配置）时的正向无码信号。没有它，
    // WorkBuddy 主机 card 的已加白商家会被 fetcher 的 fail-closed 挡住。
    const directTransport: MerchantAccessTransport = { sendUrlFor: (url) => url, direct: true };
    const relayRequiredTransport: MerchantAccessTransport = {
      sendUrlFor: () => { throw new Error("share-code transport is disabled while relay is wired"); },
      relayRequired: true,
    };
    // Safe categories only: never include a URL, a share code or raw error text.
    const routeUnavailable = (code: string): Error =>
      Object.assign(
        new Error(`商家访问路线不可用，请重新发现商家后续办（${code}）`),
        { code },
      );
    const rememberRouteHint = (
      agentId: string,
      merchantId: string,
      origin: string | undefined,
      kind: "direct" | "relay",
    ): void => {
      if (routeHintStore === undefined || origin === undefined) return;
      try {
        routeHintStore.remember({ agentId, merchantId, origin, kind });
      } catch {
        // A hint is an availability optimization. Storage failure must never
        // turn into authorization; recovery simply fails closed later.
      }
    };
    const rememberOpenHint = (agentId: string, merchantId: string, endpoint: string): void => {
      try {
        openRouteStore?.remember({ agentId, merchantId, endpoint });
      } catch {
        // Best-effort only; the next endpoint lookup re-verifies anyway.
      }
    };
    const cardOrigin = (record: CatalogAgentRecord): string | undefined => {
      if (record.agent_card_url === undefined || record.agent_card_url === "") return undefined;
      try {
        return new URL(record.agent_card_url).origin;
      } catch {
        return undefined;
      }
    };
    /**
     * Fresh, public, account-free read of the route projection. Any failure is
     * terminal for recovery: an old direct cache or an old relay hint must not
     * survive an unavailable Catalog.
     */
    const freshRouteRecord = async (
      agentId: string,
      merchantId: string,
    ): Promise<CatalogAgentRecord> => {
      if (publicCatalog === undefined) throw routeUnavailable("ROUTE_STATE_UNAVAILABLE");
      let record: CatalogAgentRecord;
      try {
        record = await publicCatalog.getRecord(agentId);
      } catch {
        throw routeUnavailable("ROUTE_STATE_UNAVAILABLE");
      }
      if (record.catalog_agent_id !== agentId) throw routeUnavailable("ROUTE_STATE_INVALID");
      if (record.merchant_id !== undefined && record.merchant_id !== merchantId)
        throw routeUnavailable("ROUTE_STATE_INVALID");
      if (record.administrative_state !== "active")
        throw routeUnavailable("ACCESS_ROUTE_UNKNOWN");
      return record;
    };
    const resolveRelayRoute = async (
      agentId: string,
      merchantId: string,
      endpointUrl: string,
    ): Promise<MerchantAccessTransport> => {
      if (!relayWired || openSource === undefined || openRouteStore === undefined)
        return relayRequiredTransport;
      const open = await openSource.get(agentId, merchantId).catch(() => {
        throw routeUnavailable("OPEN_INQUIRY_LOOKUP_FAILED");
      });
      if (open === null || open.endpoint !== endpointUrl)
        throw routeUnavailable("OPEN_INQUIRY_ROUTE_INVALID");
      rememberOpenHint(agentId, merchantId, open.endpoint);
      return openTransport(open);
    };
    /**
     * Apply the just-fetched projection. `direct` is only the merchant's
     * explicit no-share-code choice; it is not a platform whitelist fact.
     */
    const applyFreshRoute = async (
      record: CatalogAgentRecord,
      hint: { agentId: string; merchantId: string; kind: "direct" | "relay" },
      endpointUrl: string,
      origin: string,
    ): Promise<MerchantAccessTransport> => {
      const state = record.buyer_access?.state;
      if (state === "direct") {
        if (cardOrigin(record) !== origin) throw routeUnavailable("ROUTE_STATE_INVALID");
        return directTransport;
      }
      if (state === "relay") {
        return resolveRelayRoute(hint.agentId, hint.merchantId, endpointUrl);
      }
      if (state === "unknown") throw routeUnavailable("ACCESS_ROUTE_UNKNOWN");
      if (state !== undefined) throw routeUnavailable("ROUTE_STATE_INVALID");
      // Old Catalog/record without the additive projection: preserve legacy
      // semantics, but never let a direct hint outlive a newly declared
      // runtime_access gate.
      if (hint.kind === "direct") {
        if (record.runtime_access !== undefined)
          throw routeUnavailable("ACCESS_ROUTE_UNKNOWN");
        if (cardOrigin(record) !== origin) throw routeUnavailable("ROUTE_STATE_INVALID");
        return directTransport;
      }
      return resolveRelayRoute(hint.agentId, hint.merchantId, endpointUrl);
    };
    const merchantAccess: MerchantAccessResolver = {
      forMerchant: async (merchant) => {
        if (merchant.catalog_agent_id === undefined) return null;
        const cardUrl = merchant.agent_card_url;
        const expectedOrigin =
          cardUrl === undefined || cardUrl === "" ? undefined : new URL(cardUrl).origin;
        const routeState = merchant.buyer_access?.state;
        // 目录明确说"无法确认"（授权撤销/轮换/过期、agent 非 active）：这是
        // 终态，不能退回 legacy 猜测，更不能因为商家以前保存过分享码就直连。
        if (routeState === "unknown") {
          if (expectedOrigin !== undefined) accessByOrigin.delete(expectedOrigin);
          throw routeUnavailable("ACCESS_ROUTE_UNKNOWN");
        }
        // 商家显式选择无分享码：即使目录里仍保留 active runtime_access（切换
        // 模式不删已保存分享码），买家也走无码直连。direct 不是平台白名单
        // 背书；直连被 401/403 时由 fetcher fail-closed，不拿旧码回退。
        // 持久 hint 只记身份，恢复时必须重新读取目录公开状态。
        if (routeState === "direct") {
          if (expectedOrigin !== undefined) {
            accessByOrigin.delete(expectedOrigin);
            rememberRouteHint(merchant.catalog_agent_id, merchant.merchant_id, expectedOrigin, "direct");
          }
          return directTransport;
        }
        // 商家显式选择分享码：买家只能经目录中继，不能取/带分享码直连。
        // 中继未接线或当前不可用都是终态 RELAY_REQUIRED；不得回退带码直连。
        if (routeState === "relay") {
          if (expectedOrigin !== undefined) {
            accessByOrigin.delete(expectedOrigin);
            rememberRouteHint(merchant.catalog_agent_id, merchant.merchant_id, expectedOrigin, "relay");
          }
          if (!relayWired) {
            if (expectedOrigin !== undefined) accessByOrigin.set(expectedOrigin, relayRequiredTransport);
            return relayRequiredTransport;
          }
          const open = await openSource.get(merchant.catalog_agent_id, merchant.merchant_id);
          if (open !== null) {
            rememberOpenHint(merchant.catalog_agent_id, merchant.merchant_id, open.endpoint);
            return openTransport(open);
          }
          if (expectedOrigin !== undefined) accessByOrigin.set(expectedOrigin, relayRequiredTransport);
          return relayRequiredTransport;
        }
        // 以下为旧目录/旧记录（没有 buyer_access）的既有语义，保持不变。
        if (relayWired) {
          const open = await openSource.get(merchant.catalog_agent_id, merchant.merchant_id);
          if (open !== null) {
            rememberRouteHint(merchant.catalog_agent_id, merchant.merchant_id, expectedOrigin, "relay");
            rememberOpenHint(merchant.catalog_agent_id, merchant.merchant_id, open.endpoint);
            return openTransport(open);
          }
          // 公开记录声明 runtime_access 的商家需要分享码，且中继已接线：中继
          // 返回 null（未开通/拒绝授权/撤销/发布暂停的统一 404）是终态，不能
          // 回退到分享码直连，否则等于绕过商家对中继的授权。返回 null 后由
          // A2AQuoteFetcher 对声明门禁的商家 fail-closed 为 access_unavailable。
          // 已加白/无需分享码的商家（无 runtime_access）仍走下面的既有直连/
          // 无码路径；非官方 Catalog 或未配置 protocolStateDir 时中继未接线，
          // 旧接入方式不变。
          if (merchant.runtime_access !== undefined) {
            rememberRouteHint(merchant.catalog_agent_id, merchant.merchant_id, expectedOrigin, "relay");
            return null;
          }
        }
        const access = await accessSource?.get(merchant.catalog_agent_id, {
          ...(expectedOrigin !== undefined ? { runtimeOrigin: expectedOrigin } : {}),
        });
        if (access === undefined || access === null) {
          // 只有目录明确回答 404（active 配置不存在）才是无码/已加白的正向
          // 信号；没有目录会话（undefined）或 401/403 异常都按未知处理，绝不
          // 据此推断白名单。正向信号让 WorkBuddy 主机也能走无码直连；同时
          // 记下恢复 hint（只记身份，不记放行结论）。
          if (relayWired && accessSource !== undefined && expectedOrigin !== undefined) {
            accessByOrigin.delete(expectedOrigin);
            rememberRouteHint(merchant.catalog_agent_id, merchant.merchant_id, expectedOrigin, "direct");
            if (routeHintStore === undefined) accessByOrigin.set(expectedOrigin, directTransport);
            return directTransport;
          }
          return null;
        }
        if (relayWired) {
          // 目录仍有 active 分享码，但中继当前不可用（未授权/撤销/暂停等）：
          // 不把分享码交给 fetcher，也不删除/失效已保存的密钥。返回终态
          // relayRequired 标记，所有主机（不只 WorkBuddy）都 fail-closed，避免
          // 非 WB 主机成为绕过中继的旁路；恢复路径同样拒绝。
          if (expectedOrigin !== undefined) {
            accessByOrigin.set(expectedOrigin, relayRequiredTransport);
            rememberRouteHint(merchant.catalog_agent_id, merchant.merchant_id, expectedOrigin, "relay");
          }
          return relayRequiredTransport;
        }
        if (expectedOrigin === undefined) return null;
        const transport = transportFor(access.secret_value);
        accessByOrigin.set(expectedOrigin, transport);
        return transport;
      },
      forEndpoint: async (endpointUrl: string) => {
        // 对外只给固定安全分类，绝不携带 URL、分享码或底层异常文本；
        // 保留分类是为了让"路线失效 / 查询失败 / 非法端点"仍可区分。
        const unavailable = routeUnavailable;
        let origin: string;
        try {
          origin = new URL(endpointUrl).origin;
        } catch {
          throw unavailable("INVALID_ENDPOINT");
        }
        // Recovery/negotiation often only knows the endpoint. A persisted hint
        // tells us which Catalog agent to re-ask about; it does not authorize a
        // route. Always fetch the live public projection first and ignore any
        // cached transport for this origin, so a switch/revocation cannot be
        // bypassed by an old direct or share-code cache.
        const directHint = routeHintStore?.getByOrigin(origin);
        const openHint = openRouteStore?.get(endpointUrl);
        if (directHint !== undefined || openHint !== undefined) {
          if (
            directHint !== undefined &&
            openHint !== undefined &&
            (directHint.agentId !== openHint.agentId ||
              directHint.merchantId !== openHint.merchantId)
          )
            throw unavailable("ROUTE_HINT_CONFLICT");
          const hint =
            directHint ??
            (openHint === undefined
              ? undefined
              : {
                  agentId: openHint.agentId,
                  merchantId: openHint.merchantId,
                  kind: "relay" as const,
                });
          if (hint !== undefined) {
            accessByOrigin.delete(origin);
            const record = await freshRouteRecord(hint.agentId, hint.merchantId);
            return applyFreshRoute(record, hint, endpointUrl, origin);
          }
        }
        const legacy = accessByOrigin.get(origin);
        if (legacy !== undefined) {
          // 中继已接线时，旧缓存里的分享码传输也不能用于恢复；显式 direct
          // 标记是无码路径，放行给 fetcher 归一化为标准直连。
          if (relayWired && legacy.openInquiry === undefined && legacy.direct !== true)
            throw unavailable("SHARE_CODE_DIRECT_DISABLED");
          return legacy;
        }
        let host = "";
        try {
          host = new URL(origin).hostname.toLowerCase();
        } catch {
          throw unavailable("INVALID_ENDPOINT");
        }
        if (
          host === "workbuddy.host" ||
          host.endsWith(".workbuddy.host") ||
          host === "workbuddy.cn" ||
          host.endsWith(".workbuddy.cn")
        )
          throw unavailable("WORKBUDDY_ROUTE_UNAVAILABLE");
        return null;
      },
    };
    // B-05：可选的出站签名身份。没有它时 WorkBuddy 商家只能走到匿名 T0，
    // 受保护操作（任务回读等）会被商家按策略拒绝——这是刻意的 fail-closed。
    const signer = (() => {
      if (config.a2aSigningKeyDir === undefined || config.a2aSigningKeyDir === "") return undefined;
      const identity = loadOrCreateA2aSigningIdentity(config.a2aSigningKeyDir, config.buyerAgentId);
      return new HttpMessageSigner({
        keyid: identity.keyid,
        algorithm: identity.algorithm,
        privateKey: identity.privateKeyPem,
      });
    })();
    const a2a = {
      merchantAccess,
      ...(accessSource !== undefined
        ? {
            onAccessDenied: async (merchant: { catalog_agent_id?: string }) => {
              if (merchant.catalog_agent_id !== undefined) {
                await accessSource.reportFault(merchant.catalog_agent_id, "gate_rejected");
              }
            },
          }
        : {}),
      ...(signer !== undefined ? { signer } : {}),
      relayWired,
      protocolStateDir,
      localBuyerAgentId:config.buyerAgentId,
      bearerToken: config.a2aBearerToken,
      allowPrivateRanges: config.a2aAllowPrivateRanges,
      skipDnsCheck: config.a2aSkipDnsCheck,
      timeoutMs: config.a2aTimeoutMs,
      ...(config.rfqPublicMessage !== undefined ? { publicMessage: config.rfqPublicMessage } : {}),
    };
    quoteFetcher = new A2AQuoteFetcher(a2a);
    negotiator = new A2ANegotiator({
      ...a2a,
      // review P1-2（A325 收口）：生产工厂必须把**实际外发 counter 提案**
      // 接上委托约束门（A322 源审：此前行 109 未接线、serviceRef 未消费，
      // 手动注入 gate 的测试不能证明真实生产限额门）。service 后构造，
      // 经 late-bound 引用闭环；接线缺失时 negotiator 侧 fail-closed
      //（无 gate 不外发 counter——见 a2a-negotiator 强制）。
      counterProposalGate: (proposal) => serviceRef?.checkCounterProposalLimits(proposal) ??
        (serviceRef === undefined ? "counter proposal gate unavailable (fail-closed)" : undefined),
    });
  }
  // No-credential wake is not enabled by default: a platform 403/404 does not
  // prove cold start. Production must opt in only after the platform wake path
  // is empirically verified; tests inject staleWake explicitly.
  const staleWake = config.staleWake;
  let serviceRef: KiwiBuyerService | undefined;
  const serviceInstance = new KiwiBuyerService({
    store,
    principal: config.principal,
    buyerAgentId: config.buyerAgentId,
    sessionId: config.sessionId,
    ...(config.sessionOwner !== undefined ? { sessionOwner: config.sessionOwner } : {}),
    delegationPolicy: config.policy,
    ...(merchantIndex !== undefined ? { merchantIndex } : {}),
    ...(quoteFetcher !== undefined ? { quoteFetcher } : {}),
    ...(negotiator !== undefined ? { negotiator } : {}),
    ...(followsClient !== undefined ? { followsClient } : {}),
    ...(staleWake !== undefined ? { staleWake } : {}),
  });
  serviceRef = serviceInstance;
  return serviceInstance;
}
