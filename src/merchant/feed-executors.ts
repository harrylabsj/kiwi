/** Static Merchant Core executors for approval-gated broadcast writes. */

import type { CommandExecutor } from "../merchant-core/executor.js";
import type { BroadcastInput, MerchantFeedStore } from "./feed-store.js";

export const BROADCAST_TOOLS = {
  publish: "kiwi_workbench_broadcast_publish",
  revise: "kiwi_workbench_broadcast_revise",
  withdraw: "kiwi_workbench_broadcast_withdraw",
} as const;

export function createBroadcastExecutors(options: {
  merchantId: string;
  getStore: () => MerchantFeedStore | undefined;
  authorizeExecution?: (args: Readonly<Record<string, unknown>>) => void;
  onPublished?: (
    args: Readonly<Record<string, unknown>>,
    result: { broadcast_id: string; revision: number },
  ) => void;
}): CommandExecutor[] {
  const store = (): MerchantFeedStore => {
    const value = options.getStore();
    if (value === undefined) throw new Error("Merchant Feed authority is not configured");
    return value;
  };
  return [
    {
      tool: BROADCAST_TOOLS.publish,
      risk: "broadcast_publish",
      requiresCommittedDecision: true,
      readPreconditions: async (args) => ({
        broadcast_id: String(args.broadcast_id ?? ""),
        exists:
          store().getBroadcast(options.merchantId, String(args.broadcast_id ?? "")) !== undefined,
      }),
      execute: async (args) => {
        options.authorizeExecution?.(args);
        const published = store().publishWithId(
          options.merchantId,
          String(args.broadcast_id ?? ""),
          requireBroadcastInput(args.input),
        );
        options.onPublished?.(args, published);
        return published;
      },
      verifyAfter: async (args) => {
        const value = store().getBroadcast(options.merchantId, String(args.broadcast_id ?? ""));
        if (value?.status !== "published") throw new Error("broadcast publish readback failed");
      },
    },
    {
      tool: BROADCAST_TOOLS.revise,
      risk: "broadcast_publish",
      requiresCommittedDecision: true,
      readPreconditions: async (args) =>
        broadcastPrecondition(
          store().getBroadcast(options.merchantId, String(args.broadcast_id ?? "")),
        ),
      execute: async (args) => {
        options.authorizeExecution?.(args);
        return store().revise(
          options.merchantId,
          String(args.broadcast_id ?? ""),
          requireInteger(args.expected_revision, "expected_revision"),
          requireBroadcastInput(args.input),
        );
      },
      verifyAfter: async (args) => {
        const expected = requireInteger(args.expected_revision, "expected_revision") + 1;
        if (
          store().getBroadcast(options.merchantId, String(args.broadcast_id ?? ""))?.revision !==
          expected
        ) {
          throw new Error("broadcast revision readback failed");
        }
      },
    },
    {
      tool: BROADCAST_TOOLS.withdraw,
      risk: "broadcast_publish",
      requiresCommittedDecision: true,
      readPreconditions: async (args) =>
        broadcastPrecondition(
          store().getBroadcast(options.merchantId, String(args.broadcast_id ?? "")),
        ),
      execute: async (args) => {
        options.authorizeExecution?.(args);
        return store().withdraw(
          options.merchantId,
          String(args.broadcast_id ?? ""),
          requireInteger(args.expected_revision, "expected_revision"),
        );
      },
      verifyAfter: async (args) => {
        if (
          store().getBroadcast(options.merchantId, String(args.broadcast_id ?? ""))?.status !==
          "withdrawn"
        ) {
          throw new Error("broadcast withdraw readback failed");
        }
      },
    },
  ];
}

function broadcastPrecondition(
  value:
    | (BroadcastInput & {
        broadcast_id: string;
        revision: number;
        status: "published" | "withdrawn";
      })
    | undefined,
): Record<string, unknown> {
  if (value === undefined) return { missing: true };
  return {
    broadcast_id: value.broadcast_id,
    revision: value.revision,
    status: value.status,
    kind: value.kind,
    title: value.title,
    body: value.body,
    sku_refs: value.skuRefs ?? [],
    promotion_ref: value.promotionRef ?? null,
    effective_until: value.effectiveUntil ?? null,
    audience: value.audience,
  };
}

function requireBroadcastInput(value: unknown): BroadcastInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("broadcast input must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row.audience !== "public") throw new Error("broadcast audience must be public");
  return {
    kind: String(row.kind ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    audience: "public",
    ...(Array.isArray(row.sku_refs) ? { skuRefs: row.sku_refs.map((item) => String(item)) } : {}),
    ...(typeof row.promotion_ref === "string" ? { promotionRef: row.promotion_ref } : {}),
    ...(typeof row.effective_until === "string" ? { effectiveUntil: row.effective_until } : {}),
  };
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
