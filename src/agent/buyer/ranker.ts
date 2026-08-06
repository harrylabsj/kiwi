/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Deterministic candidate ranker and hard filter (design §12.2, §12.3).
 *
 * Hard filters come only from explicit user constraints, confirmed
 * HardPolicy, and structured platform facts — inferred preferences never
 * delete a candidate. The final score is computed here (never by the
 * model), and every dimension weight traces to the user instruction, a
 * confirmed memory, or the documented default.
 */

import type { ConnectorProduct } from "../connector/types.js";
import type {
  ProductObservation,
  RankingDimension,
  RankingPolicy,
  ScoreExplanation,
  TaskConstraints,
  TaskIntent,
} from "./types.js";

export interface HardFilterResult {
  eligible: "eligible" | "ineligible" | "unknown";
  reasons: string[];
  unknowns: string[];
}

/**
 * Hard filter (§12.2). A missing fact never filters a candidate out — it is
 * reported as an uncertainty instead (§18.2: stale facts must not pretend
 * to be current).
 */
export function hardFilter(
  product: ConnectorProduct,
  constraints: TaskConstraints,
  now: string,
): HardFilterResult {
  const reasons: string[] = [];
  const unknowns: string[] = [];

  if (constraints.exclude_out_of_stock !== false && product.stock <= 0) {
    reasons.push("缺货");
  }
  const total = product.price + product.delivery.fee;
  if (constraints.max_total_price !== undefined && total > constraints.max_total_price) {
    reasons.push(
      `总价 ${total} ${product.currency} 超过上限 ${constraints.max_total_price}`,
    );
  }
  if (constraints.latest_eta !== undefined) {
    const eta = Date.parse(now) + product.delivery.eta_minutes * 60_000;
    if (eta > Date.parse(constraints.latest_eta)) {
      reasons.push(`预计送达时间晚于要求的 ${constraints.latest_eta}`);
    }
  }
  if (constraints.required_terms !== undefined && constraints.required_terms.length > 0) {
    // The catalog search API exposes no after-sales facts: not filterable.
    unknowns.push("售后条款无法从搜索事实校验（需咨询确认）");
  }
  return {
    eligible: reasons.length > 0 ? "ineligible" : unknowns.length > 0 ? "unknown" : "eligible",
    reasons,
    unknowns,
  };
}

const DEFAULT_WEIGHTS: Record<RankingDimension, number> = {
  match: 1.0,
  total_cost: 1.0,
  promotion: 0.3,
  price_history: 0.2,
  stock: 0.6,
  delivery: 0.6,
  after_sales: 0.3,
  preference_fit: 0.8,
  merchant_quality: 0.4,
  freshness: 0.4,
};

export interface RankInput {
  intent: TaskIntent;
  policy: RankingPolicy;
  now: string;
  /** observation freshness: candidate -> observation (may be stale/absent). */
  observations: Map<string, ProductObservation | undefined>;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function matchScore(product: ConnectorProduct, intent: TaskIntent): { score: number; note: string } {
  const terms = [intent.query_text, intent.category]
    .filter((t): t is string => typeof t === "string" && t !== "")
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return { score: 0.5, note: "无明确关键词" };
  const haystack = [product.title, product.description, product.category, ...product.tags]
    .join(" ")
    .toLowerCase();
  const hits = terms.filter((t) => haystack.includes(t)).length;
  return { score: clamp01(hits / terms.length), note: `命中 ${hits}/${terms.length} 个关键词` };
}

function preferenceScore(
  product: ConnectorProduct,
  intent: TaskIntent,
): { score: number; note: string } {
  const prefs = intent.preferences ?? [];
  if (prefs.length === 0) return { score: 0.5, note: "无偏好输入" };
  const haystack = [
    product.title,
    product.category,
    ...product.tags,
    product.merchant.name,
    ...product.merchant.tags,
  ]
    .join(" ")
    .toLowerCase();
  const hits = prefs.filter((p) => haystack.includes(p.toLowerCase())).length;
  return { score: clamp01(hits / prefs.length), note: `偏好命中 ${hits}/${prefs.length}` };
}

/**
 * Score one candidate. Facts come from the product summary plus the latest
 * observation; a stale observation degrades the freshness dimension and is
 * listed in stale_facts (never silently treated as current, §12.3/§18.2).
 */
export function scoreCandidate(
  product: ConnectorProduct,
  input: RankInput,
): { score: number; explanation: ScoreExplanation } {
  const weights = { ...DEFAULT_WEIGHTS, ...input.policy.weights };
  const sourceOf = (d: RankingDimension): string => input.policy.sources[d] ?? "default";
  const dimensions: ScoreExplanation["dimensions"] = [];
  const staleFacts: string[] = [];

  const observation = input.observations.get(product.sku);
  const fresh =
    observation !== undefined && Date.parse(observation.fresh_until) > Date.parse(input.now);

  const push = (dimension: RankingDimension, score: number, note: string): void => {
    dimensions.push({ dimension, score, weight: weights[dimension], source: sourceOf(dimension), note });
  };

  const m = matchScore(product, input.intent);
  push("match", m.score, m.note);

  const total = product.price + product.delivery.fee;
  // Normalize cost against a soft reference: 2x the cheapest-in-set would be
  // ideal; without set context use a fixed anchor of intent-free 100 units.
  push("total_cost", clamp01(1 - total / 200), `总价 ${total} ${product.currency}（含运费 ${product.delivery.fee}）`);

  const hasPromotion = observation !== undefined && Object.keys(observation.promotion).length > 0;
  push("promotion", hasPromotion ? 1 : 0.3, hasPromotion ? "有促销信息" : "无促销信息");

  push("price_history", 0.5, "观察历史不足，暂不贡献");

  push(
    "stock",
    product.stock > 2 ? 1 : product.stock > 0 ? 0.6 : 0,
    product.stock > 0 ? `库存 ${product.stock}` : "缺货",
  );

  const etaOk =
    input.intent.needed_by === undefined
      ? undefined
      : Date.parse(input.now) + product.delivery.eta_minutes * 60_000 <=
        Date.parse(input.intent.needed_by);
  push(
    "delivery",
    etaOk === undefined ? (product.delivery.eta_minutes <= 1440 ? 0.8 : 0.5) : etaOk ? 1 : 0,
    etaOk === undefined
      ? `预计 ${product.delivery.eta_minutes} 分钟`
      : etaOk
        ? "交期满足要求"
        : "交期晚于要求",
  );

  push("after_sales", 0.3, "搜索事实不含售后条款（需咨询确认）");

  const p = preferenceScore(product, input.intent);
  push("preference_fit", p.score, p.note);

  const merchantQuality = product.warnings.length === 0 ? 0.8 : 0.3;
  push(
    "merchant_quality",
    merchantQuality,
    product.warnings.length === 0
      ? `商家 ${product.merchant.name} 无告警`
      : `商家告警: ${product.warnings.join("; ")}`,
  );

  if (observation === undefined) {
    push("freshness", 0.5, "尚无观察记录");
  } else if (fresh) {
    push("freshness", 1, `观察于 ${observation.observed_at}，新鲜`);
  } else {
    push("freshness", 0.2, `观察已过期（fresh_until ${observation.fresh_until}）`);
    staleFacts.push(`${product.sku} 的价格/库存观察已过期`);
  }

  let weightSum = 0;
  let acc = 0;
  for (const d of dimensions) {
    acc += d.score * d.weight;
    weightSum += d.weight;
  }
  const score = weightSum === 0 ? 0 : acc / weightSum;
  return { score, explanation: { dimensions, used_memories: [], stale_facts: staleFacts } };
}
