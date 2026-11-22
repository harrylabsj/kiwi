import { McpError } from "./errors.js";

/** The merchant RFQ carries one SKU and one explicitly confirmed quantity. */
export function quoteQuantity(intent: Record<string, unknown>): { value: number; unit: string } {
  const items = intent.items;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new McpError("clarification_needed", "请将每个商品分别询价。", { reason: "single_item_required" });
  }
  const quantity = items[0]?.quantity;
  if (!Number.isFinite(quantity?.value) || quantity.value <= 0 ||
      typeof quantity.unit !== "string" || quantity.unit.trim() === "") {
    throw new McpError("clarification_needed", "发出询价前，请确认数量和单位。", { reason: "quantity_required" });
  }
  return { value: quantity.value, unit: quantity.unit };
}
