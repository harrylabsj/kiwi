/** Startup recovery for promotion -> broadcast workflow crash windows. */

import type { WriteApprovalCandidate } from "../agent/merchant/action-candidate.js";
import { BROADCAST_TOOLS } from "./feed-executors.js";
import { isCurrentGrantAuthorization, type MerchantGrantStore } from "./grant-store.js";
import type { PromotionBroadcastWorkflowStore } from "./promotion-broadcast-workflow.js";
import type { MerchantPromotionStore } from "./promotion-store.js";

export async function recoverPromotionBroadcastWorkflows(options: {
  merchantId: string;
  workflows: PromotionBroadcastWorkflowStore;
  promotions: MerchantPromotionStore;
  grants: MerchantGrantStore;
  listPending: () => WriteApprovalCandidate[];
  getCandidate: (candidateId: string) => WriteApprovalCandidate | undefined;
  prepareBroadcast: (input: {
    broadcast: Record<string, unknown>;
    authorization: Record<string, unknown>;
    workflowId: string;
  }) => Promise<string>;
}): Promise<{ recovered: number; partial: number; completed: number }> {
  let recovered = 0;
  let partial = 0;
  let completed = 0;
  for (const item of options.workflows.listForRecovery(options.merchantId)) {
    let workflow = item.workflow;
    if (workflow.status === "promotion_pending") {
      const promotion = options.promotions.getPromotion(options.merchantId, workflow.promotion_id);
      if (promotion?.status !== "published") continue;
      workflow = options.workflows.markPromotionPublished(
        options.merchantId,
        workflow.workflow_id,
        promotion.revision,
      );
      recovered += 1;
    }
    if (workflow.status === "broadcast_pending") {
      const candidate =
        workflow.broadcast_candidate_id === null
          ? undefined
          : options.getCandidate(workflow.broadcast_candidate_id);
      if (candidate?.status === "executed") {
        options.workflows.markCompleted(options.merchantId, workflow.workflow_id);
        completed += 1;
      } else if (
        candidate === undefined ||
        candidate.status === "expired" ||
        candidate.status === "superseded" ||
        candidate.status === "rejected"
      ) {
        options.workflows.markPartial(
          options.merchantId,
          workflow.workflow_id,
          "broadcast candidate is unavailable or terminal during startup recovery",
        );
        partial += 1;
      }
      continue;
    }
    if (workflow.status !== "promotion_published" || !workflow.broadcast_requested) continue;
    const existing = options
      .listPending()
      .find(
        (candidate) =>
          candidate.tool === BROADCAST_TOOLS.publish &&
          candidate.arguments["workflow_id"] === workflow.workflow_id,
      );
    if (existing !== undefined) {
      options.workflows.markBroadcastPending(
        options.merchantId,
        workflow.workflow_id,
        existing.candidate_id,
      );
      recovered += 1;
      continue;
    }
    try {
      const authorization = item.broadcastAuthorization;
      const broadcast = item.broadcast;
      const actorId = String(authorization?.["actor_id"] ?? "");
      if (
        authorization === undefined ||
        broadcast === undefined ||
        !isCurrentGrantAuthorization(options.grants, {
          merchantId: options.merchantId,
          actorId,
          action: "broadcast.draft",
          snapshot: authorization,
        })
      ) {
        throw new Error("broadcast draft authorization is no longer valid");
      }
      const candidateId = await options.prepareBroadcast({
        broadcast,
        authorization,
        workflowId: workflow.workflow_id,
      });
      options.workflows.markBroadcastPending(options.merchantId, workflow.workflow_id, candidateId);
      recovered += 1;
    } catch (error) {
      options.workflows.markPartial(
        options.merchantId,
        workflow.workflow_id,
        error instanceof Error ? error.message : String(error),
      );
      partial += 1;
    }
  }
  return { recovered, partial, completed };
}
