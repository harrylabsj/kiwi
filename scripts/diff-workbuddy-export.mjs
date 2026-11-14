#!/usr/bin/env node
/**
 * 对比 WorkBuddy 平台导出的应用配置与本仓生成器输出。
 *
 * 平台导出格式与 `platform/build-platform-pack.mjs` 的输出不同：平台用 i18n key、
 * 平台 CDN 图标 URL 和内部专家实例 ID；本仓用直接文本和 oe_/os_ 资产 ID。
 * 本脚本只比较可对齐的文本字段（标题、模式/胶囊提示词、模板），并把市场配置
 * 的结构差异单独报告，避免误判。
 *
 * 用法：
 *   node scripts/diff-workbuddy-export.mjs --export <导出.zip|解压目录> [--local <out目录>] [--json] [--check]
 *
 * --check：存在文本差异时退出码 1（市场配置结构差异不计入）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_LOCAL_OUT = path.join(
  repoRoot,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/out",
);

const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const textDiff = (pathName, live, local) => ({
  path: pathName,
  live_sha256: sha256(live),
  local_sha256: sha256(local),
  live_length: [...live].length,
  local_length: [...local].length,
  live_preview: [...live].slice(0, 160).join(""),
  local_preview: [...local].slice(0, 160).join(""),
});

function readZipEntry(zipPath, suffix) {
  const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  const match = entries.find((entry) => entry === suffix || entry.endsWith(`/${suffix}`));
  if (!match) throw new Error(`导出包缺少 ${suffix}`);
  return execFileSync("unzip", ["-p", zipPath, match], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function findFile(root, suffix) {
  const direct = path.join(root, suffix);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    const found = findFile(full, suffix);
    if (found) return found;
  }
  return undefined;
}

export function loadExport(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!existsSync(resolved)) throw new Error(`导出路径不存在：${resolved}`);
  const isDir = statSync(resolved).isDirectory();
  const readJson = (suffix) => {
    const text = isDir
      ? readFileSync(findFile(resolved, suffix) ?? (() => {
          throw new Error(`导出目录缺少 ${suffix}`);
        })(), "utf8")
      : readZipEntry(resolved, suffix);
    return JSON.parse(text);
  };
  return { industryConfig: readJson("industry-config.json"), marketConfig: readJson("market.json") };
}

function resolveI18n(locale, value) {
  if (typeof value !== "string") return value;
  return Object.hasOwn(locale, value) ? locale[value] : value;
}

function normalizeModes(industryConfig, locale) {
  const items = industryConfig?.ui?.nav?.items ?? [];
  const home = items.find((item) => item.id === "home") ?? items[0];
  const modes = home?.config?.modes?.items ?? [];
  return modes.map((mode) => ({
    id: mode.modeId,
    title: resolveI18n(locale, mode.title),
    prompt: mode.systemPromptAppend ?? "",
    skills: (mode.skills ?? []).map((skill) => skill.id).sort(),
    scenes: (mode.scenes ?? []).map((scene) => ({
      id: scene.id,
      title: resolveI18n(locale, scene.title),
      prompt: scene.systemPromptAppend ?? "",
      templates: (scene.templates ?? []).map((template) => ({
        id: template.id,
        title: resolveI18n(locale, template.title),
        prompt: resolveI18n(locale, template.prompt),
      })),
    })),
  }));
}

export function normalizeExport({ industryConfig, marketConfig }) {
  const locale = industryConfig?.i18n?.source?.["zh-CN"] ?? {};
  const localeEn = industryConfig?.i18n?.source?.en ?? {};
  const home = (industryConfig?.ui?.nav?.items ?? []).find((item) => item.id === "home") ??
    industryConfig?.ui?.nav?.items?.[0];
  const headerTitleKey = home?.config?.header?.title;
  const headerTitleEnKey = home?.config?.header?.titleEn ?? headerTitleKey;
  return {
    header: {
      title: resolveI18n(locale, headerTitleKey),
      titleEn: resolveI18n(localeEn, headerTitleEnKey),
    },
    brand: resolveI18n(locale, industryConfig?.brand?.title),
    chatPlaceholder: resolveI18n(locale, industryConfig?.ui?.chatInput?.placeholder),
    models: industryConfig?.models,
    authConfig: industryConfig?.authConfig,
    jointAuth: industryConfig?.jointAuth,
    modes: normalizeModes(industryConfig, locale),
    market: summarizeMarketTree(marketConfig),
  };
}

export function normalizeLocal({ industryConfig, marketConfig }) {
  const home = (industryConfig?.ui?.nav?.items ?? []).find((item) => item.id === "home") ??
    industryConfig?.ui?.nav?.items?.[0];
  return {
    header: {
      title: home?.config?.header?.title,
      titleEn: home?.config?.header?.titleEn,
    },
    brand: undefined,
    chatPlaceholder: industryConfig?.ui?.chatInput?.placeholder,
    models: industryConfig?.models,
    authConfig: industryConfig?.authConfig,
    jointAuth: industryConfig?.jointAuth,
    modes: normalizeModes(industryConfig, {}),
    market: summarizeMarketFlat(marketConfig),
  };
}

function summarizeMarketTree(marketConfig) {
  const body = marketConfig?.body ?? marketConfig;
  const scenes = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.subType === "expert-featured" && Array.isArray(node.children)) {
      for (const category of node.children) {
        const units = (category.children ?? []).filter((child) => child?.type === "unit");
        scenes.push({ name: category?.name?.zh ?? category?.tagId, experts: units.length });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(body);
  return {
    schema: "platform_tree",
    sceneExpertCounts: scenes,
    sceneCount: scenes.length,
    expertIdPrefix: "ex_",
  };
}

function summarizeMarketFlat(marketConfig) {
  const scenarios = marketConfig?.featuredScenarios ?? [];
  return {
    schema: "local_flat",
    sceneExpertCounts: scenarios.map((scenario) => ({
      name: scenario.name,
      experts: (scenario.expertIds ?? []).length,
    })),
    sceneCount: scenarios.length,
    expertIdPrefix: "oe_",
  };
}

export function diffPlatformConfigs(live, local) {
  const diffs = [];
  const pushText = (pathName, liveValue, localValue) => {
    const liveText = liveValue ?? "";
    const localText = localValue ?? "";
    if (liveText !== localText) diffs.push(textDiff(pathName, liveText, localText));
  };
  pushText("header.title", live.header.title, local.header.title);
  pushText("header.titleEn", live.header.titleEn, local.header.titleEn);
  pushText("chat.placeholder", live.chatPlaceholder, local.chatPlaceholder);
  pushText(
    "authConfig.capabilityDescription",
    live.authConfig?.capabilityDescription,
    local.authConfig?.capabilityDescription,
  );
  if (JSON.stringify(live.jointAuth) !== JSON.stringify(local.jointAuth)) {
    diffs.push({ path: "jointAuth", live: live.jointAuth, local: local.jointAuth });
  }
  if (JSON.stringify(live.models) !== JSON.stringify(local.models)) {
    diffs.push({ path: "models", live: live.models, local: local.models });
  }

  const liveModes = new Map(live.modes.map((mode) => [mode.id, mode]));
  const localModes = new Map(local.modes.map((mode) => [mode.id, mode]));
  if (liveModes.size !== localModes.size) {
    diffs.push({ path: "modes.count", live: liveModes.size, local: localModes.size });
  }
  for (const [modeId, liveMode] of liveModes) {
    const localMode = localModes.get(modeId);
    if (!localMode) {
      diffs.push({ path: `modes.${modeId}`, live: "present", local: "missing" });
      continue;
    }
    pushText(`modes.${modeId}.title`, liveMode.title, localMode.title);
    pushText(`modes.${modeId}.systemPrompt`, liveMode.prompt, localMode.prompt);
    if (JSON.stringify(liveMode.skills) !== JSON.stringify(localMode.skills)) {
      diffs.push({ path: `modes.${modeId}.skills`, live: liveMode.skills, local: localMode.skills });
    }
    const liveScenes = new Map(liveMode.scenes.map((scene) => [scene.id, scene]));
    const localScenes = new Map(localMode.scenes.map((scene) => [scene.id, scene]));
    if (liveScenes.size !== localScenes.size) {
      diffs.push({
        path: `modes.${modeId}.scenes.count`,
        live: liveScenes.size,
        local: localScenes.size,
      });
    }
    for (const [sceneId, liveScene] of liveScenes) {
      const localScene = localScenes.get(sceneId);
      if (!localScene) {
        diffs.push({ path: `modes.${modeId}.scenes.${sceneId}`, live: "present", local: "missing" });
        continue;
      }
      pushText(`modes.${modeId}.scenes.${sceneId}.title`, liveScene.title, localScene.title);
      pushText(`modes.${modeId}.scenes.${sceneId}.systemPrompt`, liveScene.prompt, localScene.prompt);
      const localTemplates = new Map(localScene.templates.map((template) => [template.id, template]));
      for (const liveTemplate of liveScene.templates) {
        const localTemplate = localTemplates.get(liveTemplate.id);
        if (!localTemplate) {
          diffs.push({
            path: `modes.${modeId}.scenes.${sceneId}.templates.${liveTemplate.id}`,
            live: "present",
            local: "missing",
          });
          continue;
        }
        pushText(
          `modes.${modeId}.scenes.${sceneId}.templates.${liveTemplate.id}.title`,
          liveTemplate.title,
          localTemplate.title,
        );
        pushText(
          `modes.${modeId}.scenes.${sceneId}.templates.${liveTemplate.id}.prompt`,
          liveTemplate.prompt,
          localTemplate.prompt,
        );
      }
    }
  }
  return diffs;
}

export function runDiff({ exportPath, localOutDir = DEFAULT_LOCAL_OUT }) {
  const exported = loadExport(exportPath);
  const live = normalizeExport(exported);
  const local = normalizeLocal({
    industryConfig: JSON.parse(readFileSync(path.join(localOutDir, "industry-config.json"), "utf8")),
    marketConfig: JSON.parse(readFileSync(path.join(localOutDir, "market.json"), "utf8")),
  });
  const diffs = diffPlatformConfigs(live, local);
  return {
    schema: "kiwi.workbuddy.platform-export-diff.v1",
    export_path: path.resolve(exportPath),
    local_out: path.resolve(localOutDir),
    ok: diffs.length === 0,
    diff_count: diffs.length,
    diffs,
    live_market: live.market,
    local_market: local.market,
    market_note:
      "平台市场配置使用内部 ex_ 实例 ID 的树形结构；本仓生成器使用 oe_ 资产 ID 的扁平结构。" +
      "两者不可直接互相覆盖；本脚本只对比场景数量/专家关联数，不把结构差异算作文本差异。",
  };
}

function printHuman(result) {
  console.log(`导出：${result.export_path}`);
  console.log(`本地：${result.local_out}`);
  console.log(
    `市场：平台 ${result.live_market.sceneCount} 个场景（每场景 ${result.live_market.sceneExpertCounts
      .map((s) => s.experts)
      .join("/")} 个专家）；本仓 ${result.local_market.sceneCount} 个场景（每场景 ${result.local_market.sceneExpertCounts
      .map((s) => s.experts)
      .join("/")} 个专家）`,
  );
  console.log(result.market_note);
  if (result.ok) {
    console.log("文本字段：全部一致");
    return;
  }
  console.log(`文本差异：${result.diff_count} 处`);
  for (const diff of result.diffs) {
    if (diff.live_sha256) {
      console.log(
        `- ${diff.path}（平台 ${diff.live_length} 字 / 本地 ${diff.local_length} 字）`,
      );
      console.log(`  平台：${diff.live_preview}`);
      console.log(`  本地：${diff.local_preview}`);
    } else {
      console.log(`- ${diff.path}：平台=${JSON.stringify(diff.live)} 本地=${JSON.stringify(diff.local)}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const exportPath = value("--export");
  if (!exportPath) {
    console.error(
      "用法：node scripts/diff-workbuddy-export.mjs --export <导出.zip|解压目录> [--local <out目录>] [--json] [--check]",
    );
    process.exit(2);
  }
  const result = runDiff({ exportPath, localOutDir: value("--local") ?? DEFAULT_LOCAL_OUT });
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printHuman(result);
  if (args.includes("--check") && result.diff_count > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
