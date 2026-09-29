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
  home: { modes: Array<{ key: string; name: string; systemPrompt: string; skills?: string[]; capsules: Array<{ label: string; prompt: string; bindSkills?: string[] }> }> };
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

  it("版本为 1.8.0（东哥四工作场景重排）", () => {
    expect(config.version).toBe("1.8.0");
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
