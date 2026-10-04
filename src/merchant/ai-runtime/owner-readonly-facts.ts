/** A221 exact facts adapter. Only getExactProduct capability; no writer/model/default client. */
import {
  parseExactMoney,
  WORKBENCH_CURRENCY_TABLE_VERSION,
} from "../../merchant/application/money.js";
import type { MerchantClient } from "../../agent/merchant/types.js";
import type { OwnerBusinessConfig } from "./owner-business-config.js";
export class OwnerReadonlyFactsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface OwnerExactFactSnapshot {
  readonly kind: "shopping-cli-exact-observation";
  readonly runtimeMerchantId: string;
  readonly upstreamMerchantId: string;
  readonly sku: string;
  readonly currency: string;
  readonly amountMinor: string;
  readonly currencyTableVersion: string;
  readonly moneyAuthorityVersion: number;
  readonly stock: number;
  readonly listingPaused: boolean | null;
  readonly hostObservedAt: string;
  readonly sourceVerifiedAt: null;
  readonly inventorySourceVersion: null;
}
export function createOwnerReadonlyFactsAdapter(
  config: OwnerBusinessConfig,
  client: Pick<MerchantClient, "getExactProduct">,
  options: { now?: () => string } = {},
) {
  if (client === null || typeof client?.getExactProduct !== "function")
    throw new OwnerReadonlyFactsError("owner_readonly_transport_required");
  const get = client.getExactProduct.bind(client),
    runtimeMerchantId = config.runtimeMerchantId,
    upstreamMerchantId = config.source.merchantId;
  return Object.freeze({
    async readFresh(sku: string): Promise<OwnerExactFactSnapshot> {
      if (typeof sku !== "string" || !sku || sku.trim().length === 0)
        throw new OwnerReadonlyFactsError("owner_sku_invalid");
      let p: Awaited<ReturnType<MerchantClient["getExactProduct"]>>;
      try {
        p = await get(upstreamMerchantId, sku);
      } catch {
        throw new OwnerReadonlyFactsError("owner_facts_unavailable");
      }
      if (
        p === null ||
        typeof p !== "object" ||
        p.merchant_id !== upstreamMerchantId ||
        p.sku !== sku
      )
        throw new OwnerReadonlyFactsError("owner_facts_binding_mismatch");
      if (
        typeof p.price_minor !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(p.price_minor) ||
        typeof p.currency !== "string" ||
        !/^[A-Z]{3}$/.test(p.currency) ||
        typeof p.currency_table_version !== "string" ||
        !p.currency_table_version
      )
        throw new OwnerReadonlyFactsError("owner_money_unknown");
      if (p.currency_table_version !== WORKBENCH_CURRENCY_TABLE_VERSION)
        throw new OwnerReadonlyFactsError("owner_currency_table_unknown");
      try {
        parseExactMoney({ currency: p.currency, amount_minor: p.price_minor });
      } catch {
        throw new OwnerReadonlyFactsError("owner_money_unknown");
      }
      if (!Number.isSafeInteger(p.authority_version) || p.authority_version < 1)
        throw new OwnerReadonlyFactsError("owner_money_version_unknown");
      if (!Number.isSafeInteger(p.stock) || p.stock < 0)
        throw new OwnerReadonlyFactsError("owner_inventory_unknown");
      if (p.listing_paused !== undefined && typeof p.listing_paused !== "boolean")
        throw new OwnerReadonlyFactsError("owner_listing_unknown");
      const hostObservedAt = (options.now ?? (() => new Date().toISOString()))();
      if (!Number.isFinite(Date.parse(hostObservedAt)))
        throw new OwnerReadonlyFactsError("owner_observation_time_invalid");
      return Object.freeze({
        kind: "shopping-cli-exact-observation",
        runtimeMerchantId,
        upstreamMerchantId,
        sku,
        currency: p.currency,
        amountMinor: p.price_minor,
        currencyTableVersion: p.currency_table_version,
        moneyAuthorityVersion: p.authority_version,
        stock: p.stock,
        listingPaused: p.listing_paused ?? null,
        hostObservedAt,
        sourceVerifiedAt: null,
        inventorySourceVersion: null,
      });
    },
  });
}
