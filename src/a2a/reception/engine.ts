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
import { uuidv7 } from "../../negotiation/domain/identifiers.js";
import { contentDigest } from "../../negotiation/jcs.js";
import { toMinorUnits as losslessToMinorUnits } from "../../protocol/legacy-shopping-negotiation/money.js";
import type { InquiryInterpreter, InquiryTopic } from "../server/inquiry-interpreter.js";
import { applyDiscountPercentMinor } from "../server/merchant-handler.js";
import {
  multiplyQuantitySafe,
  resolveUnitConversion,
  unitConversionPolicy,
} from "../unit-alias.js";
import type { ReceptionAgentResult, ReceptionAgentRuntime } from "./agent-runtime.js";
import { RECEPTION_CONFIG_DEFAULTS } from "./config.js";
import type { ReceptionConversationStore } from "./conversation-store.js";
import { factRevision, InMemoryFactRegistry, publishResponsePlan } from "./publish.js";
import type { ReceptionReplyOutbox } from "./reply-outbox.js";
import type {
  CommercialFacts,
  ReceptionBlock,
  ReceptionConversation,
  ReceptionNeed,
  ReceptionResponsePlan,
} from "./types.js";

export interface ReceptionProductSource {
  /** M2：按买家文字返回本店候选；只做候选，不直接报价。 */
  searchProducts?(query: string): Promise<
    Array<{ sku: string; title?: string; price: number; currency: string; stock?: number }>
  >;
  getProduct(sku: string): Promise<{
    price: number;
    currency: string;
    stock?: number;
    unit?: string;
    /** 数据有效期（ISO）；过期数据不得包装成当前有效报价。 */
    valid_until?: string;
    tax_included?: boolean;
    shipping_included?: boolean;
  }>;
}

export interface ReceptionEngineInput {
  merchantId: string;
  identity: string;
  identityVerified: boolean;
  contextId: string;
  text: string;
  now: string;
  /** 入站消息 id（字段证据 source_message_id）；缺省时不签发证据。 */
  messageId?: string;
  /** KNP inquiry 的结构化字段（协议数据，权威于模型候选）；有结构化 SKU 时
   *  空文本/非中文文本不再触发澄清，直接按事实回答。 */
  structured?: { sku?: string; topics?: InquiryTopic[] };
}

export interface ReceptionEngineResult {
  plan: ReceptionResponsePlan;
  /** 面向买家的 zh-CN 文本（由计划渲染，不接受模型自由文本）。 */
  text: string;
  conversation: ReceptionConversation;
  /** 本条发布回复的身份（§16.1）：response_id 重试复用，reply_seq 按会话递增。 */
  reply: { response_id: string; reply_seq: number };
}

export interface ReceptionEngine {
  respond(input: ReceptionEngineInput): Promise<ReceptionEngineResult>;
}

export type ReceptionApprovalStatus =
  | "pending"
  | "approved"
  | "consumed"
  | "expired"
  | "rejected";

export interface ReceptionApprovalCandidate {
  approval_id: string;
  negotiation_id: string;
  sku: string;
  currency: string;
  quantity: number;
  unit?: string;
  buyer_offer_minor?: number;
  approved_minor?: number;
  status: ReceptionApprovalStatus;
}

/** 审批候选落盘接缝（复用 NegotiationApprovalStore 的入参子集）。 */
export interface ReceptionApprovalSink {
  recordPending(input: {
    negotiation_id: string;
    sku: string;
    currency: string;
    quantity: number;
    unit?: string;
    buyer_offer_minor: number;
    public_bound_minor?: number;
    floor_minor?: number;
    ttl_seconds?: number;
  }): unknown;
  /** 读取/写入前固化到期状态（§17.1）；实现可缺省。 */
  sweepExpired?(): unknown;
  /** 读取已批准候选（批准后买家下一轮消费；D15）。实现可缺省。 */
  list?(status?: ReceptionApprovalStatus): ReceptionApprovalCandidate[];
  /** 一次性消费批准价；被其他请求抢先消费/已过期时返回 undefined。 */
  consume?(input: {
    negotiation_id: string;
    sku: string;
    currency?: string;
    quantity?: number;
    unit?: string;
  }): ReceptionApprovalCandidate | undefined;
}

type StatedFields = Partial<
  Record<"sku" | "quantity" | "unit", "structured" | "model">
>;

export interface MerchantReceptionEngineDeps {
  store: ReceptionConversationStore;
  outbox: ReceptionReplyOutbox;
  interpreter?: InquiryInterpreter;
  productSource?: ReceptionProductSource;
  policy?: () => MerchantPolicy | undefined;
  /** 越界请求的审批候选入口（D15）；缺省时越界按普通事实回答（不谎称已提交）。 */
  approvals?: ReceptionApprovalSink;
  /** 审批等待期限（秒，D08 缺省 900）。 */
  approvalTtlSeconds?: number;
  /** M2：Pi 工具循环运行时；缺省走确定性解释器路径。 */
  agent?: ReceptionAgentRuntime;
  /** 商家声明的单位别名（别名 → 商品源单位）；不配置就只接受完全一致。 */
  unitAliases?: Record<string, string>;
  /** 商家声明的包装倍率（包装单位 → 1 包装 = N 个 default_unit）。 */
  unitPackageFactors?: Record<string, number>;
  /**
   * 商家的默认售卖单位；倍率只对以此为目标单位的商品源生效。
   *
   * 迁移：旧公开构造器只传 unitPackageFactors 时仍保留历史换算行为；
   * 新调用方应同时传 unitDefaultUnit，才能得到 source-target-safe 语义。
   */
  unitDefaultUnit?: string;
  /** 单次 respond 的硬截止（毫秒，D07/§18 缺省 30 秒，从 admitted_at 起算）；
   *  超时后不再发起模型/事实工具调用，降级确定性回复。 */
  deadlineMs?: number;
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

const CN_QUANTITY_UNITS = [
  "盒",
  "件",
  "个",
  "只",
  "箱",
  "瓶",
  "包",
  "袋",
  "台",
  "套",
  "双",
  "张",
  "份",
] as const;

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseNumeralToInt(raw: string): number | undefined {
  if (raw === "十") return 10;
  const tenIndex = raw.indexOf("十");
  if (tenIndex === -1) {
    return raw.length === 1 ? CN_DIGITS[raw] : undefined;
  }
  if (raw.indexOf("十", tenIndex + 1) !== -1) return undefined;
  const tens = tenIndex === 0 ? 1 : CN_DIGITS[raw.slice(0, tenIndex)];
  const ones = tenIndex === raw.length - 1 ? 0 : CN_DIGITS[raw.slice(tenIndex + 1)];
  if (tens === undefined || ones === undefined) return undefined;
  return tens * 10 + ones;
}

/**
 * 中文数量兜底（如“十盒”“两件”）。模型偶发漏抽中文数字时，避免多轮
 * 变更静默沿用旧数量；数字前 4 字符内出现阿拉伯数字/货币符号时视为价格
 * 语境（“98 一件”），不当作数量。
 */
export function parseChineseQuantity(
  text: string,
): { quantity: number; unit: string } | undefined {
  const pattern = new RegExp(
    `([一二两三四五六七八九十]+)\\s*(${CN_QUANTITY_UNITS.join("|")})`,
    "u",
  );
  const match = pattern.exec(text);
  if (match === null || match.index === undefined) return undefined;
  const prefix = text.slice(Math.max(0, match.index - 4), match.index);
  if (/[\d¥￥元块]/.test(prefix)) return undefined;
  const quantity = chineseNumeralToInt(match[1]!);
  if (quantity === undefined || quantity <= 0) return undefined;
  return { quantity, unit: match[2]! };
}

const CN_ORDINALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * 多商品澄清后的序号指代（“第一个”“选2”“第二款”）。只在上轮持久化了
 * 候选时生效；解析失败返回 undefined，让调用方继续追问。
 */
export function ordinalSkuOf(
  text: string,
  candidates: readonly string[] | undefined,
): string | undefined {
  if (candidates === undefined || candidates.length === 0) return undefined;
  const match = text.match(
    /(?:第|选)\s*(?:第)?\s*([1-9]\d?|[一二三四五六七八九十])\s*(?:个|款|项|号)?/,
  );
  if (match === null) return undefined;
  const raw = match[1]!;
  const index = /^\d+$/.test(raw) ? Number(raw) : CN_ORDINALS[raw];
  if (index === undefined || index < 1 || index > candidates.length) return undefined;
  return candidates[index - 1];
}

/** 发布结果为空（所有块被拒绝）时的固定兜底，不回显原文、不编造事实。 */
const EMPTY_PUBLISH_FALLBACK =
  "抱歉，当前无法处理这条消息，请稍后重试，或直接发送 RFQ（SKU、数量、单位）。";

export function createMerchantReceptionEngine(
  deps: MerchantReceptionEngineDeps,
): ReceptionEngine {
  const unitPolicy = unitConversionPolicy({
    aliases: deps.unitAliases,
    packageFactors: deps.unitPackageFactors,
    ...(deps.unitDefaultUnit !== undefined ? { defaultUnit: deps.unitDefaultUnit } : {}),
  });
  return {
    async respond(input) {
      // §17.1：每次接待写入前先固化已到期的审批，避免新会话面对陈旧 pending。
      try {
        deps.approvals?.sweepExpired?.();
      } catch {
        // 审批存储故障不阻断接待；ops/CLI 读取时还会再扫一次。
      }
      const text = input.text.trim().slice(0, BUYER_MESSAGE_MAX_CHARS);
      const structuredSku = input.structured?.sku;
      const structuredTopics = input.structured?.topics ?? [];
      const previous = deps.store.get(input.merchantId, input.identity, input.contextId);
      // 每回合事实注册表：快照只在发布当回合有效（不持久化、不跨回合复用）。
      const registry = new InMemoryFactRegistry();
      // D07/§18：从 admitted_at 起 30 秒硬截止；超时不再发起新工具调用，
      // 降级确定性回复（不承诺跑满时限，也不把超时伪装成理解结果）。
      const admittedAt = Date.parse(input.now);
      const deadlineMs = deps.deadlineMs ?? RECEPTION_CONFIG_DEFAULTS.runDeadlineMs;
      const deadlineExceeded = (): boolean =>
        Number.isFinite(admittedAt) && Date.parse(deps.now()) - admittedAt > deadlineMs;

      if (text === "" && structuredSku === undefined) {
        return finish(input, previous, registry, [{ kind: "ask_clarification", missing: ["sku"], reason: "empty_message" }]);
      }
      if (text !== "" && looksNonChinese(text) && structuredSku === undefined) {
        return finish(input, previous, registry, [
          { kind: "ask_clarification", missing: ["sku"], reason: "non_chinese" },
        ]);
      }

      // M2：Pi 工具循环（可选）。存在已批准候选时先走确定性消费路径，
      // 避免模型绕过“批准价只生效一次”的回环。
      const hasApprovedCandidate =
        deps.approvals
          ?.list?.("approved")
          ?.some((candidate) => candidate.negotiation_id === input.contextId) === true;
      if (deps.agent !== undefined && !hasApprovedCandidate && text !== "" && !deadlineExceeded()) {
        try {
          const agentResult = await deps.agent.run({
            merchantId: input.merchantId,
            identity: input.identity,
            contextId: input.contextId,
            text,
            ...(structuredSku !== undefined ? { structuredSku } : {}),
            ...(previous !== undefined ? { previousNeed: previous.need } : {}),
            registry,
            now: input.now,
          });
          if (
            agentResult !== undefined &&
            (structuredSku === undefined ||
              agentResultMatchesStructuredSku(agentResult, structuredSku))
          ) {
            // 模型选择转人工时，仍由服务端登记审批候选（模型没有写能力）。
            const humanBlocks = agentResult.plan.blocks.filter(
              (block): block is Extract<ReceptionBlock, { kind: "request_human_help" }> =>
                block.kind === "request_human_help",
            );
            // Exactly one submitted human block may become one server-verified
            // block. Multiple model blocks are never all published on the
            // strength of a single approval.
            const human = humanBlocks.length === 1 ? humanBlocks[0] : undefined;
            const needSku = agentResult.need?.sku ?? previous?.need.sku;
            const needQuantity = agentResult.need?.quantity ?? previous?.need.quantity;
            const needUnit = agentResult.need?.unit ?? previous?.need.unit;
            let verifiedHuman:
              | Extract<ReceptionBlock, { kind: "request_human_help" }>
              | undefined;
            if (
              human?.buyerTargetPrice !== undefined &&
              human.currency !== undefined &&
              needSku !== undefined &&
              needQuantity !== undefined &&
              deps.productSource !== undefined &&
              deps.approvals !== undefined
            ) {
              try {
                const product = await deps.productSource.getProduct(needSku);
                if (human.currency !== product.currency) {
                  // Buyer-visible target currency and the authoritative product
                  // currency disagree; never persist one and display the other.
                  verifiedHuman = undefined;
                } else {
                  const policyNow = deps.policy?.();
                  const boundary = belowPublicBound(
                    human.buyerTargetPrice,
                    product,
                    needSku,
                    policyNow,
                  );
                  if (boundary !== undefined) {
                    const floorMinor = minorOf(privateFloorMajor(policyNow, needSku));
                    const created = deps.approvals.recordPending({
                      negotiation_id: input.contextId,
                      sku: needSku,
                      currency: product.currency,
                      quantity: needQuantity,
                      ...(needUnit !== undefined ? { unit: needUnit } : {}),
                      buyer_offer_minor: boundary.targetMinor,
                      public_bound_minor: boundary.publicBoundMinor,
                      ...(floorMinor !== undefined ? { floor_minor: floorMinor } : {}),
                      ttl_seconds:
                        deps.approvalTtlSeconds ?? RECEPTION_CONFIG_DEFAULTS.approvalTtlSeconds,
                    });
                    if (
                      pendingApprovalExists(
                        deps.approvals,
                        {
                          negotiationId: input.contextId,
                          sku: needSku,
                          currency: product.currency,
                          quantity: needQuantity,
                          ...(needUnit !== undefined ? { unit: needUnit } : {}),
                          buyerOfferMinor: boundary.targetMinor,
                        },
                        created,
                      )
                    ) {
                      verifiedHuman = {
                        kind: "request_human_help",
                        topic: "price_below_public_bound",
                        buyerTargetPrice: boundary.targetMajor,
                        currency: product.currency,
                      };
                    }
                  }
                }
              } catch {
                // 事实/审批存储不可用：不保留 request_human_help，走真实兜底。
                verifiedHuman = undefined;
              }
            }
            const blocks =
              humanBlocks.length === 0
                ? agentResult.plan.blocks
                : verifiedHuman !== undefined
                  ? [
                      ...agentResult.plan.blocks.filter(
                        (block) => block.kind !== "request_human_help",
                      ),
                      verifiedHuman,
                    ]
                  : truthfulHumanFallback(agentResult.plan.blocks, {
                      ...(needSku !== undefined ? { sku: needSku } : {}),
                      ...(needQuantity !== undefined ? { quantity: needQuantity } : {}),
                    });
            const agentStated: StatedFields = {
              ...(agentResult.need?.sku !== undefined ? { sku: "model" as const } : {}),
              ...(agentResult.need?.quantity !== undefined ? { quantity: "model" as const } : {}),
              ...(agentResult.need?.unit !== undefined ? { unit: "model" as const } : {}),
            };
            return finish(input, previous, registry, blocks, agentResult.need, agentStated);
          }
        } catch {
          // 回退确定性路径。
        }
      }

      let interpreted;
      if (deps.interpreter !== undefined && text !== "" && !deadlineExceeded()) {
        try {
          interpreted = await deps.interpreter.interpret({ buyer_message: text });
        } catch {
          interpreted = undefined;
        }
      }

      // 结构化字段是协议数据（权威），模型候选其次，最后沿用会话已确认值。
      const candidateSkus =
        interpreted?.skus ?? (interpreted?.sku !== undefined ? [interpreted.sku] : []);
      // AC09/D03：多商品澄清后，买家可以用“第一个/第二款”指代候选；候选来自
      // 上一轮持久化的 pendingSkus，序号解析不依赖模型。
      const ordinalSku = ordinalSkuOf(text, previous?.need.pendingSkus);
      // 中文数量兜底（模型偶发漏抽中文数字）。
      const chineseQuantity = parseChineseQuantity(text);
      // 字段证据来源：协议字段 > 模型/搜索候选；只有本轮明确给出的字段才更新。
      const stated: StatedFields = {
        ...(structuredSku !== undefined ? { sku: "structured" as const } : {}),
        ...(interpreted?.quantity !== undefined
          ? { quantity: "model" as const }
          : chineseQuantity !== undefined
            ? { quantity: "model" as const }
            : {}),
        ...(interpreted?.unit !== undefined
          ? { unit: "model" as const }
          : chineseQuantity !== undefined
            ? { unit: "model" as const }
            : {}),
      };
      if (stated.sku === undefined && (ordinalSku !== undefined || candidateSkus.length === 1)) {
        stated.sku = "model";
      }
      // 一条消息提到多个商品时明确提示并请买家选择，禁止静默只取第一项；
      // 结构化 SKU 是协议数据（单值），不参与多候选判定。
      if (structuredSku === undefined && ordinalSku === undefined && candidateSkus.length > 1) {
        return finish(
          input,
          previous,
          registry,
          [
            {
              kind: "ask_clarification",
              missing: ["sku"],
              reason: "multiple_skus",
              candidates: candidateSkus,
            },
          ],
          { quantity: interpreted?.quantity, unit: interpreted?.unit, pendingSkus: candidateSkus },
          stated,
        );
      }
      let sku = structuredSku ?? ordinalSku ?? candidateSkus[0] ?? previous?.need.sku;
      let quantity =
        interpreted?.quantity ?? chineseQuantity?.quantity ?? previous?.need.quantity;
      let unit = interpreted?.unit ?? chineseQuantity?.unit ?? previous?.need.unit;
      let convertedFrom: { quantity: number; unit: string; factor: number } | undefined;

      // M2：买家没说 SKU 时按本店公开商品搜索；唯一命中直接进入事实回答，
      // 多命中列出候选请买家选择，零命中才回固定追问。搜索失败不阻断接待。
      if (sku === undefined && text !== "" && deps.productSource?.searchProducts !== undefined && !deadlineExceeded()) {
        let searchResults: Awaited<
          ReturnType<NonNullable<ReceptionProductSource["searchProducts"]>>
        > = [];
        try {
          searchResults = await deps.productSource.searchProducts(text);
        } catch {
          searchResults = [];
        }
        if (searchResults.length === 1) {
          sku = searchResults[0]!.sku;
          if (stated.sku === undefined) stated.sku = "model";
        } else if (searchResults.length > 1) {
          const candidates = searchResults.map((result) => result.sku);
          return finish(
            input,
            previous,
            registry,
            [
              {
                kind: "ask_clarification",
                missing: ["sku"],
                reason: "product_candidates",
                candidates,
              },
            ],
            { quantity, unit, pendingSkus: candidates },
            stated,
          );
        }
      }

      if (sku === undefined) {
        return finish(
          input,
          previous,
          registry,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "missing_sku" }],
          { quantity, unit },
          stated,
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
      // 模型回合结束后复验时限：超时不再调用事实工具，降级确定性回复。
      if (deadlineExceeded()) {
        return finish(
          input,
          previous,
          registry,
          [{ kind: "ask_clarification", missing: ["sku"], reason: "service_busy" }],
          { sku, quantity, unit },
          stated,
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

      // AC13：过期事实不得报价/登记审批；先拒绝本轮，要求重新确认。
      if (product.valid_until !== undefined) {
        const until = Date.parse(product.valid_until);
        if (!Number.isFinite(until) || until <= Date.parse(input.now)) {
          return finish(
            input,
            previous,
            registry,
            [{ kind: "ask_clarification", missing: ["sku"], reason: "facts_stale" }],
            { sku, quantity, unit },
            stated,
          );
        }
      }
      // AC06：商品源单位与请求同义时始终 1:1；包装倍率只对 default_unit
      // 目标生效，其他情况或别名冲突一律安全拒绝，不猜倍率。
      if (product.unit !== undefined && unit !== undefined) {
        const resolution = resolveUnitConversion(unitPolicy, product.unit, unit);
        if (resolution.kind === "factor") {
          // AC06：使用商家声明的包装倍率；没有数量时先问数量，绝不猜 1 箱=1 件。
          if (quantity === undefined) {
            return finish(
              input,
              previous,
              registry,
              [{ kind: "ask_clarification", missing: ["quantity"], reason: "missing_quantity" }],
              { sku },
              stated,
            );
          }
          const convertedQuantity = multiplyQuantitySafe(quantity, resolution.factor);
          if (convertedQuantity === undefined) {
            return finish(
              input,
              previous,
              registry,
              [{ kind: "ask_clarification", missing: ["quantity"], reason: "quantity_overflow" }],
              { sku, quantity },
              stated,
            );
          }
          convertedFrom = { quantity, unit, factor: resolution.factor };
          quantity = convertedQuantity;
          unit = product.unit;
        } else if (resolution.kind === "identity" || resolution.kind === "alias") {
          unit = product.unit;
        } else {
          return finish(
            input,
            previous,
            registry,
            [
              {
                kind: "ask_clarification",
                missing: ["sku"],
                reason: "unit_mismatch",
                supportedUnit: product.unit,
              },
            ],
            { sku, quantity },
            stated,
          );
        }
      }

      const policy = deps.policy?.();
      const floor = privateFloorMajor(policy, sku);
      // D15 审批回环：商家在 /ops 批准的候选，买家下一轮命中即一次性消费，
      // 用批准价渲染（不再重复登记 pending）。数量/单位变化时不消费。
      const targetMinor = minorOf(interpreted?.target_price);
      const currentFloorMinor = minorOf(floor);
      const approvalTopicsOk =
        structuredTopics.length === 0 || structuredTopics.includes("price");
      const approved = approvalTopicsOk
        ? deps.approvals?.list?.("approved")?.find(
            (candidate) =>
              candidate.negotiation_id === input.contextId &&
              candidate.sku === sku &&
              candidate.currency === product.currency &&
              (quantity === undefined || candidate.quantity === quantity) &&
              (unit === undefined || candidate.unit === undefined || candidate.unit === unit) &&
              candidate.approved_minor !== undefined &&
              // 批准后策略/底价可能已变化：当前底价高于批准价时不再消费（AC27）。
              (currentFloorMinor === undefined || candidate.approved_minor >= currentFloorMinor) &&
              (targetMinor === undefined || candidate.approved_minor >= targetMinor),
          )
        : undefined;
      if (approved !== undefined && approved.approved_minor !== undefined) {
        const consumed = deps.approvals?.consume?.({
          negotiation_id: input.contextId,
          sku,
          currency: product.currency,
          quantity: approved.quantity,
          ...(approved.unit !== undefined ? { unit: approved.unit } : {}),
        });
        if (consumed !== undefined) {
          const approvedFacts = {
            ...factsForWithSku(
              product,
              quantity ?? approved.quantity,
              policy,
              floor,
              input.now,
            ),
            approvedPrice: approved.approved_minor / 100,
          };
          const approvedSnapshot = {
            merchantId: input.merchantId,
            sku,
            visibility: "public" as const,
            issuedAt: input.now,
            ...(product.valid_until !== undefined ? { expiresAt: product.valid_until } : {}),
            facts: approvedFacts,
          };
          const approvedRef = registry.register({
            ...approvedSnapshot,
            revision: factRevision(approvedSnapshot),
          });
          return finish(
            input,
            previous,
            registry,
            [
              {
                kind: "acknowledge_need",
                sku,
                ...(quantity !== undefined ? { quantity } : {}),
                ...(unit !== undefined ? { unit } : {}),
              },
              {
                kind: "show_commercial_terms",
                ref: approvedRef,
                ...(structuredTopics.length > 0 ? { topics: structuredTopics } : {}),
              },
              { kind: "next_step", action: "send_rfq" },
            ],
            {
              sku,
              quantity,
              unit,
              ...(convertedFrom !== undefined
                ? { inputQuantity: convertedFrom.quantity, inputUnit: convertedFrom.unit }
                : {}),
            },
            stated,
          );
        }
      }
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
      const acknowledge: ReceptionBlock = {
        kind: "acknowledge_need",
        sku,
        ...(quantity !== undefined ? { quantity } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(convertedFrom !== undefined ? { convertedFrom } : {}),
      };

      // D15 自动发布边界：买家明确目标价低于公开折扣边界（list×(1-max(自动
      // 折扣%,促销%))，与确定性报价同口径）→ 登记审批候选并如实告知"需要
      // 商家确认"；不泄露公开边界数值与私有底价。边界内或无法精确换算时按
      // 普通事实回答（接待本身不发布 Offer，正式报价仍走 KNP fast path）。
      const boundary = belowPublicBound(interpreted?.target_price, product, sku, policy);
      if (
        boundary !== undefined &&
        quantity !== undefined &&
        deps.approvals !== undefined
      ) {
        try {
          const floorMinor = minorOf(floor);
          const created = deps.approvals.recordPending({
            negotiation_id: input.contextId,
            sku,
            currency: product.currency,
            quantity,
            ...(unit !== undefined ? { unit } : {}),
            buyer_offer_minor: boundary.targetMinor,
            public_bound_minor: boundary.publicBoundMinor,
            ...(floorMinor !== undefined ? { floor_minor: floorMinor } : {}),
            ttl_seconds: deps.approvalTtlSeconds ?? RECEPTION_CONFIG_DEFAULTS.approvalTtlSeconds,
          });
          if (
            pendingApprovalExists(
              deps.approvals,
              {
                negotiationId: input.contextId,
                sku,
                currency: product.currency,
                quantity,
                ...(unit !== undefined ? { unit } : {}),
                buyerOfferMinor: boundary.targetMinor,
              },
              created,
            )
          ) {
            return finish(input, previous, registry, [
              acknowledge,
              {
                kind: "show_commercial_terms",
                ref,
                ...(structuredTopics.length > 0 ? { topics: structuredTopics } : {}),
              },
              {
                kind: "request_human_help",
                topic: "price_below_public_bound",
                buyerTargetPrice: boundary.targetMajor,
                currency: product.currency,
              },
            ], {
              sku,
              quantity,
              unit,
              ...(convertedFrom !== undefined
                ? { inputQuantity: convertedFrom.quantity, inputUnit: convertedFrom.unit }
                : {}),
            }, stated);
          }
        } catch {
          // 审批存储失败：不声称待商家确认，继续普通事实回答。
        }
      }

      const blocks: ReceptionBlock[] = [
        acknowledge,
        {
          kind: "show_commercial_terms",
          ref,
          ...(structuredTopics.length > 0 ? { topics: structuredTopics } : {}),
        },
        { kind: "next_step", action: "send_rfq" },
      ];
      return finish(input, previous, registry, blocks, {
        sku,
        quantity,
        unit,
        ...(convertedFrom !== undefined
          ? { inputQuantity: convertedFrom.quantity, inputUnit: convertedFrom.unit }
          : {}),
      }, stated);
    },
  };

  function finish(
    input: ReceptionEngineInput,
    previous: ReceptionConversation | undefined,
    registry: InMemoryFactRegistry,
    blocks: ReceptionBlock[],
    need?: Partial<
      Pick<
        ReceptionNeed,
        "sku" | "quantity" | "unit" | "pendingSkus" | "evidence" | "inputQuantity" | "inputUnit"
      >
    >,
    stated?: StatedFields,
  ): ReceptionEngineResult {
    const merged = {
      sku: need?.sku ?? previous?.need.sku,
      quantity: need?.quantity ?? previous?.need.quantity,
      unit: need?.unit ?? previous?.need.unit,
    };
    // 字段证据：只有本轮明确给出的字段才签发新的 source_message_id；
    // 其余字段沿用上一轮证据。模型输出不能设置 confirmed。
    const evidence = {
      ...previous?.need.evidence,
      ...(need?.evidence ?? {}),
    };
    if (input.messageId !== undefined && stated !== undefined) {
      for (const field of ["sku", "quantity", "unit"] as const) {
        const source = stated[field];
        if (source !== undefined) {
          evidence[field] = {
            source_message_id: input.messageId,
            observed_at: input.now,
            source,
          };
        }
      }
    }
    // 买家选定 SKU 后清空候选；仍在多商品澄清中则继续保留，供“第一个”指代。
    const pendingSkus =
      need?.sku !== undefined
        ? undefined
        : (need?.pendingSkus ?? previous?.need.pendingSkus);
    const conversation = deps.store.put(input.merchantId, input.identity, input.contextId, {
      ...(merged.sku !== undefined ? { sku: merged.sku } : {}),
      ...(merged.quantity !== undefined ? { quantity: merged.quantity } : {}),
      ...(merged.unit !== undefined ? { unit: merged.unit } : {}),
      ...(pendingSkus !== undefined && pendingSkus.length > 0 ? { pendingSkus } : {}),
      ...(need?.inputQuantity !== undefined ? { inputQuantity: need.inputQuantity } : {}),
      ...(need?.inputUnit !== undefined ? { inputUnit: need.inputUnit } : {}),
      ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
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
    // §16.1：合法回复发布事务内按会话分配严格递增序号；登记出站记录
    // （P0a 同步投递即 dispatched，重试复用同一 response_id 由 outbox 幂等）。
    const responseId = `resp_${uuidv7()}`;
    const replySeq = deps.store.allocateReplySeq(input.merchantId, input.identity, input.contextId);
    deps.outbox.record({
      response_id: responseId,
      merchantId: input.merchantId,
      identity: input.identity,
      contextId: input.contextId,
      reply_seq: replySeq,
      text_digest: contentDigest(text as never),
      dispatch_class: "automatic",
      status: "dispatched",
    });
    return { plan, text, conversation, reply: { response_id: responseId, reply_seq: replySeq } };
  }
}

/** major（元）→ minor（分）的无损换算；无法精确表达返回 undefined。 */
function minorOf(major: number | undefined): number | undefined {
  if (major === undefined) return undefined;
  const converted = losslessToMinorUnits(major, 2);
  return converted.lossless ? converted.amount_minor : undefined;
}

/** 公开折扣边界（与 merchant-handler publicDiscountBoundMinor 同口径）：
 *  公开边界 = list×(1-max(max_auto_discount_percent, promos[sku].bulk_discount_percent))。 */
function publicBoundMinorOf(
  listMinor: number,
  sku: string,
  policy: MerchantPolicy | undefined,
): number {
  const autoRaw = policy?.max_auto_discount_percent;
  const auto = typeof autoRaw === "number" && Number.isFinite(autoRaw) && autoRaw > 0 ? autoRaw : 0;
  const promoPct = policy?.promos?.[sku]?.bulk_discount_percent ?? 0;
  const pct = Math.max(auto, Number.isFinite(promoPct) && promoPct > 0 ? promoPct : 0);
  return applyDiscountPercentMinor(listMinor, pct);
}

/** 买家目标价是否低于公开折扣边界；无法精确换算（lossy）时按未越界处理。 */
/**
 * Verify that a pending approval really exists server-side and matches the
 * exact buyer request. A successful-looking return value alone is not enough:
 * storage may have failed after the caller saw an object. Only list("pending")
 * is treated as authoritative.
 */
function pendingApprovalExists(
  approvals: ReceptionApprovalSink,
  expected: {
    negotiationId: string;
    sku: string;
    currency: string;
    quantity: number;
    unit?: string;
    buyerOfferMinor: number;
  },
  created: unknown,
): boolean {
  if (approvals.list === undefined) return false;
  const approvalId = (created as { approval_id?: unknown } | null)?.approval_id;
  if (typeof approvalId !== "string" || approvalId === "") return false;
  try {
    const pending = approvals.list("pending");
    return pending.some(
      (candidate) =>
        candidate.approval_id === approvalId &&
        candidate.negotiation_id === expected.negotiationId &&
        candidate.sku === expected.sku &&
        candidate.currency === expected.currency &&
        candidate.quantity === expected.quantity &&
        (expected.unit === undefined || candidate.unit === expected.unit) &&
        (candidate.buyer_offer_minor === undefined ||
          candidate.buyer_offer_minor === expected.buyerOfferMinor),
    );
  } catch {
    return false;
  }
}

/** Server-side structured SKU is immutable; a model plan for another SKU is ignored. */
function agentResultMatchesStructuredSku(
  result: ReceptionAgentResult,
  structuredSku: string,
): boolean {
  if (result.need?.sku !== undefined && result.need.sku !== structuredSku) return false;
  return result.plan.blocks.every((block) => {
    if (block.kind === "acknowledge_need") {
      return block.sku === undefined || block.sku === structuredSku;
    }
    if (block.kind === "show_commercial_terms") return block.ref.sku === structuredSku;
    if (block.kind === "recommend_option") {
      return (
        block.ref.sku === structuredSku &&
        (block.comparedRefs ?? []).every((ref) => ref.sku === structuredSku)
      );
    }
    return true;
  });
}

function truthfulHumanFallback(
  blocks: ReceptionBlock[],
  need: { sku?: string; quantity?: number },
): ReceptionBlock[] {
  if (need.sku === undefined) {
    return [{ kind: "ask_clarification", missing: ["sku"], reason: "missing_sku" }];
  }
  if (need.quantity === undefined) {
    return [{ kind: "ask_clarification", missing: ["quantity"], reason: "missing_quantity" }];
  }
  const filtered = blocks.filter((block) => block.kind !== "request_human_help");
  if (filtered.some((block) => block.kind === "ask_clarification" || block.kind === "next_step")) {
    return filtered;
  }
  return [...filtered, { kind: "next_step", action: "send_rfq" }];
}

function belowPublicBound(
  targetPrice: number | undefined,
  product: { price: number; currency: string },
  sku: string,
  policy: MerchantPolicy | undefined,
): { targetMinor: number; targetMajor: number; publicBoundMinor: number } | undefined {
  if (targetPrice === undefined) return undefined;
  const target = losslessToMinorUnits(targetPrice, 2);
  const list = losslessToMinorUnits(product.price, 2);
  if (!target.lossless || !list.lossless) return undefined;
  const bound = publicBoundMinorOf(list.amount_minor, sku, policy);
  if (target.amount_minor >= bound) return undefined;
  return { targetMinor: target.amount_minor, targetMajor: targetPrice, publicBoundMinor: bound };
}

function factsForWithSku(
  product: {
    price: number;
    currency: string;
    stock?: number;
    tax_included?: boolean;
    shipping_included?: boolean;
  },
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
    ...(product.tax_included !== undefined ? { taxIncluded: product.tax_included } : {}),
    ...(product.shipping_included !== undefined
      ? { shippingIncluded: product.shipping_included }
      : {}),
  };
}
