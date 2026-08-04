/**
 * Deterministic StrategyEngine (design §8).
 *
 * Operator natural language is compiled into a typed StrategyPatch by fixed
 * rules — no model call, no prompt concatenation. Classification order:
 * forbidden (always refused) -> numeric relax/tighten against the profile's
 * hard limits -> ETA / quantity rules -> soft_preference fallback.
 *
 * - tighten:           narrows a constraint; applies immediately.
 * - soft_preference:   preference inside HardPolicy; applies immediately.
 * - relax:             widens a constraint; requires explicit confirmation.
 * - forbidden:         attacks a product boundary; never applied.
 *
 * The engine never widens HardPolicy by itself: it only classifies; the
 * controller decides what gets applied and records it as events.
 */

import type { Role } from "../negotiation/types.js";
import type { PatchScope, StrategyPatch } from "./types.js";

/** Hard-limit context used to classify numeric directives. */
export interface StrategyContext {
  role: Role;
  /** Buyer private budget ceiling from the profile (HardPolicy). */
  buyer_max_total_price?: number;
  /** Merchant private floor price from the profile (HardPolicy). */
  merchant_min_unit_price?: number;
}

export type StrategyRiskLevel = "ok" | "confirm" | "blocked";

export interface StrategyRisk {
  level: StrategyRiskLevel;
  reason: string;
}

interface ForbiddenRule {
  rule: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Product-boundary attacks (design §8 `forbidden`, §16). Conservative on
 * purpose: a false positive only means the operator rephrases.
 */
const FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  {
    rule: "forbid_gate_bypass",
    pattern:
      /(取消|关闭|禁用|绕过|跳过|去掉).{0,12}(策略门|审批|硬约束|安全门|校验|policy|approval|gate)|bypass|disable.{0,20}(policy|approval|gate)/i,
    reason: "不得取消或绕过策略门、审批或硬约束",
  },
  {
    rule: "forbid_order",
    pattern: /直接下单|帮我下单|创建订单|place.{0,4}order|create.{0,4}order/i,
    reason: "v0.2 不创建订单（no-order 边界不可取消）",
  },
  {
    rule: "forbid_payment",
    pattern: /直接支付|代为付款|立即付款|pay now|make.{0,4}payment/i,
    reason: "v0.2 不涉及支付",
  },
  {
    rule: "forbid_reservation",
    pattern: /锁库|预留库存|reserve.{0,8}(stock|inventory)/i,
    reason: "磋商不预留库存",
  },
  {
    rule: "forbid_identity_merge",
    pattern:
      /合并身份|同时持有.{0,8}(双方|token)|同一进程.{0,8}(买卖双方|双方)|merge.{0,8}identit/i,
    reason: "买卖双方身份与 token 不得合并到同一进程",
  },
  {
    rule: "forbid_secret_exfil",
    pattern:
      /(把|将).{0,10}(token|密钥|api.?key|密码).{0,6}(发|给|告诉|泄露)|share.{0,12}(token|api.?key|secret)/i,
    reason: "不得把 token 或密钥外发给任何人",
  },
];

const TURN_SCOPE = /这一轮|本轮|下一轮|本次|this turn|next turn/i;
const BUDGET_WORD = /预算|budget/i;
const FLOOR_WORD = /底价|最低价|floor/i;
// Tighten ETA is checked BEFORE relax ETA: “不接受更晚交付” contains 更晚.
const ETA_TIGHTEN = /不接受更晚|不能晚于|不晚于|更早|提前|no later|earlier/i;
const ETA_RELAX = /更晚|延后|推迟|放宽(交期|送达|交付)|宽限|later (delivery|eta)|extend/i;
const QTY_CAP = /最多(买|要)?\s*\d+|至多\s*\d+|at most \d+/i;
const AMOUNT = /(\d+(?:\.\d+)?)/;

function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class StrategyEngine {
  /** Compile one operator message into a typed patch. Pure and deterministic. */
  compile(text: string, context: StrategyContext): StrategyPatch {
    const scope: PatchScope = TURN_SCOPE.test(text) ? "turn" : "session";

    for (const forbidden of FORBIDDEN_RULES) {
      if (forbidden.pattern.test(text)) {
        return {
          kind: "forbidden",
          scope,
          summary: `拒绝：${forbidden.reason}`,
          directive: text,
          requires_confirmation: false,
          matched_rules: [forbidden.rule],
        };
      }
    }

    const amountMatch = AMOUNT.exec(text);
    const amount = amountMatch?.[1] !== undefined ? Number(amountMatch[1]) : undefined;

    if (context.role === "buyer" && BUDGET_WORD.test(text) && amount !== undefined) {
      const current = context.buyer_max_total_price;
      if (current !== undefined && amount > current) {
        return {
          kind: "relax",
          scope,
          summary: `放宽：将买方预算上限由 ${current} 提高到 ${amount}`,
          directive: text,
          requires_confirmation: true,
          matched_rules: ["raise_budget"],
        };
      }
      return {
        kind: "tighten",
        scope,
        summary:
          current !== undefined && amount < current
            ? `收紧：将买方预算上限由 ${current} 降低到 ${amount}`
            : `收紧：买方预算上限设为 ${amount}`,
        directive: text,
        requires_confirmation: false,
        matched_rules: ["lower_budget"],
      };
    }

    if (context.role === "merchant" && FLOOR_WORD.test(text) && amount !== undefined) {
      const current = context.merchant_min_unit_price;
      if (current !== undefined && amount < current) {
        return {
          kind: "relax",
          scope,
          summary: `放宽：将商家最低单价由 ${current} 降低到 ${amount}`,
          directive: text,
          requires_confirmation: true,
          matched_rules: ["lower_floor"],
        };
      }
      return {
        kind: "tighten",
        scope,
        summary:
          current !== undefined && amount > current
            ? `收紧：将商家最低单价由 ${current} 提高到 ${amount}`
            : `收紧：商家最低单价设为 ${amount}`,
        directive: text,
        requires_confirmation: false,
        matched_rules: ["raise_floor"],
      };
    }

    if (ETA_TIGHTEN.test(text)) {
      return {
        kind: "tighten",
        scope,
        summary: "收紧：不接受更晚的交付时间",
        directive: text,
        requires_confirmation: false,
        matched_rules: ["tighten_eta"],
      };
    }
    if (ETA_RELAX.test(text)) {
      return {
        kind: "relax",
        scope,
        summary: "放宽：允许更晚的交付时间",
        directive: text,
        requires_confirmation: true,
        matched_rules: ["relax_eta"],
      };
    }
    if (QTY_CAP.test(text)) {
      return {
        kind: "tighten",
        scope,
        summary: `收紧：限制购买数量（${truncate(text, 40)}）`,
        directive: text,
        requires_confirmation: false,
        matched_rules: ["cap_quantity"],
      };
    }

    return {
      kind: "soft_preference",
      scope,
      summary: `偏好：${truncate(text)}`,
      directive: text,
      requires_confirmation: false,
      matched_rules: ["soft_preference"],
    };
  }

  /** Risk gate for a compiled patch (design §8 confirmation rules). */
  assess(patch: StrategyPatch): StrategyRisk {
    if (patch.kind === "forbidden") {
      return { level: "blocked", reason: patch.summary };
    }
    if (patch.kind === "relax") {
      return { level: "confirm", reason: "放宽约束需要显式确认（/strategy confirm）" };
    }
    return { level: "ok", reason: "" };
  }
}

export function createStrategyEngine(): StrategyEngine {
  return new StrategyEngine();
}
