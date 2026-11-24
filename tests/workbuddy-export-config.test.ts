/**
 * 平台导入格式转换：以平台导出为模板，叠加本仓的候选文案，同时保留
 * templateId/version/brand/icon/expert 关联等平台专属字段。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertToPlatformImport } from "../scripts/export-workbuddy-config.mjs";
import { diffPlatformConfigs, normalizeExport, normalizeLocal } from "../scripts/diff-workbuddy-export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buddyRoot = path.join(root, "integrations/hosts/workbuddy/kiwi-merchant-buddy");
const base = JSON.parse(
  readFileSync(path.join(buddyRoot, "platform/platform-export/2026-11-14/industry-config.json"), "utf8"),
);
const local = JSON.parse(readFileSync(path.join(buddyRoot, "platform/out/industry-config.json"), "utf8"));
const market = JSON.parse(
  readFileSync(path.join(buddyRoot, "platform/platform-export/2026-11-14/market.json"), "utf8"),
);

describe("WorkBuddy 平台导入格式转换", () => {
  it("转换后文本与本仓生成结果一致，仅保留平台格式差异", () => {
    const converted = convertToPlatformImport(base, local);
    const diffs = diffPlatformConfigs(normalizeExport({ industryConfig: converted, marketConfig: market }), normalizeLocal({
      industryConfig: local,
      marketConfig: JSON.parse(readFileSync(path.join(buddyRoot, "platform/out/market.json"), "utf8")),
    }));
    expect(diffs.map((diff) => diff.path)).toEqual(["jointAuth"]);
  });

  it("基于 V7 生成候选时保留平台配置与模板 ID，不修改 V7 归档", () => {
    const snapshot = readFileSync(path.join(buddyRoot, "platform/platform-export/2026-11-24/industry-config.json"));
    expect(readFileSync(path.join(buddyRoot, "platform/import/industry-config.platform-import.json"))).toEqual(snapshot);
    const v7 = JSON.parse(snapshot.toString("utf8"));
    const candidate = convertToPlatformImport(v7, local, { onboardingRefresh: true }) as typeof v7;
    for (const field of ["templateId", "version", "brand", "models", "jointAuth", "authConfig"]) {
      expect(candidate[field]).toEqual(v7[field]);
    }
    expect(candidate.ui.chatInput).toEqual(v7.ui.chatInput);

    const v7Home = v7.ui.nav.items[0].config;
    const home = candidate.ui.nav.items[0].config;
    expect(home.header).toEqual(v7Home.header);
    const [onboarding, catalog, insights, negotiation] = home.modes.items;
    expect(insights).toEqual(v7Home.modes.items[2]);
    expect(negotiation).toEqual(v7Home.modes.items[3]);
    expect(onboarding.skills).toEqual(v7Home.modes.items[0].skills);
    expect(catalog.skills).toEqual(v7Home.modes.items[1].skills);
    expect(onboarding.scenes.map((scene: { id: string }) => scene.id)).toEqual([
      "cap-register", "cap-email", "cap-cloud", "cap-connect", "cap-golive", "cap-upgrade",
    ]);
    const card = onboarding.scenes[3];
    const originalCard = v7Home.modes.items[0].scenes.find((scene: { id: string }) => scene.id === "cap-connect");
    expect(card).toMatchObject({ id: "cap-connect", expert: originalCard.expert });
    expect(card.templates.map((template: { id: string }) => template.id)).toEqual(["t9", "t10", "t11", "t12"]);
    expect(onboarding.scenes[2].templates.map((template: { id: string }) => template.id)).toEqual([
      "t13", "t14", "t15", "t16",
    ]);
    const zh = candidate.i18n.source["zh-CN"];
    expect(zh[onboarding.scenes[0].templates[1].title]).toBe("已有账号");
    expect(zh[onboarding.scenes[0].templates[1].prompt]).toBe("我已经有 Kiwi 商家账号，帮我打开kiwi商家后台");
    expect(onboarding.systemPromptAppend).toContain("https://catalog.kiwi.harrylabsj.com/portal/account");
    expect(zh[card.title]).toBe("发布名片");
    expect(zh[card.templates[0].prompt]).toBe("配对码在哪里看？怎么确认「发布名片」？");
    expect(zh[card.templates[2].prompt]).toBe("点「发布名片」之前我要核对什么？");
    expect(catalog.systemPromptAppend).not.toContain("整表替换");
  });

  it("保留平台专属字段（templateId/version/brand/图标/专家关联）", () => {
    const converted = convertToPlatformImport(base, local) as {
      templateId: string;
      version: number;
      brand: { logo: string };
      ui: { nav: { items: Array<{ config: { modes: { items: Array<{ scenes: Array<{ expert?: { id: string } }> }> } } }> } };
    };
    expect(converted.templateId).toBe("cb_jU2kgRjXVRjE2gmSjgyH");
    expect(converted.version).toBe(1);
    expect(converted.brand.logo).toContain("buddy_app_icon");
    const scenes = converted.ui.nav.items[0]!.config.modes.items.flatMap((mode) => mode.scenes);
    expect(scenes.some((scene) => scene.expert?.id?.startsWith("ex_"))).toBe(true);
  });
});
