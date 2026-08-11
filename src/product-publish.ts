#!/usr/bin/env node
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
 * `kiwi merchant publish` 编排（product-strategy rev1.1 §4.5/§19 D2）。
 *
 * 编排层在 kiwi 仓，调两仓能力（组件独立发布，§12）：
 *
 *   1. 确认/注册 owner Agent  → kiwi-catalog POST /v1/agent-catalog/agents/register
 *      （owner_token = HMAC-SHA256("kiwi-catalog-owner:" + merchant_id)，
 *       与 kiwi-catalog api/auth.py 逐字节一致；注册幂等 upsert）
 *   2. 读投影并发布 listings  → spawn `shopping listings projections list`（只读）
 *      取 public-only 投影 → 逐条直连 kiwi-catalog POST /v1/listings/publish
 *      （v3.0 起 publish 面归独立 kiwi-catalog 服务，行级幂等在服务端；
 *       owner token 直传优先，否则按 register 同公式 HMAC 派生）
 *      随后 reconcile：投影中消失的商品 POST /v1/listings/{id}/withdraw
 *   3. 汇总分步状态           → fail-closed：agent 注册失败则短路
 *      （listings 依赖 owner agent 存在），listings 失败报错不假装全成功。
 */

import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isLoopbackHost } from "./a2a/client/url-policy.js";
import type { AgentProfile } from "./config/profile.js";
import { registerCatalogAgent } from "./discovery/catalog-source/register.js";
import { isRedirectResponse } from "./net/safe-http.js";
import { SHOPPING_CLI_COMPAT, compatRangeText, versionInRange } from "./product-compat.js";

export interface MerchantPublishOptions {
  /** merchant profile（role: merchant；agent_id = catalog merchant_id）。 */
  profile: AgentProfile;
  /** kiwi-catalog base URL（缺省由调用方解析 KIWI_CATALOG_URL）。 */
  catalogBaseUrl: string;
  /** KIWI_CATALOG_OWNER_TOKEN_SECRET（owner token 派生，legacy）。 */
  ownerTokenSecret?: string;
  /** 商家随机 owner token（v12+ 双路径；优先于 HMAC 派生）。 */
  ownerToken?: string;
  /** shopping-cli SQLite 数据库路径（listings publish-listings --db）。 */
  shoppingCliDb: string;
  /** shopping-cli 可执行名/路径（缺省 "shopping"）。 */
  shoppingCliPath?: string;
  /** shopping-cli 侧 merchant_id（投影过滤；缺省 = profile.agent_id）。
   *  catalog 侧身份恒为 profile.agent_id——两者不同时（如 catalog 申请
   *  审批身份配随机 owner token）用本字段显式映射投影侧。 */
  shoppingCliMerchant?: string;
  /** catalog 注册域名（缺省 KIWI_CATALOG_DOMAIN / merchant-{agent_id}.local）。 */
  catalogDomain?: string;
  /** 审查 P1-B：投影为空但 catalog 存在 ACTIVE product listing 时，默认
   *  拒绝 reconcile 下架（典型成因是 --shopping-cli-merchant 不匹配或
   *  --shopping-cli-db 指向空库，静默全量下架=数据丢失且报告仍 ok）。
   *  设为 true 显式放行"全部下架"语义（CLI --allow-empty-projection）。 */
  allowEmptyProjectionReconcile?: boolean;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawnSync;
}

export interface StepAgent {
  ok: boolean;
  catalog_agent_id?: string;
  error?: string;
}

export interface StepListings {
  ok: boolean;
  skipped_reason?: string;
  published?: number;
  skipped?: number;
  withdrawn?: number;
  published_refs?: string[];
  skipped_refs?: string[];
  withdrawn_refs?: string[];
  errors?: string[];
  raw?: unknown;
}

export interface StepCompat {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface MerchantPublishReport {
  ok: boolean;
  steps: {
    shopping_cli_compat: StepCompat;
    agent: StepAgent;
    listings: StepListings;
  };
}

function safeAgentId(agentId: string): string {
  return agentId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * 审查 P1-10：构造注册用的 agent_card_url —— **绝对且经过校验**。
 *
 * `domain` 可能是裸 hostname（`merchant-x.local`，本地占位）或已含 scheme 的
 * URL；统一规范化为 `<scheme>://<host>/.well-known/agent-card.json`。此前直接
 * 拼接 `${domain}/.well-known/agent-card.json`——裸 hostname 时产物是相对 URL
 * （catalog 无法按 well-known 验证），且若 domain 携带 userinfo/路径会污染注册
 * 身份。
 *
 * 校验（fail-closed，任何一项不过 → 抛错短路，不发布）：
 *   - 绝对 URL 且 http(s)；
 *   - 远程 host 必须 https（loopback 本地形态允许 http）；
 *   - 无 userinfo / query / fragment；
 *   - path 只允许空或 "/"（agent_card_url 的 well-known 路径由本函数追加）。
 */
function buildAgentCardUrl(domain: string): string {
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`catalog domain 不是合法 URL/域名: "${domain}"（应为 https://<host> 形式）`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`catalog domain 必须使用 http(s)（got ${parsed.protocol}）: ${domain}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`catalog domain 不得内嵌凭据（userinfo）: ${domain}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`catalog domain 不得包含 query/fragment: ${domain}`);
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error(`catalog domain 不得包含路径（agent_card_url 由本函数构造）: ${domain}`);
  }
  const host = parsed.hostname;
  // 复用仓内统一 loopback 判定（P3-13）：Node URL.hostname 对 IPv6 带方括号
  // （http://[::1] → "[::1]"），此前裸比 "::1" 把 IPv6 loopback 误判为远程。
  const isLoopback = isLoopbackHost(host);
  if (parsed.protocol !== "https:" && !isLoopback) {
    throw new Error(`catalog domain 远程 host 必须使用 https（本地 loopback 才允许 http）: ${domain}`);
  }
  const port = parsed.port !== "" ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${host}${port}/.well-known/agent-card.json`;
}

/**
 * 审查 P1-11：catalog 出站调用（可能携带 owner_token 凭据）——**绝不跟随
 * 重定向**。manual redirect 下任何 3xx / opaqueredirect 立即抛错，不解析
 * body：重定向会把 Authorization 头 / body / query 中的凭据转发给第三方
 * host。跨源重定向是 token 泄漏路径（SC-SEC-01 同型）；fail-closed 拒绝所有
 * 3xx（含同源——最简且最安全的保证）。
 */
async function catalogFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  const res = await fetchImpl(url, { ...init, redirect: "manual" });
  if (isRedirectResponse(res)) {
    throw new Error(`catalog request must not follow redirects (HTTP ${res.status} from ${url})`);
  }
  return res;
}

/**
 * 执行一次 publish 编排。fail-closed：
 * - agent 注册失败 → 短路（listings 依赖 owner agent 存在），ok:false；
 * - listings spawn/报告失败 → ok:false + 错误明细；
 * - 全成功 → ok:true + 分步计数。
 */
export async function merchantPublish(
  options: MerchantPublishOptions,
): Promise<MerchantPublishReport> {
  const profile = options.profile;
  // 双身份拆分（2026-08-08 修复）：catalog 侧身份与 shopping-cli 侧 merchant
  // 是两个独立概念——
  // - catalogMerchantId = profile.agent_id：agent 注册/复用、owner token
  //   派生（HMAC）与校验、publish body merchant_id、自查端点（kiwi-catalog
  //   一商家一 agent + publish 校验 owner 绑定都以此为准）；
  // - shoppingMerchant = --shopping-cli-merchant ?? profile.agent_id：投影
  //   过滤（shopping-cli 侧 merchant）。D1 init 统一身份后两者相同；显式
  //   映射用于 catalog 申请审批身份（随机 owner token）与 shopping-cli
  //   商家名不同的场景——原实现把映射项当成全局身份，导致随机 token
  //   （KIWI_MERCHANT_TOKEN）下 publish 身份错乱。
  const catalogMerchantId = profile.agent_id;
  const shoppingMerchant = options.shoppingCliMerchant ?? profile.agent_id;
  const domain =
    options.catalogDomain ??
    process.env.KIWI_CATALOG_DOMAIN ??
    `merchant-${safeAgentId(catalogMerchantId)}.local`;

  // ── Step 0: shopping-cli 版本兼容检查（D3 矩阵共同消费，fail-closed）──
  // 矩阵单一来源 = product-compat.ts；与 `kiwi doctor` 共同消费。
  const versionSpawn = options.spawnImpl ?? spawnSync;
  let versionResult: ReturnType<typeof spawnSync>;
  try {
    versionResult = versionSpawn(options.shoppingCliPath ?? "shopping", ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch (err) {
    return {
      ok: false,
      steps: {
        shopping_cli_compat: {
          ok: false,
          error: `shopping-cli 版本检测失败：${err instanceof Error ? err.message : String(err)}`,
        },
        agent: { ok: false, error: "shopping-cli 版本不兼容，未执行注册" },
        listings: { ok: false, skipped_reason: "shopping-cli 版本不兼容" },
      },
    };
  }
  const versionText = String(versionResult.stdout ?? "").split("\n")[0] ?? "";
  if (!versionInRange(versionText, SHOPPING_CLI_COMPAT)) {
    return {
      ok: false,
      steps: {
        shopping_cli_compat: {
          ok: false,
          version: versionText !== "" ? versionText : undefined,
          error:
            `shopping-cli ${versionText !== "" ? versionText : "版本无法识别"} 超出 Kiwi 支持范围` +
            `（${compatRangeText(SHOPPING_CLI_COMPAT)}）`,
        },
        agent: { ok: false, error: "shopping-cli 版本不兼容，未执行注册" },
        listings: { ok: false, skipped_reason: "shopping-cli 版本不兼容" },
      },
    };
  }
  const compatStep: StepCompat = {
    ok: true,
    ...(versionText !== "" ? { version: versionText } : {}),
  };

  // ── Step 1: 确认/注册 owner Agent（幂等：先查复用，没有再注册）──────────
  // 重复 publish 必须是安全操作（rev1.1 §4.5）：kiwi-catalog 一商家一 agent
  // 约束下二次 register 会 409——先按 merchant 查询已有 agent，有则复用。
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = options.catalogBaseUrl.replace(/\/+$/, "");
  let catalogAgentId: string | undefined;
  let agentError: string | undefined;
  try {
    const lookupUrl = `${baseUrl}/v1/agent-catalog/merchants/${encodeURIComponent(catalogMerchantId)}/agents`;
    const lookup = await catalogFetch(fetchImpl, lookupUrl, { signal: AbortSignal.timeout(15_000) });
    if (lookup.ok) {
      const body = (await lookup.json()) as { results?: Array<{ catalog_agent_id?: string }> };
      const existing = body.results?.[0]?.catalog_agent_id;
      if (typeof existing === "string" && existing !== "") {
        catalogAgentId = existing;
      }
    }
    // 查询失败（网络/非 2xx）不短路——继续尝试注册；注册失败才报错。
    if (catalogAgentId === undefined) {
      const reg = await registerCatalogAgent({
        catalogBaseUrl: options.catalogBaseUrl,
        domain,
        merchantId: catalogMerchantId,
        ownerToken: options.ownerToken,
        ownerTokenSecret: options.ownerTokenSecret,
        agentCardUrl: buildAgentCardUrl(domain),
        fetchImpl: options.fetchImpl,
        timeoutMs: 15_000,
      });
      catalogAgentId = reg.catalogAgentId;
    }
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err);
  }
  if (agentError !== undefined || catalogAgentId === undefined) {
    return {
      ok: false,
      steps: {
        shopping_cli_compat: compatStep,
        agent: { ok: false, error: agentError ?? "catalog register returned no agent id" },
        listings: { ok: false, skipped_reason: "agent 注册失败（listings 依赖 owner agent）" },
      },
    };
  }

  // ── Step 2: 读 shopping-cli 投影 → 直连 catalog 发布 listings ──────────
  // shopping-cli v3.0 剥离 publish-listings 后，发布面归 kiwi-catalog：
  // 本步骤读取可发布投影（listings projections list --format json，只读），
  // 逐条直连 POST /v1/listings/publish（owner token 直传）。--db 是
  // shopping-cli 顶层参数，必须在子命令之前。
  const spawn = options.spawnImpl ?? spawnSync;
  const args = [
    "--db", options.shoppingCliDb,
    "listings",
    "projections",
    "--merchant", shoppingMerchant,
    "--format", "json",
  ];
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawn(options.shoppingCliPath ?? "shopping", args, {
      encoding: "utf-8",
      timeout: 60_000,
    });
  } catch (err) {
    return {
      ok: false,
      steps: {
        shopping_cli_compat: compatStep,
        agent: { ok: true, catalog_agent_id: catalogAgentId },
        listings: {
          ok: false,
          errors: [`shopping-cli spawn failed: ${err instanceof Error ? err.message : String(err)}`],
        },
      },
    };
  }

  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (result.status !== 0) {
    // fail-closed：投影读取失败（含非零退出/输出非 JSON）一律不发布
    const detail = (stderr !== "" ? stderr.trim() : stdout.trim()).slice(0, 300);
    return {
      ok: false,
      steps: {
        shopping_cli_compat: compatStep,
        agent: { ok: true, catalog_agent_id: catalogAgentId },
        listings: {
          ok: false,
          errors: [`shopping-cli projections failed: ${detail !== "" ? detail : `exit ${result.status ?? "?"}`}`],
        },
      },
    };
  }
  let projections: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(stdout) as { ok?: boolean; results?: unknown };
    if (parsed.ok === true && Array.isArray(parsed.results)) {
      projections = parsed.results as Array<Record<string, unknown>>;
    }
  } catch {
    // 非 JSON → fail-closed（不发布，避免漏发）
    return {
      ok: false,
      steps: {
        shopping_cli_compat: compatStep,
        agent: { ok: true, catalog_agent_id: catalogAgentId },
        listings: { ok: false, errors: [`shopping-cli projections 输出非 JSON：${stdout.slice(0, 200)}`] },
      },
    };
  }

  // 逐条直连 catalog publish（投影是 canonical payload 子集；owner 身份由
  // 发布方补齐：merchant_id / owner_agent_id / owner_token / handoff 默认）。
  // owner token：直传优先，否则 HMAC 派生（与 register 一致）。
  const effectiveOwnerToken =
    options.ownerToken !== undefined && options.ownerToken !== ""
      ? options.ownerToken
      : options.ownerTokenSecret !== undefined
        ? createHmac("sha256", options.ownerTokenSecret)
            .update(`kiwi-catalog-owner:${catalogMerchantId}`)
            .digest("hex")
        : "";
  const reportErrors: string[] = [];
  const publishedRefs: string[] = [];
  const skippedRefs: string[] = [];
  for (const projection of projections) {
    const ref = String(projection.source_product_ref ?? "?");
    // category 必须非空（catalog contracts.py 要求）——为空则跳过并报告，
    // 不猜默认值（fail-closed）。
    const category = projection.category;
    if (typeof category !== "string" || category.trim() === "") {
      skippedRefs.push(ref);
      continue;
    }
    // 投影含内部元数据（_provenance 等）——catalog 契约 additionalProperties:
    // false，发布前剔除 _ 前缀字段（仅 wire 字段进 body）。
    const wireFields = Object.fromEntries(
      Object.entries(projection).filter(([key]) => !key.startsWith("_")),
    );
    // 每商品成交入口（KTH destination_ref）：投影携带商家维护的
    // handoff_destination（shopping-cli products.handoff_destination）。
    // 按值派生（审查 P3-10，此前无条件标 external_checkout_url 并输出原始
    // ref）：合法 http(s) URL → external_checkout_url + ref；opaque 非 URL
    // 文本（chat-id/电话/文档引用）→ 两个字段都不进公开 listing（架构约定：
    // 成交入口由商家 Agent 谈判达成后点对点交给买家，opaque ref 进公开目录
    // 是语义污染）。原始 handoff_destination 键一律剔除（catalog 契约
    // additionalProperties:false 会拒未知键；product listing 的两个 handoff
    // 字段均可选，省略仍通过 schema 校验）。
    const { handoff_destination: rawHandoff, ...projectionWire } = wireFields;
    const handoffRef = typeof rawHandoff === "string" ? rawHandoff.trim() : "";
    const body: Record<string, unknown> = {
      ...projectionWire,
      merchant_id: catalogMerchantId,
      owner_agent_id: catalogAgentId,
      owner_token: effectiveOwnerToken,
    };
    if (/^https?:\/\/\S+$/.test(handoffRef)) {
      body.handoff_destination_types = ["external_checkout_url"];
      body.handoff_destination_ref = handoffRef;
    }
    if (typeof body.owner_token !== "string" || body.owner_token === "") {
      reportErrors.push(`${ref}: no owner token (KIWI_MERCHANT_TOKEN 或 secret 派生)`);
      continue;
    }
    try {
      const res = await catalogFetch(fetchImpl, `${baseUrl}/v1/listings/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string; listing?: { listing_id?: string } };
      if (res.ok && payload.ok === true) {
        publishedRefs.push(ref);
      } else {
        reportErrors.push(`${ref}: ${payload.error ?? `HTTP ${res.status}`}`);
      }
    } catch (err) {
      reportErrors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Step 2b: reconcile——投影消失的商品 withdraw（data-hub DoD #5）──────
  // products.active=0 或已删除的商品不再出现在投影里；拉取本 agent 现有
  // product listings（自查端点，owner_token 经 query），与投影 ref 集合
  // diff，多出的下架（capability listing 不在投影集合，不处理）。服务端
  // 对已 WITHDRAWN 幂等返回；SUSPENDED 的 listing 也允许商家 withdraw。
  const projectedRefs = new Set(
    projections.map((p) => String(p.source_product_ref ?? "")).filter((ref) => ref !== ""),
  );
  // 审查 P1-B（2026-08-10 复验）：空投影 + 既有 ACTIVE product listing =
  // 配置错误典型信号（--shopping-cli-merchant 不匹配 / --shopping-cli-db
  // 指向空库）——此前 reconcile 会把自查端点返回的全部 listing 下架且
  // 报告仍 ok:true，自动化发布不告警。fail-closed：拒绝下架，除非显式
  // allowEmptyProjectionReconcile。自查失败不在此重复判定（下方循环会报）。
  let reconcileBlocked = false;
  if (projections.length === 0 && options.allowEmptyProjectionReconcile !== true) {
    const probeUrl =
      `${baseUrl}/v1/agents/${encodeURIComponent(catalogAgentId)}/listings` +
      `?owner_token=${encodeURIComponent(effectiveOwnerToken)}&limit=100`;
    try {
      const probeRes = await catalogFetch(fetchImpl, probeUrl, { signal: AbortSignal.timeout(15_000) });
      const probePayload = (await probeRes.json()) as {
        ok?: boolean;
        results?: Array<Record<string, unknown>>;
      };
      if (probeRes.ok && probePayload.ok === true) {
        const hasActiveProductListing = (probePayload.results ?? []).some(
          (rec) =>
            String(rec.listing_type ?? "") === "product" &&
            String(rec.publication_state ?? "") !== "WITHDRAWN",
        );
        if (hasActiveProductListing) {
          reconcileBlocked = true;
          reportErrors.push(
            "投影为空但 catalog 存在 ACTIVE product listing：拒绝 reconcile 下架" +
              "（疑似 --shopping-cli-merchant 不匹配或 --shopping-cli-db 指向空库）；" +
              "如确需全部下架请显式传 --allow-empty-projection",
          );
        }
      }
    } catch {
      // 探测失败交给下方 reconcile 循环报错（fail-closed 语义一致）
    }
  }
  const withdrawnRefs: string[] = [];
  try {
    let cursor: string | undefined;
    for (;;) {
      if (reconcileBlocked) break;
      const listUrl =
        `${baseUrl}/v1/agents/${encodeURIComponent(catalogAgentId)}/listings` +
        `?owner_token=${encodeURIComponent(effectiveOwnerToken)}&limit=100` +
        (cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const listRes = await catalogFetch(fetchImpl, listUrl, { signal: AbortSignal.timeout(15_000) });
      const listPayload = (await listRes.json()) as {
        ok?: boolean;
        results?: Array<Record<string, unknown>>;
        next_cursor?: string;
        error?: string;
      };
      if (!listRes.ok || listPayload.ok !== true) {
        reportErrors.push(`withdraw reconcile failed: ${listPayload.error ?? `HTTP ${listRes.status}`}`);
        break;
      }
      for (const rec of listPayload.results ?? []) {
        // 只 diff product listing：capability listing 不在投影集合，不处理
        if (String(rec.listing_type ?? "") !== "product") continue;
        const ref = String(rec.source_product_ref ?? "");
        if (ref === "" || projectedRefs.has(ref)) continue;
        if (String(rec.publication_state ?? "") === "WITHDRAWN") continue;
        const listingId = String(rec.listing_id ?? "");
        if (listingId === "") continue;
        try {
          const wRes = await catalogFetch(
            fetchImpl,
            `${baseUrl}/v1/listings/${encodeURIComponent(listingId)}/withdraw`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ owner_token: effectiveOwnerToken }),
              signal: AbortSignal.timeout(20_000),
            },
          );
          const wPayload = (await wRes.json()) as { ok?: boolean; error?: string };
          if (wRes.ok && wPayload.ok === true) {
            withdrawnRefs.push(ref);
          } else {
            reportErrors.push(`${ref}: withdraw ${wPayload.error ?? `HTTP ${wRes.status}`}`);
          }
        } catch (err) {
          reportErrors.push(`${ref}: withdraw ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const next = listPayload.next_cursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }
  } catch (err) {
    reportErrors.push(`withdraw reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ok = reportErrors.length === 0;
  return {
    ok,
    steps: {
      shopping_cli_compat: compatStep,
      agent: { ok: true, catalog_agent_id: catalogAgentId },
      listings: {
        ok,
        published: publishedRefs.length,
        skipped: skippedRefs.length,
        withdrawn: withdrawnRefs.length,
        published_refs: publishedRefs,
        skipped_refs: skippedRefs,
        withdrawn_refs: withdrawnRefs,
        ...(reportErrors.length > 0 ? { errors: reportErrors } : {}),
      },
    },
  };
}
