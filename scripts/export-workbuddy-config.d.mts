/** 类型声明：供 tests 从 TS 导入 export-workbuddy-config.mjs。 */

export declare const DEFAULT_BASE: string;
export declare const DEFAULT_LOCAL: string;

export declare function convertToPlatformImport(
  base: unknown,
  local: unknown,
): Record<string, unknown>;
