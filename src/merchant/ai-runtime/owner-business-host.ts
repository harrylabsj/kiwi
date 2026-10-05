/** Explicit private single-descriptor assembly; no public CLI/HTTP or default write tools. */
import { contentHash } from "../../agent/merchant/action-candidate.js";
import type { MerchantClient } from "../../agent/merchant/types.js";
import { parseExactMoney } from "../application/money.js";
import { createExactProductExecutors, EXACT_PRODUCT_TOOLS } from "../exact-product-executors.js";
import {
  OwnerCommittedProofAuthority,
  type OwnerBusinessBinding,
  type OwnerCommittedPermit,
} from "./owner-committed-proof.js";
import { OwnerOperationReader, type OwnerBusinessReceipt } from "./owner-operation-reader.js";
export class OwnerBusinessHost {
  private readonly executor;
  private readonly reader;
  constructor(
    private readonly options: {
      authority: OwnerCommittedProofAuthority;
      client: MerchantClient;
      upstreamMerchantId: string;
      authoritySource: string;
      timeoutMs: number;
      reservationTokens: number;
      /** Service must explicitly promise conditional version + same-op idempotent history semantics. */
      conditionalOperationContract: "exact-money-version-and-operation-id/1";
    },
  ) {
    this.options = { ...options };
    if (
      !(options.authority instanceof OwnerCommittedProofAuthority) ||
      options.conditionalOperationContract !== "exact-money-version-and-operation-id/1" ||
      !Number.isSafeInteger(options.reservationTokens) ||
      options.reservationTokens < 1
    )
      throw new Error("business_authority_missing");
    this.executor = createExactProductExecutors({
      merchantId: options.upstreamMerchantId,
      client: options.client,
    }).find((e) => e.tool === EXACT_PRODUCT_TOOLS.updateMoney)!;
    this.reader = new OwnerOperationReader({
      client: options.client,
      source: options.authoritySource,
      upstreamMerchantId: options.upstreamMerchantId,
      timeoutMs: options.timeoutMs,
    });
  }
  get reservationTokens(): number {
    return this.options.reservationTokens;
  }
  inspect(permit: OwnerCommittedPermit): OwnerBusinessBinding {
    const b = this.options.authority.inspect(permit);
    this.verify(b);
    return b;
  }
  verify(binding: OwnerBusinessBinding): void {
    if (
      binding.upstreamMerchantId !== this.options.upstreamMerchantId ||
      binding.authoritySource !== this.options.authoritySource
    )
      throw new Error("business_host_binding_mismatch");
    this.options.authority.verifyPersisted(binding);
  }
  async fresh(binding: OwnerBusinessBinding): Promise<Record<string, unknown>> {
    this.verify(binding);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current;
    try {
      current = await Promise.race([
        this.options.client.getExactProduct(binding.upstreamMerchantId, binding.sku),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("business_source_timeout")),
            this.options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (current.merchant_id !== binding.upstreamMerchantId)
      throw new Error("business_source_merchant_mismatch");
    const parsed = parseExactMoney(
      { currency: current.currency, amount_minor: current.price_minor },
      { requireOperatingSupport: true },
    );
    if (current.currency_table_version !== parsed.currency_table_version)
      throw new Error("business_source_currency_table_mismatch");
    const facts = {
      sku: current.sku,
      currency: current.currency,
      price_minor: current.price_minor,
      currency_table_version: current.currency_table_version,
      authority_version: current.authority_version,
    };
    this.verify(binding);
    if (
      facts.sku !== binding.sku ||
      facts.authority_version !== binding.expectedMoneyAuthorityVersion ||
      facts.currency !== binding.currency ||
      facts.currency_table_version !== binding.currencyTableVersion ||
      typeof facts.price_minor !== "string"
    )
      throw new Error("business_source_unknown_or_changed");
    return {
      ...facts,
      merchant_id: binding.merchantId,
      principal: binding.principal,
      business_key: binding.preconditions.business_key,
    };
  }
  async execute(binding: OwnerBusinessBinding, permit: OwnerCommittedPermit): Promise<void> {
    if (contentHash(this.inspect(permit)) !== contentHash(binding))
      throw new Error("committed_permit_binding_mismatch");
    this.options.authority.assertClaimed(binding);
    this.verify(binding);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.executor.execute(binding.arguments, {} as never, {
          kind: "committed",
          operationId: binding.operationId,
          actorId: binding.actorId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("business_result_unknown")),
            this.options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  read(binding: OwnerBusinessBinding): Promise<OwnerBusinessReceipt> {
    this.verify(binding);
    return this.reader.read(binding);
  }
}
