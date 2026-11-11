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
 * `kiwi mcp serve` —— 启动 kiwi-buyer-mcp stdio server（战略 v2.5 §6.1/§6.5）。
 *
 * 配置来源：
 *   --db <path>        持久 store 路径（默认 $KIWI_MCP_DB 或 ~/.kiwi/mcp/dsh.sqlite）
 *   --principal <id>   Principal opaque 标识（默认 env KIWI_PRINCIPAL）
 *   --agent <id>       buyer_agent_id（默认 env KIWI_BUYER_AGENT）
 *   --buyer-id <id>    仅用于 catalog 去重统计的 X-Buyer-Id（默认 env
 *                      KIWI_CATALOG_BUYER_ID；缺省 = --agent，不影响本地任务 owner）
 *   --session <id>     session_id（默认 env KIWI_SESSION）
 *   --policy <file>    冻结 DelegationPolicy JSON（默认 env KIWI_DELEGATION_POLICY；
 *                      未提供则用内置安全默认：读 AUTO、accept/handoff ASK、payment NEVER）
 *   --catalog-url      真实 merchant 网络：catalog 发现 → A2A 直连 merchant（listings
 *                      感知搜索 + A2AQuoteFetcher/A2ANegotiator）
 *   --catalog-session  catalog 账号会话 token（M4 买家关注；默认 env
 *                      KIWI_CATALOG_SESSION；未配置时关注工具返回登录引导）
 *   --marketplace-url  试点兼容：shopping-cli 直连（MarketplaceQuoteFetcher/Negotiator）
 *   --a2a-bearer-token / --a2a-allow-private-ranges / --a2a-skip-dns-check /
 *   --a2a-timeout-ms    A2A 轨可选配置
 *
 * 执行 seam（MerchantIndex/QuoteFetcher/Negotiator）已接线：marketplaceUrl 优先，
 * 否则 catalogUrl → A2A 直连 merchant 网络；本 server 负责契约面 + 持久任务/审批状态机。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { assertNorthboundContractValid } from "../contracts/northbound-schema.js";
import { buildBuyerService } from "../buyer-core/build-service.js";
import { McpServer } from "./server.js";
import { resolveSessionOwner } from "./session-owner.js";
import { buildKiwiTools } from "./tools.js";

export const KIWI_MCP_VERSION = "0.1.0";

/**
 * 默认 catalog 入口（kiwi-catalog 公网地址）。kiwi-buyer 默认经它发现商家；
 * 用户无需配置，可用 --catalog-url <url> 覆盖。
 */
export const DEFAULT_CATALOG_URL = "https://catalog.kiwi.harrylabsj.com";

/** 内置安全默认 DelegationPolicy（§5.3 默认映射）。 */
export const DEFAULT_DELEGATION_POLICY = {
  policy_id: "dp-default",
  version: "1.0",
  principal: "principal:unset",
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto", note: "受限 AUTO：受 limits 约束" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: { max_rounds: 3 },
} as const;

export interface McpServeOptions {
  db?: string;
  principal?: string;
  buyerAgentId?: string;
  /** 仅用于 catalog 用量统计的稳定买家标识；缺省 = buyerAgentId。 */
  catalogBuyerId?: string;
  sessionId?: string;
  /** Optional managed-host secret; otherwise a local 0600 key is used. */
  sessionToken?: string;
  sessionTokenFile?: string;
  clientId?: string;
  policy?: Record<string, unknown>;
  catalogUrl?: string;
  marketplaceUrl?: string;
  buyerBootstrapToken?: string;
  /** catalog 账号会话 token（M4 买家关注；默认 env KIWI_CATALOG_SESSION）。 */
  catalogSessionToken?: string;
  a2aBearerToken?: string;
  a2aAllowPrivateRanges?: boolean;
  a2aSkipDnsCheck?: boolean;
  a2aTimeoutMs?: number;
  rfqPublicMessage?: string;
  /**
   * Buyer 自己的持久 Ed25519 身份目录。给定时每个出站 A2A 请求都签名，商家把
   * 公钥登记进 `a2a-trusted-keys.json` 后，受保护操作（GetTask/回执轮询）才会
   * 认这个买家；不给则维持匿名（只能发 T0 询价，读不回报价）。
   */
  a2aSigningKeyDir?: string;
}

function readPolicy(options: McpServeOptions, principal: string): Record<string, unknown> {
  const fromEnv = process.env.KIWI_DELEGATION_POLICY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    try {
      return JSON.parse(fromEnv) as Record<string, unknown>;
    } catch {
      throw new Error("KIWI_DELEGATION_POLICY is not valid JSON");
    }
  }
  const raw =
    options.policy !== undefined ? options.policy : { ...DEFAULT_DELEGATION_POLICY, principal };
  assertNorthboundContractValid("delegation-policy", raw, "delegation policy");
  return raw;
}

export async function runMcpServe(args: string[]): Promise<number> {
  const opts: McpServeOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    // Disabled migration flags must be rejected even when they are the final
    // argument (there is no following value to trigger the normal branch).
    if (flag === "--adopt-legacy" || flag === "--adopt-legacy-owner") {
      process.stderr.write("legacy task adoption is disabled: ownership must be proven out of band\n");
      return 2;
    }
    const value = args[i + 1];
    if (value === undefined) continue;
    if (flag === "--db") opts.db = value;
    else if (flag === "--principal") opts.principal = value;
    else if (flag === "--agent") opts.buyerAgentId = value;
    else if (flag === "--buyer-id") opts.catalogBuyerId = value;
    else if (flag === "--session") opts.sessionId = value;
    else if (flag === "--session-token") opts.sessionToken = value;
    else if (flag === "--session-token-file") opts.sessionTokenFile = value;
    else if (flag === "--client-id") opts.clientId = value;
    else if (flag === "--catalog-url") opts.catalogUrl = value;
    else if (flag === "--marketplace-url") opts.marketplaceUrl = value;
    else if (flag === "--buyer-bootstrap-token") opts.buyerBootstrapToken = value;
    else if (flag === "--catalog-session") opts.catalogSessionToken = value;
    else if (flag === "--a2a-bearer-token") opts.a2aBearerToken = value;
    else if (flag === "--a2a-allow-private-ranges") opts.a2aAllowPrivateRanges = value === "true";
    else if (flag === "--a2a-skip-dns-check") opts.a2aSkipDnsCheck = value === "true";
    else if (flag === "--a2a-timeout-ms") opts.a2aTimeoutMs = Number(value);
    else if (flag === "--rfq-public-message") opts.rfqPublicMessage = value;
    else if (flag === "--a2a-signing-key-dir") opts.a2aSigningKeyDir = value;
    else if (flag === "--policy") {
      try {
        opts.policy = JSON.parse(readFileSync(value, "utf-8")) as Record<string, unknown>;
      } catch {
        process.stderr.write(`cannot read --policy file ${value}\n`);
        return 2;
      }
    }
  }
  const principal = opts.principal ?? process.env.KIWI_PRINCIPAL ?? "principal:local";
  const buyerAgentId = opts.buyerAgentId ?? process.env.KIWI_BUYER_AGENT ?? "buyer-agent:kiwi-mcp";
  // 只影响 catalog 的 X-Buyer-Id（运营去重买家统计），不影响本地任务 owner。
  const catalogBuyerId = opts.catalogBuyerId ?? process.env.KIWI_CATALOG_BUYER_ID;
  if (catalogBuyerId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(catalogBuyerId)) {
    process.stderr.write("--buyer-id/KIWI_CATALOG_BUYER_ID must be 1-128 chars of [A-Za-z0-9._:-]\n");
    return 2;
  }
  // Stable default: when a token is used, restart/reconnect must recover the
  // same identity. Never include the process id in the default label.
  const sessionId = opts.sessionId ?? process.env.KIWI_SESSION ?? "default";
  const dbPath =
    opts.db ?? process.env.KIWI_MCP_DB ?? path.join(homedir(), ".kiwi", "mcp", "dsh.sqlite");
  const explicitToken = opts.sessionToken ?? process.env.KIWI_SESSION_TOKEN;
  const tokenFile = opts.sessionTokenFile ?? process.env.KIWI_SESSION_TOKEN_FILE;
  const clientId = opts.clientId ?? process.env.KIWI_CLIENT_ID;
  let sessionOwner: string;
  try {
    sessionOwner = resolveSessionOwner({
    clientId,
    principal,
    buyerAgentId,
    sessionId,
    ...(explicitToken !== undefined ? { sessionToken: explicitToken } : {}),
    ...(tokenFile !== undefined ? { sessionTokenFile: tokenFile } : {}),
    ...(process.env.KIWI_SESSION_TOKEN_DIR !== undefined
      ? { tokenDir: process.env.KIWI_SESSION_TOKEN_DIR } : {}),
      dbPath,
    });
  } catch (error) {
    process.stderr.write(`session credential rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const policy = readPolicy(opts, principal);
  // 持久 store 默认路径：--db → KIWI_MCP_DB env → ~/.kiwi/mcp/dsh.sqlite（HOME 基准，
  // 稳定可跨宿主；dsh/Hermes 等 host 不传 --db 时也能落一致位置，不再依赖 cwd）。
  // 单核心多包装：MCP 与 HTTP 共用同一 buildBuyerService（§6.3）。
  const service = buildBuyerService({
    dbPath,
    principal,
    buyerAgentId,
    ...(catalogBuyerId !== undefined ? { catalogBuyerId } : {}),
    sessionId,
    sessionOwner,
    policy,
    catalogUrl: opts.catalogUrl ?? DEFAULT_CATALOG_URL,
    marketplaceUrl: opts.marketplaceUrl,
    buyerBootstrapToken: opts.buyerBootstrapToken ?? process.env.SHOPPING_BUYER_BOOTSTRAP_TOKEN,
    catalogSessionToken: opts.catalogSessionToken ?? process.env.KIWI_CATALOG_SESSION,
    a2aBearerToken: opts.a2aBearerToken,
    a2aAllowPrivateRanges: opts.a2aAllowPrivateRanges,
    a2aSkipDnsCheck: opts.a2aSkipDnsCheck,
    a2aTimeoutMs: opts.a2aTimeoutMs,
    ...(opts.rfqPublicMessage !== undefined ? { rfqPublicMessage: opts.rfqPublicMessage } : {}),
    // 保持 opt-in：默认仍匿名，只有显式给了目录才签名出站请求（避免对不认识
    // 该公钥的商家把普通询价也变成未验证身份）。
    a2aSigningKeyDir: opts.a2aSigningKeyDir ?? process.env.KIWI_A2A_SIGNING_KEY_DIR,
  });
  const tools = buildKiwiTools(service);
  const server = new McpServer({
    tools,
    serverInfo: { name: "kiwi-buyer-mcp", version: KIWI_MCP_VERSION },
  });
  await server.serve();
  return 0;
}
