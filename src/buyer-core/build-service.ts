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

import { assertNorthboundContractValid } from "../contracts/northbound-schema.js";
import { KiwiCatalogMerchantIndex, MarketplaceMerchantIndex } from "./merchant-index.js";
import { MarketplaceNegotiator } from "./negotiator.js";
import { MarketplaceQuoteFetcher } from "./quote-fetcher.js";
import { KiwiBuyerService } from "./service.js";
import { TaskApprovalStore } from "./store.js";

export interface BuyerServiceConfig {
  dbPath: string;
  principal: string;
  buyerAgentId: string;
  sessionId: string;
  policy: Record<string, unknown>;
  catalogUrl?: string;
  marketplaceUrl?: string;
  buyerBootstrapToken?: string;
}

/** 构建 Buyer Core：store + merchant index + quote fetcher + negotiator。 */
export function buildBuyerService(config: BuyerServiceConfig): KiwiBuyerService {
  assertNorthboundContractValid("delegation-policy", config.policy, "delegation policy");
  const store = new TaskApprovalStore({ dbPath: config.dbPath });
  let merchantIndex;
  if (config.marketplaceUrl !== undefined) {
    merchantIndex = new MarketplaceMerchantIndex({ baseUrl: config.marketplaceUrl });
  } else if (config.catalogUrl !== undefined) {
    merchantIndex = new KiwiCatalogMerchantIndex({ baseUrl: config.catalogUrl });
  }
  const quoteFetcher =
    config.marketplaceUrl !== undefined
      ? new MarketplaceQuoteFetcher({
          baseUrl: config.marketplaceUrl,
          buyerBootstrapToken: config.buyerBootstrapToken ?? "",
        })
      : undefined;
  const negotiator =
    config.marketplaceUrl !== undefined ? new MarketplaceNegotiator({ baseUrl: config.marketplaceUrl }) : undefined;
  return new KiwiBuyerService({
    store,
    principal: config.principal,
    buyerAgentId: config.buyerAgentId,
    sessionId: config.sessionId,
    delegationPolicy: config.policy,
    ...(merchantIndex !== undefined ? { merchantIndex } : {}),
    ...(quoteFetcher !== undefined ? { quoteFetcher } : {}),
    ...(negotiator !== undefined ? { negotiator } : {}),
  });
}
