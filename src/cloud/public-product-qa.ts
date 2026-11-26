/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import type { ReadPublicProductFacts } from "../commerce/data-source.js";
import { PUBLIC_PRODUCT_FIELDS } from "../commerce/data-source.js";
import { KiwiCatalogSource } from "../discovery/catalog-source/kiwi-source.js";
import type { AgentProfile } from "../config/profile.js";
import { CatalogClient } from "./catalog-client.js";
import { resolveSignedListingContext } from "./listing-publisher.js";
import type { CloudProductSourceHandle } from "./product-source.js";

/** 本地表只用于定位候选；不能以报价数据代替已发布资料。 */
export function findFileProductQaSku(source: CloudProductSourceHandle, question: string): string | undefined {
  const normalized = question.trim().toLowerCase();
  const candidates = source.list().filter(({ title }) => normalized.includes(title.toLowerCase()));
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  return candidate !== undefined && source.describeSku(candidate.sku).available ? candidate.sku : undefined;
}

/** 文件报价有效与 Catalog 公开发布是两道独立的门。只读公开 listing 的内容。 */
export function readPublishedCloudProduct(input: {
  profile: AgentProfile; dataDir: string; publicOrigin: string; catalogUrl: string;
  source: CloudProductSourceHandle; fetchImpl?: typeof fetch;
}): ReadPublicProductFacts {
  const transport = input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl };
  const client = new CatalogClient({ baseUrl: input.catalogUrl, ...transport });
  const catalog = new KiwiCatalogSource({ baseUrl: input.catalogUrl, timeoutMs: 1_200, ...transport });
  return async (sku) => {
    if (sku.length === 0 || sku.length > 128 || !input.source.describeSku(sku).available) return undefined;
    const binding = await resolveSignedListingContext({
      profile: input.profile, dataDir: input.dataDir, runtimeOrigin: input.publicOrigin, catalogBaseUrl: input.catalogUrl, client,
    });
    if (binding === null) return undefined;
    const rows = await catalog.searchListings({ q: sku, merchant_id: binding.merchantId, owner_agent_id: binding.agentId, listing_type: "product", limit: 12 });
    const matches = rows.map(({ listing }) => listing).filter((listing) => listing.listing_type === "product" &&
      listing.merchant_id === binding.merchantId && listing.owner_agent_id === binding.agentId && listing.source_product_ref === sku &&
      listing.publication_state === "ACTIVE" && listing.listing_freshness_state === "FRESH");
    const listing = matches[0];
    if (matches.length !== 1 || listing === undefined || !input.source.describeSku(sku).available) return undefined;
    const fields = { title: listing.title, ...(listing.summary ? { overview: listing.summary } : {}) };
    const reviewed = { ...fields } as Record<string, string>;
    for (const field of PUBLIC_PRODUCT_FIELDS) {
      if (field === "title" || field === "overview") continue;
      const value = listing.attributes?.[field];
      if (typeof value === "string") reviewed[field] = value;
    }
    return { merchant_id: input.profile.owner_id, sku, revision: listing.listing_digest, valid_until: listing.fresh_until, fields: reviewed };
  };
}
