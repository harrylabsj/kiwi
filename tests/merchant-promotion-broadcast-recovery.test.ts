import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { WriteApprovalCandidate } from "../src/agent/merchant/action-candidate.js";
import { BROADCAST_TOOLS } from "../src/merchant/feed-executors.js";
import { MerchantGrantStore } from "../src/merchant/grant-store.js";
import { recoverPromotionBroadcastWorkflows } from "../src/merchant/promotion-broadcast-recovery.js";
import { PromotionBroadcastWorkflowStore } from "../src/merchant/promotion-broadcast-workflow.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";

const NOW = "2026-09-21T12:00:00.000Z";
const MERCHANT = "merchant-001";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const promotions = new MerchantPromotionStore({ db, now: () => NOW });
  const grants = new MerchantGrantStore({ db, now: () => NOW });
  const workflows = new PromotionBroadcastWorkflowStore({ db, now: () => NOW });
  const promotion = promotions.createDraft(MERCHANT, {
    skuRefs: ["sku-1"],
    rule: {
      kind: "limited_price",
      unit_price: { currency: "CNY", amount_minor: "9999" },
    },
    audience: "public",
    starts: "2026-09-21T00:00:00Z",
    ends: "2026-09-22T00:00:00Z",
    timezone: "UTC",
  });
  const workflow = workflows.create({
    merchantId: MERCHANT,
    promotionId: promotion.promotion_id,
    broadcast: {
      kind: "promotion_notice",
      title: "Promotion live",
      body: "Promotion details",
      audience: "public",
    },
    broadcastAuthorization: {
      actor_id: "owner:merchant-001",
      actor_role: "owner",
      action: "broadcast.draft",
      authorization_generation: 0,
      matched_grant_ids: [],
    },
  });
  return { db, promotions, grants, workflows, promotion, workflow };
}

function candidate(
  id: string,
  workflowId: string,
  status: WriteApprovalCandidate["status"] = "pending_approval",
): WriteApprovalCandidate {
  return {
    candidate_id: id,
    principal_id: "merchant-agent:merchant-001",
    tool: BROADCAST_TOOLS.publish,
    arguments: { workflow_id: workflowId },
    arguments_hash: "sha256:args",
    preconditions: {},
    preconditions_hash: "sha256:pre",
    risk: "broadcast_publish",
    status,
    expires_at: "2026-09-21T13:00:00.000Z",
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("promotion broadcast startup recovery", () => {
  it("repairs promotion-committed/workflow-pending without republishing promotion", async () => {
    const { db, promotions, grants, workflows, promotion, workflow } = fixture();
    promotions.publish(MERCHANT, promotion.promotion_id, 1, {
      publishedBy: "owner:merchant-001",
      approvalRef: "operation-publish",
    });
    let prepared = 0;
    const result = await recoverPromotionBroadcastWorkflows({
      merchantId: MERCHANT,
      workflows,
      promotions,
      grants,
      listPending: () => [],
      getCandidate: () => undefined,
      prepareBroadcast: async ({ workflowId }) => {
        prepared += 1;
        return `candidate-${workflowId}`;
      },
    });
    expect(result).toEqual({ recovered: 2, partial: 0, completed: 0 });
    expect(prepared).toBe(1);
    expect(workflows.get(MERCHANT, workflow.workflow_id)).toMatchObject({
      status: "broadcast_pending",
      promotion_revision: 2,
      broadcast_candidate_id: `candidate-${workflow.workflow_id}`,
    });
    expect(promotions.getPromotion(MERCHANT, promotion.promotion_id)?.revision).toBe(2);
    db.close();
  });

  it("reuses an already-created pending broadcast candidate after a bind crash", async () => {
    const { db, promotions, grants, workflows, promotion, workflow } = fixture();
    promotions.publish(MERCHANT, promotion.promotion_id, 1, {
      publishedBy: "owner:merchant-001",
      approvalRef: "operation-publish",
    });
    workflows.markPromotionPublished(MERCHANT, workflow.workflow_id, 2);
    const existing = candidate("candidate-existing", workflow.workflow_id);
    let prepared = 0;
    await recoverPromotionBroadcastWorkflows({
      merchantId: MERCHANT,
      workflows,
      promotions,
      grants,
      listPending: () => [existing],
      getCandidate: () => undefined,
      prepareBroadcast: async () => {
        prepared += 1;
        return "candidate-duplicate";
      },
    });
    expect(prepared).toBe(0);
    expect(workflows.get(MERCHANT, workflow.workflow_id)).toMatchObject({
      status: "broadcast_pending",
      broadcast_candidate_id: existing.candidate_id,
    });
    db.close();
  });

  it("finishes executed broadcasts and marks missing terminal candidates partial", async () => {
    const first = fixture();
    first.promotions.publish(MERCHANT, first.promotion.promotion_id, 1, {
      publishedBy: "owner:merchant-001",
      approvalRef: "operation-publish",
    });
    first.workflows.markPromotionPublished(MERCHANT, first.workflow.workflow_id, 2);
    first.workflows.markBroadcastPending(MERCHANT, first.workflow.workflow_id, "candidate-done");
    const done = candidate("candidate-done", first.workflow.workflow_id, "executed");
    expect(
      await recoverPromotionBroadcastWorkflows({
        merchantId: MERCHANT,
        workflows: first.workflows,
        promotions: first.promotions,
        grants: first.grants,
        listPending: () => [],
        getCandidate: () => done,
        prepareBroadcast: async () => "unused",
      }),
    ).toMatchObject({ completed: 1 });
    expect(first.workflows.get(MERCHANT, first.workflow.workflow_id)?.status).toBe("completed");
    first.db.close();

    const second = fixture();
    second.promotions.publish(MERCHANT, second.promotion.promotion_id, 1, {
      publishedBy: "owner:merchant-001",
      approvalRef: "operation-publish",
    });
    second.workflows.markPromotionPublished(MERCHANT, second.workflow.workflow_id, 2);
    second.workflows.markBroadcastPending(MERCHANT, second.workflow.workflow_id, "candidate-lost");
    expect(
      await recoverPromotionBroadcastWorkflows({
        merchantId: MERCHANT,
        workflows: second.workflows,
        promotions: second.promotions,
        grants: second.grants,
        listPending: () => [],
        getCandidate: () => undefined,
        prepareBroadcast: async () => "unused",
      }),
    ).toMatchObject({ partial: 1 });
    expect(second.workflows.get(MERCHANT, second.workflow.workflow_id)?.status).toBe("partial");
    second.db.close();
  });
});
