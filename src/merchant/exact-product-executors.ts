/** Workbench exact-money product create/update executors. */

import type { MerchantClient } from "../agent/merchant/types.js";
import type { CommandExecutor } from "../merchant-core/executor.js";
import { parseExactMoney } from "./application/money.js";

export const EXACT_PRODUCT_TOOLS = {
  create: "kiwi_workbench_product_create_exact",
  updateMoney: "kiwi_workbench_product_money_update_exact",
} as const;

export function createExactProductExecutors(options: {
  merchantId: string;
  client: MerchantClient;
}): CommandExecutor[] {
  return [
    {
      tool: EXACT_PRODUCT_TOOLS.create,
      risk: "write_catalog",
      requiresCommittedDecision: true,
      readPreconditions: async (args) => {
        const sku = requireText(args["sku"], "sku");
        let exists = false;
        try {
          await options.client.getExactProduct(options.merchantId, sku);
          exists = true;
        } catch {
          exists = false;
        }
        return { sku, exists };
      },
      execute: async (args) => {
        const money = parseExactMoney(args["money"], { requireOperatingSupport: true });
        return await options.client.createExactProduct({
          merchant_id: options.merchantId,
          sku: requireText(args["sku"], "sku"),
          title: requireText(args["title"], "title"),
          price_minor: money.amount_minor,
          stock: requireNonNegativeInteger(args["stock"], "stock"),
          expected_authority_version: requirePositiveInteger(
            args["expected_authority_version"],
            "expected_authority_version",
          ),
          currency: money.currency,
          currency_table_version: money.currency_table_version,
          ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
          ...(typeof args["category"] === "string" ? { category: args["category"] } : {}),
          ...(Array.isArray(args["tags"])
            ? { tags: args["tags"].map((value) => String(value)) }
            : {}),
          ...(Array.isArray(args["delivery_attributes"])
            ? {
                delivery_attributes: args["delivery_attributes"].map((value) => String(value)),
              }
            : {}),
          ...(typeof args["handoff_destination"] === "string"
            ? { handoff_destination: args["handoff_destination"] }
            : {}),
        });
      },
      verifyAfter: async (args) => {
        const value = await options.client.getExactProduct(
          options.merchantId,
          requireText(args["sku"], "sku"),
        );
        const expected = parseExactMoney(args["money"], { requireOperatingSupport: true });
        if (value.price_minor !== expected.amount_minor || value.currency !== expected.currency) {
          throw new Error("exact product create readback failed");
        }
      },
    },
    {
      tool: EXACT_PRODUCT_TOOLS.updateMoney,
      risk: "write_catalog",
      requiresCommittedDecision: true,
      readPreconditions: async (args) => {
        const current = await options.client.getExactProduct(
          options.merchantId,
          requireText(args["sku"], "sku"),
        );
        return {
          sku: current.sku,
          currency: current.currency,
          price_minor: current.price_minor,
          currency_table_version: current.currency_table_version,
          authority_version: current.authority_version,
        };
      },
      execute: async (args) => {
        const money = parseExactMoney(args["money"], { requireOperatingSupport: true });
        return await options.client.updateExactProductMoney({
          merchant_id: options.merchantId,
          sku: requireText(args["sku"], "sku"),
          price_minor: money.amount_minor,
          currency_table_version: money.currency_table_version,
          expected_authority_version: requirePositiveInteger(
            args["expected_authority_version"],
            "expected_authority_version",
          ),
        });
      },
      verifyAfter: async (args) => {
        const value = await options.client.getExactProduct(
          options.merchantId,
          requireText(args["sku"], "sku"),
        );
        const expected = parseExactMoney(args["money"], { requireOperatingSupport: true });
        if (value.price_minor !== expected.amount_minor || value.currency !== expected.currency) {
          throw new Error("exact product money update readback failed");
        }
      },
    },
  ];
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}
