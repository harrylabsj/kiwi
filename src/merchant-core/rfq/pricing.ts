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
 * 确定性计价引擎（询报价工作台设计 v0.1.1 §7）。
 *
 * PricingEngine.calculate 为纯函数：只做算术与输入界限检查，不读策略、
 * 不取事实、不接受模型提交的最终金额。金额一律最小货币单位（分）整数，
 * 内部乘法与税额用 BigInt——禁止二进制浮点先算元再乘 100。任何中间量
 * 越界按 PRICING_INVALID 整单拒绝（不截断、不取模、不回退浮点）。
 *
 * 逐行 HALF_UP 舍入到分后再求和（rounding: HALF_UP_LINE）：
 *   未税：net = B；tax = HALF_UP(B × r / 10000)；gross = net + tax
 *   含税：gross = B；tax = HALF_UP(B × r / (10000 + r))；net = gross − tax
 * 与交接包 04_reference/pricing_reference.py 及 10 个金标算例一致
 * （tests/merchant-rfq 契约测试逐例比对）。
 */

import { RfqError, type PricingInput, type PricingLineInput, type PricingResult, type PricingShippingInput, type PricingSplit, type TaxBasis } from "./types.js";

/** 单笔金额上限（分）：0..1e12 安全整数（v0.1.1 §7.1）。 */
export const MAX_QUOTE_AMOUNT_MINOR = 1_000_000_000_000;
/** 数量上限。 */
export const MAX_QUANTITY = 100_000;
/** 单份报价行数上限。 */
export const MAX_LINES = 100;

const MAX_MINOR = BigInt(MAX_QUOTE_AMOUNT_MINOR);
const TEN_THOUSAND = 10_000n;

function requireInt(value: unknown, name: string, lo: number, hi: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < lo || value > hi) {
    throw new RfqError("pricing_invalid", `${name} 必须是 [${lo}, ${hi}] 内的安全整数`);
  }
  return value;
}

/** HALF_UP 非负整数除法：(2n + d) / (2d)。 */
function halfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) {
    throw new RfqError("pricing_invalid", "舍入要求非负分子与正分母");
  }
  return (2n * n + d) / (2n * d);
}

function checkAmount(v: bigint, what: string): bigint {
  if (v < 0n || v > MAX_MINOR) {
    // 中间量越界同样 PRICING_INVALID 整单拒绝（§7.1）。
    throw new RfqError("pricing_invalid", `${what} 超出 0..${MAX_QUOTE_AMOUNT_MINOR} 金额上限`);
  }
  return v;
}

/** 单笔金额按税口径拆分（EXCLUSIVE / INCLUSIVE；UNKNOWN 不能进入计价）。 */
export function splitTax(amount: bigint, basis: TaxBasis, rateBps: number): PricingSplit {
  checkAmount(amount, "amount");
  requireInt(rateBps, "tax_rate_bps", 0, 10_000);
  const rate = BigInt(rateBps);
  let net: bigint;
  let tax: bigint;
  let gross: bigint;
  if (basis === "EXCLUSIVE") {
    net = amount;
    tax = halfUp(amount * rate, TEN_THOUSAND);
    gross = net + tax;
  } else {
    gross = amount;
    tax = halfUp(amount * rate, TEN_THOUSAND + rate);
    net = gross - tax;
  }
  return {
    net_minor: Number(checkAmount(net, "net")),
    tax_minor: Number(checkAmount(tax, "tax")),
    gross_minor: Number(checkAmount(gross, "gross")),
  };
}

function parseLine(raw: PricingLineInput): { lineId: string; amount: bigint; basis: TaxBasis; rate: number } {
  if (typeof raw?.line_id !== "string" || raw.line_id === "") {
    throw new RfqError("pricing_invalid", "line_id 必须是非空字符串");
  }
  const quantity = requireInt(raw.quantity, `quantity(${raw.line_id})`, 1, MAX_QUANTITY);
  const unitPrice = requireInt(raw.unit_price_minor, `unit_price_minor(${raw.line_id})`, 0, MAX_QUOTE_AMOUNT_MINOR);
  const discount = requireInt(raw.discount_minor, `discount_minor(${raw.line_id})`, 0, MAX_QUOTE_AMOUNT_MINOR);
  if (raw.tax_basis !== "EXCLUSIVE" && raw.tax_basis !== "INCLUSIVE") {
    throw new RfqError("pricing_invalid", `tax_basis(${raw.line_id}) 必须是 EXCLUSIVE 或 INCLUSIVE`);
  }
  // 中间量 quantity × unit_price_minor 与行优惠后金额同受上限约束（§7.1）：
  // 乘积越界先拒绝，不允许「大基数 + 大优惠」抵消后通过。
  const base = checkAmount(BigInt(quantity) * BigInt(unitPrice), `quantity × unit_price_minor(${raw.line_id})`);
  const amount = base - BigInt(discount);
  if (amount < 0n) {
    throw new RfqError("pricing_invalid", `行 ${raw.line_id} 优惠超过行基数`);
  }
  return { lineId: raw.line_id, amount, basis: raw.tax_basis, rate: raw.tax_rate_bps };
}

function parseShipping(raw: PricingShippingInput): { amount: bigint; basis: TaxBasis; rate: number } {
  const amount = requireInt(raw?.amount_minor, "shipping.amount_minor", 0, MAX_QUOTE_AMOUNT_MINOR);
  if (raw.tax_basis !== "EXCLUSIVE" && raw.tax_basis !== "INCLUSIVE") {
    throw new RfqError("pricing_invalid", "shipping.tax_basis 必须是 EXCLUSIVE 或 INCLUSIVE");
  }
  return { amount: BigInt(amount), basis: raw.tax_basis, rate: raw.tax_rate_bps };
}

/**
 * 确定性计价（纯函数）。首版仅 CNY；输入金额 0..1e12 安全整数；数量
 * 1..100000；行数 1..100；逐行舍入后求和，总额同样受上限约束。
 */
export function calculatePricing(input: PricingInput): PricingResult {
  if (input?.schema_version !== "0.1.0" || input.currency !== "CNY" || input.rounding !== "HALF_UP_LINE") {
    throw new RfqError("pricing_invalid", "unsupported version, currency or rounding");
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > MAX_LINES) {
    throw new RfqError("pricing_invalid", `1..${MAX_LINES} lines required`);
  }
  const seen = new Set<string>();
  const lines: Array<PricingSplit & { line_id: string }> = [];
  for (const raw of input.lines) {
    const { lineId, amount, basis, rate } = parseLine(raw);
    if (seen.has(lineId)) {
      throw new RfqError("pricing_invalid", `重复 line_id：${lineId}`);
    }
    seen.add(lineId);
    lines.push({ line_id: lineId, ...splitTax(amount, basis, rate) });
  }
  const ship = parseShipping(input.shipping);
  const shipping = splitTax(ship.amount, ship.basis, ship.rate);
  const totals = {
    net_minor: lines.reduce((acc, l) => acc + l.net_minor, shipping.net_minor),
    tax_minor: lines.reduce((acc, l) => acc + l.tax_minor, shipping.tax_minor),
    gross_minor: lines.reduce((acc, l) => acc + l.gross_minor, shipping.gross_minor),
  };
  for (const [k, v] of Object.entries(totals)) {
    checkAmount(BigInt(v), `totals.${k}`);
  }
  return { lines, shipping, totals };
}

/** 单行基数（数量 × 单价 − 优惠），供策略层核对授权价格等使用。 */
export function lineBaseMinor(line: PricingLineInput): number {
  const { amount } = parseLine(line);
  return Number(checkAmount(amount, "line base"));
}
