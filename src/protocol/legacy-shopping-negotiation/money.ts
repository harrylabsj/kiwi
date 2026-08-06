/**
 * Money 小数位数与 legacy float ↔ KNP minor-units 转换（子规范 §7.1）。
 *
 * KNP/1.0 禁止 float 金额（§7.1 / §19.1 JCS）；shopping.negotiation/0.1 的
 * proposal.unit_price / delivery.fee 是十进制 float。转译仅在 legacy 金额的
 * 精度不超过目标货币最小单位时无损；否则 fail-closed（legacy→KNP 方向由
 * 调用方根据 lossless=false 拒绝，绝不把小数位损失静默抹平）。
 *
 * 货币指数表只覆盖常见结算货币；未知货币默认指数 2（三位大写货币代码的
 * 常见小数位）。需要扩展时通过 LegacyNegotiationAdapter 注入
 * currencyExponentOf。
 */

/** 常见货币的最小单位指数（10^exp 个 minor = 1 个主要单位）。 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  HKD: 2,
  TWD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
};

export const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * 绝对 epsilon：`amount * 10^exp` 的 float 表示误差约 1e-9 量级；1e-6 远大于
 * 该误差、又远小于 1 个最小单位，因此可区分「float 表示误差」与「真正超出
 * 最小单位的小数位损失」。
 */
export const MINOR_UNIT_EPSILON = 1e-6;

export function currencyExponent(currency: string): number {
  const exp = CURRENCY_EXPONENTS[currency];
  return exp === undefined ? DEFAULT_CURRENCY_EXPONENT : exp;
}

export interface MinorUnitConversion {
  amount_minor: number;
  /** true 表示精确可表达；false 表示 float 精度超出最小单位，转译有损。 */
  lossless: boolean;
}

/**
 * legacy 十进制金额 → KNP minor units（§7.1）。`lossless=false` 时
 * `amount_minor` 为 NaN，调用方必须 fail-closed，不得使用该值。
 */
export function toMinorUnits(amount: number, exponent: number): MinorUnitConversion {
  if (!Number.isFinite(amount) || amount < 0) {
    return { amount_minor: Number.NaN, lossless: false };
  }
  const scaled = amount * 10 ** exponent;
  const amountMinor = Math.round(scaled);
  const lossless = Math.abs(scaled - amountMinor) <= MINOR_UNIT_EPSILON;
  return { amount_minor: lossless ? amountMinor : Number.NaN, lossless };
}

/** KNP minor units → legacy 十进制金额（仅用于 KNP→legacy，无损）。 */
export function fromMinorUnits(amount_minor: number, exponent: number): number {
  return amount_minor / 10 ** exponent;
}
