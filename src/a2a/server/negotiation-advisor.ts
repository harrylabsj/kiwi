/**
 * 商家协商顾问（C）：让商家"会说话"，但不让模型定价。
 *
 * 设计红线（与 `src/merchant/decision-backend.ts` 的既有边界一致）：
 *  - 价格仍由确定性引擎计算（floor / 公开折扣边界 / 促销），顾问**不参与**
 *    定价，也拿不到私有底价；
 *  - 顾问只生成面向买家的 `public_message` 措辞（解释、下一步、可谈维度）；
 *  - 输出必须通过安全校验：长度、无换行、出现的数字必须属于公开事实集合
 *    （list / 公开边界 / 本轮响应价 / 数量），否则整条丢弃并回退到既有文案。
 *
 * 未配置顾问时行为不变；配置后也只改变措辞，不改变任何价格数字。
 */

export interface NegotiationAdvisorInput {
  sku: string;
  quantity: number;
  currency: string;
  /** list 价（minor）。 */
  list_price_minor: number;
  /** 公开折扣边界（minor，可公开）。 */
  public_bound_minor?: number;
  /** 买家本轮还价（minor）。 */
  buyer_counter_minor?: number;
  /** 本轮实际响应价（minor）。 */
  response_price_minor: number;
  /** 已配置的权威交期。 */
  delivery_before?: string;
}

export interface NegotiationAdvisor {
  /** 返回面向买家的说明文本；失败返回 undefined（调用方回退固定文案）。 */
  message(input: NegotiationAdvisorInput): Promise<string | undefined>;
}

export const ADVISOR_MESSAGE_MAX_CHARS = 500;

export interface DeepSeekNegotiationAdvisorOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * DeepSeek 措辞顾问（可选启用）。Prompt 只包含公开事实，**不包含 floor**；
 * 模型输出仍要经过 safeAdvisorMessage，异常/超时/非 200 一律 undefined。
 */
export function createDeepSeekNegotiationAdvisor(
  options: DeepSeekNegotiationAdvisorOptions = {},
): NegotiationAdvisor {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async message(input) {
      const apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "DEEPSEEK_API_KEY"] ?? "";
      if (apiKey === "") return undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(
          `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/chat/completions`,
          {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: options.model ?? DEFAULT_MODEL,
              temperature: 0.2,
              max_tokens: 200,
              messages: [
                {
                  role: "system",
                  content:
                    "You write one short buyer-facing sentence for a merchant quote. " +
                    "Use ONLY the numbers in the user message verbatim. Never invent a lower price, " +
                    "never mention internal costs, floors or approval thresholds. No line breaks.",
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    sku: input.sku,
                    quantity: input.quantity,
                    currency: input.currency,
                    list_price: input.list_price_minor / 100,
                    response_price: input.response_price_minor / 100,
                    ...(input.public_bound_minor !== undefined
                      ? { lowest_public_price: input.public_bound_minor / 100 }
                      : {}),
                    ...(input.delivery_before !== undefined
                      ? { delivery_before: input.delivery_before }
                      : {}),
                  }),
                },
              ],
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return undefined;
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = payload.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : undefined;
      } catch {
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 顾问输出安全校验：不允许换行/超长；文本中出现的每个数字都必须能在**公开
 * 事实**里找到对应（按 minor 与裸数值两种写法）。私有 floor 永远不会在
 * 允许集合里，因此"不小心说出底价"会被整条拒绝。
 */
export function safeAdvisorMessage(
  text: string | undefined,
  allowed: {
    priceMinorValues: number[];
    quantities: number[];
  },
): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > ADVISOR_MESSAGE_MAX_CHARS) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  const priceMinor = new Set(allowed.priceMinorValues.map((value) => Math.round(value)));
  const quantities = new Set(allowed.quantities.map((value) => Math.round(value)));
  const numbers = trimmed.match(/\d+(?:\.\d+)?/g) ?? [];
  for (const raw of numbers) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return undefined;
    const asMinor = Math.round(value * 100);
    if (!priceMinor.has(asMinor) && !quantities.has(value)) return undefined;
  }
  return trimmed;
}
