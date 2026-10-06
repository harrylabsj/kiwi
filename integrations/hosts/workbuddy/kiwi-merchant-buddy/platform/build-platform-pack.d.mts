/** 类型声明：供 tests 从 TS 导入 platform/build-platform-pack.mjs。 */

export declare const CONFIG_PATH: string;
export declare const DEFAULT_OUT_DIR: string;
/** 首页标题分隔符（平台 header.title 精确格式未确认，导入实测后改这一处）。 */
export declare const HOME_TITLE_SEPARATOR: string;
/** zip 导入包内配置目录名（平台侧模板 ID 即应用 ID）。 */
export declare const ZIP_TEMPLATE_DIR: string;
export declare const SKILL_ASSET_IDS: Record<string, string | undefined>;
export declare const ICONS: Record<string, string>;

export interface PlatformTemplate {
  id: string;
  title: string;
  titleEn: string;
  prompt: string;
  promptEn: string;
}

export interface PlatformScene {
  id: string;
  title: string;
  titleEn: string;
  iconFileName: string;
  expertId: string;
  systemPromptAppend?: string;
  templates: PlatformTemplate[];
}

export interface PlatformMode {
  modeId: string;
  title: string;
  titleEn: string;
  iconFileName: string;
  systemPromptAppend: string;
  skills: Array<{ id: string }>;
  scenes: PlatformScene[];
}

export interface IndustryConfig {
  templateId: string;
  version: string;
  ui: {
    nav: {
      items: Array<{
        id: string;
        target: string;
        title: string;
        order: number;
        config: {
          header: { visible: boolean; title: string; titleEn: string };
          modes: { defaultSelected: string; items: PlatformMode[] };
        };
      }>;
    };
    chatInput: { placeholder: string };
  };
  i18n: { source: { en: Record<string, string> } };
  models: { custom: { disabled: boolean } };
  jointAuth: { connectorName: string };
  authConfig: { mcpOnly: boolean; skipJump: boolean; capabilityDescription: string };
}

export interface MarketExpert {
  id: string;
  name: string;
  nameEn: string;
  kind: "dedicated";
  categoryId: string;
  description: string;
  descriptionEn: string;
  systemPrompt: string;
  skillIds: string[];
  sceneIds: string[];
}

export interface MarketTeam {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  systemPrompt: string;
  memberExpertIds: string[];
}

export interface MarketScenario {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  expertIds: string[];
}

export interface MarketCategory {
  id: string;
  name: string;
  nameEn: string;
}

/** zip 导入包 market.json 的内容（字段名为按平台表单反推的近似格式，导入实测后修正）。 */
export interface MarketConfig {
  experts: MarketExpert[];
  expertTeams: MarketTeam[];
  featuredScenarios: MarketScenario[];
  expertCategories: MarketCategory[];
  teamCategories: MarketCategory[];
  enableExpertTeams: boolean;
  enableFeaturedScenarios: boolean;
}

/** market-draft/market-draft.json 的人读草稿（含占位说明与待回填清单）。 */
export interface MarketDraft {
  $note: string;
  experts: Array<
    MarketExpert & {
      skills: Array<{ assetId: string; assetIdIsPlaceholder: boolean }>;
      scenes: Array<{ id: string; title: string }>;
    }
  >;
  expertTeam: MarketTeam & { members: Array<{ id: string; name: string }> };
  featuredScenarios: Array<MarketScenario & { experts: Array<{ id: string; name: string }> }>;
  expertCategories: MarketCategory[];
  teamCategories: MarketCategory[];
  enableExpertTeams: boolean;
  enableFeaturedScenarios: boolean;
  pendingBackfill: string[];
}

/** 生成平台配置包；任一校验不通过即抛错（逐条列出原因）。 */
export declare function buildPlatformPack(config: unknown): {
  industryConfig: IndustryConfig;
  icons: Record<string, string>;
  warnings: string[];
  marketConfig: MarketConfig;
  marketDraft: MarketDraft;
  zipBuffer: Buffer;
};

export interface ModePackDef {
  modeKey: string;
  titleEn: string;
  icon: string;
  scenes: Array<{
    id: string;
    title: string;
    titleEn: string;
    icon: string;
    sourceCapsules: string[];
    systemPromptAppend?: string;
    templates: Array<Omit<PlatformTemplate, "id">>;
  }>;
}

export declare const MODE_PACKS: ModePackDef[];

export interface MarketExpertDef {
  id: string;
  name: string;
  nameEn: string;
  categoryId: string;
  description: string;
  descriptionEn: string;
  skills: string[];
  systemPrompt: string;
}

export declare const MARKET_EXPERTS: MarketExpertDef[];
export declare const MARKET_EXPERT_TEAM: Omit<MarketTeam, "memberExpertIds">;
export declare const MARKET_SCENARIOS: Array<MarketScenario & { memberIds: string[] }>;
export declare const MARKET_EXPERT_CATEGORIES: MarketCategory[];
/** 平台胶囊 id → 市场专家资产 id（oe_*，审核中；双向校验与 MARKET_EXPERTS 一致）。 */
export declare const SCENE_EXPERT_IDS: Record<string, string>;
