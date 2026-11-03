/**
 * ResponsePlan 发布前校验与渲染（P0a，设计 §11「模型规划表达、系统发布事实」）：
 *
 *   - show_commercial_terms 只接受服务端事实引用；发布器校验引用存在性、
 *     版本、租户归属、可见性与有效期，任一不过即拒绝该块；
 *   - 校验通过的块从同一快照渲染公开文本，绝不按块内自带数字渲染；
 *   - 没有 free_text 槽位：所有块都是受控类型，文案由发布器确定性生成。
 */

import { contentDigest } from "../../negotiation/jcs.js";
import type {
  CommercialFactSnapshot,
  FactRef,
  ReceptionBlock,
  ReceptionResponsePlan,
} from "./types.js";

export type RejectReason =
  | "reference_not_found"
  | "version_mismatch"
  | "cross_tenant"
  | "not_public"
  | "expired";

export interface RejectedBlock {
  block: ReceptionBlock;
  reason: RejectReason;
}

/** 事实快照注册表：快照按 SKU 登记，引用必须带匹配版本才能解析。 */
export interface CommercialFactRegistry {
  register(snapshot: CommercialFactSnapshot): FactRef;
  resolve(ref: FactRef): CommercialFactSnapshot | undefined;
}

/** 每回合事实注册表（进程内，不持久化；快照只在发布当回合有效）。 */
export class InMemoryFactRegistry implements CommercialFactRegistry {
  private readonly snapshots = new Map<string, CommercialFactSnapshot>();

  register(snapshot: CommercialFactSnapshot): FactRef {
    this.snapshots.set(snapshot.sku, snapshot);
    return { sku: snapshot.sku, revision: snapshot.revision };
  }

  resolve(ref: FactRef): CommercialFactSnapshot | undefined {
    return this.snapshots.get(ref.sku);
  }
}

/** 快照版本：内容 digest——事实或归属变化即版本变化，旧引用自然失效。 */
export function factRevision(snapshot: Omit<CommercialFactSnapshot, "revision">): string {
  return contentDigest({
    merchantId: snapshot.merchantId,
    sku: snapshot.sku,
    visibility: snapshot.visibility,
    issuedAt: snapshot.issuedAt,
    ...(snapshot.expiresAt !== undefined ? { expiresAt: snapshot.expiresAt } : {}),
    facts: snapshot.facts,
  } as never);
}

export interface PublishResult {
  /** 校验通过的块渲染出的公开文本；全部被拒绝时为空串（调用方兜底）。 */
  text: string;
  rejected: RejectedBlock[];
}

function validateFactRef(
  ref: FactRef,
  registry: CommercialFactRegistry,
  merchantId: string,
  now: string,
): RejectReason | undefined {
  const snapshot = registry.resolve(ref);
  if (snapshot === undefined) return "reference_not_found";
  if (snapshot.revision !== ref.revision) return "version_mismatch";
  if (snapshot.merchantId !== merchantId) return "cross_tenant";
  if (snapshot.visibility !== "public") return "not_public";
  if (snapshot.expiresAt !== undefined) {
    const expires = Date.parse(snapshot.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.parse(now)) return "expired";
  }
  return undefined;
}

function renderFacts(snapshot: CommercialFactSnapshot): string[] {
  const lines: string[] = [];
  const facts = snapshot.facts;
  if (facts.listPrice !== undefined && facts.currency !== undefined) {
    lines.push(`当前公开标价 ${facts.listPrice.toFixed(2)} ${facts.currency}。`);
  }
  if (facts.stockAvailable === true) lines.push("库存可以覆盖本次数量。");
  if (facts.stockAvailable === false) lines.push("当前库存不足以覆盖本次数量。");
  if (facts.stockAvailable === undefined) lines.push("库存状态待确认。");
  if (facts.deliveryBefore !== undefined) {
    lines.push(`预计交期不晚于 ${facts.deliveryBefore.slice(0, 10)}。`);
  } else {
    lines.push("交期待确认。");
  }
  return lines;
}

function renderBlock(block: ReceptionBlock, registry: CommercialFactRegistry): string[] {
  switch (block.kind) {
    case "acknowledge_need": {
      const parts: string[] = [];
      if (block.sku !== undefined) parts.push(`SKU ${block.sku}`);
      if (block.quantity !== undefined) {
        parts.push(
          block.unit !== undefined ? `${block.quantity} ${block.unit}` : `${block.quantity}`,
        );
      }
      return parts.length > 0 ? [`已记录需求：${parts.join("，")}。`] : [];
    }
    case "ask_clarification": {
      if (block.reason === "non_chinese") {
        return ["目前仅支持中文接待。请用中文说明需要的商品、数量和单位，或发送结构化 RFQ。"];
      }
      if (block.reason === "empty_message") {
        return ["请说明需要的商品、数量和单位。"];
      }
      if (block.reason === "service_busy") {
        // §18 故障降级：如实告知可恢复的下一步，不编造缺货或拒绝。
        return ["当前查询较忙，请稍后重试；也可以直接发送 RFQ（SKU、数量、单位）获取正式报价。"];
      }
      if (block.reason === "unknown_sku") {
        return ["暂时无法从商品源确认该 SKU，请核对后重试。"];
      }
      return ["请提供商品 SKU；如已知数量与单位也请一并说明。"];
    }
    case "show_commercial_terms": {
      const snapshot = registry.resolve(block.ref);
      return snapshot === undefined ? [] : renderFacts(snapshot);
    }
    case "request_human_help": {
      // 只显示真实审批状态（刚登记的 pending）：不说已批准、不泄露商家边界
      // 与底价；买家目标价是其本人声明的数字，可以回显。
      const target =
        block.buyerTargetPrice !== undefined && block.currency !== undefined
          ? `您的目标价 ${block.buyerTargetPrice.toFixed(2)} ${block.currency} `
          : "这个价格 ";
      return [
        `${target}低于本店可自动确认的范围，这项条件需要商家确认，目前尚未批准。确认后我会继续处理；您也可以稍后用中文追问进度。`,
      ];
    }
    case "next_step":
      return ["以上为非约束性信息；请发送 RFQ（SKU、数量、单位）获取正式报价。"];
  }
}

/**
 * 发布校验：逐块验证后渲染。被拒绝的块不进入回复；其余块照常发布
 * （设计 §11 首版自动发布规则 1：引用不合法时拒绝该块）。
 */
export function publishResponsePlan(input: {
  plan: ReceptionResponsePlan;
  registry: CommercialFactRegistry;
  merchantId: string;
  now: string;
}): PublishResult {
  const rejected: RejectedBlock[] = [];
  const lines: string[] = [];
  for (const block of input.plan.blocks) {
    if (block.kind === "show_commercial_terms") {
      const reason = validateFactRef(block.ref, input.registry, input.merchantId, input.now);
      if (reason !== undefined) {
        rejected.push({ block, reason });
        continue;
      }
    }
    lines.push(...renderBlock(block, input.registry));
  }
  return { text: lines.join(" "), rejected };
}
