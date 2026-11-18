/**
 * 接待 Pi 运行时（M2）：受控工具循环。
 *
 * 模型只通过四个工具工作：
 *   search_products        → 本店公开候选
 *   get_commercial_facts   → 服务端事实快照引用（价格/库存/交期）
 *   propose_need_patch     → 本轮需求增量（待服务端合并）
 *   propose_reply          → 类型化回复计划（终态）
 *
 * 红线：
 *  - 模型拿不到价格/交期字面值以外的写能力；所有金额经 fact ref 由发布器渲染；
 *  - 工具参数与模型输出都按不可信处理；schema 之外直接拒绝；
 *  - propose_reply 之后不再接受工具调用；超时/异常返回 undefined，调用方回退
 *    确定性接待路径。
 */

import { toMinorUnits } from "../../protocol/legacy-shopping-negotiation/money.js";
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type AgentToolResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";

import type { MerchantPolicy } from "../../config/profile.js";
import type { AttemptBudgetHooks } from "../server/inquiry-interpreter.js";
import {
  canonicalUnitToken,
  multiplyQuantitySafe,
  resolveUnitConversion,
  unitConversionPolicy,
} from "../unit-alias.js";
import type { ReceptionProductSource } from "./engine.js";
import { factRevision, type InMemoryFactRegistry } from "./publish.js";
import {
  DEFAULT_QUESTION_SPEC_REGISTRY,
  type QuestionSpecRegistry,
} from "./question-spec.js";
import { receptionToolContractDigest } from "./skill-contract.js";
import {
  MAX_LOADED_SKILL_CHARS,
  MAX_LOADED_SKILLS,
  skillSummaryPrompt,
  type ReceptionSkillCatalog,
} from "./skill-catalog.js";
import {
  ContextGuard,
  type ContextSnapshot,
  type CurrentSkillBinding,
} from "../../merchant-core/context-governance/context-guard.js";
import { createActorContext } from "../../merchant-core/context-governance/actor-context.js";
import type {
  CustomerMemoryToolProvider,
  CustomerRecallContext,
} from "./customer-memory-tools.js";
import {
  MEMORY_NAMESPACES,
  MEMORY_SOURCE_KINDS,
  type MemoryNamespace,
  type MemorySourceKind,
} from "../../merchant-core/customer-memory/types.js";
import type {
  ReceptionBlock,
  ReceptionNeed,
  ReceptionResponsePlan,
} from "./types.js";

export const TOOL_SEARCH_PRODUCTS = "search_products";
export const TOOL_COMPARE_PRODUCTS = "compare_products";
export const TOOL_GET_COMMERCIAL_FACTS = "get_commercial_facts";
export const TOOL_PROPOSE_NEED_PATCH = "propose_need_patch";
export const TOOL_PROPOSE_REPLY = "propose_reply";
export const TOOL_LOAD_RECEPTION_SKILL = "load_reception_skill";
export const TOOL_RECALL_CUSTOMER_CONTEXT = "recall_customer_context";
export const TOOL_SEARCH_CUSTOMER_HISTORY = "search_customer_history";
export const TOOL_PROPOSE_CUSTOMER_MEMORY = "propose_customer_memory";

const RECEPTION_TOOL_ALLOWLIST: readonly string[] = [
  TOOL_SEARCH_PRODUCTS,
  TOOL_COMPARE_PRODUCTS,
  TOOL_GET_COMMERCIAL_FACTS,
  TOOL_PROPOSE_NEED_PATCH,
  TOOL_PROPOSE_REPLY,
];

const BLOCK_KINDS = new Set([
  "acknowledge_need",
  "ask_clarification",
  "ask_registered_question",
  "show_commercial_terms",
  "recommend_option",
  "request_human_help",
  "next_step",
]);

export interface ReceptionAgentInput {
  merchantId: string;
  identity: string;
  contextId: string;
  text: string;
  /** Immutable server-side KNP structured SKU. The model may not switch it. */
  structuredSku?: string;
  previousNeed?: ReceptionNeed;
  registry: InMemoryFactRegistry;
  now: string;
}

export interface ReceptionAgentMetrics {
  steps: number;
  toolCalls: Record<string, number>;
  usage: { input: number; output: number; total: number };
  quotaRejected?: boolean;
  /** 本轮接收的技能加载结果（审计 A17–A20；只含 key/release/结果）。 */
  loadedSkills?: Array<{
    skill_key: string;
    release_id: string;
    accepted: boolean;
    reason?: string;
  }>;
}

export interface ReceptionAgentResult {
  plan: ReceptionResponsePlan;
  need?: Partial<
    Pick<
      ReceptionNeed,
      "sku" | "quantity" | "unit" | "pendingSkus" | "inputQuantity" | "inputUnit"
    >
  >;
  metrics: ReceptionAgentMetrics;
}

export interface ReceptionAgentRuntime {
  run(input: ReceptionAgentInput): Promise<ReceptionAgentResult | undefined>;
}

export interface PiReceptionRuntimeOptions {
  streamFn: StreamFn;
  model: Model<Api>;
  productSource?: ReceptionProductSource;
  policy?: () => MerchantPolicy | undefined;
  unitAliases?: Record<string, string>;
  unitPackageFactors?: Record<string, number>;
  /**
   * 商家的默认售卖单位；倍率只对以此为目标单位的商品源生效。
   * 旧调用形式不传时保留历史 factor 换算；新调用方应显式传入。
   */
  unitDefaultUnit?: string;
  maxSteps?: number;
  maxToolAttempts?: number;
  timeoutMs?: number;
  /** API key resolver for the real provider. */
  getApiKey?: () => string | undefined;
  systemPrompt?: string;
  /**
   * QuestionSpec 注册表（§7.2）：提供时把受控问题目录追加到系统提示，
   * 模型只能选择 question_id；发布器仍逐项校验。
   */
  questionRegistry?: QuestionSpecRegistry;
  /**
   * 已发布接待技能目录（M2-6）：提供时运行快照绑定当前生效版本，注入
   * skill_summaries 并开放 load_reception_skill；撤回/版本变化在发布门失效。
   */
  skillCatalog?: ReceptionSkillCatalog;
  /**
   * 客户记忆/历史工具（M3-6）：有有效绑定与 grant 时绑定运行快照并开放
   * recall/search/propose 三个工具；无绑定时不提供，只用当前会话。
   */
  customerProvider?: CustomerMemoryToolProvider;
  /** 每次模型回合的预算 lease（§18）；拒绝时本轮降级确定性路径。 */
  budget?: AttemptBudgetHooks;
  /** 工具级指标出口（node 写入本地 metrics 文件）。 */
  onMetrics?: (metrics: ReceptionAgentMetrics) => void;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a Kiwi merchant reception agent serving one buyer at a time.",
  "Reply in Simplified Chinese (zh-CN) only. One product per conversation.",
  "Use search_products when the buyer has not named a SKU.",
  "Call get_commercial_facts for the chosen SKU and quantity. Never invent a price,",
  "stock count, delivery date or any commercial fact; only the facts tool is authoritative.",
  "When the request is ambiguous or a required field is missing, ask one short",
  "clarification question. When ready, call propose_reply with typed blocks:",
  "acknowledge_need, ask_clarification, ask_registered_question (using a registered",
  "question_id from the catalog), show_commercial_terms (using the fact ref),",
  "request_human_help or next_step. You may use recommend_option with a fact ref and",
  "compared refs from compare_products; reasonCode must be lowest_public_price or in_stock.",
  "Never write free-form commercial text.",
  "Every reply block uses the field \"kind\" (never \"type\"). Required shapes:",
  "{\"kind\":\"acknowledge_need\",\"sku\":\"SKU\",\"quantity\":2,\"unit\":\"件\"},",
  "{\"kind\":\"show_commercial_terms\",\"ref\":{\"sku\":\"SKU\",\"revision\":\"sha256:...\"}},",
  "{\"kind\":\"ask_clarification\",\"missing\":[\"quantity\"],\"reason\":\"missing_quantity\"},",
  "{\"kind\":\"ask_registered_question\",\"question_id\":\"q_missing_quantity_v1\"},",
  "{\"kind\":\"next_step\",\"action\":\"send_rfq\"}.",
  "Do not add free-text fields to next_step; the publisher renders all text.",
  "History search hits mean the buyer only asked before: say 曾询价, never 购买 or 已购买;",
  "history is not a current quote. Re-read commercial facts before any price/stock claim.",
].join(" ");

function buildReceptionSystemPrompt(registry: QuestionSpecRegistry): string {
  const catalog = registry.catalogText();
  return catalog === "" ? DEFAULT_SYSTEM_PROMPT : `${DEFAULT_SYSTEM_PROMPT} ${catalog}`;
}

function toolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

const BUYER_QUANTITY_UNIT =
  "盒|件|个|只|箱|瓶|包|袋|台|套|双|张|份|piece(?:s)?|box(?:es)?|pcs?|units?";
const BUYER_CN_DIGITS: Record<string, number> = {
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
function buyerChineseNumber(raw: string): number | undefined {
  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [tensRaw, onesRaw] = raw.split("十");
    const tens = tensRaw === "" ? 1 : BUYER_CN_DIGITS[tensRaw ?? ""];
    const ones = onesRaw === "" ? 0 : BUYER_CN_DIGITS[onesRaw ?? ""];
    if (tens === undefined || ones === undefined) return undefined;
    return tens * 10 + ones;
  }
  return BUYER_CN_DIGITS[raw];
}

/**
 * Server-side buyer quantity/unit extraction. The model may not shrink a
 * requested quantity for a stock claim; compare_products/get_commercial_facts
 * only bind stock to this independently parsed value.
 */
export function parseBuyerQuantity(
  text: string,
): { quantity: number; unit: string } | undefined {
  const candidates: Array<{ quantity: number; unit: string; priceContext: boolean }> = [];
  const chinesePattern = new RegExp(
    `([一二两三四五六七八九十]+)\\s*(${BUYER_QUANTITY_UNIT})`,
    "gu",
  );
  for (const match of text.matchAll(chinesePattern)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 4), match.index ?? 0);
    const quantity = buyerChineseNumber(match[1] ?? "");
    if (quantity !== undefined && quantity > 0) {
      // Keep price-context candidates for the ambiguity check below, but do
      // not let them become the sole quantity when no other candidate exists.
      candidates.push({
        quantity,
        unit: match[2] ?? "",
        priceContext: /[\d¥￥元块]/.test(prefix),
      });
    }
  }
  const arabicPattern = new RegExp(
    `(?:^|[^\\d])(\\d+)\\s*(${BUYER_QUANTITY_UNIT})`,
    "giu",
  );
  for (const match of text.matchAll(arabicPattern)) {
    const quantity = Number(match[1]);
    if (Number.isSafeInteger(quantity) && quantity > 0) {
      candidates.push({ quantity, unit: match[2] ?? "", priceContext: false });
    }
  }
  const distinct = new Map<string, { quantity: number; unit: string; priceContext: boolean }>();
  for (const item of candidates) {
    const key = `${item.quantity}:${canonicalUnitToken(item.unit)}`;
    const existing = distinct.get(key);
    distinct.set(key, {
      quantity: item.quantity,
      unit: item.unit,
      priceContext: existing === undefined ? item.priceContext : existing.priceContext && item.priceContext,
    });
  }
  // Ambiguity is checked over ALL candidate expressions, including ones that
  // looked like price context. "原先1件要十件" must not silently bind to 1.
  if (distinct.size !== 1) return undefined;
  const only = [...distinct.values()][0]!;
  return only.priceContext ? undefined : { quantity: only.quantity, unit: only.unit };
}

function buyerUnitMatchesPolicy(
  policy: ReturnType<typeof unitConversionPolicy>,
  buyerUnit: string,
  requestedUnit: string,
): boolean {
  const buyer = canonicalUnitToken(buyerUnit);
  const requested = canonicalUnitToken(requestedUnit);
  return (
    buyer === requested ||
    policy.aliases[buyer] === requested ||
    policy.aliases[requested] === buyer
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格 schema：模型块只允许固定字段，未知字段直接拒绝（X02）。 */
function hasOnlyKeys(item: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(item).every((key) => allowed.includes(key));
}

/** 把模型提交的 blocks 限缩到白名单结构；引用仍由发布器校验。 */
export function sanitizeReceptionBlocks(
  value: unknown,
  questionRegistry: QuestionSpecRegistry = DEFAULT_QUESTION_SPEC_REGISTRY,
): ReceptionBlock[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) return undefined;
  const blocks: ReceptionBlock[] = [];
  for (const item of value) {
    if (!isObject(item)) return undefined;
    // 兼容别名：部分模型把块类型写成 `type`；规范化后仍按 `kind` 严格校验
    // 字段（不扩大允许的块种类）。
    const kind =
      typeof item.kind === "string"
        ? item.kind
        : typeof item.type === "string"
          ? item.type
          : undefined;
    if (kind === undefined || !BLOCK_KINDS.has(kind)) return undefined;
    switch (kind) {
      case "acknowledge_need": {
        if (!hasOnlyKeys(item, ["kind", "type", "sku", "quantity", "unit", "convertedFrom"])) {
          return undefined;
        }
        const sku = typeof item.sku === "string" && item.sku.trim() !== "" ? item.sku.trim() : undefined;
        const quantity =
          typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity > 0
            ? item.quantity
            : undefined;
        const unit = typeof item.unit === "string" && item.unit.trim() !== "" ? item.unit.trim() : undefined;
        blocks.push({
          kind: "acknowledge_need",
          ...(sku !== undefined ? { sku } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit !== undefined ? { unit } : {}),
        });
        break;
      }
      case "ask_clarification": {
        if (!hasOnlyKeys(item, ["kind", "type", "reason", "candidates", "missing"])) {
          return undefined;
        }
        const reason = item.reason;
        if (
          reason !== "missing_sku" &&
          reason !== "unknown_sku" &&
          reason !== "non_chinese" &&
          reason !== "empty_message" &&
          reason !== "service_busy" &&
          reason !== "multiple_skus" &&
          reason !== "product_candidates"
        ) {
          return undefined;
        }
        const candidates = Array.isArray(item.candidates)
          ? item.candidates.filter((candidate): candidate is string => typeof candidate === "string").slice(0, 8)
          : undefined;
        blocks.push({
          kind: "ask_clarification",
          missing: ["sku"],
          reason,
          ...(candidates !== undefined ? { candidates } : {}),
        });
        break;
      }
      case "ask_registered_question": {
        if (
          !hasOnlyKeys(item, [
            "kind",
            "type",
            "question_id",
            "schema_version",
            "slot",
            "reason_code",
            "candidate_refs",
          ])
        ) {
          return undefined;
        }
        const questionId =
          typeof item.question_id === "string" ? item.question_id.trim() : "";
        if (questionId.length === 0 || questionId.length > 64) return undefined;
        // 服务端按注册表补齐契约字段：模型只需选择 question_id。若显式提供了
        // schema/slot/reason，必须与注册表一致（不允许模型改写契约）。
        const spec = questionRegistry.resolve(questionId);
        if (spec === undefined) return undefined;
        const schemaVersion =
          item.schema_version === undefined ? spec.schema_version : item.schema_version;
        const slot = item.slot === undefined ? spec.slot : item.slot;
        const reasonCode =
          item.reason_code === undefined ? spec.reason_code : item.reason_code;
        if (slot !== "sku" && slot !== "quantity" && slot !== "unit") return undefined;
        if (
          typeof schemaVersion !== "number" ||
          !Number.isSafeInteger(schemaVersion) ||
          schemaVersion !== spec.schema_version ||
          slot !== spec.slot ||
          typeof reasonCode !== "string" ||
          reasonCode !== spec.reason_code
        ) {
          return undefined;
        }
        const candidateRefs = Array.isArray(item.candidate_refs)
          ? item.candidate_refs
              .filter((candidate): candidate is string => typeof candidate === "string")
              .slice(0, 8)
          : undefined;
        blocks.push({
          kind: "ask_registered_question",
          question_id: questionId,
          schema_version: schemaVersion,
          slot,
          reason_code: reasonCode,
          ...(candidateRefs !== undefined && candidateRefs.length > 0
            ? { candidate_refs: candidateRefs }
            : {}),
        });
        break;
      }
      case "show_commercial_terms": {
        if (!hasOnlyKeys(item, ["kind", "type", "ref", "topics"])) return undefined;
        const ref = item.ref;
        if (
          !isObject(ref) ||
          typeof ref.sku !== "string" ||
          typeof ref.revision !== "string"
        ) {
          return undefined;
        }
        const topics = Array.isArray(item.topics)
          ? item.topics.filter(
              (topic): topic is "price" | "stock" | "delivery" =>
                topic === "price" || topic === "stock" || topic === "delivery",
            )
          : undefined;
        blocks.push({
          kind: "show_commercial_terms",
          ref: { sku: ref.sku, revision: ref.revision },
          ...(topics !== undefined && topics.length > 0 ? { topics } : {}),
        });
        break;
      }
      case "recommend_option": {
        if (!hasOnlyKeys(item, ["kind", "type", "ref", "comparedRefs", "reasonCode"])) {
          return undefined;
        }
        const ref = item.ref;
        if (!isObject(ref) || typeof ref.sku !== "string" || typeof ref.revision !== "string") {
          return undefined;
        }
        const comparedRefs = Array.isArray(item.comparedRefs)
          ? item.comparedRefs
              .filter(
                (candidate): candidate is { sku: string; revision: string } =>
                  isObject(candidate) &&
                  typeof candidate.sku === "string" &&
                  typeof candidate.revision === "string",
              )
              .slice(0, 3)
          : undefined;
        const reasonCode = item.reasonCode;
        if (reasonCode !== "lowest_public_price" && reasonCode !== "in_stock") {
          return undefined;
        }
        blocks.push({
          kind: "recommend_option",
          ref: { sku: ref.sku, revision: ref.revision },
          ...(comparedRefs !== undefined && comparedRefs.length > 0 ? { comparedRefs } : {}),
          reasonCode,
        });
        break;
      }
      case "request_human_help": {
        if (
          !hasOnlyKeys(item, ["kind", "type", "topic", "buyerTargetPrice", "currency"]) ||
          item.topic !== "price_below_public_bound"
        ) {
          return undefined;
        }
        const buyerTargetPrice =
          typeof item.buyerTargetPrice === "number" && Number.isFinite(item.buyerTargetPrice)
            ? item.buyerTargetPrice
            : undefined;
        const currency = typeof item.currency === "string" ? item.currency : undefined;
        blocks.push({
          kind: "request_human_help",
          topic: "price_below_public_bound",
          ...(buyerTargetPrice !== undefined ? { buyerTargetPrice } : {}),
          ...(currency !== undefined ? { currency } : {}),
        });
        break;
      }
      case "next_step": {
        if (!hasOnlyKeys(item, ["kind", "type", "action"]) || item.action !== "send_rfq") {
          return undefined;
        }
        blocks.push({ kind: "next_step", action: "send_rfq" });
        break;
      }
    }
  }
  return blocks;
}

function policyFloorMinor(
  policy: MerchantPolicy | undefined,
  sku: string,
): number | undefined {
  const floor = policy?.price_floors?.[sku] ?? policy?.min_unit_price_private;
  if (typeof floor !== "number" || !Number.isFinite(floor)) return undefined;
  // 审查 P3：与 lossless 纪律一致，展示门控用十分位取整会差 1 分（如 2.675）。
  return Math.floor(floor * 100 + 1e-9);
}

function deliveryBefore(policy: MerchantPolicy | undefined, now: string): string | undefined {
  const days = policy?.delivery_lead_days;
  if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
  const base = Date.parse(now);
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + days * 86_400_000).toISOString();
}

export function createPiReceptionRuntime(
  options: PiReceptionRuntimeOptions,
): ReceptionAgentRuntime {
  const unitPolicy = unitConversionPolicy({
    aliases: options.unitAliases,
    packageFactors: options.unitPackageFactors,
    ...(options.unitDefaultUnit !== undefined ? { defaultUnit: options.unitDefaultUnit } : {}),
  });
  return {
    async run(input) {
      const policy = options.policy?.();
      let plan: ReceptionResponsePlan | undefined;
      let needPatch: Partial<
        Pick<
          ReceptionNeed,
          "sku" | "quantity" | "unit" | "pendingSkus" | "inputQuantity" | "inputUnit"
        >
      > = {};
      interface FactUnitState {
        inputQuantity?: number;
        inputUnit?: string;
        quantity?: number;
        unit?: string;
        factor?: number;
      }
      const factUnits = new Map<string, FactUnitState>();
      const rejectedFactUnits = new Map<string, { inputQuantity?: number; inputUnit?: string }>();
      const buyerQuantity = parseBuyerQuantity(input.text);
      const boundSku = input.structuredSku?.trim() || undefined;
      // M2-6/M3-6：技能目录 + 客户绑定/运行快照/四检查点守卫。
      const skillCatalog = options.skillCatalog;
      const skillBindings = skillCatalog?.activeBindings(input.merchantId) ?? [];
      const skillSummaries = skillCatalog?.summaries(input.merchantId);
      const skillSummaryText =
        skillSummaries !== undefined ? skillSummaryPrompt(skillSummaries) : "";
      const customerContext: CustomerRecallContext | undefined =
        options.customerProvider?.contextFor(input.merchantId, input.identity);
      const guardEnabled = skillCatalog !== undefined || customerContext !== undefined;
      let receptionGuard: ContextGuard | undefined;
      let receptionSnapshot: ContextSnapshot | undefined;
      const receptionActor = !guardEnabled
        ? undefined
        : createActorContext({
            merchant_id: input.merchantId,
            actor_id: `reception:${input.identity}`.slice(0, 128),
            auth_strength: "session",
            subject_binding: customerContext !== undefined ? "organization" : "none",
            capabilities:
              customerContext !== undefined
                ? ["reception:serve", "customer:self", "memory:read"]
                : ["reception:serve"],
          });
      if (guardEnabled && receptionActor !== undefined) {
        const configVersion = receptionToolContractDigest();
        receptionSnapshot = {
          snapshot_id: `run_${input.contextId}`.slice(0, 128),
          issued_at: input.now,
          binding_epoch: customerContext?.binding_epoch ?? 0,
          grant_versions: customerContext?.grant_versions ?? {},
          data_scope_epochs: customerContext?.data_scope_epochs ?? {},
          memory_set_version: customerContext?.memory_set_version ?? 0,
          conversation_revision: 0,
          config_version: configVersion,
          skill_bindings: skillBindings.map((binding) => ({
            skill_key: binding.skill_key,
            release_id: binding.release_id,
            compiled_artifact_hash: binding.compiled_artifact_hash,
            generation: binding.generation,
            revocation_epoch: binding.revocation_epoch,
          })),
        };
        const authority = {
          currentGrantEpoch: (merchantId: string, grantId: string): number | undefined =>
            options.customerProvider?.currentGrantEpoch(merchantId, grantId),
          currentBindingEpoch: (merchantId: string): number | undefined =>
            options.customerProvider?.currentBindingEpoch(merchantId, input.identity),
          currentDataScopeEpoch: (merchantId: string, scopeKey: string): number | undefined =>
            options.customerProvider?.currentDataScopeEpoch(merchantId, scopeKey),
          currentSkillBinding: (merchantId: string, skillKey: string): CurrentSkillBinding | undefined =>
            skillCatalog?.currentBinding(merchantId, skillKey),
          currentMemorySetVersion: (merchantId: string): number | undefined =>
            customerContext === undefined
              ? undefined
              : options.customerProvider?.currentMemorySetVersion(
                  merchantId,
                  customerContext.subject_id,
                ),
          currentConversationRevision: (): number | undefined => undefined,
          currentConfigVersion: (): string | undefined => configVersion,
          sourceAvailable: (): boolean => false,
        };
        receptionGuard = new ContextGuard({ authority, now: () => input.now });
      }
      const checkGuard = (
        checkpoint: "tool_call" | "provider_attempt" | "publish",
        tool?: string,
      ): void => {
        if (
          receptionGuard === undefined ||
          receptionActor === undefined ||
          receptionSnapshot === undefined
        ) {
          return;
        }
        const base = {
          actor: receptionActor,
          snapshot: receptionSnapshot,
          capability: "reception:serve" as const,
        };
        if (checkpoint === "tool_call") {
          receptionGuard.checkToolCall({ ...base, ...(tool !== undefined ? { tool } : {}) });
        } else if (checkpoint === "provider_attempt") {
          receptionGuard.checkProviderAttempt(base);
        } else {
          receptionGuard.checkPublish(base);
        }
      };
      const canProposeMemory = customerContext !== undefined && options.customerProvider !== undefined && (options.customerProvider.canPropose?.(customerContext) ?? true);
      const allowedTools: readonly string[] = [
        ...RECEPTION_TOOL_ALLOWLIST,
        ...(skillCatalog !== undefined && skillBindings.length > 0
          ? [TOOL_LOAD_RECEPTION_SKILL]
          : []),
        ...(customerContext !== undefined
          ? [
              TOOL_RECALL_CUSTOMER_CONTEXT,
              TOOL_SEARCH_CUSTOMER_HISTORY,
              ...(canProposeMemory ? [TOOL_PROPOSE_CUSTOMER_MEMORY] : []),
            ]
          : []),
      ];
      let loadedSkillCount = 0;
      let loadedSkillChars = 0;
      const loadedSkills: NonNullable<ReceptionAgentMetrics["loadedSkills"]> = [];
      let steps = 0;
      let toolAttempts = 0;
      let timedOut = false;

      const guard = async (
        context: BeforeToolCallContext,
      ): Promise<BeforeToolCallResult | undefined> => {
        if (!allowedTools.includes(context.toolCall.name)) {
          return { block: true, reason: "tool_not_allowed" };
        }
        // 每次工具调用前检查权限/技能绑定/版本；异常向引擎抛出 → 回退确定性。
        checkGuard("tool_call", context.toolCall.name);
        if (plan !== undefined) {
          return { block: true, reason: "reply_already_proposed" };
        }
        toolAttempts += 1;
        if (toolAttempts > (options.maxToolAttempts ?? 12)) {
          return { block: true, reason: "tool_budget_exhausted" };
        }
        const serialized = JSON.stringify(context.toolCall.arguments ?? {});
        if (serialized.length > 8_000) {
          return { block: true, reason: "arguments_too_large" };
        }
        return undefined;
      };

      const tools: AgentTool<TSchema, unknown>[] = [
        {
          name: TOOL_SEARCH_PRODUCTS,
          label: "Search products",
          description: "Search this merchant's public products by the buyer's words.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            const query = isObject(args) && typeof args.query === "string" ? args.query : "";
            if (options.productSource?.searchProducts === undefined) {
              return toolResult(JSON.stringify({ candidates: [], note: "search_not_configured" }));
            }
            const candidates = await options.productSource.searchProducts(query).catch(() => []);
            const visible =
              boundSku === undefined
                ? candidates
                : candidates.filter((candidate) => candidate.sku === boundSku);
            return toolResult(
              JSON.stringify({
                candidates: visible.slice(0, 5).map((candidate) => ({
                  sku: candidate.sku,
                  ...(candidate.title !== undefined ? { title: candidate.title } : {}),
                  price: candidate.price,
                  currency: candidate.currency,
                  ...(candidate.stock !== undefined ? { stock: candidate.stock } : {}),
                })),
              }),
            );
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_COMPARE_PRODUCTS,
          label: "Compare products",
          description:
            "Read public price, stock and delivery facts for up to three SKUs so you can compare them.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              skus: { type: "array" },
              quantity: { type: "integer", minimum: 1 },
              unit: { type: "string" },
            },
            required: ["skus"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            const rawSkus =
              isObject(args) && Array.isArray(args.skus) ? args.skus : [];
            const skus = rawSkus
              .filter((sku): sku is string => typeof sku === "string")
              .map((sku) => sku.trim())
              .filter((sku) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sku))
              .slice(0, 3);
            if (boundSku !== undefined && skus.some((sku) => sku !== boundSku)) {
              return toolResult(
                JSON.stringify({ products: [], error: "sku_mismatch", bound_sku: boundSku }),
              );
            }
            if (skus.length === 0 || options.productSource === undefined) {
              return toolResult(JSON.stringify({ products: [] }));
            }
            const requestedQuantity =
              isObject(args) &&
              typeof args.quantity === "number" &&
              Number.isSafeInteger(args.quantity) &&
              args.quantity > 0
                ? args.quantity
                : undefined;
            const requestedUnit =
              isObject(args) && typeof args.unit === "string" && args.unit.trim() !== ""
                ? args.unit.trim()
                : undefined;
            const products = [];
            for (const sku of skus) {
              try {
                const product = await options.productSource.getProduct(sku);
                if (product.valid_until !== undefined) {
                  const until = Date.parse(product.valid_until);
                  if (!Number.isFinite(until) || until <= Date.parse(input.now)) {
                    products.push({ sku, error: "facts_stale" });
                    continue;
                  }
                }
                const floorMinor = policyFloorMinor(policy, sku);
                const listMinor = toMinorUnits(product.price, 2);
                const listPrice =
                  floorMinor !== undefined &&
                  (!listMinor.lossless || listMinor.amount_minor < floorMinor)
                    ? undefined
                    : product.price;
                let unit = product.unit;
                let stockQuantity = requestedQuantity;
                if (product.unit !== undefined && requestedUnit !== undefined) {
                  const resolution = resolveUnitConversion(unitPolicy, product.unit, requestedUnit);
                  if (resolution.kind === "factor") {
                    stockQuantity =
                      requestedQuantity === undefined
                        ? undefined
                        : multiplyQuantitySafe(requestedQuantity, resolution.factor);
                    unit = product.unit;
                  } else if (resolution.kind === "identity" || resolution.kind === "alias") {
                    unit = product.unit;
                  } else {
                    products.push({ sku, error: "unit_mismatch", supported_unit: product.unit });
                    continue;
                  }
                }
                const buyerBound =
                  requestedQuantity !== undefined &&
                  requestedUnit !== undefined &&
                  buyerQuantity !== undefined &&
                  buyerQuantity.quantity === requestedQuantity &&
                  buyerUnitMatchesPolicy(unitPolicy, buyerQuantity.unit, requestedUnit);
                const stockAvailable =
                  buyerBound &&
                  product.stock !== undefined &&
                  product.unit !== undefined &&
                  stockQuantity !== undefined
                    ? product.stock >= stockQuantity
                    : undefined;
                const delivery = deliveryBefore(policy, input.now);
                const facts = {
                  ...(listPrice !== undefined
                    ? { listPrice, currency: product.currency }
                    : {}),
                  ...(unit !== undefined ? { unit } : {}),
                  ...(stockAvailable !== undefined ? { stockAvailable } : {}),
                  ...(delivery !== undefined ? { deliveryBefore: delivery } : {}),
                  ...(product.tax_included !== undefined
                    ? { taxIncluded: product.tax_included }
                    : {}),
                  ...(product.shipping_included !== undefined
                    ? { shippingIncluded: product.shipping_included }
                    : {}),
                };
                const base = {
                  merchantId: input.merchantId,
                  sku,
                  visibility: "public" as const,
                  issuedAt: input.now,
                  ...(product.valid_until !== undefined ? { expiresAt: product.valid_until } : {}),
                  facts,
                };
                const ref = input.registry.register({
                  ...base,
                  revision: factRevision(base),
                });
                products.push({
                  sku,
                  ref,
                  ...(listPrice !== undefined
                    ? { listPrice, currency: product.currency }
                    : {}),
                  ...(product.stock !== undefined ? { stock: product.stock } : {}),
                  ...(product.unit !== undefined ? { unit: product.unit } : {}),
                });
              } catch {
                products.push({ sku, error: "unknown_sku" });
              }
            }
            return toolResult(JSON.stringify({ products }));
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_GET_COMMERCIAL_FACTS,
          label: "Get commercial facts",
          description:
            "Read the authoritative price, stock and delivery facts for one SKU and quantity.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              sku: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              unit: { type: "string" },
            },
            required: ["sku"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            const requestedSku =
              isObject(args) && typeof args.sku === "string" ? args.sku.trim() : "";
            if (boundSku !== undefined && requestedSku !== "" && requestedSku !== boundSku) {
              return toolResult(JSON.stringify({ error: "sku_mismatch", bound_sku: boundSku }));
            }
            const sku = boundSku ?? requestedSku;
            const quantity =
              isObject(args) &&
              typeof args.quantity === "number" &&
              Number.isSafeInteger(args.quantity) &&
              args.quantity > 0
                ? args.quantity
                : undefined;
            const requestedUnit =
              isObject(args) && typeof args.unit === "string" && args.unit.trim() !== ""
                ? args.unit.trim()
                : undefined;
            if (sku === "" || options.productSource === undefined) {
              return toolResult(JSON.stringify({ error: "unknown_sku" }));
            }
            let product;
            try {
              product = await options.productSource.getProduct(sku);
            } catch {
              return toolResult(JSON.stringify({ error: "unknown_sku" }));
            }
            // AC13：过期事实不得进入回复或审批。
            if (product.valid_until !== undefined) {
              const until = Date.parse(product.valid_until);
              if (!Number.isFinite(until) || until <= Date.parse(input.now)) {
                return toolResult(JSON.stringify({ error: "facts_stale" }));
              }
            }
            // AC06：商品源单位与请求同义时始终 1:1；包装倍率只对 default_unit
            // 目标生效，其他情况或别名冲突一律安全拒绝，不猜倍率。
            // Unit facts are source-unit provenance: a model-supplied spelling
            // is not merchant/source evidence when the product has no unit.
            let unit = product.unit;
            let effectiveQuantity = quantity;
            let factFactor: number | undefined;
            if (product.unit !== undefined && requestedUnit !== undefined) {
              const resolution = resolveUnitConversion(unitPolicy, product.unit, requestedUnit);
              if (resolution.kind === "factor") {
                if (quantity === undefined) {
                  rejectedFactUnits.set(sku, { inputUnit: requestedUnit });
                  return toolResult(JSON.stringify({ error: "missing_quantity" }));
                }
                const convertedQuantity = multiplyQuantitySafe(quantity, resolution.factor);
                if (convertedQuantity === undefined) {
                  rejectedFactUnits.set(sku, { inputQuantity: quantity, inputUnit: requestedUnit });
                  return toolResult(JSON.stringify({ error: "quantity_overflow" }));
                }
                effectiveQuantity = convertedQuantity;
                unit = product.unit;
                factFactor = resolution.factor;
              } else if (resolution.kind === "identity" || resolution.kind === "alias") {
                unit = product.unit;
              } else {
                rejectedFactUnits.set(sku, { inputQuantity: quantity, inputUnit: requestedUnit });
                return toolResult(
                  JSON.stringify({
                    error: "unit_mismatch",
                    supported_unit: product.unit,
                  }),
                );
              }
            }
            if (factFactor !== undefined && effectiveQuantity !== undefined && unit !== undefined &&
                quantity !== undefined && requestedUnit !== undefined) {
              factUnits.set(sku, {
                inputQuantity: quantity,
                inputUnit: requestedUnit,
                quantity: effectiveQuantity,
                unit,
                factor: factFactor,
              });
              rejectedFactUnits.delete(sku);
            } else if (effectiveQuantity !== undefined || unit !== undefined) {
              factUnits.set(sku, {
                ...(effectiveQuantity !== undefined ? { quantity: effectiveQuantity } : {}),
                ...(unit !== undefined ? { unit } : {}),
              });
              rejectedFactUnits.delete(sku);
            }
            const floorMinor = policyFloorMinor(policy, sku);
            const listMinor = toMinorUnits(product.price, 2);
            const listPrice =
              floorMinor !== undefined &&
              (!listMinor.lossless || listMinor.amount_minor < floorMinor)
                ? undefined
                : product.price;
            const stockBound =
              quantity !== undefined &&
              requestedUnit !== undefined &&
              buyerQuantity !== undefined &&
              buyerQuantity.quantity === quantity &&
              buyerUnitMatchesPolicy(unitPolicy, buyerQuantity.unit, requestedUnit);
            const stockAvailable =
              stockBound &&
              product.stock !== undefined &&
              product.unit !== undefined &&
              effectiveQuantity !== undefined
                ? product.stock >= effectiveQuantity
                : undefined;
            const delivery = deliveryBefore(policy, input.now);
            const facts = {
              ...(listPrice !== undefined
                ? { listPrice, currency: product.currency }
                : {}),
              ...(unit !== undefined ? { unit } : {}),
              ...(stockAvailable !== undefined ? { stockAvailable } : {}),
              ...(delivery !== undefined ? { deliveryBefore: delivery } : {}),
              ...(product.tax_included !== undefined
                ? { taxIncluded: product.tax_included }
                : {}),
              ...(product.shipping_included !== undefined
                ? { shippingIncluded: product.shipping_included }
                : {}),
            };
            const base = {
              merchantId: input.merchantId,
              sku,
              visibility: "public" as const,
              issuedAt: input.now,
              facts,
            };
            const ref = input.registry.register({
              ...base,
              revision: factRevision(base),
            });
            return toolResult(
              JSON.stringify({
                ref,
                facts,
                ...(unit !== undefined ? { unit } : product.unit !== undefined ? { unit: product.unit } : {}),
                ...(effectiveQuantity !== undefined ? { quantity: effectiveQuantity } : {}),
                note: "Only these facts may appear in show_commercial_terms.",
              }),
            );
          },
        } as AgentTool<TSchema, unknown>,
        {
          name: TOOL_PROPOSE_NEED_PATCH,
          label: "Propose need patch",
          description: "Record the product, quantity and unit the buyer has confirmed so far.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              sku: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              unit: { type: "string" },
            },
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            if (!isObject(args)) return toolResult(JSON.stringify({ error: "invalid_patch" }));
            const sku = typeof args.sku === "string" && args.sku.trim() !== "" ? args.sku.trim() : undefined;
            const quantity =
              typeof args.quantity === "number" &&
              Number.isSafeInteger(args.quantity) &&
              args.quantity > 0
                ? args.quantity
                : undefined;
            const unit = typeof args.unit === "string" && args.unit.trim() !== "" ? args.unit.trim() : undefined;
            if (boundSku !== undefined && sku !== undefined && sku !== boundSku) {
              return toolResult(JSON.stringify({ error: "sku_mismatch", bound_sku: boundSku }));
            }
            const effectiveSku = boundSku ?? sku ?? needPatch.sku;
            const rejected = effectiveSku !== undefined ? rejectedFactUnits.get(effectiveSku) : undefined;
            if (rejected !== undefined) {
              return toolResult(JSON.stringify({ error: "need_patch_conflict" }));
            }
            const conversion = effectiveSku !== undefined ? factUnits.get(effectiveSku) : undefined;
            if (conversion?.factor !== undefined) {
              const inputMatches =
                quantity === conversion.inputQuantity &&
                unit !== undefined &&
                conversion.inputUnit !== undefined &&
                canonicalUnitToken(unit) === canonicalUnitToken(conversion.inputUnit);
              const effectiveMatches =
                quantity === conversion.quantity &&
                unit !== undefined &&
                conversion.unit !== undefined &&
                canonicalUnitToken(unit) === canonicalUnitToken(conversion.unit);
              const omitted = quantity === undefined && unit === undefined;
              if (!omitted && !inputMatches && !effectiveMatches) {
                return toolResult(JSON.stringify({ error: "need_patch_conflict" }));
              }
              if (
                conversion.quantity === undefined ||
                conversion.unit === undefined ||
                conversion.inputQuantity === undefined ||
                conversion.inputUnit === undefined
              ) {
                return toolResult(JSON.stringify({ error: "need_patch_conflict" }));
              }
              needPatch = {
                ...needPatch,
                sku: effectiveSku,
                quantity: conversion.quantity,
                unit: conversion.unit,
                inputQuantity: conversion.inputQuantity,
                inputUnit: conversion.inputUnit,
              };
              return toolResult(JSON.stringify({ accepted: true }));
            }
            needPatch = {
              ...needPatch,
              ...(effectiveSku !== undefined ? { sku: effectiveSku } : {}),
              ...(quantity !== undefined ? { quantity } : {}),
              ...(unit !== undefined ? { unit } : {}),
            };
            return toolResult(JSON.stringify({ accepted: true }));
          },
        } as AgentTool<TSchema, unknown>,
        ...(skillCatalog !== undefined && skillBindings.length > 0
          ? [
              {
                name: TOOL_LOAD_RECEPTION_SKILL,
                label: "Load reception skill",
                description:
                  "Load one published reception skill by skill_key from this run's summaries.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { skill_key: { type: "string" } },
                  required: ["skill_key"],
                },
                execute: async (_id: unknown, params: unknown): Promise<AgentToolResult<unknown>> => {
                  const args: unknown = params;
                  const skillKey =
                    isObject(args) && typeof args.skill_key === "string"
                      ? args.skill_key.trim()
                      : "";
                  const binding = skillBindings.find((item) => item.skill_key === skillKey);
                  if (binding === undefined) {
                    loadedSkills.push({
                      skill_key: skillKey,
                      release_id: "",
                      accepted: false,
                      reason: "skill_not_bound",
                    });
                    return toolResult(
                      JSON.stringify({ accepted: false, error: "skill_not_bound" }),
                    );
                  }
                  if (loadedSkillCount >= MAX_LOADED_SKILLS) {
                    loadedSkills.push({
                      skill_key: skillKey,
                      release_id: binding.release_id,
                      accepted: false,
                      reason: "max_skills",
                    });
                    return toolResult(
                      JSON.stringify({
                        accepted: false,
                        error: "skill_limit_exceeded",
                        reason: "max_skills",
                      }),
                    );
                  }
                  const artifact = skillCatalog.loadArtifact(
                    input.merchantId,
                    skillKey,
                    binding.release_id,
                  );
                  if (artifact === undefined) {
                    loadedSkills.push({
                      skill_key: skillKey,
                      release_id: binding.release_id,
                      accepted: false,
                      reason: "skill_unavailable",
                    });
                    return toolResult(
                      JSON.stringify({ accepted: false, error: "skill_unavailable" }),
                    );
                  }
                  if (
                    loadedSkillChars + artifact.body_text.length >
                    MAX_LOADED_SKILL_CHARS
                  ) {
                    loadedSkills.push({
                      skill_key: skillKey,
                      release_id: binding.release_id,
                      accepted: false,
                      reason: "body_budget",
                    });
                    return toolResult(
                      JSON.stringify({
                        accepted: false,
                        error: "skill_limit_exceeded",
                        reason: "body_budget",
                      }),
                    );
                  }
                  loadedSkillCount += 1;
                  loadedSkillChars += artifact.body_text.length;
                  loadedSkills.push({
                    skill_key: artifact.skill_key,
                    release_id: artifact.release_id,
                    accepted: true,
                  });
                  return toolResult(
                    JSON.stringify({
                      accepted: true,
                      skill_key: artifact.skill_key,
                      release_id: artifact.release_id,
                      compiled_artifact_hash: artifact.compiled_artifact_hash,
                      question_schema_version: artifact.question_schema_version,
                      required_tools: artifact.required_tools,
                      steps: artifact.steps,
                      body_text: artifact.body_text,
                    }),
                  );
                },
              } as AgentTool<TSchema, unknown>,
            ]
          : []),
        ...(customerContext !== undefined && options.customerProvider !== undefined
          ? [
              {
                name: TOOL_RECALL_CUSTOMER_CONTEXT,
                label: "Recall customer context",
                description:
                  "Read this bound subject's active memory items (minimum fields only).",
                parameters: { type: "object", additionalProperties: false, properties: {} },
                execute: async (): Promise<AgentToolResult<unknown>> => {
                  const items = options.customerProvider!.recall(customerContext);
                  return toolResult(JSON.stringify({ status: "ok", items }));
                },
              } as AgentTool<TSchema, unknown>,
              {
                name: TOOL_SEARCH_CUSTOMER_HISTORY,
                label: "Search customer history",
                description:
                  "Search this bound subject's authorized history; at most 5 snippets.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    query: { type: "string" },
                    cursor: { type: "string" },
                  },
                  required: ["query"],
                },
                execute: async (_id: unknown, params: unknown): Promise<AgentToolResult<unknown>> => {
                  const args: unknown = params;
                  if (!isObject(args) || typeof args.query !== "string") {
                    return toolResult(JSON.stringify({ status: "unavailable", reason: "invalid_query" }));
                  }
                  const cursor =
                    typeof args.cursor === "string" && args.cursor.trim() !== ""
                      ? args.cursor.trim()
                      : undefined;
                  const result = options.customerProvider!.search(customerContext, {
                    query: args.query,
                    ...(cursor !== undefined ? { cursor } : {}),
                  });
                  return toolResult(JSON.stringify(result));
                },
              } as AgentTool<TSchema, unknown>,
            ]
          : []),
        ...(canProposeMemory && customerContext !== undefined && options.customerProvider !== undefined
          ? [
              {
                name: TOOL_PROPOSE_CUSTOMER_MEMORY,
                label: "Propose customer memory",
                description:
                  "Propose a customer memory candidate. It stays candidate until the customer confirms.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    namespace: { type: "string" },
                    key: { type: "string" },
                    value_ref: { type: "string" },
                    value_type: { type: "string" },
                    source_kind: { type: "string" },
                    confidence: { type: "number" },
                  },
                  required: ["namespace", "key", "value_ref", "value_type", "source_kind"],
                },
                execute: async (_id: unknown, params: unknown): Promise<AgentToolResult<unknown>> => {
                  const args: unknown = params;
                  if (
                    !isObject(args) ||
                    typeof args.namespace !== "string" ||
                    !(MEMORY_NAMESPACES as readonly string[]).includes(args.namespace) ||
                    typeof args.key !== "string" ||
                    typeof args.value_ref !== "string" ||
                    typeof args.value_type !== "string" ||
                    typeof args.source_kind !== "string" ||
                    !(MEMORY_SOURCE_KINDS as readonly string[]).includes(args.source_kind)
                  ) {
                    return toolResult(JSON.stringify({ accepted: false, error: "invalid_memory" }));
                  }
                  try {
                    const proposal = await options.customerProvider!.propose(customerContext, {
                      namespace: args.namespace as MemoryNamespace,
                      key: args.key,
                      value_ref: args.value_ref,
                      value_type: args.value_type,
                      source_kind: args.source_kind as MemorySourceKind,
                      ...(typeof args.confidence === "number"
                        ? { confidence: args.confidence }
                        : {}),
                    });
                    return toolResult(
                      JSON.stringify({ accepted: true, ...proposal }),
                    );
                  } catch {
                    return toolResult(
                      JSON.stringify({ accepted: false, error: "proposal_rejected" }),
                    );
                  }
                },
              } as AgentTool<TSchema, unknown>,
            ]
          : []),
        {
          name: TOOL_PROPOSE_REPLY,
          label: "Propose reply",
          description: "Submit the final typed response plan. Ends the turn.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              blocks: { type: "array" },
            },
            required: ["blocks"],
          },
          execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
            const args: unknown = params;
            if (!isObject(args)) return toolResult(JSON.stringify({ accepted: false, error: "invalid_plan" }));
            const blocks = sanitizeReceptionBlocks(
              args.blocks,
              options.questionRegistry ?? DEFAULT_QUESTION_SPEC_REGISTRY,
            );
            if (blocks === undefined) {
              // 诊断开关：记录模型原始 blocks（不含买家原文/密钥），便于定位
              // 输出契约漂移；默认关闭，不改变生产日志。
              if (process.env.KIWI_RECEPTION_DEBUG_PROPOSE === "1") {
                process.stderr.write(
                  `[reception] invalid_blocks ${JSON.stringify(args.blocks).slice(0, 3000)}\n`,
                );
              }
              return toolResult(JSON.stringify({ accepted: false, error: "invalid_blocks" }));
            }
            if (boundSku !== undefined) {
              const wrong = blocks.some((block) => {
                if (block.kind === "acknowledge_need") {
                  return block.sku !== undefined && block.sku !== boundSku;
                }
                if (block.kind === "show_commercial_terms") return block.ref.sku !== boundSku;
                if (block.kind === "recommend_option") {
                  return (
                    block.ref.sku !== boundSku ||
                    (block.comparedRefs ?? []).some((ref) => ref.sku !== boundSku)
                  );
                }
                return false;
              });
              if (wrong) {
                return toolResult(
                  JSON.stringify({ accepted: false, error: "sku_mismatch", bound_sku: boundSku }),
                );
              }
            }
            const normalizedBlocks = blocks.map((block) => {
              if (
                block.kind !== "acknowledge_need" ||
                needPatch.sku === undefined ||
                (block.sku !== undefined && block.sku !== needPatch.sku)
              ) {
                return block;
              }
              const conversion = factUnits.get(needPatch.sku);
              return {
                ...block,
                sku: needPatch.sku,
                ...(needPatch.quantity !== undefined ? { quantity: needPatch.quantity } : {}),
                ...(needPatch.unit !== undefined ? { unit: needPatch.unit } : {}),
                ...(conversion?.factor !== undefined &&
                needPatch.inputQuantity !== undefined &&
                needPatch.inputUnit !== undefined
                  ? {
                      convertedFrom: {
                        quantity: needPatch.inputQuantity,
                        unit: needPatch.inputUnit,
                        factor: conversion.factor,
                      },
                    }
                  : {}),
              };
            });
            plan = { locale: "zh-CN", blocks: normalizedBlocks };
            return toolResult(JSON.stringify({ accepted: true }));
          },
        } as AgentTool<TSchema, unknown>,
      ];

      const baseSystemPrompt =
        options.systemPrompt ??
        buildReceptionSystemPrompt(
          options.questionRegistry ?? DEFAULT_QUESTION_SPEC_REGISTRY,
        );
      const customerPrompt =
        customerContext !== undefined
          ? "Customer memory/history tools are bound to the current subject; never expose other subjects or infer identity."
          : "";
      const systemPrompt = [baseSystemPrompt, skillSummaryText, customerPrompt]
        .filter((part) => part.trim() !== "")
        .join("\n\n");
      const guardedStreamFn: typeof options.streamFn =
        skillCatalog === undefined
          ? options.streamFn
          : ((...args: Parameters<typeof options.streamFn>) => {
              checkGuard("provider_attempt");
              return options.streamFn(...args);
            }) as typeof options.streamFn;
      const agent = new Agent({
        streamFn: guardedStreamFn,
        initialState: {
          systemPrompt,
          model: options.model,
          tools,
        },
        convertToLlm: (messages) => messages as Message[],
        toolExecution: "sequential",
        beforeToolCall: guard,
        ...(options.getApiKey !== undefined ? { getApiKey: options.getApiKey } : {}),
      });

      const maxSteps = options.maxSteps ?? 6;
      const metrics: ReceptionAgentMetrics = {
        steps: 0,
        toolCalls: {},
        usage: { input: 0, output: 0, total: 0 },
        loadedSkills,
      };
      let activeLease: string | undefined;
      let lastSettledOutput = 0;
      let quotaRejected = false;

      agent.subscribe((event: AgentEvent) => {
        if (event.type === "turn_start") {
          if (options.budget !== undefined) {
            const begin = options.budget.begin();
            if ("rejected" in begin) {
              quotaRejected = true;
              options.budget.onRejected(begin.rejected);
              agent.abort();
              return undefined;
            }
            activeLease = begin.leaseId;
          }
          return undefined;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = event.message.usage;
          metrics.usage.input += usage.input;
          metrics.usage.output += usage.output;
          metrics.usage.total += usage.totalTokens;
          return undefined;
        }
        if (event.type === "tool_execution_start") {
          metrics.toolCalls[event.toolName] = (metrics.toolCalls[event.toolName] ?? 0) + 1;
          return undefined;
        }
        if (event.type === "turn_end") {
          steps += 1;
          metrics.steps = steps;
          if (activeLease !== undefined && options.budget !== undefined) {
            const delta = Math.max(0, metrics.usage.output - lastSettledOutput);
            options.budget.settle(activeLease, delta);
            lastSettledOutput = metrics.usage.output;
            activeLease = undefined;
          }
          if (steps >= maxSteps) {
            timedOut = true;
            agent.abort();
          }
        }
        return undefined;
      });

      const timer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, options.timeoutMs ?? 30_000);
      try {
        await agent.prompt(JSON.stringify({
          buyer_message: input.text,
          previous_need: input.previousNeed ?? {},
          locale: "zh-CN",
        }));
        await agent.waitForIdle();
      } catch {
        // 回退确定性路径；未结算的预算 lease 在 finally 按未知用量保留。
      } finally {
        clearTimeout(timer);
        if (activeLease !== undefined && options.budget !== undefined) {
          options.budget.settle(activeLease, undefined);
          activeLease = undefined;
        }
      }

      if (quotaRejected) metrics.quotaRejected = true;
      options.onMetrics?.(metrics);
      if (plan === undefined || timedOut || quotaRejected) return undefined;
      // 发布前最后一次版本/撤回检查；失败抛出 → 引擎丢弃模型计划并回退确定性。
      checkGuard("publish");
      return {
        plan,
        ...(Object.keys(needPatch).length > 0 ? { need: needPatch } : {}),
        metrics,
      };
    },
  };
}
