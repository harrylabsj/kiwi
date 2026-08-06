/**
 * KNP/1.0 ConditionalOffer 确定性求值器（子规范 §13，基线 §12）。
 *
 * 输入 ConditionalOffer + 已披露事实集 → 输出结果 TermSet。纯数据解释器：
 * 只识别 all/any（深度 ≤ 2）与 eq/neq/gt/gte/lt/lte/in 比较符，无 eval/exec、
 * 无网络回调、无模型参与（§13.2 / §12 禁止可执行表达式）。
 *
 * 求值规则（§13.6 / §12.2）：
 *   无 rule 命中 → base_terms；
 *   单个 rule 命中 → 该 rule 的完整 then_terms；
 *   多个 rule 命中且 canonical then_terms 完全一致 → 视为同一结果；
 *   多个 rule 命中且结果不同 → condition_conflict；
 *   MUST NOT 逐字段隐式 merge 不同的 then_terms；LLM MUST NOT 在冲突间选择。
 *
 * 披露约束（§12.3）：本求值器只接受"已披露事实集"——调用方必须只传入
 * NetworkDisclosurePolicy 已允许公开的字段值。求值器自身对不在 allowlist 的
 * field 求值请求 fail-closed（field_unsupported）；缺失/未披露的事实永远不命中
 * （含 neq，防止借反例探测私有 buyer 属性）。
 */

import { NegotiationValidationError, schemaError } from "../domain/common.js";
import type { TermSet } from "../domain/common.js";
import {
  CONDITION_FIELDS,
  type ConditionLeaf,
  type ConditionNode,
  type ConditionRule,
  type ConditionalOffer,
} from "../domain/objects.js";
import { canonicalize } from "../jcs.js";

/** 单个 condition field 在事实上下文中的值。协议治理字段当前均为数值量。 */
export type FactValue = number | string;

/**
 * 已披露事实集：以协议 field 标识（§13.5）为键。只含已通过
 * NetworkDisclosurePolicy 允许公开的 Buyer 属性（§12.3）。
 */
export type FactContext = Readonly<Record<string, FactValue>>;

/** 顺序比较仅对有限数值定义；任一操作数非有限数值返回 null（求值失败 → 不命中）。 */
function numericRelation(left: unknown, right: unknown): number | null {
  if (typeof left !== "number" || typeof right !== "number") return null;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return left < right ? -1 : left > right ? 1 : 0;
}

function evaluateLeaf(leaf: ConditionLeaf, facts: FactContext, path: string): boolean {
  // 防御性 allowlist 校验（schema 校验通常已前置拦截；此处 fail-closed）。
  if (!(CONDITION_FIELDS as readonly string[]).includes(leaf.field)) {
    throw new NegotiationValidationError(
      "field_unsupported",
      `condition field ${leaf.field} is not in the KNP/1.0 allowlist`,
      `${path}/field`,
    );
  }
  const fact = facts[leaf.field];
  // 缺失/未披露的事实永远不命中：既保持确定性，也防止条件集借 neq/gt 等
  // 反例形状推断私有属性。
  if (fact === undefined) return false;

  switch (leaf.op) {
    case "eq":
      return fact === leaf.value;
    case "neq":
      return fact !== leaf.value;
    case "in": {
      return (
        Array.isArray(leaf.value) &&
        (leaf.value as (number | string)[]).some((candidate) => candidate === fact)
      );
    }
    case "gt": {
      const relation = numericRelation(fact, leaf.value);
      return relation !== null && relation > 0;
    }
    case "gte": {
      const relation = numericRelation(fact, leaf.value);
      return relation !== null && relation >= 0;
    }
    case "lt": {
      const relation = numericRelation(fact, leaf.value);
      return relation !== null && relation < 0;
    }
    case "lte": {
      const relation = numericRelation(fact, leaf.value);
      return relation !== null && relation <= 0;
    }
  }
}

/**
 * 求值一个 condition 节点。`depth` 为根（`when`）以下层数；> 2 视为非法结构
 * （§13.3），与 validateConditionalOffer 的深度约束一致（fail-closed）。
 */
export function evaluateNode(
  node: ConditionNode,
  facts: FactContext,
  path = "/conditions",
  depth = 0,
): boolean {
  if (depth > 2) {
    throw schemaError(path, "condition nesting must not exceed 2 levels below the root");
  }
  if ("all" in node) {
    return node.all.every((child, i) => evaluateNode(child, facts, `${path}/all/${i}`, depth + 1));
  }
  if ("any" in node) {
    return node.any.some((child, i) => evaluateNode(child, facts, `${path}/any/${i}`, depth + 1));
  }
  return evaluateLeaf(node, facts, path);
}

/**
 * 求值整个 ConditionalOffer，返回结果 TermSet（§13.6 / §12.2）。
 *
 * 多个 rule 命中且 canonical then_terms 完全一致时视为同一结果；结果不同时抛
 * condition_conflict。不会把不同 then_terms 按字段 merge，也不做模型选择。
 */
export function evaluateConditionalOffer(offer: ConditionalOffer, facts: FactContext): TermSet {
  const matched: ConditionRule[] = [];
  offer.conditions.forEach((rule, i) => {
    if (evaluateNode(rule.when, facts, `/conditions/${i}/when`)) {
      matched.push(rule);
    }
  });

  if (matched.length === 0) return offer.base_terms;
  if (matched.length === 1) return matched[0]!.then_terms;

  // 多命中：比较 canonical then_terms（RFC 8785 JCS 字节），而非引用或对象形状。
  const firstCanonical = canonicalize(matched[0]!.then_terms);
  if (matched.slice(1).every((rule) => canonicalize(rule.then_terms) === firstCanonical)) {
    return matched[0]!.then_terms;
  }
  throw new NegotiationValidationError(
    "condition_conflict",
    `${matched.length} conditions matched with differing then_terms; refusing to merge or pick`,
    "/conditions",
  );
}
