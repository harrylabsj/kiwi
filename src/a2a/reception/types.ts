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
  /** 多商品澄清时待选择的候选（AC09）；买家选择后清空。 */
  pendingSkus?: string[];
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
  /** 商家一次性批准的单价（major）；仅本轮消费审批候选时出现。 */
  approvedPrice?: number;
}

/** 服务端事实快照的引用（版本 = 快照内容 digest）。 */
export interface FactRef {
  sku: string;
  revision: string;
}

/**
 * 服务端事实快照：发布校验的权威来源。商务数字只能经快照进入回复，
 * 块本身不携带字面金额/库存/交期（设计 §11：模型规划表达、系统发布事实）。
 */
export interface CommercialFactSnapshot {
  /** 租户归属；发布校验拒绝跨租户引用。 */
  merchantId: string;
  sku: string;
  /** 快照版本（内容 digest）；引用版本不匹配即拒绝。 */
  revision: string;
  /** 可见性；非 public 的快照不得进入对买家的回复。 */
  visibility: "public" | "private";
  /** 取数时间（ISO）。 */
  issuedAt: string;
  /** 数据有效期（ISO）；过期即不可发布为当前有效事实。 */
  expiresAt?: string;
  facts: CommercialFacts;
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
      reason:
        | "missing_sku"
        | "unknown_sku"
        | "non_chinese"
        | "empty_message"
        | "service_busy"
        | "multiple_skus";
      /** multiple_skus：买家提到的 SKU 候选（请买家选择，不静默取第一项）。 */
      candidates?: string[];
    }
  | {
      kind: "show_commercial_terms";
      /** 服务端事实引用；发布器校验存在性/版本/租户/可见性/有效期后渲染。 */
      ref: FactRef;
      /** 结构化 inquiry 的主题；缺省渲染全部事实（普通文本行为不变）。 */
      topics?: Array<"price" | "stock" | "delivery">;
    }
  | {
      kind: "request_human_help";
      /** 越界主题：买家目标价低于公开折扣边界（D15 越界转审批）。 */
      topic: "price_below_public_bound";
      /** 买家自己声明的目标价（major units）；回显买家输入，不含商家边界。 */
      buyerTargetPrice?: number;
      currency?: string;
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
