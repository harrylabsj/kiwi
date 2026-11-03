/**
 * 商家 AI 接待（P0a）内部契约。
 *
 * 边界：
 *  - NeedDraft 只是待确认的需求提案，不是正式 RFQ，也不写 confirmed；
 *  - ResponsePlan 是类型化回复块，商务数字只能来自服务端事实引用；
 *  - 这些对象都不进入 KNP wire（KNP 仍以 canonical envelope 为准）。
 */

export type ReceptionLocale = "zh-CN";

/** 一次会话内逐步累积的需求提案；revision 由服务端递增。 */
export interface ReceptionNeed {
  sku?: string;
  quantity?: number;
  unit?: string;
  revision: number;
  updatedAt: string;
}

export interface CommercialFacts {
  /** 公开标价（major units）；低于私有底价时为 undefined。 */
  listPrice?: number;
  currency?: string;
  /** 库存是否足以覆盖本次数量；来源未知时 undefined。 */
  stockAvailable?: boolean;
  /** 权威交期（ISO）；未配置 delivery_lead_days 时 undefined。 */
  deliveryBefore?: string;
}

export type ReceptionBlock =
  | {
      kind: "acknowledge_need";
      sku?: string;
      quantity?: number;
      unit?: string;
    }
  | {
      kind: "ask_clarification";
      missing: Array<"sku" | "quantity" | "unit">;
      reason: "missing_sku" | "unknown_sku" | "non_chinese" | "empty_message";
    }
  | {
      kind: "show_commercial_terms";
      facts: CommercialFacts;
    }
  | {
      kind: "next_step";
      action: "send_rfq";
    };

export interface ReceptionResponsePlan {
  locale: ReceptionLocale;
  blocks: ReceptionBlock[];
}

export interface ReceptionConversation {
  merchantId: string;
  identity: string;
  contextId: string;
  need: ReceptionNeed;
}
