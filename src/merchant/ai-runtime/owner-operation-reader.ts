/** Async historical receipt adapter. No current-price inference and no 404=no-effect. */
import type { OwnerAsyncReceiptReader } from "./owner-business-proof-contract.js";
import type { MerchantClient } from "../../agent/merchant/types.js";
import type { OwnerBusinessBinding } from "./owner-committed-proof.js";
import { contentHash } from "../../agent/merchant/action-candidate.js";
export type OwnerBusinessReceipt =
  | { status: "unknown"; reason: "incomplete" | "unavailable" }
  | {
      status: "applied";
      binding: OwnerBusinessBinding;
      source: string;
      receiptRef: string;
      resultingMoneyAuthorityVersion: number;
    };
export class OwnerOperationReader implements OwnerAsyncReceiptReader {
  constructor(
    private readonly options: {
      client: MerchantClient;
      source: string;
      upstreamMerchantId: string;
      timeoutMs: number;
    },
  ) {
    this.options = { ...options };
    if (
      !options.source ||
      !options.upstreamMerchantId ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30000
    )
      throw new Error("receipt_authority_missing");
  }
  async read(binding: OwnerBusinessBinding): Promise<OwnerBusinessReceipt> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (
        binding.authoritySource !== this.options.source ||
        binding.upstreamMerchantId !== this.options.upstreamMerchantId
      )
        return { status: "unknown", reason: "incomplete" };
      const operation = await Promise.race([
        this.options.client.getProductOperation(binding.upstreamMerchantId, binding.operationId),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.options.timeoutMs);
        }),
      ]);
      const result = operation?.result;
      const product = result?.product as Record<string, unknown> | undefined;
      if (
        !operation ||
        operation.status !== "succeeded" ||
        operation.operation_id !== binding.operationId ||
        operation.merchant_id !== binding.upstreamMerchantId ||
        operation.operation_kind !== "exact_product_money_update" ||
        operation.sku !== binding.sku ||
        !result ||
        result.expected_authority_version !== binding.expectedMoneyAuthorityVersion ||
        !product ||
        product.sku !== binding.sku ||
        product.merchant_id !== binding.upstreamMerchantId ||
        product.currency !== binding.currency ||
        product.price_minor !== binding.amountMinor ||
        product.currency_table_version !== binding.currencyTableVersion ||
        !Number.isSafeInteger(product.authority_version) ||
        Number(product.authority_version) !== binding.expectedMoneyAuthorityVersion + 1
      )
        return { status: "unknown", reason: "incomplete" };
      return {
        status: "applied",
        binding: structuredClone(binding),
        source: this.options.source,
        receiptRef: contentHash(operation),
        resultingMoneyAuthorityVersion: Number(product.authority_version),
      };
    } catch {
      return { status: "unknown", reason: "unavailable" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
