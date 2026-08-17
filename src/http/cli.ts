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
 * `kiwi buyer-api serve` —— Buyer Core 的 HTTP 包装（战略 v2.5 §6.3/Appendix A）。
 *
 * 与 MCP 同一 buyer-core（buildBuyerService），不同传输。参数与 `kiwi mcp serve`
 * 一致，另加 --port / --host。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_CATALOG_URL, DEFAULT_DELEGATION_POLICY, type McpServeOptions } from "../mcp/cli.js";
import { buildBuyerService } from "../buyer-core/build-service.js";
import { MerchantOpsService } from "../merchant/ops.js";
import { createBuyerHttpServer } from "./server.js";

interface UcpMerchantConfig {
  domain: string;
  catalogEndpoint: string;
}

export async function runHttpServe(args: string[]): Promise<number> {
  const opts: McpServeOptions & { port?: number; host?: string } = {};
  let ucpConfigPath: string | undefined;
  let merchantTokensPath: string | undefined;
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
    else if (flag === "--port") opts.port = Number(value);
    else if (flag === "--host") opts.host = value;
    else if (flag === "--ucp-config") ucpConfigPath = value;
    else if (flag === "--merchant-tokens") merchantTokensPath = value;
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
  const policy = opts.policy ?? { ...DEFAULT_DELEGATION_POLICY, principal };
  const dbPath = opts.db ?? path.join(".kiwi", "mcp", "state.sqlite");
  const service = buildBuyerService({
    dbPath,
    principal,
    buyerAgentId: opts.buyerAgentId ?? process.env.KIWI_BUYER_AGENT ?? "buyer-agent:kiwi-http",
    sessionId: opts.sessionId ?? process.env.KIWI_SESSION ?? `session-${process.pid}`,
    policy,
    catalogUrl: opts.catalogUrl ?? DEFAULT_CATALOG_URL,
    marketplaceUrl: opts.marketplaceUrl,
    buyerBootstrapToken: opts.buyerBootstrapToken ?? process.env.SHOPPING_BUYER_BOOTSTRAP_TOKEN,
    a2aBearerToken: opts.a2aBearerToken,
    a2aAllowPrivateRanges: opts.a2aAllowPrivateRanges,
    a2aSkipDnsCheck: opts.a2aSkipDnsCheck,
    a2aTimeoutMs: opts.a2aTimeoutMs,
  });
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";
  const merchantUcp =
    ucpConfigPath !== undefined
      ? (JSON.parse(readFileSync(ucpConfigPath, "utf-8")) as Record<string, UcpMerchantConfig>)
      : undefined;
  // Merchant Ops（§7.6）：从 merchant-tokens.env（merchantId=token 每行）构建，
  // 命名空间隔离——merchant token 只访问 kiwi.merchant.*。
  const merchantOps: Record<string, MerchantOpsService> = {};
  if (merchantTokensPath !== undefined && opts.marketplaceUrl !== undefined) {
    for (const line of readFileSync(merchantTokensPath, "utf-8").split("\n")) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const merchantId = line.slice(0, idx).trim();
      const token = line.slice(idx + 1).trim();
      if (merchantId === "" || token === "") continue;
      merchantOps[merchantId] = new MerchantOpsService({ baseUrl: opts.marketplaceUrl, merchantToken: token });
    }
  }
  const server = createBuyerHttpServer({
    service,
    ...(merchantUcp !== undefined ? { merchantUcp } : {}),
    ...(Object.keys(merchantOps).length > 0 ? { merchantOps } : {}),
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  process.stderr.write(`kiwi-buyer-http listening on http://${host}:${port}\n`);
  return 0;
}
