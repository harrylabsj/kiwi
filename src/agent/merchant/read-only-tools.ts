/**
 * 商家只读对话的工具白名单。
 *
 * 只允许读取本商家实例的目录/库存/磋商/经营摘要等既有投影；写工具、私有
 * 阈值读取、记忆写入与技能工具一律不在只读对话中注入。该白名单在 kernel
 * 装配阶段执行，不依赖 prompt 或运行模式。
 */

export const READ_ONLY_MERCHANT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_catalog_products",
  "get_catalog_product",
  "get_inventory_snapshot",
  "list_incoming_consultations",
  "get_catalog_health",
  "list_a2a_negotiations",
]);

/**
 * 金额相关工具（owner-only 报价/底价或可能含金额的经营摘要）不在只读对话
 * 白名单内；`list_incoming_consultations` / `list_a2a_negotiations` 由
 * `redactAmounts` 在 handler 层去掉 price_minor 后才保留。
 */

export function isReadOnlyMerchantTool(name: string): boolean {
  return READ_ONLY_MERCHANT_TOOL_NAMES.has(name);
}

export function filterReadOnlyMerchantTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => isReadOnlyMerchantTool(tool.name));
}
