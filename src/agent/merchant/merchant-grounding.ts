import type { AgentProfile } from "../../config/profile.js";
import type { GroundingContext, GroundingRule } from "../context/grounding.js";

function has(text: string, terms: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  return terms.some((term) => lowered.includes(term));
}

function enabled(profile: AgentProfile): boolean {
  return profile.merchant_experience?.enabled !== false &&
    profile.merchant_experience?.grounding !== false;
}

/** Rules are intentionally read-only; write tools can never be a grounding target. */
export const MERCHANT_GROUNDING_RULES: readonly GroundingRule[] = [
  {
    name: "pending-actions",
    priority: 10,
    match: ({ latestUserText, sessionState }: GroundingContext) => {
      const profile = sessionState.profile as AgentProfile | undefined;
      if (profile !== undefined && !enabled(profile)) return undefined;
      if (!has(latestUserText, ["待审批", "等待批准", "pending", "approve", "批准", "执行"])) {
        return undefined;
      }
      return { tool: "get_pending_actions", arguments: {}, reason: "approval state must be current" };
    },
  },
  {
    name: "negotiations",
    priority: 20,
    match: ({ latestUserText }: GroundingContext) => {
      if (!has(latestUserText, ["磋商", "询价", "报价", "还价", "buyer", "negotiation"])) {
        return undefined;
      }
      return { tool: "get_negotiation_digest", arguments: { status: "active" }, reason: "read current A2A negotiations first" };
    },
  },
  {
    name: "human-review",
    priority: 30,
    match: ({ latestUserText }: GroundingContext) => {
      if (!has(latestUserText, ["人工", "审核", "转人工", "human review"])) return undefined;
      return { tool: "get_human_review_queue", arguments: {}, reason: "read the current review queue first" };
    },
  },
  {
    name: "inventory-health",
    priority: 40,
    match: ({ latestUserText }: GroundingContext) => {
      if (!has(latestUserText, ["库存", "缺货", "有货", "补货", "stock", "inventory"])) {
        return undefined;
      }
      return { tool: "get_catalog_health", arguments: {}, reason: "inventory answers require current catalog facts" };
    },
  },
  {
    name: "catalog",
    priority: 50,
    match: ({ latestUserText }: GroundingContext) => {
      if (!has(latestUserText, ["商品", "目录", "sku", "listing", "catalog"])) return undefined;
      return { tool: "list_catalog_products", arguments: {}, reason: "catalog answers require current owned listings" };
    },
  },
  {
    name: "business-snapshot",
    priority: 60,
    match: ({ latestUserText }: GroundingContext) => {
      if (!has(latestUserText, ["经营", "生意", "销售", "业绩", "指标", "收入", "最近怎么样"])) {
        return undefined;
      }
      return { tool: "get_business_snapshot", arguments: {}, reason: "business answers require current metrics" };
    },
  },
];

export function merchantGroundingContext(
  profile: AgentProfile,
  latestUserText: string,
): GroundingContext {
  return { latestUserText, sessionState: { profile } };
}
