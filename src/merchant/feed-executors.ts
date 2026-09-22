/** Static Merchant Core executors for approval-gated broadcast writes. */

import { contentHash } from "../agent/merchant/action-candidate.js";
import type { CommandExecutor } from "../merchant-core/executor.js";
import {
  BROADCAST_OPERATION_KINDS,
  type BroadcastInput,
  type BroadcastOperationKind,
  type FeedOperation,
  type MerchantFeedStore,
} from "./feed-store.js";

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
  /**
   * 构造本次操作的回执标识。`requestHash` 覆盖**语义输入**（不是读取时的原始 JSON）：
   * 同 operation_id 换了请求内容必须冲突，而字段顺序/无关字段不得造成假冲突。
   */
  const operationFor = (
    operationKind: BroadcastOperationKind,
    args: Readonly<Record<string, unknown>>,
    decision: { kind: "committed"; operationId: string; actorId: string } | undefined,
  ): FeedOperation => ({
    operationId: requireCommitted(decision).operationId,
    operationKind,
    requestHash: contentHash({
      operation_kind: operationKind,
      merchant_id: options.merchantId,
      broadcast_id: String(args.broadcast_id ?? ""),
      expected_revision: args.expected_revision ?? null,
      input: args.input ?? null,
    }),
  });

  /**
   * 对账适配器：写后不确定时按 operation_id 查**我们自己的**回执。
   *
   * 广播是 kiwi 内部写，没有下游服务可问——回执就落在 feed store 自己的表里，
   * 且与效果**同事务**。没有这个适配器时 `MerchantCommandLog.reconcile` 会返回
   * unknown +「no downstream operation query adapter」，把一次可自动判定的对账
   * 变成人工升级。
   */
  const queryOutcome = (operationKind: BroadcastOperationKind) =>
    async (
      args: Record<string, unknown>,
      _ctx: unknown,
      decision: { operationId: string },
    ): Promise<{ status: "succeeded" } | { status: "unknown"; error: string }> => {
      const receipt = store().getOperation(options.merchantId, decision.operationId);
      return receipt !== undefined &&
        receipt.operation_kind === operationKind &&
        receipt.broadcast_id === String(args.broadcast_id ?? "")
        ? { status: "succeeded" }
        : { status: "unknown", error: "broadcast receipt does not match" };
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
      execute: async (args, _context, decision) => {
        options.authorizeExecution?.(args);
        const published = store().publishWithId(
          options.merchantId,
          String(args.broadcast_id ?? ""),
          requireBroadcastInput(args.input),
          operationFor(BROADCAST_OPERATION_KINDS.publish, args, decision),
        );
        options.onPublished?.(args, published);
        return published;
      },
      queryOutcome: queryOutcome(BROADCAST_OPERATION_KINDS.publish),
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
      execute: async (args, _context, decision) => {
        options.authorizeExecution?.(args);
        return store().revise(
          options.merchantId,
          String(args.broadcast_id ?? ""),
          requireInteger(args.expected_revision, "expected_revision"),
          requireBroadcastInput(args.input),
          operationFor(BROADCAST_OPERATION_KINDS.revise, args, decision),
        );
      },
      queryOutcome: queryOutcome(BROADCAST_OPERATION_KINDS.revise),
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
      execute: async (args, _context, decision) => {
        options.authorizeExecution?.(args);
        return store().withdraw(
          options.merchantId,
          String(args.broadcast_id ?? ""),
          requireInteger(args.expected_revision, "expected_revision"),
          operationFor(BROADCAST_OPERATION_KINDS.withdraw, args, decision),
        );
      },
      queryOutcome: queryOutcome(BROADCAST_OPERATION_KINDS.withdraw),
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

function requireCommitted(
  value: { kind: "committed"; operationId: string; actorId: string } | undefined,
): { operationId: string; actorId: string } {
  if (value?.kind !== "committed") {
    throw new Error("broadcast execution requires a committed decision");
  }
  return value;
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
