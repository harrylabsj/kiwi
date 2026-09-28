/** 类型声明：供 tests 从 TS 导入 scripts/export-shopping-cli-products.mjs。 */

export declare const TEMPLATE_HEADER: string[];
export declare const MAX_EXPORT_ROWS: number;

export interface ShoppingCliProductRow {
  sku: string;
  title: string;
  price: number;
  currency: string;
  stock: number | null;
  active: number;
  updated_at: string;
  description: string | null;
}

export interface ShoppingCliExportOptions {
  unit?: string;
  validDays?: number;
  includePaused?: boolean;
  now?: () => Date;
}

export declare function buildShoppingCliExportCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  options?: ShoppingCliExportOptions,
): { csv: string; exportedCount: number; skippedPaused: string[] };
