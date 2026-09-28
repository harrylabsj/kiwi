/**
 * WP12：Buddy 应用配置草稿的结构断言（任务书要求：4 模式、每模式胶囊 ≥5）。
 * 同时校验 skills 引用一致：模式 skills / 胶囊 bindSkills / market.skills
 * 都必须指向 skills/ 下真实存在的技能目录。
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
  home: { modes: Array<{ key: string; name: string; skills?: string[]; capsules: Array<{ label: string; prompt: string; bindSkills?: string[] }> }> };
  market: { skills: string[] };
};

describe("Buddy 应用配置（buddy-app.config.json）", () => {
  it("恰好 4 个工作模式，每个模式胶囊 ≥5（平台规则）", () => {
    const modes = config.home.modes;
    expect(modes).toHaveLength(4);
    expect(modes.map((m) => m.key)).toEqual(["onboarding", "operations", "visibility", "cs-prep"]);
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
    const operations = config.home.modes.find((m) => m.key === "operations");
    expect(operations?.capsules.find((c) => c.label === "整理商品")?.bindSkills).toEqual(["kiwi-product-import"]);
  });

  it("版本保持 1.7.0（WP12 不单独升版，发版时统一升）", () => {
    expect(config.version).toBe("1.7.0");
  });
});
