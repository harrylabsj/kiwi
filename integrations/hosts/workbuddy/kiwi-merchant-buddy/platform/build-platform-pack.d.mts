/** 类型声明：供 tests 从 TS 导入 platform/build-platform-pack.mjs。 */

export declare const CONFIG_PATH: string;
export declare const DEFAULT_OUT_DIR: string;
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
          header: { visible: boolean; title: string };
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

/** 生成平台配置包；任一校验不通过即抛错（逐条列出原因）。 */
export declare function buildPlatformPack(config: unknown): {
  industryConfig: IndustryConfig;
  icons: Record<string, string>;
  warnings: string[];
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
