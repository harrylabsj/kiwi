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
 *   --db <path>        持久 store 路径（默认 ./.kiwi/mcp/state.sqlite）
 *   --principal <id>   Principal opaque 标识（默认 env KIWI_PRINCIPAL）
 *   --agent <id>       buyer_agent_id（默认 env KIWI_BUYER_AGENT）
 *   --session <id>     session_id（默认 env KIWI_SESSION）
 *   --policy <file>    冻结 DelegationPolicy JSON（默认 env KIWI_DELEGATION_POLICY；
 *                      未提供则用内置安全默认：读 AUTO、accept/handoff ASK、payment NEVER）
 *   --catalog-url      真实 merchant 网络：catalog 发现 → A2A 直连 merchant（listings
 *                      感知搜索 + A2AQuoteFetcher/A2ANegotiator）
 *   --marketplace-url  试点兼容：shopping-cli 直连（MarketplaceQuoteFetcher/Negotiator）
 *   --a2a-bearer-token / --a2a-allow-private-ranges / --a2a-skip-dns-check /
 *   --a2a-timeout-ms    A2A 轨可选配置
 *
 * 执行 seam（MerchantIndex/QuoteFetcher/Negotiator）已接线：marketplaceUrl 优先，
 * 否则 catalogUrl → A2A 直连 merchant 网络；本 server 负责契约面 + 持久任务/审批状态机。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { assertNorthboundContractValid } from "../contracts/northbound-schema.js";
import { buildBuyerService } from "../buyer-core/build-service.js";
import { McpServer } from "./server.js";
import { buildKiwiTools } from "./tools.js";

export const KIWI_MCP_VERSION = "0.1.0";

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
  sessionId?: string;
  policy?: Record<string, unknown>;
  catalogUrl?: string;
  marketplaceUrl?: string;
  buyerBootstrapToken?: string;
  a2aBearerToken?: string;
  a2aAllowPrivateRanges?: boolean;
  a2aSkipDnsCheck?: boolean;
  a2aTimeoutMs?: number;
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
    options.policy !== undefined
      ? options.policy
      : { ...DEFAULT_DELEGATION_POLICY, principal };
  assertNorthboundContractValid("delegation-policy", raw, "delegation policy");
  return raw;
}

export async function runMcpServe(args: string[]): Promise<number> {
  const opts: McpServeOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined) continue;
    if (flag === "--db") opts.db = value;
    else if (flag === "--principal") opts.principal = value;
    else if (flag === "--agent") opts.buyerAgentId = value;
    else if (flag === "--session") opts.sessionId = value;
    else if (flag === "--catalog-url") opts.catalogUrl = value;
    else if (flag === "--marketplace-url") opts.marketplaceUrl = value;
    else if (flag === "--buyer-bootstrap-token") opts.buyerBootstrapToken = value;
    else if (flag === "--a2a-bearer-token") opts.a2aBearerToken = value;
    else if (flag === "--a2a-allow-private-ranges") opts.a2aAllowPrivateRanges = value === "true";
    else if (flag === "--a2a-skip-dns-check") opts.a2aSkipDnsCheck = value === "true";
    else if (flag === "--a2a-timeout-ms") opts.a2aTimeoutMs = Number(value);
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
  const sessionId = opts.sessionId ?? process.env.KIWI_SESSION ?? `session-${process.pid}`;
  const policy = readPolicy(opts, principal);
  const dbPath = opts.db ?? path.join(".kiwi", "mcp", "state.sqlite");
  // 单核心多包装：MCP 与 HTTP 共用同一 buildBuyerService（§6.3）。
  const service = buildBuyerService({
    dbPath,
    principal,
    buyerAgentId,
    sessionId,
    policy,
    catalogUrl: opts.catalogUrl,
    marketplaceUrl: opts.marketplaceUrl,
    buyerBootstrapToken: opts.buyerBootstrapToken ?? process.env.SHOPPING_BUYER_BOOTSTRAP_TOKEN,
    a2aBearerToken: opts.a2aBearerToken,
    a2aAllowPrivateRanges: opts.a2aAllowPrivateRanges,
    a2aSkipDnsCheck: opts.a2aSkipDnsCheck,
    a2aTimeoutMs: opts.a2aTimeoutMs,
  });
  const tools = buildKiwiTools(service);
  const server = new McpServer({
    tools,
    serverInfo: { name: "kiwi-buyer-mcp", version: KIWI_MCP_VERSION },
  });
  await server.serve();
  return 0;
}
