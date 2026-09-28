/**
 * WP18/WP19：平台格式配置包（industry-config.json + SVG 图标 + 市场配置 + zip）的生成与校验测试。
 * 生成器 integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs
 * 内置全部平台规则校验（不通过即抛错）；本测试额外独立断言关键规则、与 1.7.0
 * 草稿的一致性、SVG 合法性、首页标题与市场配置草稿规则、sites_deploy 新口径，
 * 以及落盘产物与即时构建结果一致（防止改配置后忘重新生成）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlatformPack,
  CONFIG_PATH,
  DEFAULT_OUT_DIR,
  HOME_TITLE_SEPARATOR,
  ICONS,
  MODE_PACKS,
  SCENE_EXPERT_IDS,
  ZIP_TEMPLATE_DIR,
} from "../integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/build-platform-pack.mjs";

const outDir = DEFAULT_OUT_DIR;
const platformDir = path.resolve(outDir, "..");

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
  version: string;
  home: {
    title: { brandName: { zh: string; en: string }; slogan: { zh: string; en: string } };
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

const { industryConfig, icons, warnings, marketConfig, marketDraft, zipBuffer } = buildPlatformPack(config);
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
    expertId: string;
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
    expect(homeItem.config.header).toEqual({
      visible: true,
      title: `Kiwi商家${HOME_TITLE_SEPARATOR}让采购专家找到你`,
      titleEn: `Kiwi Merchant${HOME_TITLE_SEPARATOR}Get found by buyers`,
    });
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

describe("WP19 首页标题", () => {
  it("中文两字段合计 ≤15 字，英文合计 ≤8 词，值取自 1.7.0 home.title", () => {
    const { brandName, slogan } = config.home.title;
    const zhLength = [...`${brandName.zh}${slogan.zh}`].length;
    expect(zhLength, "中文两字段合计字数").toBeLessThanOrEqual(15);
    const enWords = `${brandName.en} ${slogan.en}`.trim().split(/\s+/).length;
    expect(enWords, "英文两字段合计词数").toBeLessThanOrEqual(8);
    expect(homeItem.config.header.title).toBe(`${brandName.zh}${HOME_TITLE_SEPARATOR}${slogan.zh}`);
    expect(homeItem.config.header.titleEn).toBe(`${brandName.en}${HOME_TITLE_SEPARATOR}${slogan.en}`);
  });
});

describe("WP19 sites_deploy 新口径（WP17 后）", () => {
  const deprecatedPatterns = [/\binspect\b/i, /\bactivate\b/i, /(?<![\w-])deploy(?![\w-])/i] as const;

  it("一键上云胶囊的执行步骤为 取包校验→首次发布取地址→prepare --origin→同一应用再发布→自检→上线核对", () => {
    const cloud = allScenes.find((s) => s.id === "cap-cloud")!;
    expect(cloud.systemPromptAppend).toContain("取包校验→首次发布取地址→prepare --origin→同一应用再发布→自检→上线核对");
    expect(cloud.systemPromptAppend).toContain("kiwi_catalog_get_service_status");
    expect(cloud.systemPromptAppend).toContain("方案 B");
  });

  it("注册开通模式系统提示词仍为 WP17 后的 sites_deploy 流程（逐字沿用 1.7.0）", () => {
    const onboarding = modes.find((m) => m.modeId === "onboarding")!;
    expect(onboarding.systemPromptAppend).toContain("workbuddy_sites_deploy");
    expect(onboarding.systemPromptAppend).toBe(
      config.home.modes.find((m) => m.key === "onboarding")!.systemPrompt,
    );
  });

  it("生成物（行业配置 + 市场配置）不出现把 inspect/activate/deploy 当作执行步骤的文字", () => {
    const texts = [JSON.stringify(industryConfig), JSON.stringify(marketConfig)];
    for (const text of texts) {
      expect(/\binspect\b/i.test(text), "出现 inspect").toBe(false);
      expect(/\bactivate\b/i.test(text), "出现 activate").toBe(false);
      expect(/(?<![\w-])deploy(?![\w-])/i.test(text), "出现独立 deploy 步骤词").toBe(false);
    }
    // 派生词不受影响：工具名/技能名/部署文案仍应存在。
    expect(JSON.stringify(industryConfig)).toContain("workbuddy_sites_deploy");
    expect(JSON.stringify(industryConfig)).toContain("kiwi-cloud-deploy");
    expect(JSON.stringify(industryConfig)).toContain("部署失败");
  });

  it("落盘产物与 zip 内文件同样不含旧口径步骤词", () => {
    const onDisk = readFileSync(path.join(outDir, "industry-config.json"), "utf8");
    const onDiskMarket = readFileSync(path.join(outDir, "market.json"), "utf8");
    const zipText = [...readZipEntries(zipBuffer).values()].map((b) => b.toString("utf8")).join("\n");
    for (const text of [onDisk, onDiskMarket, zipText]) {
      for (const pattern of deprecatedPatterns) {
        expect(pattern.test(text), `落盘/zip 产物命中旧口径步骤词 ${pattern}`).toBe(false);
      }
    }
  });
});

describe("WP19 市场配置（5 专用专家 + 1 专家团 + 4 精选场景）", () => {
  const zhNameRe = /^[\u4e00-\u9fa5]{1,5}$/;

  it("专用专家 5 个、无公共专家，名称 ≤5 汉字、英文名 ≤30，字段完整", () => {
    const dedicated = marketConfig.experts.filter((e) => e.kind === "dedicated");
    const publicExperts = marketConfig.experts.filter((e) => e.kind !== "dedicated");
    expect(dedicated).toHaveLength(5);
    expect(publicExperts).toHaveLength(0);
    for (const expert of dedicated) {
      expect(expert.name).toMatch(zhNameRe);
      expect([...expert.nameEn].length).toBeLessThanOrEqual(30);
      expect(expert.description.trim()).not.toBe("");
      expect(expert.descriptionEn.trim()).not.toBe("");
      expect(expert.systemPrompt.trim()).not.toBe("");
      expect(expert.sceneIds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("每位专家 systemPrompt 遵守网关不碰实例/上线只认工具/不代点/不伪造边界", () => {
    for (const expert of marketConfig.experts) {
      expect(expert.systemPrompt).toContain("网关不碰实例");
      expect(expert.systemPrompt).toContain("kiwi_catalog_get_service_status");
      expect(expert.systemPrompt).toContain("不伪造任何回执");
      for (const m of expert.systemPrompt.matchAll(/\b(kiwi_[a-z0-9_]+)\b/g)) {
        expect(m[1]!.startsWith("kiwi_catalog_"), `${expert.id} 引用非目录网关工具 ${m[1]}`).toBe(true);
      }
      for (const m of expert.systemPrompt.matchAll(/\b(kiwi-[a-z0-9-]+)\b/g)) {
        expect(["kiwi-cloud-deploy", "kiwi-product-import", "kiwi-merchant-cs-prep"]).toContain(m[1]);
      }
    }
  });

  it("技能资产 ID：cs-prep 为真实资产，未知技能为 pending:<技能名> 占位（不编造）", () => {
    const byId = new Map(marketConfig.experts.map((e) => [e.id, e]));
    expect(byId.get("exp-cs-coach")!.skillIds).toEqual(["os_dc3a52407574eb77"]);
    expect(byId.get("exp-onboarding-advisor")!.skillIds).toEqual(["pending:kiwi-cloud-deploy"]);
    expect(byId.get("exp-operations-assistant")!.skillIds).toEqual(["pending:kiwi-product-import"]);
    for (const assetId of marketConfig.experts.flatMap((e) => e.skillIds)) {
      expect(/^os_[0-9a-f]{8,}$/.test(assetId) || assetId.startsWith("pending:"), assetId).toBe(true);
    }
  });

  it("专家团 1 个：由全部 5 位专用专家组成", () => {
    expect(marketConfig.expertTeams).toHaveLength(1);
    const team = marketConfig.expertTeams[0]!;
    expect(team.id).toBe("team-kiwi-launch");
    expect(team.memberExpertIds).toHaveLength(5);
    expect(new Set(team.memberExpertIds).size).toBe(5);
    expect(team.systemPrompt).toContain("网关不碰实例");
  });

  it("精选场景 4 个：每个关联 1–3 个专家/专家团，关联 id 均已定义", () => {
    expect(marketConfig.featuredScenarios).toHaveLength(4);
    const known = new Set([
      ...marketConfig.experts.map((e) => e.id),
      ...marketConfig.expertTeams.map((t) => t.id),
    ]);
    for (const scenario of marketConfig.featuredScenarios) {
      expect(scenario.expertIds.length).toBeGreaterThanOrEqual(1);
      expect(scenario.expertIds.length).toBeLessThanOrEqual(3);
      for (const id of scenario.expertIds) expect(known.has(id), `${scenario.id} → ${id}`).toBe(true);
      expect(scenario.description.trim()).not.toBe("");
      expect(scenario.descriptionEn.trim()).not.toBe("");
    }
    expect(marketConfig.featuredScenarios.map((s) => s.name)).toEqual([
      "第一次开店",
      "上传商品",
      "看懂运营报告",
      "准备接待采购",
    ]);
  });

  it("专家分类 4 个（≥3）；启用开关显式打开", () => {
    expect(marketConfig.expertCategories.length).toBeGreaterThanOrEqual(3);
    const categoryIds = new Set(marketConfig.expertCategories.map((c) => c.id));
    for (const expert of marketConfig.experts) {
      expect(categoryIds.has(expert.categoryId), expert.categoryId).toBe(true);
    }
    expect(marketConfig.enableExpertTeams).toBe(true);
    expect(marketConfig.enableFeaturedScenarios).toBe(true);
  });

  it("胶囊 expertId 与专家草稿用占位 id 对应（SCENE_EXPERT_IDS 完备且双向一致）", () => {
    for (const scene of allScenes) {
      expect(scene.expertId).toBe(SCENE_EXPERT_IDS[scene.id]!);
      expect(scene.expertId).toMatch(/^exp-[a-z-]+$/);
    }
    const byExpert = new Map(marketConfig.experts.map((e) => [e.id, [] as string[]]));
    for (const scene of allScenes) byExpert.get(scene.expertId)!.push(scene.id);
    for (const expert of marketConfig.experts) {
      expect(expert.sceneIds.sort()).toEqual(byExpert.get(expert.id)!.sort());
    }
    // 纯数据胶囊归报表分析师，其余胶囊归模式主责专家。
    const byId = new Map(marketConfig.experts.map((e) => [e.id, e]));
    expect(byId.get("exp-reports-analyst")!.sceneIds.sort()).toEqual(["cap-followers", "cap-views"]);
    expect(byId.get("exp-onboarding-advisor")!.sceneIds).toHaveLength(5);
  });

  it("所有专家/专家团/场景 id 均为显式占位（exp-/team-/scn- 前缀）", () => {
    for (const id of [
      ...marketConfig.experts.map((e) => e.id),
      ...marketConfig.expertTeams.map((t) => t.id),
      ...marketConfig.featuredScenarios.map((s) => s.id),
    ]) {
      expect(id).toMatch(/^(exp|team|scn)-[a-z-]+$/);
    }
    expect(marketDraft.pendingBackfill.length).toBeGreaterThanOrEqual(4);
    expect(marketDraft.pendingBackfill.join("\n")).toContain("占位");
    expect(marketDraft.pendingBackfill.join("\n")).toContain("pending:kiwi-cloud-deploy".slice(0, 7));
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

describe("WP18/WP19 落盘产物（platform/out、platform/market-draft）与构建结果一致", () => {
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

  it("market.json 与市场草稿 market-draft.json 均与即时构建结果一致（防漂移）", () => {
    expect(JSON.parse(readFileSync(path.join(outDir, "market.json"), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(marketConfig)),
    );
    expect(JSON.parse(readFileSync(path.join(platformDir, "market-draft", "market-draft.json"), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(marketDraft)),
    );
    expect(existsSync(path.join(platformDir, "market-draft", "README.md"))).toBe(true);
    const draftReadme = readFileSync(path.join(platformDir, "market-draft", "README.md"), "utf8");
    expect(draftReadme).toContain("team-kiwi-launch");
    expect(draftReadme).toContain("占位");
  });

  it("out/ 目录无陈旧文件（恰好 4 项：industry-config.json / icons / market.json / platform-pack.zip）", () => {
    expect(readdirSync(outDir).sort()).toEqual([
      "icons",
      "industry-config.json",
      "market.json",
      "platform-pack.zip",
    ]);
  });

  it("platform-pack.zip 条目集合与内容正确：<templateId>/ 配置 + 24 图标 + market.json", () => {
    const zipOnDisk = readFileSync(path.join(outDir, "platform-pack.zip"));
    expect(zipOnDisk.equals(zipBuffer), "落盘 zip 与构建结果字节一致").toBe(true);
    const entries = readZipEntries(zipBuffer);
    const expectedNames = [
      `${ZIP_TEMPLATE_DIR}/industry-config.json`,
      ...Object.keys(icons).map((name) => `${ZIP_TEMPLATE_DIR}/icons/${name}`),
      "market.json",
    ].sort();
    expect([...entries.keys()].sort()).toEqual(expectedNames);
    expect(
      entries.get(`${ZIP_TEMPLATE_DIR}/industry-config.json`)!.toString("utf8"),
    ).toEqual(readFileSync(path.join(outDir, "industry-config.json"), "utf8"));
    expect(entries.get("market.json")!.toString("utf8")).toEqual(
      readFileSync(path.join(outDir, "market.json"), "utf8"),
    );
    for (const [name, svg] of Object.entries(icons)) {
      expect(entries.get(`${ZIP_TEMPLATE_DIR}/icons/${name}`)!.toString("utf8")).toBe(`${svg}\n`);
    }
  });
});

/** 最小 zip 读取（配合生成器内最小 zip 写入做防漂移/内容断言）：扫描 local file header。 */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let pos = 0;
  while (pos < buf.length - 4) {
    if (buf.readUInt32LE(pos) !== 0x04034b50) {
      pos += 1;
      continue;
    }
    const flags = buf.readUInt16LE(pos + 6)!;
    const method = buf.readUInt16LE(pos + 8)!;
    const size = buf.readUInt32LE(pos + 18)!;
    const nameLength = buf.readUInt16LE(pos + 26)!;
    const extraLength = buf.readUInt16LE(pos + 28)!;
    const name = buf.subarray(pos + 30, pos + 30 + nameLength).toString("utf8");
    expect(flags & 0x08, `zip 条目 ${name} 不应使用 streaming flag`).toBe(0);
    expect(method, `zip 条目 ${name} 应为 store 方式`).toBe(0);
    const dataStart = pos + 30 + nameLength + extraLength;
    entries.set(name, buf.subarray(dataStart, dataStart + size));
    pos = dataStart + size;
  }
  return entries;
}
