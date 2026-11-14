/**
 * WP12/WP25：Buddy 应用配置草稿的结构断言（任务书要求：4 模式、每模式胶囊 ≥5）。
 * 同时校验 skills 引用一致：模式 skills / 胶囊 bindSkills / market.skills
 * 都必须指向 skills/ 下真实存在的技能目录；三个技能的模式归属符合东哥四场景分工。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const buddyRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../integrations/hosts/workbuddy/kiwi-merchant-buddy",
);
const config = JSON.parse(
  readFileSync(path.join(buddyRoot, "buddy-app.config.json"), "utf8"),
) as {
  version: string;
  home: {
    "内置连接器": string;
    modes: Array<{ key: string; name: string; description: string; systemPrompt: string; skills?: string[]; capsules: Array<{ label: string; prompt: string; bindSkills?: string[] }> }>;
  };
  market: { skills: string[] };
};

describe("Buddy 应用配置（buddy-app.config.json）", () => {
  it("恰好 4 个工作模式（东哥四场景），每个模式胶囊 ≥5（平台规则）", () => {
    const modes = config.home.modes;
    expect(modes).toHaveLength(4);
    expect(modes.map((m) => m.key)).toEqual(["onboarding", "catalog", "insights", "negotiation"]);
    expect(modes.map((m) => m.name)).toEqual(["注册开通", "商品报价", "运营分析", "审批磋商"]);
    for (const mode of modes) {
      expect(mode.capsules.length, `${mode.key} 胶囊数`).toBeGreaterThanOrEqual(5);
      for (const capsule of mode.capsules) {
        expect(capsule.label.trim()).not.toBe("");
        expect(capsule.prompt.trim()).not.toBe("");
      }
    }
  });

  it("模式 skills 引用的技能目录都真实存在（含 SKILL.md）", () => {
    for (const mode of config.home.modes) {
      for (const skill of mode.skills ?? []) {
        expect(
          existsSync(path.join(buddyRoot, "skills", skill, "SKILL.md")),
          `${mode.key} 引用的技能 ${skill} 缺 SKILL.md`,
        ).toBe(true);
      }
    }
  });

  it("三个技能的模式归属符合东哥四场景分工", () => {
    const byKey = new Map(config.home.modes.map((m) => [m.key, m.skills ?? []]));
    expect(byKey.get("onboarding")).toEqual(["kiwi-cloud-deploy"]);
    expect(byKey.get("catalog")).toEqual(["kiwi-product-import"]);
    expect(byKey.get("insights")).toEqual(["kiwi-merchant-cs-prep"]);
    expect(byKey.get("negotiation")).toEqual([]);
  });

  it("market.skills 包含全部模式 skills，且同样指向真实技能目录", () => {
    const modeSkills = new Set(config.home.modes.flatMap((mode) => mode.skills ?? []));
    for (const skill of modeSkills) {
      expect(config.market.skills, `market.skills 缺 ${skill}`).toContain(skill);
    }
    for (const skill of config.market.skills) {
      expect(existsSync(path.join(buddyRoot, "skills", skill, "SKILL.md")), `${skill} 缺 SKILL.md`).toBe(true);
    }
  });

  it("胶囊 bindSkills ⊆ 所在模式的 skills（整理商品 → kiwi-product-import）", () => {
    for (const mode of config.home.modes) {
      const modeSkills = new Set(mode.skills ?? []);
      for (const capsule of mode.capsules) {
        for (const skill of capsule.bindSkills ?? []) {
          expect(modeSkills.has(skill), `${mode.key} 胶囊「${capsule.label}」绑定未列入模式 skills 的技能 ${skill}`).toBe(true);
        }
      }
    }
    const catalog = config.home.modes.find((m) => m.key === "catalog");
    expect(catalog?.capsules.find((c) => c.label === "整理商品")?.bindSkills).toEqual(["kiwi-product-import"]);
  });

  it("版本为 1.8.2（四工作场景 + P0 审核修复 + 合并线上 V5）", () => {
    expect(config.version).toBe("1.8.2");
  });

  it("1.8.2 合并线上 V5：品牌/标题/简介与模型配置引导", () => {
    expect((config as unknown as { identity: { appName: string; appNameEn: string; 简介: string } }).identity).toMatchObject({
      appName: "kiwi商家智能体",
      appNameEn: "Kiwi Merchant Agent",
    });
    expect((config as unknown as { home: { title: { brandName: { zh: string }; slogan: { zh: string } } } }).home.title).toMatchObject({
      brandName: { zh: "Kiwi商家智能体" },
      slogan: { zh: "生意自主进行" },
    });
    for (const mode of config.home.modes) {
      expect(mode.systemPrompt, `${mode.key} 缺模型配置引导`).toContain("模型配置引导");
    }
    expect(config.home.modes.find((m) => m.key === "onboarding")!.systemPrompt).toContain("技能与运行状态");
    expect(config.home.modes.find((m) => m.key === "catalog")!.systemPrompt).toContain("技能与工具边界");
    expect(config.home.modes.find((m) => m.key === "insights")!.systemPrompt).toContain("技能与工具边界");
    expect(JSON.stringify(config)).not.toContain("商品导入表整理技能当前未获平台发布");
  });

  it("1.8.1 上线边界：不宣称买家可发现/可询价，内置连接器状态与台账一致", () => {
    const onboarding = config.home.modes.find((m) => m.key === "onboarding")!;
    expect(onboarding.description).not.toContain("让采购方发现你并直接发来询价");
    expect(onboarding.systemPrompt).toContain("名片已发布、连接正常");
    expect(onboarding.systemPrompt).toContain("不要据此说买家已能搜索到你或发来询价");
    expect(onboarding.systemPrompt).not.toContain("采购方可以发现你并发来询价");
    expect(config.home["内置连接器"]).toContain("v1.2.0");
  });

  it("③④（运营分析/审批磋商）系统提示词写明首发边界：工作台 + 网关不碰实例 + 不编造数据", () => {
    for (const key of ["insights", "negotiation"]) {
      const mode = config.home.modes.find((m) => m.key === key)!;
      expect(mode.systemPrompt, `${key} 缺「首发边界」`).toContain("首发边界");
      expect(mode.systemPrompt, `${key} 缺「工作台」引导`).toContain("工作台");
      expect(mode.systemPrompt, `${key} 缺「网关不碰实例」`).toContain("网关不碰实例");
      expect(mode.systemPrompt, `${key} 缺「不编造」口径`).toContain("不编造");
      expect(mode.systemPrompt, `${key} 缺「不直接读取实例数据」`).toContain("不直接读取实例数据");
    }
  });
});
