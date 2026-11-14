/** 类型声明：供 tests 从 TS 导入 diff-workbuddy-export.mjs。 */

export declare const DEFAULT_LOCAL_OUT: string;

export interface NormalizedMode {
  id: string;
  title: string;
  prompt: string;
  skills: string[];
  scenes: Array<{
    id: string;
    title: string;
    prompt: string;
    templates: Array<{ id: string; title: string; prompt: string }>;
  }>;
}

export interface NormalizedConfig {
  header: { title: string; titleEn: string };
  brand?: string;
  chatPlaceholder?: string;
  models?: unknown;
  authConfig?: unknown;
  jointAuth?: unknown;
  modes: NormalizedMode[];
  market: {
    schema: string;
    sceneExpertCounts: Array<{ name: string; experts: number }>;
    sceneCount: number;
    expertIdPrefix: string;
  };
}

export interface ConfigDiff {
  path: string;
  live_sha256?: string;
  local_sha256?: string;
  live_length?: number;
  local_length?: number;
  live_preview?: string;
  local_preview?: string;
  live?: unknown;
  local?: unknown;
}

export declare function loadExport(inputPath: string): {
  industryConfig: unknown;
  marketConfig: unknown;
};

export declare function normalizeExport(input: { industryConfig: unknown; marketConfig: unknown }): NormalizedConfig;

export declare function normalizeLocal(input: { industryConfig: unknown; marketConfig: unknown }): NormalizedConfig;

export declare function diffPlatformConfigs(live: NormalizedConfig, local: NormalizedConfig): ConfigDiff[];

export declare function runDiff(input: { exportPath: string; localOutDir?: string }): {
  schema: string;
  export_path: string;
  local_out: string;
  ok: boolean;
  diff_count: number;
  diffs: ConfigDiff[];
  live_market: NormalizedConfig["market"];
  local_market: NormalizedConfig["market"];
  market_note: string;
};
