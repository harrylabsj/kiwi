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
          en: { "home.header.titleEn": "Kiwi Merchant Agent" } as Record<string, string>,
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

  it("本地新增的模板/胶囊/模式会被逐一点名（live 侧单向遍历的盲区）", () => {
    const localExtra = localFixture("same prompt");
    const extraTemplate = {
      id: "t3",
      title: "本地新模板",
      prompt: "本地新模板提示词",
      titleEn: "Local-only template",
      promptEn: "Local-only template prompt",
    };
    localExtra.industryConfig.ui.nav.items[0]!.config.modes.items[0]!.scenes[0]!.templates.push(
      extraTemplate,
    );
    const local = normalizeLocal(localExtra);
    const live = normalizeExport(exportFixture("same prompt"));
    // live 2 项、本地 3 项：count 必须报，且新模板要以 id 点名（这是门禁此前
    // 完全看不见的场景——内容存在但导入包只遍历 base，会把它静默丢弃）。
    const diffs = diffPlatformConfigs(live, local);
    expect(diffs.some((diff) => diff.path === "modes.onboarding.scenes.cap-register.templates.count")).toBe(true);
    expect(diffs.some((diff) => diff.path === "modes.onboarding.scenes.cap-register.templates.t3")).toBe(true);
    expect(diffs.find((diff) => diff.path === "modes.onboarding.scenes.cap-register.templates.t3"))
      .toMatchObject({ live: "missing", local: "present" });

    // 本地新增胶囊 / 模式：count 之外也要能点名。
    const localExtraScene = localFixture("same prompt");
    localExtraScene.industryConfig.ui.nav.items[0]!.config.modes.items[0]!.scenes.push({
      id: "cap-extra",
      title: "本地新胶囊",
      systemPromptAppend: "extra",
      templates: [],
    });
    const sceneDiffs = diffPlatformConfigs(live, normalizeLocal(localExtraScene));
    expect(sceneDiffs.some((diff) => diff.path === "modes.onboarding.scenes.count")).toBe(true);
    expect(sceneDiffs.some((diff) => diff.path === "modes.onboarding.scenes.cap-extra")).toBe(true);

    const localExtraMode = localFixture("same prompt");
    localExtraMode.industryConfig.ui.nav.items[0]!.config.modes.items.push({
      modeId: "extra-mode",
      title: "本地新模式",
      systemPromptAppend: "extra",
      skills: [],
      scenes: [],
    });
    const modeDiffs = diffPlatformConfigs(live, normalizeLocal(localExtraMode));
    expect(modeDiffs.some((diff) => diff.path === "modes.count")).toBe(true);
    expect(modeDiffs.some((diff) => diff.path === "modes.extra-mode")).toBe(true);
  });

  it("英文文案纳入对比：en 占位符与模板 en 文案漂移可见", () => {
    const localEn = localFixture("same prompt");
    // fixture 的字面量类型没有 en 字段；按运行时真实结构宽化后写入。
    const localChatInput = localEn.industryConfig.ui.chatInput as Record<string, unknown>;
    localChatInput.placeholderEn = "本地英文占位符";
    const localTemplate = localEn.industryConfig.ui.nav.items[0]!.config.modes.items[0]!.scenes[0]!
      .templates[0]! as unknown as Record<string, unknown>;
    localTemplate.promptEn = "Local prompt for t1";
    const liveEn = exportFixture("same prompt");
    const liveEnMap = liveEn.industryConfig.i18n.source.en as Record<string, string>;
    liveEnMap["home.chatInput.placeholder"] = "Live English placeholder";
    liveEnMap["home.scenes.cap-register.templates.t1.prompt"] = "Live English prompt";
    const diffs = diffPlatformConfigs(normalizeExport(liveEn), normalizeLocal(localEn));
    expect(diffs.some((diff) => diff.path === "chat.placeholderEn")).toBe(true);
    expect(
      diffs.some(
        (diff) => diff.path === "modes.onboarding.scenes.cap-register.templates.t1.promptEn",
      ),
    ).toBe(true);
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

  it("loadExport 支持 zip 输入（readZipEntry 分支）", () => {
    // 该 zip 是平台草稿导出，内容与快照目录的正式导出不同——只验证 zip 解析
    // 路径可用且结构完整，不与目录结果比对。
    const zipPath = path.join(snapshot, "platform-draft-1.8.2-export.zip");
    const fromZip = runDiff({ exportPath: zipPath, localOutDir: localOut });
    expect(fromZip.schema).toBe("kiwi.workbuddy.platform-export-diff.v1");
    expect(fromZip.export_path.endsWith("platform-draft-1.8.2-export.zip")).toBe(true);
    expect(fromZip.live_market.sceneCount).toBeGreaterThan(0);
    expect(Number.isFinite(fromZip.diff_count)).toBe(true);
  });

  it("CLI 缺参或把 flag 当值时按用法错误退出", () => {
    expect(() => execFileSync(process.execPath, [script], { encoding: "utf8" })).toThrow();
    // `--export --json`：值以 -- 开头，视为缺参而不是把 --json 当路径。
    expect(() =>
      execFileSync(process.execPath, [script, "--export", "--json"], { encoding: "utf8" }),
    ).toThrow();
  });
});
