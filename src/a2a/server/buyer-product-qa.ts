/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import { PUBLIC_PRODUCT_FIELDS, type PublicProductField, type PublicProductFacts, type ReadPublicProductFacts } from "../../commerce/data-source.js";

export interface BuyerProductQa {
  merchantId: string;
  read: ReadPublicProductFacts;
  /** 仅供可信的本地宿主注入；运行时不自动接任何网络供应商。输入是不可信问题数据。 */
  classifyLocal?: (questions: readonly { index: number; text: string }[], signal: AbortSignal) => Promise<unknown>;
  /** 可信宿主为分类设置的等待预算：默认 500 ms，最多 3,000 ms；不从买家输入配置。 */
  classifyLocalTimeoutMs?: number;
}

type Language = "zh" | "en";
type Topic = PublicProductField | "delivery" | "stock";
export interface ProductQuestion { field?: string; reason?: string }
export interface ProductAnswer {
  index: number;
  topic: Topic;
  status: "answered" | "needs_input" | "needs_merchant" | "unavailable";
  answer: string;
  evidence?: { sku: string; revision: string; field: PublicProductField };
  followup?: { case_ref: string; status: string };
}
const TOPICS: ReadonlyArray<readonly [Topic, string, string, RegExp]> = [
  ["title", "名称", "Name", /商品名|叫什么|product.name/iu],
  ["overview", "简介", "Overview", /产品介绍|商品介绍|介绍|describe|overview|description/iu],
  ["features", "特点", "Features", /特点|优点|卖点|特色|features?|highlights?|what makes/iu],
  ["capacity", "容量", "Capacity", /容量|容积|装多少|盛多少|多少毫升|多大容量|capacity|how much (?:does|can) .* hold/iu],
  ["material", "材质", "Material", /材质|材料|什么做|material|made (?:of|from)/iu],
  ["dimensions", "尺寸", "Dimensions", /尺寸|规格大小|长宽高|宽度|高度|直径|dimension|diameter/iu],
  ["weight", "重量", "Weight", /重量|多重|weight|weigh/iu],
  ["color", "颜色", "Color", /颜色|色号|colou?r/iu],
  ["customization", "定制", "Customization", /logo|印字|刻字|定制|customi[sz]|engrave|branding/iu],
  ["delivery", "到货时间", "Delivery", /交期|[发到]货|送达|送到|配送|delivery|arrival|shipping|lead.?time/iu],
  ["stock", "备货", "Availability", /库存|现货|备货|stock|inventory|availability/iu],
];
const publicField = (value: Topic): value is PublicProductField => PUBLIC_PRODUCT_FIELDS.some((field) => field === value);
const label = (topic: Topic, language: Language): string => {
  const entry = TOPICS.find(([key]) => key === topic)!;
  return language === "zh" ? entry[1] : entry[2];
};
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

/** 独立检查投影；报价源可读或缓存命中不构成公开事实。 */
function validFacts(facts: PublicProductFacts, merchantId: string, sku: string, now: string): boolean {
  return facts.merchant_id === merchantId && facts.sku === sku && text(facts.revision, 160) &&
    (facts.valid_until === undefined || Date.parse(facts.valid_until) > Date.parse(now)) &&
    facts.fields !== null && typeof facts.fields === "object";
}

/** 只认结构化问题及可复核的主题；输入和任何提取结果都不能选择数据来源。 */
export function productTopics(question: ProductQuestion): Topic[] {
  const field = (question.field ?? "").trim().toLowerCase();
  const exact = TOPICS.find(([key]) => key === field);
  const reason = (question.reason ?? "").slice(0, 1_000);
  return TOPICS.filter(([key, , , pattern]) => key === exact?.[0] || pattern.test(reason) ||
    (exact === undefined && field.length < 80 && pattern.test(field))).map(([key]) => key);
}

type QuestionTopic = { index: number; topic: Topic; inferred?: true };
const localAttempts = new WeakSet<NonNullable<BuyerProductQa["classifyLocal"]>>();
const MAX_QUESTIONS = 12;
const MAX_TOPICS = 16;
const DEFAULT_CLASSIFY_TIMEOUT_MS = 500;
const MAX_CLASSIFY_TIMEOUT_MS = 3_000;

function classifyTimeoutMs(value?: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 && value <= MAX_CLASSIFY_TIMEOUT_MS
    ? value : DEFAULT_CLASSIFY_TIMEOUT_MS;
}

/** 同轮只对规则未识别的问题调用一次本地分类，不传会话、SKU、商品资料或报价。 */
export async function classifyProductQuestions(qa: BuyerProductQa, questions: readonly ProductQuestion[]): Promise<QuestionTopic[]> {
  const work: QuestionTopic[] = [];
  const unresolved: Array<{ index: number; text: string }> = [];
  questions.slice(0, MAX_QUESTIONS).forEach((question, index) => {
    const topics = productTopics(question);
    for (const topic of topics) work.push({ index, topic });
    const reason = question.reason?.trim();
    if (!topics.length && unresolved.length < 3 && text(reason, 160)) unresolved.push({ index, text: reason });
  });
  const classify = qa.classifyLocal;
  if (classify === undefined || unresolved.length === 0 || work.length >= MAX_TOPICS || localAttempts.has(classify)) return work.slice(0, MAX_TOPICS);
  const indexes = new Set(unresolved.map(({ index }) => index));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    localAttempts.add(classify);
    const attempt = Promise.resolve().then(() => classify(unresolved, controller.signal)).finally(() => { localAttempts.delete(classify); });
    const raw: unknown = await Promise.race([attempt, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => { resolve(undefined); controller.abort(); }, classifyTimeoutMs(qa.classifyLocalTimeoutMs));
    })]);
    const additional = validateLocalTopics(raw, indexes);
    return [...work, ...additional].sort((a, b) => a.index - b.index).slice(0, MAX_TOPICS);
  } catch { return work.slice(0, MAX_TOPICS); }
  finally { clearTimeout(timer); }
}

function validateLocalTopics(raw: unknown, indexes: ReadonlySet<number>): QuestionTopic[] {
  if (!Array.isArray(raw) || raw.length > indexes.size) return [];
  const additional: QuestionTopic[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const { index, topics } = row;
    if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "index") || !Object.hasOwn(row, "topics") ||
        typeof index !== "number" || !indexes.has(index) || seen.has(index) || !Array.isArray(topics) || topics.length > 3) return [];
    seen.add(index);
    const fields = new Set<PublicProductField>();
    for (const topic of topics) {
      const field = PUBLIC_PRODUCT_FIELDS.find((name) => name === topic);
      if (field === undefined || fields.has(field)) return [];
      fields.add(field);
      additional.push({ index, topic: field, inferred: true });
    }
  }
  return additional;
}

export function hasPublicProductTopic(work: readonly QuestionTopic[]): boolean {
  return work.some(({ topic }) => publicField(topic));
}

export async function answerProductQuestions(input: {
  qa: BuyerProductQa; sku?: string; work: readonly QuestionTopic[]; language: Language; now: () => string;
}): Promise<ProductAnswer[]> {
  const { work } = input;
  if (!hasPublicProductTopic(work)) return [];
  let facts: PublicProductFacts | undefined;
  let invalid = false;
  if (input.sku !== undefined) {
    try {
      // Budget also covers non-network custom sources; late results never reach the reply.
      const sku = input.sku;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        facts = await Promise.race([
          input.qa.read(sku),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("public_facts_timeout")), 1_500); }),
        ]);
      } finally { clearTimeout(timer); }
      invalid = facts !== undefined && !validFacts(facts, input.qa.merchantId, sku, input.now());
    } catch { invalid = true; }
  }
  const zh = input.language === "zh";
  return work.map(({ index, topic, inferred }): ProductAnswer => {
    const what = label(topic, input.language);
    const base = { index, topic };
    if (input.sku === undefined) return { ...base, status: "needs_input", answer: zh ? "请先确认商品 SKU" : "Please confirm the product SKU" };
    if (invalid || facts === undefined) return { ...base, status: "unavailable", answer: zh ? `${what}：暂无法核实该商品的已发布资料` : `${what}: published information is unavailable` };
    if (publicField(topic)) {
      const field = topic === "features" && !Object.hasOwn(facts.fields, topic) ? "overview" : topic;
      const value = facts.fields[field];
      if (text(value, 360) && Object.hasOwn(facts.fields, field)) {
        return { ...base, status: "answered", answer: `${label(field, input.language)}：${value}`, evidence: { sku: facts.sku, revision: facts.revision, field } };
      }
    }
    if (inferred) {
      return { ...base, status: "needs_input", answer: zh ? `请确认您是否在问${what}` : `Please confirm whether you are asking about ${what.toLowerCase()}` };
    }
    return { ...base, status: "needs_merchant", answer: zh ? `${what}：没有足够的公开资料，需要商家确认` : `${what}: published information is insufficient; merchant confirmation is needed` };
  });
}
