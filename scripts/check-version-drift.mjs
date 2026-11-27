#!/usr/bin/env node
// Copyright 2026 harrylabsj
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * 版本漂移检查：防止「修复已合并 main、但未发布/未部署」的事故（2026-11-24
 * 海纳百川重绑 409：修复 fcc7253 当天已在 catalog main，生产仍跑旧版）。
 *
 * 检查三类漂移（fail-soft：告警走 GitHub issue，本身不因业务漂移退出非零）：
 *   1. lock pin 跟踪的组件（kiwi-catalog / shopping-cli）：repo main HEAD ≠
 *      portfolio.lock.json pin → 有改动未进入发布组合。
 *   2. registry 与声明版本：registry latest ≠ main（kiwi 仓产品）或 pin 提交
 *      （外部仓产品）声明的版本 → 发布未完成或版本号漂移。
 *   3. registry latest > 声明版本：main 落后于 registry（异常，人工排查）。
 *
 * 有漂移时创建/更新唯一 open issue（label version-drift，含隐藏标记）；无漂移
 * 时自动关闭该 issue。漂移细节进 step summary 与 issue 正文，不泄露任何凭据。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ISSUE_LABEL = "version-drift";
const ISSUE_MARKER = "<!-- version-drift-auto -->";

// Gate 模式（release workflow 前置门禁用）：发现「漂移且该通道未在本轮发布
// 选中」时退出码 1，不写 issue；漂移恰好在选中通道上时视为「本轮即发它」。
const argv = process.argv.slice(2);
const gate = argv.includes("--gate");
const channelsArg = argv.find((a) => a.startsWith("--channels="))?.split("=")[1] ?? "all";
const acknowledgeSkips = argv.includes("--acknowledge-skips");
const CHANNEL_PRODUCTS = {
  npm: "kiwi",
  "merchant-cloud": "kiwi-merchant-cloud",
  "kiwi-catalog": "kiwi-catalog",
  "shopping-cli": "shopping-cli",
  "dsh-plugin": "kiwi-dsh-plugin",
};
const selectedProducts = new Set(
  channelsArg === "all"
    ? Object.values(CHANNEL_PRODUCTS)
    : channelsArg.split(",").map((c) => CHANNEL_PRODUCTS[c.trim()]).filter(Boolean),
);

const lock = JSON.parse(readFileSync("portfolio.lock.json", "utf8"));
const products = JSON.parse(readFileSync("portfolio-products.json", "utf8")).products;

const CATALOG_REPO = "harrylabsj/kiwi-catalog";
const SHOPPING_REPO = "harrylabsj/shopping-cli";

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 }).trim();

function repoHead(repo) {
  return gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
}

function fileAtRef(repo, ref, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const raw = gh(["api", `repos/${repo}/contents/${encoded}?ref=${ref}`, "--jq", ".content"]);
  return Buffer.from(raw.replace(/\n/g, ""), "base64").toString("utf8");
}

function pinVersionPath(component, sourcePath) {
  if (typeof sourcePath !== "string") throw new Error("pin version source path is missing");
  const prefix = `${component}/`;
  const relative = sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : sourcePath;
  if (!relative || relative.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("invalid pin version source path");
  }
  return relative;
}

function versionFromSource(source) {
  const pkg = source.match(/"version"\s*:\s*"([^"]+)"/);
  if (pkg) return pkg[1];
  const toml = source.match(/^version\s*=\s*"([^"]+)"/m);
  if (toml) return toml[1];
  throw new Error("version field not found in source");
}

async function registryLatest(channel, name) {
  const url =
    channel === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`
      : `https://pypi.org/pypi/${name}/json`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const body = await res.json();
        const version = channel === "npm" ? body?.version : body?.info?.version;
        if (typeof version !== "string" || !version.trim()) throw new Error(`registry ${name}: missing version`);
        return version;
      }
    } catch (error) {
      if (attempt === 1) throw error;
      continue;
    }
    if (attempt === 1 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`registry ${name}: HTTP ${res.status}`);
    }
  }
}

const rows = [];
const problems = [];
const checkErrors = [];

for (const p of products) {
  if (["workbuddy-merchant-app"].includes(p.id)) continue;
  const registryName = {
    "kiwi": "@harrylabsj/kiwi",
    "kiwi-merchant-cloud": "@harrylabsj/kiwi-merchant-cloud",
    "kiwi-catalog": "kiwi-catalog",
    "shopping-cli": "shopping-cli",
    "kiwi-dsh-plugin": "@harrylabsj/kiwi-dsh-plugin",
  }[p.id];
  if (registryName === undefined) continue;
  try {
    const declared = p.version;
    const latest = await registryLatest(p.channel, registryName);
    let repo = null;
    let mainHead = null;
    let pin = null;
    if (p.id === "kiwi-catalog") {
      repo = CATALOG_REPO;
      pin = lock.repositories["kiwi-catalog"].commit;
    } else if (p.id === "shopping-cli") {
      repo = SHOPPING_REPO;
      pin = lock.repositories["shopping-cli"].commit;
    }
    const checks = [];
    if (repo !== null && pin !== null) {
      mainHead = repoHead(repo);
      const pinVersion = versionFromSource(fileAtRef(repo, pin, pinVersionPath(p.id, p.version_source?.path)));
      checks.push({
        name: "lock pin 与 main 一致",
        ok: mainHead === pin,
        detail: mainHead === pin ? pin.slice(0, 8) : `main ${mainHead.slice(0, 8)} ≠ pin ${pin.slice(0, 8)}（有改动未进入发布组合）`,
      });
      checks.push({
        name: "pin 声明版本与 registry 一致",
        ok: pinVersion === latest,
        detail: pinVersion === latest ? pinVersion : `pin 声明 ${pinVersion} ≠ registry latest ${latest}（发布未完成或 pin 过期）`,
      });
    } else {
      checks.push({
        name: "main 声明版本与 registry 一致",
        ok: declared === latest,
        detail: declared === latest ? declared : `main 声明 ${declared} ≠ registry latest ${latest}`,
      });
    }
    for (const c of checks) {
      rows.push({ product: p.id, check: c.name, ok: c.ok, detail: c.detail });
      if (!c.ok) {
        const selected = selectedProducts.has(p.id);
        if (gate) {
          // 本轮未选中的通道出现漂移 → 阻塞；已选中的漂移 = 本轮正在发它。
          if (!selected) problems.push(`- **${p.id}**（${c.name}）：${c.detail}`);
        } else {
          problems.push(`- **${p.id}**（${c.name}）：${c.detail}`);
        }
      }
    }
  } catch (error) {
    rows.push({ product: p.id, check: "漂移检查执行", ok: false, detail: String(error instanceof Error ? error.message : error) });
    checkErrors.push(`- **${p.id}**：检查执行失败：${error instanceof Error ? error.message : error}`);
  }
}

const drift = problems.length > 0;
const checkedAt = new Date().toISOString();
const table = [
  "| 产品 | 检查 | 结果 | 详情 |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.product} | ${r.check} | ${r.ok ? "✅" : "❌"} | ${r.detail} |`),
].join("\n");
if (gate) {
  const summary = `## 发布门禁：版本漂移检查（${checkedAt}）\n\n${table}\n\n${
    drift
      ? acknowledgeSkips
        ? "⚠️ 未选中通道存在漂移，但已通过 acknowledge_unpinned_skips 显式豁免（本轮有意跳过）。"
        : "**门禁拦截**：未选中通道存在未发布改动。请二选一：a) 更新对应组件 pin 并把通道加入本轮 channels；b) 确认本轮有意跳过，勾选 acknowledge_unpinned_skips 重新运行。"
      : "无已知阻塞漂移（已选中的漂移即本轮发布对象）。"
  }${checkErrors.length ? "\n\n**门禁拦截**：至少一项检查未能完成，无法确认发布组合。请检查网络或配置后重新运行；跳过漂移豁免不适用于执行失败。" : ""}`;
  process.stdout.write(summary + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }
  if (checkErrors.length || drift && !acknowledgeSkips) process.exitCode = 1;
} else {
  await reportScheduled();
}

async function reportScheduled() {
  const summary = `## 版本漂移检查（${checkedAt}）\n\n${table}\n\n${checkErrors.length ? "**部分检查未完成**" : drift ? "**发现漂移**" : "无漂移"}`;
  process.stdout.write(summary + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }

  const dryRun = process.env.VERSION_DRIFT_DRY_RUN === "1";
  const openIssues = JSON.parse(
    gh(["issue", "list", "--label", ISSUE_LABEL, "--state", "open", "--json", "number", "--limit", "10"]),
  );
  if (dryRun) {
    console.log(`dry-run: drift=${drift}, open drift issues=${openIssues.length}, 不写 issue`);
  } else if (drift || checkErrors.length) {
    const body =
      `${ISSUE_MARKER}\n自动检查发现以下组件存在「已合并未发布 / 未部署」漂移（${checkedAt}）：\n\n` +
      `${[...problems, ...checkErrors].join("\n")}\n\n` +
      `${table}\n\n` +
      `处理建议：确认漂移内容是否需要发布；发布后本 issue 会在下次检查无漂移时自动关闭。\n`;
    if (openIssues.length > 0) {
      gh(["issue", "comment", String(openIssues[0].number), "--body", body]);
      console.log(`updated issue #${openIssues[0].number}`);
    } else {
      const url = gh([
        "issue", "create",
        "--title", `版本漂移：存在已合并但未发布/未部署的改动（${checkedAt.slice(0, 10)}）`,
        "--label", ISSUE_LABEL,
        "--body", body,
      ]);
      console.log(`created issue ${url}`);
    }
  } else {
    for (const issue of openIssues) {
      gh(["issue", "close", String(issue.number), "--comment", `${ISSUE_MARKER}\n${checkedAt} 检查无漂移，自动关闭。`]);
      console.log(`closed issue #${issue.number}`);
    }
  }
}
