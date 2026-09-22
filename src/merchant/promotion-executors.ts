/** WebAuthn-committed promotion publish/withdraw executors. */

import type { CommandExecutor } from "../merchant-core/executor.js";
import type { MerchantPromotionStore } from "./promotion-store.js";
import type { PromotionBroadcastWorkflowStore } from "./promotion-broadcast-workflow.js";

export const PROMOTION_TOOLS = {
  publish: "kiwi_workbench_promotion_publish",
  withdraw: "kiwi_workbench_promotion_withdraw",
} as const;

export function createPromotionExecutors(options: {
  merchantId: string;
  getStore: () => MerchantPromotionStore | undefined;
  getWorkflowStore?: () => PromotionBroadcastWorkflowStore | undefined;
  prepareBroadcast?: (input: {
    broadcast: Record<string, unknown>;
    authorization: Record<string, unknown>;
    workflowId: string;
  }) => Promise<string> | string;
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
  /**
   * 对账适配器：写后不确定时按 operationId（= approval_ref）查**我们自己的**
   * 权威行。促销是 kiwi 内部写，没有下游服务可问——approval_ref 与状态迁移在
   * 同一个 `begin immediate` 里提交（见 store.transition），查到引用且状态与
   * 本次操作的目标态一致即成功。没有这个适配器时 `MerchantCommandLog.reconcile`
   * 会返回 unknown +「no downstream operation query adapter」，把一次可自动
   * 判定的对账变成人工升级。
   */
  const queryOutcome =
    (expectedStatus: "published" | "withdrawn") =>
    async (
      args: Record<string, unknown>,
      _ctx: unknown,
      decision: { operationId: string },
    ): Promise<{ status: "succeeded" } | { status: "unknown"; error: string }> => {
      const receipt = store().getOperation(options.merchantId, decision.operationId);
      return receipt !== undefined &&
        receipt.promotion_id === String(args["promotion_id"] ?? "") &&
        receipt.status === expectedStatus
        ? { status: "succeeded" }
        : { status: "unknown", error: "promotion receipt does not match" };
    };
  return [
    {
      tool: PROMOTION_TOOLS.publish,
      risk: "promotion_publish",
      requiresCommittedDecision: true,
      readPreconditions: precondition,
      execute: async (args, _context, decision) => {
        const published = store().publish(
          options.merchantId,
          requireText(args["promotion_id"], "promotion_id"),
          requireRevision(args["expected_revision"]),
          {
            publishedBy: requireCommitted(decision).actorId,
            approvalRef: requireCommitted(decision).operationId,
          },
        );
        const workflowId = optionalText(args["workflow_id"]);
        const workflows = options.getWorkflowStore?.();
        if (workflowId === undefined || workflows === undefined) return published;
        const workflow = workflows.markPromotionPublished(
          options.merchantId,
          workflowId,
          published.revision,
        );
        if (!workflow.broadcast_requested) return { promotion: published, workflow };
        const broadcast = workflows.broadcastContent(options.merchantId, workflowId);
        try {
          const authorization = requireRecord(
            args["broadcast_authorization"],
            "broadcast_authorization",
          );
          if (broadcast === undefined || options.prepareBroadcast === undefined) {
            throw new Error("broadcast candidate preparation is unavailable");
          }
          const candidateId = await options.prepareBroadcast({
            broadcast,
            authorization,
            workflowId,
          });
          return {
            promotion: published,
            workflow: workflows.markBroadcastPending(options.merchantId, workflowId, candidateId),
          };
        } catch (error) {
          return {
            promotion: published,
            workflow: workflows.markPartial(
              options.merchantId,
              workflowId,
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
      },
      queryOutcome: queryOutcome("published"),
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
      queryOutcome: queryOutcome("withdrawn"),
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

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is required`);
  }
  return value as Record<string, unknown>;
}
