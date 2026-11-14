#!/usr/bin/env node
/**
 * 把本仓生成器输出转换为 WorkBuddy 平台「导入 industry-config.json」可接受的格式。
 *
 * 平台导出格式与本仓生成器格式不同：平台用 i18n key、品牌字段、平台图标 URL、
 * 专家实例 ID；本仓用直接文本和 oe_/os_ 资产 ID。直接上传本仓 industry-config.json
 * 会被平台静默忽略。本脚本以平台导出为模板，只替换可对齐的文本字段，保留平台
 * 专属字段（templateId/version/brand.logo/icons/expert 关联）。
 *
 * 用法：
 *   node scripts/export-workbuddy-config.mjs \
 *     --base platform/platform-export/2026-11-14/industry-config.json \
 *     --local platform/out/industry-config.json \
 *     --out platform/out/industry-config.platform-import.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASE = path.join(
  repoRoot,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/platform-export/2026-11-14/industry-config.json",
);
export const DEFAULT_LOCAL = path.join(
  repoRoot,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/out/industry-config.json",
);

const clone = (value) => JSON.parse(JSON.stringify(value));
const homeItem = (config) =>
  (config?.ui?.nav?.items ?? []).find((item) => item.id === "home") ?? config?.ui?.nav?.items?.[0];

function setI18n(industry, key, zh, en) {
  const source = industry.i18n?.source ?? {};
  source["zh-CN"] ??= {};
  source.en ??= {};
  if (zh !== undefined) source["zh-CN"][key] = zh;
  if (en !== undefined) source.en[key] = en;
}

function requireField(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`缺少 ${label}`);
  return value;
}

export function convertToPlatformImport(base, local) {
  const output = clone(base);
  const baseHome = homeItem(output);
  const localHome = homeItem(local);
  if (!baseHome || !localHome) throw new Error("配置缺少 home item");

  const localHeader = localHome.config?.header ?? {};
  const headerTitle = requireField(localHeader.title, "local header.title");
  const headerTitleEn = requireField(localHeader.titleEn, "local header.titleEn");
  const brandZh = headerTitle.split(/[·|]/)[0]?.trim() ?? headerTitle;
  const brandEn = headerTitleEn.split(/[·|]/)[0]?.trim() ?? headerTitleEn;
  setI18n(output, "home.header.title", headerTitle, headerTitleEn);
  setI18n(output, "brand.title", brandZh, brandEn);
  if (baseHome.config.header) baseHome.config.header.title = "home.header.title";
  if (output.brand) output.brand.title = "brand.title";

  const localChat = local.ui?.chatInput?.placeholder;
  if (typeof localChat === "string" && localChat.trim()) {
    setI18n(output, "home.chatInput.placeholder", localChat, undefined);
  }

  if (output.authConfig && local.authConfig?.capabilityDescription !== undefined) {
    output.authConfig.capabilityDescription = local.authConfig.capabilityDescription;
  }

  const localModes = new Map(
    (localHome.config?.modes?.items ?? []).map((mode) => [mode.modeId, mode]),
  );
  for (const baseMode of baseHome.config?.modes?.items ?? []) {
    const localMode = localModes.get(baseMode.modeId);
    if (!localMode) continue;
    baseMode.systemPromptAppend = localMode.systemPromptAppend ?? "";
    if (Array.isArray(localMode.skills) && localMode.skills.length > 0) {
      baseMode.skills = localMode.skills.map((skill) => ({ id: skill.id }));
    } else {
      delete baseMode.skills;
    }
    setI18n(output, baseMode.title, localMode.title, localMode.titleEn);

    const localScenes = new Map((localMode.scenes ?? []).map((scene) => [scene.id, scene]));
    for (const baseScene of baseMode.scenes ?? []) {
      const localScene = localScenes.get(baseScene.id);
      if (!localScene) continue;
      baseScene.systemPromptAppend = localScene.systemPromptAppend ?? "";
      setI18n(output, baseScene.title, localScene.title, localScene.titleEn);

      const localTemplates = new Map(
        (localScene.templates ?? []).map((template) => [template.id, template]),
      );
      for (const baseTemplate of baseScene.templates ?? []) {
        const localTemplate = localTemplates.get(baseTemplate.id);
        if (!localTemplate) continue;
        setI18n(
          output,
          baseTemplate.title,
          localTemplate.title,
          localTemplate.titleEn,
        );
        setI18n(
          output,
          baseTemplate.prompt,
          localTemplate.prompt,
          localTemplate.promptEn,
        );
      }
    }
  }

  return output;
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const basePath = value("--base") ?? DEFAULT_BASE;
  const localPath = value("--local") ?? DEFAULT_LOCAL;
  const outPath = value("--out");
  if (!outPath) {
    console.error(
      "用法：node scripts/export-workbuddy-config.mjs --base <平台导出 industry-config.json> --local <本仓生成 industry-config.json> --out <输出文件>",
    );
    process.exit(2);
  }
  const converted = convertToPlatformImport(
    JSON.parse(readFileSync(basePath, "utf8")),
    JSON.parse(readFileSync(localPath, "utf8")),
  );
  writeFileSync(outPath, `${JSON.stringify(converted, null, 2)}\n`);
  console.log(`已生成平台导入格式：${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
