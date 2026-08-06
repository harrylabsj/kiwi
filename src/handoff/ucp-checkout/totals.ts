/**
 * Kiwi v1.1 Transaction Handoff（WP2）— UCP Checkout totals 校验。
 *
 * totals 是 business 权威（platform MUST NOT 自行计算替代）；platform MAY 校验
 * `非 total 各项之和 == total`。不符 → MUST NOT 自动完成，应拒绝或升级。本模块
 * 只做「校验 + 结构化上报」，绝不修改 / 替代 business 给出的 totals。
 *
 * 判定规则：
 *   - 无 totals → undefined（不校验；business 权威）；
 *   - totals 有至少一个数值细项（除 currency/total 外）→ 求和 == total 才 ok，
 *     否则 mismatch（附 breakdown 供上报）；
 *   - totals 只有 currency + total（无数值细项可核对）→ 视为「无法校验」→ 拒绝
 *     完成（fail-closed：无法证明 sum 一致就不能自动完成）。
 */

import type { UcpCheckoutTotals } from "./types.js";

export interface TotalsValidationResult {
  ok: boolean;
  /** 非 total 各项之和。 */
  computed: number;
  /** business 声明的 total。 */
  expected: number;
  /** 参与求和的数值字段明细（不含 currency/total）。 */
  breakdown: Record<string, number>;
}

/** totals 缺席 → undefined（MAY 校验，不强制）。 */
export function validateTotals(totals: UcpCheckoutTotals | undefined): TotalsValidationResult | undefined {
  if (totals === undefined) return undefined;
  const breakdown: Record<string, number> = {};
  let computed = 0;
  for (const [key, value] of Object.entries(totals)) {
    if (key === "currency" || key === "total") continue;
    if (typeof value === "number" && Number.isInteger(value)) {
      breakdown[key] = value;
      computed += value;
    }
  }
  if (Object.keys(breakdown).length === 0) {
    // 无数值细项可核对 → 无法证明 sum == total → fail-closed。
    return { ok: false, computed: 0, expected: totals.total, breakdown };
  }
  return { ok: computed === totals.total, computed, expected: totals.total, breakdown };
}
