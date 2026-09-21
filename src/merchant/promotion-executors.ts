/** WebAuthn-committed promotion publish/withdraw executors. */

import type { CommandExecutor } from "../merchant-core/executor.js";
import type { MerchantPromotionStore } from "./promotion-store.js";

export const PROMOTION_TOOLS = {
  publish: "kiwi_workbench_promotion_publish",
  withdraw: "kiwi_workbench_promotion_withdraw",
} as const;

export function createPromotionExecutors(options: {
  merchantId: string;
  getStore: () => MerchantPromotionStore | undefined;
}): CommandExecutor[] {
  const store = (): MerchantPromotionStore => {
    const value = options.getStore();
    if (value === undefined) throw new Error("Merchant promotion authority is not configured");
    return value;
  };
  const precondition = async (args: Record<string, unknown>) => {
    const promotion = store().getPromotion(
      options.merchantId,
      requireText(args["promotion_id"], "promotion_id"),
    );
    return promotion === undefined
      ? { missing: true }
      : {
          promotion_id: promotion.promotion_id,
          revision: promotion.revision,
          status: promotion.status,
          sku_refs: promotion.sku_refs,
          starts_at: promotion.starts_at,
          ends_at: promotion.ends_at,
          rule: promotion.rule,
        };
  };
  return [
    {
      tool: PROMOTION_TOOLS.publish,
      risk: "promotion_publish",
      requiresCommittedDecision: true,
      readPreconditions: precondition,
      execute: async (args, _context, decision) =>
        store().publish(
          options.merchantId,
          requireText(args["promotion_id"], "promotion_id"),
          requireRevision(args["expected_revision"]),
          {
            publishedBy: requireCommitted(decision).actorId,
            approvalRef: requireCommitted(decision).operationId,
          },
        ),
      verifyAfter: async (args) => {
        const value = store().getPromotion(
          options.merchantId,
          requireText(args["promotion_id"], "promotion_id"),
        );
        if (value?.status !== "published") throw new Error("promotion publish readback failed");
      },
    },
    {
      tool: PROMOTION_TOOLS.withdraw,
      risk: "promotion_publish",
      requiresCommittedDecision: true,
      readPreconditions: precondition,
      execute: async (args, _context, decision) =>
        store().withdraw(
          options.merchantId,
          requireText(args["promotion_id"], "promotion_id"),
          requireRevision(args["expected_revision"]),
          {
            publishedBy: requireCommitted(decision).actorId,
            approvalRef: requireCommitted(decision).operationId,
          },
        ),
      verifyAfter: async (args) => {
        const value = store().getPromotion(
          options.merchantId,
          requireText(args["promotion_id"], "promotion_id"),
        );
        if (value?.status !== "withdrawn") throw new Error("promotion withdraw readback failed");
      },
    },
  ];
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("expected_revision is invalid");
  return Number(value);
}

function requireCommitted(
  value: { kind: "committed"; operationId: string; actorId: string } | undefined,
): { operationId: string; actorId: string } {
  if (value?.kind !== "committed")
    throw new Error("promotion execution requires a committed decision");
  return value;
}
