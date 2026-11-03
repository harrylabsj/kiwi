/**
 * 商家 AI 接待引擎（P0a）：
 *   买家原文 → 意图候选（模型）→ 商品源事实 → 类型化 ResponsePlan → 发布校验 → zh-CN 文本。
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
import { factRevision, InMemoryFactRegistry, publishResponsePlan } from "./publish.js";
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
    /** 数据有效期（ISO）；过期数据不得包装成当前有效报价。 */
    valid_until?: string;
  }>;
}

export interface ReceptionEngineInput {
  merchantId: string;
  identity: string;
  identityVerified: boolean;
  contextId: string;
  text: string;
  now: string;
  /** KNP inquiry 的结构化字段（协议数据，权威于模型候选）；有结构化 SKU 时
   *  空文本/非中文文本不再触发澄清，直接按事实回答。 */
  structured?: { sku?: string };
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

/** 发布结果为空（所有块被拒绝）时的固定兜底，不回显原文、不编造事实。 */
const EMPTY_PUBLISH_FALLBACK =
  "抱歉，当前无法处理这条消息，请稍后重试，或直接发送 RFQ（SKU、数量、单位）。";

export function createMerchantReceptionEngine(
  deps: MerchantReceptionEngineDeps,
): ReceptionEngine {
  return {
    async respond(input) {
      const text = input.text.trim().slice(0, BUYER_MESSAGE_MAX_CHARS);
      const structuredSku = input.structured?.sku;
      const previous = deps.store.get(input.merchantId, input.identity, input.contextId);
      // 每回合事实注册表：快照只在发布当回合有效（不持久化、不跨回合复用）。
      const registry = new InMemoryFactRegistry();

      if (text === "" && structuredSku === undefined) {
        return finish(input, previous, registry, [{ kind: "ask_clarification", missing: ["sku"], reason: "empty_message" }]);
      }
      if (text !== "" && looksNonChinese(text) && structuredSku === undefined) {
        return finish(input, previous, registry, [
          { kind: "ask_clarification", missing: ["sku"], reason: "non_chinese" },
        ]);
      }

      let interpreted;
      if (deps.interpreter !== undefined && text !== "") {
        try {
          interpreted = await deps.interpreter.interpret({ buyer_message: text });
        } catch {
          interpreted = undefined;
        }
      }

      // 结构化字段是协议数据（权威），模型候选其次，最后沿用会话已确认值。
      const sku = structuredSku ?? interpreted?.sku ?? previous?.need.sku;
      const quantity = interpreted?.quantity ?? previous?.need.quantity;
      const unit = interpreted?.unit ?? previous?.need.unit;

      if (sku === undefined) {
        return finish(
          input,
          previous,
          registry,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "missing_sku" }],
          { quantity, unit },
        );
      }

      if (deps.productSource === undefined) {
        return finish(
          input,
          previous,
          registry,
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
          registry,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "unknown_sku" }],
        );
      }

      const policy = deps.policy?.();
      const floor = privateFloorMajor(policy, sku);
      const facts = factsForWithSku(product, quantity, policy, floor, input.now);
      // 事实快照注册后只以引用进入计划；发布器从同一快照渲染（§11）。
      const snapshotBase = {
        merchantId: input.merchantId,
        sku,
        visibility: "public" as const,
        issuedAt: input.now,
        ...(product.valid_until !== undefined ? { expiresAt: product.valid_until } : {}),
        facts,
      };
      const ref = registry.register({ ...snapshotBase, revision: factRevision(snapshotBase) });
      const blocks: ReceptionBlock[] = [
        {
          kind: "acknowledge_need",
          sku,
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit !== undefined ? { unit } : {}),
        },
        { kind: "show_commercial_terms", ref },
        { kind: "next_step", action: "send_rfq" },
      ];
      return finish(input, previous, registry, blocks, { sku, quantity, unit });
    },
  };

  function finish(
    input: ReceptionEngineInput,
    previous: ReceptionConversation | undefined,
    registry: InMemoryFactRegistry,
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
    // 发布前校验（引用存在性/版本/租户/可见性/有效期）后才渲染公开文本。
    const published = publishResponsePlan({
      plan,
      registry,
      merchantId: input.merchantId,
      now: input.now,
    });
    const text = published.text === "" ? EMPTY_PUBLISH_FALLBACK : published.text;
    return { plan, text, conversation };
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
