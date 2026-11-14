/**
 * 平台导入格式转换：以平台导出为模板，替换成本仓 1.8.2 的文本，同时保留
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
