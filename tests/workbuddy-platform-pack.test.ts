/**
 * WP18：平台格式配置包（industry-config.json + SVG 图标）的生成与校验测试。
 * 生成器 integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs
 * 内置全部平台规则校验（不通过即抛错）；本测试额外独立断言关键规则、与 1.7.0
 * 草稿的一致性、SVG 合法性，以及落盘产物与即时构建结果一致（防止改配置后忘重新生成）。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlatformPack,
  CONFIG_PATH,
  DEFAULT_OUT_DIR,
  ICONS,
  MODE_PACKS,
} from "../integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs";

const outDir = DEFAULT_OUT_DIR;

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
  version: string;
  home: {
    modes: Array<{
      key: string;
      name: string;
      systemPrompt: string;
      tools: string[];
      skills?: string[];
      capsules: Array<{ label: string; prompt: string }>;
    }>;
    内置连接器: string;
  };
  misc: { 输入框占位符: { zh: string; en: string }; 绑定应用授权文案: string };
};

const { industryConfig, icons, warnings } = buildPlatformPack(config);
const homeItem = industryConfig.ui.nav.items[0]!;
const modes = homeItem.config.modes.items as Array<{
  modeId: string;
  title: string;
  titleEn: string;
  iconFileName: string;
  systemPromptAppend: string;
  skills: Array<{ id: string }>;
  scenes: Array<{
    id: string;
    title: string;
    titleEn: string;
    iconFileName: string;
    systemPromptAppend?: string;
    templates: Array<{ id: string; title: string; titleEn: string; prompt: string; promptEn: string }>;
  }>;
}>;
const allScenes = modes.flatMap((m) => m.scenes);

describe("WP18 平台配置包：平台规则", () => {
  it("顶层结构与固定字段符合平台 importer 格式", () => {
    expect(industryConfig.templateId).toBe("");
    expect(industryConfig.version).toBe("1.0.0");
    expect(industryConfig.ui.nav.items).toHaveLength(1);
    expect(homeItem).toMatchObject({
      id: "home",
      target: "builtin:new_task",
      title: "conversation.newTask",
      order: 10,
    });
    expect(homeItem.config.header).toEqual({ visible: true, title: "" });
    expect(industryConfig.models).toEqual({ custom: { disabled: true } });
    expect(industryConfig.i18n).toEqual({ source: { en: {} } });
  });

  it("工作模式 3–5 个，每个 ≥5 个胶囊，模式 systemPrompt 必填", () => {
    expect(modes.length).toBeGreaterThanOrEqual(3);
    expect(modes.length).toBeLessThanOrEqual(5);
    expect(modes.map((m) => m.modeId)).toEqual(["onboarding", "operations", "visibility", "cs-prep"]);
    for (const mode of modes) {
      expect(mode.scenes.length, `${mode.modeId} 胶囊数`).toBeGreaterThanOrEqual(5);
      expect(mode.systemPromptAppend.trim()).not.toBe("");
    }
  });

  it("每个胶囊只属于一个模式（scene id 全局唯一），每胶囊 4–10 条模板且字段完整", () => {
    const sceneIds = allScenes.map((s) => s.id);
    expect(new Set(sceneIds).size).toBe(sceneIds.length);
    for (const scene of allScenes) {
      expect(scene.templates.length, `${scene.id} 模板数`).toBeGreaterThanOrEqual(4);
      expect(scene.templates.length, `${scene.id} 模板数`).toBeLessThanOrEqual(10);
      for (const t of scene.templates) {
        expect(t.title.trim()).not.toBe("");
        expect(t.titleEn.trim()).not.toBe("");
        expect(t.prompt.trim()).not.toBe("");
        expect(t.promptEn.trim()).not.toBe("");
      }
    }
    const templateIds = allScenes.flatMap((s) => s.templates.map((t) => t.id));
    expect(new Set(templateIds).size).toBe(templateIds.length);
    expect(templateIds).toHaveLength(80); // 20 胶囊 × 4 条
  });

  it("模式与胶囊名称 ≤5 个汉字、英文名 ≤30；图标文件名都已备好", () => {
    for (const mode of modes) {
      expect(mode.title).toMatch(/^[\u4e00-\u9fa5]{1,5}$/);
      expect([...mode.titleEn].length).toBeLessThanOrEqual(30);
      expect(icons[mode.iconFileName]).toBeTruthy();
    }
    for (const scene of allScenes) {
      expect(scene.title).toMatch(/^[\u4e00-\u9fa5]{1,5}$/);
      expect([...scene.titleEn].length).toBeLessThanOrEqual(30);
      expect(icons[scene.iconFileName]).toBeTruthy();
    }
  });

  it("不包含平台不可导入的键（bindTools/bindSkills/inspirationIds）与已撤回连接器", () => {
    const bannedKeys = new Set(["bindTools", "bindSkills", "inspirationIds"]);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          expect(bannedKeys.has(key), `输出包含禁止键 ${key}`).toBe(false);
          walk(value);
        }
      }
    };
    walk(industryConfig);
    expect(JSON.stringify(industryConfig)).not.toContain("oc_c86216e2a36110bf");
  });

  it("模板不承诺免费/7×24（禁词表）", () => {
    const banned = [/免费/, /7×24/, /7x24/i, /全天候/, /\bfor free\b/i, /\bfree of charge\b/i, /\bfree plan\b/i];
    for (const t of allScenes.flatMap((s) => s.templates)) {
      const text = `${t.title}\n${t.titleEn}\n${t.prompt}\n${t.promptEn}`;
      for (const pattern of banned) {
        expect(pattern.test(text), `模板 ${t.id} 命中禁词 ${pattern}`).toBe(false);
      }
    }
  });
});

describe("WP18 平台配置包：与 1.7.0 草稿一致性", () => {
  it("模式 systemPromptAppend 逐字沿用 1.7.0 系统提示词，模式名沿用原中文名", () => {
    for (const mode of modes) {
      const source = config.home.modes.find((m) => m.key === mode.modeId);
      expect(source).toBeTruthy();
      expect(mode.systemPromptAppend).toBe(source!.systemPrompt);
      expect(mode.title).toBe(source!.name);
    }
  });

  it("1.7.0 的每个胶囊都被恰好一个平台胶囊覆盖（映射表 sourceCapsules 完备且不重复）", () => {
    const sourceLabels = config.home.modes.flatMap((m) => m.capsules.map((c) => c.label));
    const covered: string[] = [];
    for (const pack of MODE_PACKS) {
      const sourceMode = config.home.modes.find((m) => m.key === pack.modeKey)!;
      const labels = new Set(sourceMode.capsules.map((c) => c.label));
      for (const scene of pack.scenes) {
        for (const label of scene.sourceCapsules) {
          expect(labels.has(label), `${pack.modeKey} 下不存在源胶囊「${label}」`).toBe(true);
          covered.push(label);
        }
      }
    }
    expect(new Set(covered).size).toBe(covered.length); // 每个源胶囊只归一个平台胶囊
    expect(covered.sort()).toEqual([...sourceLabels].sort()); // 一个不漏
  });

  it("胶囊 systemPromptAppend 中的工具/技能指引不超出 1.7.0 该模式的 tools/skills", () => {
    const toolRe = /\b(kiwi_[a-z0-9_]+)\b/g;
    const skillRe = /\b(kiwi-(?:cloud-deploy|product-import|merchant-cs-prep))\b/g;
    for (const mode of modes) {
      const source = config.home.modes.find((m) => m.key === mode.modeId)!;
      const tools = new Set(source.tools);
      const skills = new Set(source.skills ?? []);
      for (const scene of mode.scenes) {
        for (const m of scene.systemPromptAppend?.matchAll(toolRe) ?? []) {
          expect(tools.has(m[1]!), `${scene.id} 引用 ${mode.modeId} 之外的工具 ${m[1]}`).toBe(true);
        }
        for (const m of scene.systemPromptAppend?.matchAll(skillRe) ?? []) {
          expect(skills.has(m[1]!), `${scene.id} 引用 ${mode.modeId} 之外的技能 ${m[1]}`).toBe(true);
        }
      }
    }
  });

  it("输入框占位符、授权文案、连接器与 1.7.0 一致；连接器为在用资产 ID", () => {
    expect(industryConfig.ui.chatInput.placeholder).toBe(config.misc.输入框占位符.zh);
    expect(industryConfig.authConfig).toEqual({
      mcpOnly: true,
      skipJump: false,
      capabilityDescription: config.misc.绑定应用授权文案,
    });
    expect([...industryConfig.authConfig.capabilityDescription].length).toBeLessThanOrEqual(30);
    expect(industryConfig.jointAuth.connectorName).toBe("oc_0053ad85c92a6587");
    expect(config.home.内置连接器).toContain("oc_0053ad85c92a6587");
  });

  it("技能挂载：cs-prep 有平台资产 ID；其余两个技能缺 ID 时省略并给出警告", () => {
    const byMode = new Map(modes.map((m) => [m.modeId, m.skills]));
    expect(byMode.get("cs-prep")).toEqual([{ id: "os_dc3a52407574eb77" }]);
    expect(byMode.get("onboarding")).toEqual([]);
    expect(byMode.get("operations")).toEqual([]);
    expect(warnings.join("\n")).toContain("kiwi-cloud-deploy");
    expect(warnings.join("\n")).toContain("kiwi-product-import");
  });

  it("默认模式为注册开通（1.7.0 首个模式）", () => {
    expect(homeItem.config.modes.defaultSelected).toBe("onboarding");
    expect(modes[0]!.modeId).toBe("onboarding");
  });
});

describe("WP18 SVG 图标", () => {
  it("图标字典与 JSON 引用一一对应（4 模式 + 20 胶囊 = 24 个，无多余）", () => {
    const referenced = new Set<string>([
      ...modes.map((m) => m.iconFileName),
      ...allScenes.map((s) => s.iconFileName),
    ]);
    expect(referenced.size).toBe(24);
    expect(new Set(Object.keys(icons))).toEqual(referenced);
    expect(Object.keys(ICONS)).toHaveLength(24);
  });

  it("每个 SVG：48×48 viewBox、可解析、无文字/脚本/外部引用、<4KB", () => {
    for (const [name, svg] of Object.entries(icons)) {
      expect(svg.startsWith("<svg "), name).toBe(true);
      expect(svg.endsWith("</svg>"), name).toBe(true);
      expect(svg).toContain('viewBox="0 0 48 48"');
      const lower = svg.toLowerCase();
      for (const banned of ["<script", "<text", "<image", "<foreignobject", "href=", "xlink:", "url(", "<use", "data:", "javascript:"]) {
        expect(lower.includes(banned), `${name} 含禁止内容 ${banned}`).toBe(false);
      }
      // 标签配对：非自闭合标签入栈，闭合标签必须匹配。
      const stack: string[] = [];
      for (const m of svg.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g)) {
        if (m[1] === "/") {
          expect(stack.pop(), `${name} 多余的闭合标签 </${m[2]}>`).toBe(m[2]);
        } else if (!/\/\s*$/.test(m[3]!)) {
          stack.push(m[2]!);
        }
      }
      expect(stack, `${name} 有未闭合标签`).toEqual([]);
      expect(Buffer.byteLength(svg, "utf8"), `${name} 应 <4KB`).toBeLessThan(4096);
    }
  });
});

describe("WP18 落盘产物（platform/out）与构建结果一致", () => {
  it("industry-config.json 与即时构建结果完全一致（防漂移）", () => {
    const onDisk = readFileSync(path.join(outDir, "industry-config.json"), "utf8");
    expect(JSON.parse(onDisk)).toEqual(JSON.parse(JSON.stringify(industryConfig)));
  });

  it("icons/ 目录文件集合与内容一一对应，无多余文件", () => {
    const files = readdirSync(path.join(outDir, "icons"));
    expect(files.sort()).toEqual([...Object.keys(icons)].sort());
    for (const [name, svg] of Object.entries(icons)) {
      expect(readFileSync(path.join(outDir, "icons", name), "utf8").trim()).toBe(svg);
    }
  });
});
