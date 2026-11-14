#!/usr/bin/env node
/**
 * 平台导出 vs 本仓生成器的差异门禁。
 *
 * 以 `platform/platform-export/<date>/expected-diffs.json` 为基线：如果
 * `platform/out/` 的生成结果相对平台导出发生了新的文本差异，或既有差异消失，
 * 本脚本失败并要求显式更新基线。这样“版本号不变但内容漂移”会在 CI 前暴露。
 *
 * 用法：
 *   node scripts/verify-workbuddy-platform-drift.mjs
 *   node scripts/verify-workbuddy-platform-drift.mjs --update
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runDiff } from "./diff-workbuddy-export.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDir = path.join(
  repoRoot,
  "integrations/hosts/workbuddy/kiwi-merchant-buddy/platform/platform-export/2026-11-14",
);
const expectedPath = path.join(snapshotDir, "expected-diffs.json");

function project(result) {
  return {
    schema: "kiwi.workbuddy.platform-export-expected-diffs.v1",
    export_date: "2026-11-14",
    diff_count: result.diff_count,
    diffs: result.diffs
      .map((diff) =>
        diff.live_sha256
          ? {
              path: diff.path,
              live_sha256: diff.live_sha256,
              local_sha256: diff.local_sha256,
              live_length: diff.live_length,
              local_length: diff.local_length,
            }
          : { path: diff.path, live: diff.live, local: diff.local },
      )
      .sort((a, b) => String(a.path).localeCompare(String(b.path))),
    live_market: result.live_market,
    local_market: result.local_market,
  };
}

const args = process.argv.slice(2);
const result = runDiff({ exportPath: snapshotDir });
const actual = project(result);

if (args.includes("--update")) {
  writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`已更新差异基线：${expectedPath}（${actual.diff_count} 处差异）`);
  process.exit(0);
}

let expected;
try {
  expected = JSON.parse(readFileSync(expectedPath, "utf8"));
} catch (error) {
  console.error(`缺少或无法读取差异基线 ${expectedPath}：${error.message}`);
  console.error("运行 node scripts/verify-workbuddy-platform-drift.mjs --update 生成基线。");
  process.exit(1);
}

const expectedByPath = new Map(expected.diffs.map((diff) => [diff.path, diff]));
const actualByPath = new Map(actual.diffs.map((diff) => [diff.path, diff]));
const added = [...actualByPath.keys()].filter((key) => !expectedByPath.has(key)).sort();
const removed = [...expectedByPath.keys()].filter((key) => !actualByPath.has(key)).sort();
const changed = [...actualByPath.keys()]
  .filter((key) => expectedByPath.has(key) && JSON.stringify(actualByPath.get(key)) !== JSON.stringify(expectedByPath.get(key)))
  .sort();

const marketDrift =
  JSON.stringify(actual.live_market) !== JSON.stringify(expected.live_market) ||
  JSON.stringify(actual.local_market) !== JSON.stringify(expected.local_market);

if (added.length === 0 && removed.length === 0 && changed.length === 0 && !marketDrift) {
  console.log(
    `WORKBUDDY_PLATFORM_DRIFT_OK：与 2026-11-14 平台导出的 ${actual.diff_count} 处已知差异一致。`,
  );
  process.exit(0);
}

console.error("WORKBUDDY_PLATFORM_DRIFT_DETECTED：生成结果与平台导出基线不一致");
if (added.length) console.error(`- 新增差异：${added.join(", ")}`);
if (removed.length) console.error(`- 差异消失：${removed.join(", ")}`);
if (changed.length) console.error(`- 差异内容变化：${changed.join(", ")}`);
if (marketDrift) console.error("- 市场配置摘要变化（场景数或每场景专家数）");
console.error("确认变更符合预期后运行：node scripts/verify-workbuddy-platform-drift.mjs --update");
process.exit(1);
