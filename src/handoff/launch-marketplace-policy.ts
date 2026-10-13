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
 * A651 包四：可信 SKU↔平台商品ID 及交易入口政策（PACK4-READONLY-PLAN 落地）。
 *
 * 本模块是**中立纯函数层**（无 I/O、无网络、无模型可达参数面）：
 *   - parseMarketplaceTradeUrl：只接受三个平台 builder（marketplace-product-link.ts）
 *     的确切最小 URL 形态；SKU 永不当 URL ID；不发明第四平台、不改冻结 schema。
 *   - MarketplaceSourceBinding：由**正常 host reader**（已配置 CatalogSource.getListing
 *     重读）产生的非秘密 sidecar 证据；模型 shortlist 的 source 标签 / URL /
 *     verified:true 一律不作为来源。
 *   - verifyMarketplaceLaunch：把候选/协议/任务绑定与一次**新鲜重读**比对——
 *     来源变更（owner/SKU/平台/ID/digest/revision/有效期/健康态）→ 陈旧需原
 *     审批流程新确认；无证据 → needs_configuration，不交付。
 *
 * 证明边界（不越界声明）：仅证明「本次正常 Catalog 声明的 SKU 对应该平台商品
 * URL/ID，协议交付一致」——**不是**平台确认商品真值、价格/库存、下单/支付、
 * 预留或交易完成。三平台之外不扩。
 */

import { contentDigest } from "../negotiation/jcs.js";

/** 交易平台词表（与 marketplace-product-link.ts 单一来源保持同集；不新增）。 */
export type LaunchTradePlatform = "jd" | "taobao" | "tmall";

/** 固定公共错误分类（不透 URL/host/query 原文或内部异常细节）。 */
export type MarketplaceLaunchPolicyCode =
  | "trade_uri_invalid"
  | "unsupported_platform"
  | "platform_id_invalid";

export class MarketplaceLaunchPolicyError extends Error {
  readonly code: MarketplaceLaunchPolicyCode;

  constructor(code: MarketplaceLaunchPolicyCode, message: string) {
    super(message);
    this.name = "MarketplaceLaunchPolicyError";
    this.code = code;
  }
}

/** 三个平台生成器（buildMarketplaceProductLink）的确切形态；host 精确匹配。 */
const PLATFORM_HOSTS: Readonly<Record<string, LaunchTradePlatform>> = {
  "item.jd.com": "jd",
  "item.taobao.com": "taobao",
  "detail.tmall.com": "tmall",
};

const PLATFORM_ID_PATTERN = /^[1-9][0-9]*$/;

export interface ParsedMarketplaceTradeUrl {
  readonly platform: LaunchTradePlatform;
  /** 平台 opaque 商品 ID：ASCII 正整数字符串；不转 Number、不科学计数、不改字节。 */
  readonly platform_product_id: string;
  /** 输入 URI 原字节（绑定审计用）。 */
  readonly declared_uri: string;
}

/**
 * 解析并校验一个交易 URI。唯一权威判据：**原字节 raw 必须与由 platform +
 * opaque ID 经三平台 builder 形态重建的唯一规范 URL 逐字相等**（verbatim
 * equality）。这一条同时否决：显式 `:443`（URL 归一化后 port 为空，但 raw
 * 与重建串不等）、dot 段路径（`/../` 被归一化）、反斜杠（WHATWG 归一化为
 * `/`）、userinfo、fragment、percent 编码、额外/重复 query、缺 id。
 * 分类拒绝先给出可读原因，最后以逐字相等一锤定音；SKU 永不当 URL ID。
 */
export function parseMarketplaceTradeUrl(raw: unknown): ParsedMarketplaceTradeUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must be a non-empty https URL string");
  }
  // URL 构造器会吞控制字符/空白/编码差异——先按原字节拒（CRLF 注入、
  // 空白截断、tab 混淆都在这里死掉）。语义 = ASCII 0x00-0x20 与 0x7f；
  // 逐 code unit 判定（no-control-regex 合规，规则不关）。
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI contains control or whitespace characters");
    }
  }
  if (raw.includes("%")) {
    // builder 形态不含任何 percent 编码；出现即混淆/注入尝试（fail-closed，
    // 不尝试解码比对——解码等价类不可枚举）。
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must use the exact marketplace form (no percent-encoding)");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must be https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must not carry userinfo");
  }
  if (url.port !== "") {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must use the default port");
  }
  if (url.hash !== "") {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must not carry a fragment");
  }
  // host 精确命中三平台表（WHATWG URL 已把 host 小写化）：IP/IDN/尾点/大小写
  // 变体域名都落不进表，无需再发明平行规则。
  const platform = PLATFORM_HOSTS[url.hostname];
  if (platform === undefined) {
    throw new MarketplaceLaunchPolicyError("unsupported_platform", "trade URI host is not a supported marketplace platform");
  }
  let platformProductId: string;
  if (platform === "jd") {
    // path 形如 /{id}.html，恰好一段；query 一律无。
    const match = /^\/([1-9][0-9]*)\.html$/.exec(url.pathname);
    if (match === null) {
      throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "JD trade URI must be https://item.jd.com/{id}.html");
    }
    platformProductId = match[1]!;
  } else {
    // taobao/tmall：path 恰为 /item.htm；query 只有恰好一个 id，值为 ASCII
    // 正整数字符串。
    if (url.pathname !== "/item.htm") {
      throw new MarketplaceLaunchPolicyError("trade_uri_invalid", `${platform} trade URI path must be /item.htm`);
    }
    const ids = url.searchParams.getAll("id");
    if (ids.length !== 1) {
      throw new MarketplaceLaunchPolicyError("trade_uri_invalid", `${platform} trade URI must carry exactly one id parameter`);
    }
    const id = ids[0]!;
    if (!PLATFORM_ID_PATTERN.test(id)) {
      throw new MarketplaceLaunchPolicyError("platform_id_invalid", "platform product id must be an ASCII positive integer string");
    }
    platformProductId = id;
  }
  // 权威判据：与 builder 重建的唯一规范 URL 逐字相等——显式 `:443`、dot 段
  // （/../）、反斜杠、多余 `?`/`&` 都因归一化而与 raw 不等，在此统一拒绝。
  if (raw !== canonicalTradeUri(platform, platformProductId)) {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trade URI must be byte-identical to the canonical marketplace form");
  }
  return { platform, platform_product_id: platformProductId, declared_uri: raw };
}

/** 三平台 builder 的确切形态（与 marketplace-product-link.ts 逐字同形，不引运行时依赖）。 */
function canonicalTradeUri(platform: LaunchTradePlatform, id: string): string {
  switch (platform) {
    case "jd":
      return `https://item.jd.com/${id}.html`;
    case "taobao":
      return `https://item.taobao.com/item.htm?id=${id}`;
    case "tmall":
      return `https://detail.tmall.com/item.htm?id=${id}`;
  }
}

/** 同平台同 opaque 商品 ID 判定（重定向每一跳强制）。 */
export function sameMarketplaceTarget(
  a: ParsedMarketplaceTradeUrl,
  b: ParsedMarketplaceTradeUrl,
): boolean {
  return a.platform === b.platform && a.platform_product_id === b.platform_product_id;
}

// ───────────────────────── 可信来源 sidecar ─────────────────────────

export const MARKETPLACE_SOURCE_BINDING_VERSION = "marketplace_source_binding/1";

/**
 * 正常 host reader（已配置 CatalogSource.getListing）实际读取的 listing 投影。
 * 结构上是 ListingRecord 的受控子集——handoff 层不 import discovery 模块，
 * 只要求结构满足；模型/搜索结果里的同名字段**不构成**本类型来源。
 */
export interface MarketplaceListingSnapshot {
  readonly listing_id: string;
  readonly listing_type: string;
  readonly owner_agent_id: string;
  readonly merchant_id: string;
  readonly source_product_ref?: string;
  readonly source_revision?: string;
  readonly handoff_destination_ref?: string;
  readonly listing_digest: string;
  readonly publication_state: string;
  readonly listing_freshness_state: string;
  readonly fresh_until: string;
  readonly updated_at: string;
}

/** 非秘密 sidecar（KTH §11.3 最小化；不含 cookie/grant/query token）。 */
export interface MarketplaceSourceBinding {
  readonly binding_version: typeof MARKETPLACE_SOURCE_BINDING_VERSION;
  /** 配置态 catalog 来源标识（如 catalog base URL origin）；非模型可填参数。 */
  readonly configured_catalog_origin: string;
  readonly listing_id: string;
  readonly listing_digest: string;
  /** 缺省如实 null——不伪造上游 revision。 */
  readonly source_revision: string | null;
  readonly owner_agent_id: string;
  readonly merchant_id: string;
  readonly merchant_sku: string;
  readonly declared_uri: string;
  /** P4 校准（2026-10-13）：binding 只为三平台确切形态形成；错误 ID/额外
   *  query 直接拒绝，不做自有域 fallback——故两字段恒非空。 */
  readonly parsed_platform: LaunchTradePlatform;
  readonly platform_product_id: string;
  readonly listing_updated_at: string;
  readonly fresh_until: string;
  readonly observed_at: string;
  /** 受控投影快照摘要（listing 全量 digest 之外的本地绑定锚）。 */
  readonly local_snapshot_digest: string;
  /** 与任务/磋商/协议/条款/候选的精确绑定（执行期逐项重核）。 */
  readonly task_id: string;
  readonly negotiation_id: string;
  readonly agreement_id: string;
  readonly terms_digest: string;
  readonly candidate_digest: string;
}

export interface MarketplaceSourceBindingInput {
  readonly catalogOrigin: string;
  readonly listing: MarketplaceListingSnapshot;
  readonly taskId: string;
  readonly negotiationId: string;
  readonly agreementId: string;
  readonly termsDigest: string;
  readonly candidateDigest: string;
  readonly observedAt: string;
}

/**
 * 从一次**已发生的可信读取**构造 sidecar。declared_uri = listing 实际声明的
 * 成交入口，必须是三平台确切形态——错误 ID/额外 query/混淆形态直接拒绝
 * （P4 不添加自有域 fallback：URL 交易门只覆盖可平台绑定的市场入口；opaque
 * quote/contact/session 类型语义独立保持，不受本门影响）。
 */
export function buildMarketplaceSourceBinding(input: MarketplaceSourceBindingInput): MarketplaceSourceBinding {
  const declaredUri = input.listing.handoff_destination_ref;
  if (typeof declaredUri !== "string" || declaredUri.trim() === "") {
    throw new MarketplaceLaunchPolicyError("trade_uri_invalid", "trusted listing declares no trade URI (handoff_destination_ref missing)");
  }
  const parsed = parseMarketplaceTradeUrl(declaredUri);
  const snapshot = {
    listing_id: input.listing.listing_id,
    listing_type: input.listing.listing_type,
    owner_agent_id: input.listing.owner_agent_id,
    merchant_id: input.listing.merchant_id,
    source_product_ref: input.listing.source_product_ref ?? null,
    source_revision: input.listing.source_revision ?? null,
    handoff_destination_ref: declaredUri,
    listing_digest: input.listing.listing_digest,
    publication_state: input.listing.publication_state,
    listing_freshness_state: input.listing.listing_freshness_state,
    fresh_until: input.listing.fresh_until,
    updated_at: input.listing.updated_at,
  };
  return Object.freeze({
    binding_version: MARKETPLACE_SOURCE_BINDING_VERSION,
    configured_catalog_origin: input.catalogOrigin,
    listing_id: input.listing.listing_id,
    listing_digest: input.listing.listing_digest,
    source_revision: input.listing.source_revision ?? null,
    owner_agent_id: input.listing.owner_agent_id,
    merchant_id: input.listing.merchant_id,
    merchant_sku: input.listing.source_product_ref ?? "",
    declared_uri: declaredUri,
    parsed_platform: parsed.platform,
    platform_product_id: parsed.platform_product_id,
    listing_updated_at: input.listing.updated_at,
    fresh_until: input.listing.fresh_until,
    observed_at: input.observedAt,
    local_snapshot_digest: contentDigest(snapshot),
    task_id: input.taskId,
    negotiation_id: input.negotiationId,
    agreement_id: input.agreementId,
    terms_digest: input.termsDigest,
    candidate_digest: input.candidateDigest,
  });
}

// ───────────────────────── 执行期强制核验 ─────────────────────────

export type MarketplaceLaunchVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * needs_configuration：无可用来源证据（不交付；不改候选终态）。
       * stale：证据存在但与当前事实不一致（来源变更 → 原审批流程新确认）。
       */
      readonly disposition: "needs_configuration" | "stale";
      readonly reason: string;
    };

export interface MarketplaceLaunchVerifyInput {
  /** 审批/恢复链上带来的 sidecar（无 → needs_configuration）。 */
  readonly binding: unknown;
  /** 执行期**新鲜重读**的可信快照（正常 host reader 产物）。 */
  readonly fresh: MarketplaceListingSnapshot | undefined;
  readonly catalogOrigin: string;
  readonly taskId: string;
  readonly negotiationId: string;
  readonly agreementId: string;
  readonly termsDigest: string;
  readonly candidateDigest: string;
  readonly destinationType: string;
  readonly destinationRef: string;
  /** 当前协议实际接受商品 SKU（agreement items[0].sku）。 */
  readonly agreedSku: string;
  /** 协议商家归属（catalog owner agent id）。 */
  readonly ownerAgentId: string;
  readonly nowMs: number;
}

/**
 * 强制交易门核验（执行期，generic executeHandoff 内调用；不可由 callback 跳过）：
 *   1. 无 sidecar / 形状不符 → needs_configuration（旧 READY 无证据不迁移旧授权）；
 *   2. sidecar 与当前任务/协议/候选/条款绑定不一致 → stale（需原审批新确认）；
 *   3. 新鲜重读缺失 → stale（来源不可读，不冒交付）；
 *   4. 重读与 sidecar 任一来源事实变化（listing/owner/merchant/SKU/URI/平台/
 *      ID/digest/revision/updated_at/fresh_until）→ stale；
 *   5. 重读健康门（product/ACTIVE/FRESH/fresh_until 未来）不过 → stale；
 *   6. 候选目的地与可信 declared_uri / 平台 ID 精确匹配不过 → stale。
 * reason 只含固定分类与字段名，不含 URI/query 原文。
 */
export function verifyMarketplaceLaunch(input: MarketplaceLaunchVerifyInput): MarketplaceLaunchVerdict {
  const binding = input.binding;
  if (typeof binding !== "object" || binding === null) {
    return { ok: false, disposition: "needs_configuration", reason: "no marketplace trade source binding on candidate" };
  }
  const b = binding as Partial<MarketplaceSourceBinding>;
  if (b.binding_version !== MARKETPLACE_SOURCE_BINDING_VERSION) {
    return { ok: false, disposition: "needs_configuration", reason: "unknown marketplace source binding version" };
  }
  const required: ReadonlyArray<keyof MarketplaceSourceBinding> = [
    "configured_catalog_origin", "listing_id", "listing_digest", "source_revision", "owner_agent_id",
    "merchant_id", "merchant_sku", "declared_uri", "parsed_platform", "platform_product_id",
    "listing_updated_at", "fresh_until", "observed_at", "local_snapshot_digest",
    "task_id", "negotiation_id", "agreement_id", "terms_digest", "candidate_digest",
  ];
  for (const key of required) {
    if (b[key] === undefined) {
      return { ok: false, disposition: "needs_configuration", reason: `marketplace source binding is missing field ${String(key)}` };
    }
  }
  const binds: ReadonlyArray<[keyof MarketplaceSourceBinding, string]> = [
    ["task_id", input.taskId],
    ["negotiation_id", input.negotiationId],
    ["agreement_id", input.agreementId],
    ["terms_digest", input.termsDigest],
    ["candidate_digest", input.candidateDigest],
  ];
  for (const [key, expected] of binds) {
    if (b[key] !== expected) {
      return { ok: false, disposition: "stale", reason: `marketplace source binding ${String(key)} does not match the current candidate` };
    }
  }
  if (input.fresh === undefined) {
    return { ok: false, disposition: "stale", reason: "trusted trade source could not be re-read (no fresh listing)" };
  }
  const fresh = input.fresh;
  const sourceFields: ReadonlyArray<[keyof MarketplaceListingSnapshot, keyof MarketplaceSourceBinding | undefined]> = [
    ["listing_id", "listing_id"],
    ["listing_digest", "listing_digest"],
    ["owner_agent_id", "owner_agent_id"],
    ["merchant_id", "merchant_id"],
    ["handoff_destination_ref", "declared_uri"],
    ["updated_at", "listing_updated_at"],
    ["fresh_until", "fresh_until"],
  ];
  for (const [freshKey, bindingKey] of sourceFields) {
    const actual = fresh[freshKey];
    const expected = bindingKey === undefined ? undefined : b[bindingKey];
    if ((actual ?? null) !== (expected ?? null)) {
      return { ok: false, disposition: "stale", reason: `trade source ${String(freshKey)} changed since approval` };
    }
  }
  if ((fresh.source_revision ?? null) !== (b.source_revision ?? null)) {
    return { ok: false, disposition: "stale", reason: "trade source revision changed since approval" };
  }
  if ((fresh.source_product_ref ?? "") !== b.merchant_sku || b.merchant_sku !== input.agreedSku) {
    return { ok: false, disposition: "stale", reason: "trade source SKU does not match the agreed terms SKU" };
  }
  if (fresh.owner_agent_id !== input.ownerAgentId) {
    return { ok: false, disposition: "stale", reason: "trade source owner does not match the agreement merchant" };
  }
  // 健康门：product / ACTIVE / FRESH / fresh_until 严格未来（NaN 按过期）。
  if (fresh.listing_type !== "product") {
    return { ok: false, disposition: "stale", reason: "trade source listing is not a product listing" };
  }
  if (fresh.publication_state !== "ACTIVE" || fresh.listing_freshness_state !== "FRESH") {
    return { ok: false, disposition: "stale", reason: "trade source listing is not ACTIVE/FRESH" };
  }
  const freshUntilMs = Date.parse(fresh.fresh_until);
  if (!Number.isFinite(freshUntilMs) || freshUntilMs <= input.nowMs) {
    return { ok: false, disposition: "stale", reason: "trade source listing freshness has elapsed" };
  }
  // 目的地精确匹配：候选 ref 必须等于可信 declared_uri，且与绑定的平台/ID
  // 一致（URI 只从可信读取提取，不从候选重解析放行；binding 恒为三平台形态）。
  if (input.destinationRef !== b.declared_uri) {
    return { ok: false, disposition: "stale", reason: "candidate destination does not match the trusted trade URI" };
  }
  if (typeof b.parsed_platform !== "string" || typeof b.platform_product_id !== "string") {
    return { ok: false, disposition: "needs_configuration", reason: "marketplace source binding carries no platform identity" };
  }
  let parsed: ParsedMarketplaceTradeUrl;
  try {
    parsed = parseMarketplaceTradeUrl(input.destinationRef);
  } catch {
    return { ok: false, disposition: "stale", reason: "candidate destination no longer matches the marketplace trade form" };
  }
  if (parsed.platform !== b.parsed_platform || parsed.platform_product_id !== b.platform_product_id) {
    return { ok: false, disposition: "stale", reason: "candidate destination platform product id changed" };
  }
  return { ok: true };
}
