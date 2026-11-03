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
import type { ReceptionAgentRuntime } from "./agent-runtime.js";
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
            ...(previous !== undefined ? { previousNeed: previous.need } : {}),
            registry,
            now: input.now,
          });
          if (agentResult !== undefined) {
            // 模型选择转人工时，仍由服务端登记审批候选（模型没有写能力）。
            const human = agentResult.plan.blocks.find(
              (block): block is Extract<ReceptionBlock, { kind: "request_human_help" }> =>
                block.kind === "request_human_help",
            );
            const needSku = agentResult.need?.sku ?? previous?.need.sku;
            const needQuantity = agentResult.need?.quantity ?? previous?.need.quantity;
            if (
              human?.buyerTargetPrice !== undefined &&
              needSku !== undefined &&
              deps.productSource !== undefined &&
              deps.approvals !== undefined
            ) {
              try {
                const product = await deps.productSource.getProduct(needSku);
                const policyNow = deps.policy?.();
                const boundary = belowPublicBound(
                  human.buyerTargetPrice,
                  product,
                  needSku,
                  policyNow,
                );
                if (boundary !== undefined) {
                  const floorMinor = minorOf(privateFloorMajor(policyNow, needSku));
                  deps.approvals.recordPending({
                    negotiation_id: input.contextId,
                    sku: needSku,
                    currency: product.currency,
                    quantity: needQuantity ?? 1,
                    ...(agentResult.need?.unit !== undefined
                      ? { unit: agentResult.need.unit }
                      : {}),
                    buyer_offer_minor: boundary.targetMinor,
                    public_bound_minor: boundary.publicBoundMinor,
                    ...(floorMinor !== undefined ? { floor_minor: floorMinor } : {}),
                    ttl_seconds:
                      deps.approvalTtlSeconds ?? RECEPTION_CONFIG_DEFAULTS.approvalTtlSeconds,
                  });
                }
              } catch {
                // 事实/审批存储不可用：保留模型计划（发布器仍会校验事实引用）。
              }
            }
            const agentStated: StatedFields = {
              ...(agentResult.need?.sku !== undefined ? { sku: "model" as const } : {}),
              ...(agentResult.need?.quantity !== undefined ? { quantity: "model" as const } : {}),
              ...(agentResult.need?.unit !== undefined ? { unit: "model" as const } : {}),
            };
            return finish(
              input,
              previous,
              registry,
              agentResult.plan.blocks,
              agentResult.need,
              agentStated,
            );
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
      // 字段证据来源：协议字段 > 模型/搜索候选；只有本轮明确给出的字段才更新。
      const stated: StatedFields = {
        ...(structuredSku !== undefined ? { sku: "structured" as const } : {}),
        ...(interpreted?.quantity !== undefined ? { quantity: "model" as const } : {}),
        ...(interpreted?.unit !== undefined ? { unit: "model" as const } : {}),
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
      const quantity = interpreted?.quantity ?? previous?.need.quantity;
      const unit = interpreted?.unit ?? previous?.need.unit;

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
            { sku, quantity, unit },
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
      };

      // D15 自动发布边界：买家明确目标价低于公开折扣边界（list×(1-max(自动
      // 折扣%,促销%))，与确定性报价同口径）→ 登记审批候选并如实告知"需要
      // 商家确认"；不泄露公开边界数值与私有底价。边界内或无法精确换算时按
      // 普通事实回答（接待本身不发布 Offer，正式报价仍走 KNP fast path）。
      const boundary = belowPublicBound(interpreted?.target_price, product, sku, policy);
      if (boundary !== undefined && deps.approvals !== undefined) {
        const floorMinor = minorOf(floor);
        deps.approvals.recordPending({
          negotiation_id: input.contextId,
          sku,
          currency: product.currency,
          quantity: quantity ?? 1,
          ...(unit !== undefined ? { unit } : {}),
          buyer_offer_minor: boundary.targetMinor,
          public_bound_minor: boundary.publicBoundMinor,
          ...(floorMinor !== undefined ? { floor_minor: floorMinor } : {}),
          ttl_seconds: deps.approvalTtlSeconds ?? RECEPTION_CONFIG_DEFAULTS.approvalTtlSeconds,
        });
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
        ], { sku, quantity, unit }, stated);
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
      return finish(input, previous, registry, blocks, { sku, quantity, unit }, stated);
    },
  };

  function finish(
    input: ReceptionEngineInput,
    previous: ReceptionConversation | undefined,
    registry: InMemoryFactRegistry,
    blocks: ReceptionBlock[],
    need?: Partial<
      Pick<ReceptionNeed, "sku" | "quantity" | "unit" | "pendingSkus" | "evidence">
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
