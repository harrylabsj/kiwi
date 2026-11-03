/**
 * 商家 AI 接待引擎（P0a）：
 *   买家原文 → 意图候选（模型）→ 商品源事实 → 类型化 ResponsePlan → zh-CN 文本。
 *
 * 红线：
 *  - 模型只负责理解（SKU/数量/单位/主题），不生成价格、库存或交期；
 *  - 所有商务数字来自商品源与商家策略；未知就明确说未知；
 *  - 普通 A2A 文本不创建 KNP Offer，只准备需求并提示发送 RFQ；
 *  - 非中文请求只返回中文范围提示，不用未验收的翻译生成正式需求。
 */

import type { MerchantPolicy } from "../../config/profile.js";
import type { InquiryInterpreter } from "../server/inquiry-interpreter.js";
import type { ReceptionConversationStore } from "./conversation-store.js";
import type {
  CommercialFacts,
  ReceptionBlock,
  ReceptionConversation,
  ReceptionNeed,
  ReceptionResponsePlan,
} from "./types.js";

export interface ReceptionProductSource {
  getProduct(sku: string): Promise<{
    price: number;
    currency: string;
    stock?: number;
    unit?: string;
  }>;
}

export interface ReceptionEngineInput {
  merchantId: string;
  identity: string;
  identityVerified: boolean;
  contextId: string;
  text: string;
  now: string;
}

export interface ReceptionEngineResult {
  plan: ReceptionResponsePlan;
  /** 面向买家的 zh-CN 文本（由计划渲染，不接受模型自由文本）。 */
  text: string;
  conversation: ReceptionConversation;
}

export interface ReceptionEngine {
  respond(input: ReceptionEngineInput): Promise<ReceptionEngineResult>;
}

export interface MerchantReceptionEngineDeps {
  store: ReceptionConversationStore;
  interpreter?: InquiryInterpreter;
  productSource?: ReceptionProductSource;
  policy?: () => MerchantPolicy | undefined;
  now: () => string;
}

const BUYER_MESSAGE_MAX_CHARS = 1_000;

/** 简单 CJK 检测：没有任何汉字且含拉丁字母时按非中文处理（D05）。 */
function looksNonChinese(text: string): boolean {
  return !/[一-鿿]/.test(text) && /[A-Za-z]/.test(text);
}

export function resolveDeliveryBefore(
  policy: MerchantPolicy | undefined,
  now: string,
): string | undefined {
  const days = policy?.delivery_lead_days;
  if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
  const base = Date.parse(now);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + days * 86_400_000).toISOString();
}

function privateFloorMajor(policy: MerchantPolicy | undefined, sku: string): number | undefined {
  const floor = policy?.price_floors?.[sku] ?? policy?.min_unit_price_private;
  return typeof floor === "number" && Number.isFinite(floor) ? floor : undefined;
}

function render(plan: ReceptionResponsePlan): string {
  const lines: string[] = [];
  for (const block of plan.blocks) {
    switch (block.kind) {
      case "acknowledge_need": {
        const parts: string[] = [];
        if (block.sku !== undefined) parts.push(`SKU ${block.sku}`);
        if (block.quantity !== undefined) {
          parts.push(
            block.unit !== undefined ? `${block.quantity} ${block.unit}` : `${block.quantity}`,
          );
        }
        if (parts.length > 0) lines.push(`已记录需求：${parts.join("，")}。`);
        break;
      }
      case "ask_clarification": {
        if (block.reason === "non_chinese") {
          lines.push("目前仅支持中文接待。请用中文说明需要的商品、数量和单位，或发送结构化 RFQ。");
        } else if (block.reason === "empty_message") {
          lines.push("请说明需要的商品、数量和单位。");
        } else if (block.reason === "unknown_sku") {
          lines.push("暂时无法从商品源确认该 SKU，请核对后重试。");
        } else {
          lines.push("请提供商品 SKU；如已知数量与单位也请一并说明。");
        }
        break;
      }
      case "show_commercial_terms": {
        const facts = block.facts;
        if (facts.listPrice !== undefined && facts.currency !== undefined) {
          lines.push(`当前公开标价 ${facts.listPrice.toFixed(2)} ${facts.currency}。`);
        }
        if (facts.stockAvailable === true) lines.push("库存可以覆盖本次数量。");
        if (facts.stockAvailable === false) lines.push("当前库存不足以覆盖本次数量。");
        if (facts.stockAvailable === undefined) lines.push("库存状态待确认。");
        if (facts.deliveryBefore !== undefined) {
          lines.push(`预计交期不晚于 ${facts.deliveryBefore.slice(0, 10)}。`);
        } else {
          lines.push("交期待确认。");
        }
        break;
      }
      case "next_step":
        lines.push("以上为非约束性信息；请发送 RFQ（SKU、数量、单位）获取正式报价。");
        break;
    }
  }
  return lines.join(" ");
}

export function createMerchantReceptionEngine(
  deps: MerchantReceptionEngineDeps,
): ReceptionEngine {
  return {
    async respond(input) {
      const text = input.text.trim().slice(0, BUYER_MESSAGE_MAX_CHARS);
      const previous = deps.store.get(input.merchantId, input.identity, input.contextId);

      if (text === "") {
        return finish(input, previous, [{ kind: "ask_clarification", missing: ["sku"], reason: "empty_message" }]);
      }
      if (looksNonChinese(text)) {
        return finish(input, previous, [
          { kind: "ask_clarification", missing: ["sku"], reason: "non_chinese" },
        ]);
      }

      let interpreted;
      if (deps.interpreter !== undefined) {
        try {
          interpreted = await deps.interpreter.interpret({ buyer_message: text });
        } catch {
          interpreted = undefined;
        }
      }

      const sku = interpreted?.sku ?? previous?.need.sku;
      const quantity = interpreted?.quantity ?? previous?.need.quantity;
      const unit = interpreted?.unit ?? previous?.need.unit;

      if (sku === undefined) {
        return finish(
          input,
          previous,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "missing_sku" }],
          { quantity, unit },
        );
      }

      if (deps.productSource === undefined) {
        return finish(
          input,
          previous,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "unknown_sku" }],
        );
      }
      let product;
      try {
        product = await deps.productSource.getProduct(sku);
      } catch {
        return finish(
          input,
          previous,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "unknown_sku" }],
        );
      }

      const policy = deps.policy?.();
      const floor = privateFloorMajor(policy, sku);
      const facts = factsForWithSku(product, quantity, policy, floor, input.now);
      const blocks: ReceptionBlock[] = [
        {
          kind: "acknowledge_need",
          sku,
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit !== undefined ? { unit } : {}),
        },
        { kind: "show_commercial_terms", facts },
        { kind: "next_step", action: "send_rfq" },
      ];
      return finish(input, previous, blocks, { sku, quantity, unit });
    },
  };

  function finish(
    input: ReceptionEngineInput,
    previous: ReceptionConversation | undefined,
    blocks: ReceptionBlock[],
    need?: Partial<Pick<ReceptionNeed, "sku" | "quantity" | "unit">>,
  ): ReceptionEngineResult {
    const merged = {
      sku: need?.sku ?? previous?.need.sku,
      quantity: need?.quantity ?? previous?.need.quantity,
      unit: need?.unit ?? previous?.need.unit,
    };
    const conversation = deps.store.put(input.merchantId, input.identity, input.contextId, {
      ...(merged.sku !== undefined ? { sku: merged.sku } : {}),
      ...(merged.quantity !== undefined ? { quantity: merged.quantity } : {}),
      ...(merged.unit !== undefined ? { unit: merged.unit } : {}),
    });
    const plan: ReceptionResponsePlan = { locale: "zh-CN", blocks };
    return { plan, text: render(plan), conversation };
  }
}

function factsForWithSku(
  product: { price: number; currency: string; stock?: number },
  quantity: number | undefined,
  policy: MerchantPolicy | undefined,
  floor: number | undefined,
  now: string,
): CommercialFacts {
  const listPrice = floor !== undefined && product.price < floor ? undefined : product.price;
  const stockAvailable =
    product.stock === undefined
      ? undefined
      : quantity !== undefined
        ? product.stock >= quantity
        : product.stock > 0;
  const delivery = resolveDeliveryBefore(policy, now);
  return {
    ...(listPrice !== undefined ? { listPrice, currency: product.currency } : {}),
    ...(stockAvailable !== undefined ? { stockAvailable } : {}),
    ...(delivery !== undefined ? { deliveryBefore: delivery } : {}),
  };
}
