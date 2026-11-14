/**
 * 平台导出配置 vs 本仓生成器的差异工具。
 * 只验证可对齐的文本字段；市场配置的 ex_/oe_ 结构差异单独报告，不算文本差异。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffPlatformConfigs, normalizeExport, normalizeLocal, runDiff } from "../scripts/diff-workbuddy-export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/diff-workbuddy-export.mjs");
const snapshot = path.join(
  root,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/platform-export/2026-11-14",
);
const localOut = path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/out");

function exportFixture(prompt: string) {
  return {
    industryConfig: {
      brand: { title: "brand.title" },
      ui: {
        nav: {
          items: [
            {
              id: "home",
              config: {
                header: { title: "home.header.title", titleEn: "home.header.titleEn" },
                modes: {
                  items: [
                    {
                      modeId: "onboarding",
                      title: "home.modes.onboarding.title",
                      systemPromptAppend: prompt,
                      skills: [{ id: "os_1ea25f81ce98fea3" }],
                      scenes: [
                        {
                          id: "cap-register",
                          title: "home.scenes.cap-register.title",
                          systemPromptAppend: "live scene prompt",
                          templates: [
                            {
                              id: "t1",
                              title: "home.scenes.cap-register.templates.t1.title",
                              prompt: "home.scenes.cap-register.templates.t1.prompt",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
        chatInput: { placeholder: "home.chatInput.placeholder" },
      },
      i18n: {
        source: {
          "zh-CN": {
            "brand.title": "Kiwi商家智能体",
            "home.header.title": "Kiwi商家智能体·生意自主进行",
            "home.chatInput.placeholder": "问问我：注册开通",
            "home.modes.onboarding.title": "注册开通",
            "home.scenes.cap-register.title": "注册账号",
            "home.scenes.cap-register.templates.t1.title": "新商家注册",
            "home.scenes.cap-register.templates.t1.prompt": "帮我注册",
          },
          en: { "home.header.titleEn": "Kiwi Merchant Agent" },
        },
      },
    },
    marketConfig: {
      body: {
        type: "market",
        children: [
          {
            type: "collection",
            subType: "expert-featured",
            children: [
              {
                type: "category",
                name: { zh: "第一次开店" },
                children: [
                  { type: "unit", id: "ex_a" },
                  { type: "unit", id: "ex_b" },
                  { type: "unit", id: "ex_c" },
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

function localFixture(prompt: string) {
  return {
    industryConfig: {
      ui: {
        nav: {
          items: [
            {
              id: "home",
              config: {
                header: { title: "Kiwi商家智能体·本地测试", titleEn: "Kiwi Merchant Agent·Let business run itself" },
                modes: {
                  items: [
                    {
                      modeId: "onboarding",
                      title: "注册开通",
                      systemPromptAppend: prompt,
                      skills: [{ id: "os_1ea25f81ce98fea3" }],
                      scenes: [
                        {
                          id: "cap-register",
                          title: "注册账号",
                          systemPromptAppend: "local scene prompt",
                          templates: [{ id: "t1", title: "新商家注册", prompt: "帮我注册" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
        chatInput: { placeholder: "问问我：注册开通" },
      },
    },
    marketConfig: {
      featuredScenarios: [{ name: "第一次开店", expertIds: ["oe_a", "oe_b"] }],
    },
  };
}

describe("WorkBuddy 平台导出差异工具", () => {
  it("能对齐模式/胶囊/模板文本，并单独总结市场结构", () => {
    const live = normalizeExport(exportFixture("live prompt"));
    const local = normalizeLocal(localFixture("local prompt"));
    expect(live.modes[0]!.scenes[0]!.templates[0]!.prompt).toBe("帮我注册");
    expect(live.market.sceneExpertCounts).toEqual([{ name: "第一次开店", experts: 3 }]);
    expect(local.market.sceneExpertCounts).toEqual([{ name: "第一次开店", experts: 2 }]);
    const diffs = diffPlatformConfigs(live, local);
    expect(diffs.map((diff) => diff.path)).toEqual(
      expect.arrayContaining(["header.title", "modes.onboarding.systemPrompt", "modes.onboarding.scenes.cap-register.systemPrompt"]),
    );
    expect(diffs.some((diff) => diff.path.includes("market"))).toBe(false);
  });

  it("CLI 可对比 2026-11-14 快照并输出稳定 JSON", () => {
    const stdout = execFileSync(
      process.execPath,
      [script, "--export", snapshot, "--local", localOut, "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout) as ReturnType<typeof runDiff>;
    expect(result.ok).toBe(false);
    expect(result.diff_count).toBeGreaterThan(0);
    expect(result.live_market.sceneCount).toBe(4);
    expect(result.local_market.sceneCount).toBe(4);
    expect(result.live_market.sceneExpertCounts.every((scene) => scene.experts === 3)).toBe(true);
    expect(result.local_market.sceneExpertCounts.every((scene) => scene.experts === 2)).toBe(true);
    expect(result.diffs.some((diff) => diff.path === "header.title")).toBe(true);
  });
});
