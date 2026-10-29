#!/usr/bin/env node
// 发布前提：**端到端验收回执**必须存在、未过期，且与本次要发布的版本一致。
//
// 用法：
//   node scripts/verify-release-acceptance.mjs [--max-age-hours 168]
//
// 为什么不是每次发布都现跑：端到端链路要打到真实目录与真实商家（公网），
// CI 不能依赖外部生产环境的可用性。所以链路由 `scripts/run-acceptance.mjs`
// 在受控环境跑完并把证据写进 build-inputs/release-acceptance.json（受冻源
// 契约覆盖，随提交受审）；这里只做**离线、fail-closed** 的核验。
//
// 校验项：
//   1. 文件存在且 schema 正确；
//   2. 每个链路阶段都 ok（search / quote / agreement / handoff）；
//   3. 回执未过期（默认 7 天，KIWI_ACCEPTANCE_MAX_AGE_HOURS 可覆盖）；
//   4. 回执记录的 kiwi / shopping-cli 版本与当前仓库一致；
//   5. handoff 只有 external_checkout_url 才要求 url 非空，其它类型不强制。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argFile = (() => {
  const i = args.indexOf("--file");
  return i >= 0 ? path.resolve(args[i + 1]) : undefined;
})();
const file = argFile ?? path.join(root, "build-inputs/release-acceptance.json");
let maxAgeHours = Number(process.env.KIWI_ACCEPTANCE_MAX_AGE_HOURS ?? "168");
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--max-age-hours") maxAgeHours = Number(args[i + 1]);
}
const fail = (message) => {
  console.error(`RELEASE_ACCEPTANCE_REJECTED ${message}`);
  process.exit(1);
};

if (!existsSync(file)) fail(`缺少端到端验收回执：先运行 node scripts/run-acceptance.mjs（${path.relative(root, file)}）`);
let receipt;
try {
  receipt = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  fail(`回执不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
}
if (receipt?.schema !== "kiwi.release-acceptance/1") fail("回执 schema 不是 kiwi.release-acceptance/1");

const recordedAt = Date.parse(String(receipt.recorded_at ?? ""));
if (!Number.isFinite(recordedAt)) fail("回执缺少可解析的 recorded_at");
const ageHours = (Date.now() - recordedAt) / 3_600_000;
if (!(maxAgeHours > 0)) fail(`--max-age-hours 非法：${maxAgeHours}`);
if (ageHours > maxAgeHours) {
  fail(`回执已过期 ${ageHours.toFixed(1)}h > ${maxAgeHours}h；重跑 node scripts/run-acceptance.mjs`);
}

const required = ["search", "quote", "agreement", "handoff"];
const steps = receipt.chain ?? {};
for (const name of required) {
  if (steps[name]?.ok !== true) fail(`链路阶段 ${name} 未通过：${steps[name]?.detail ?? "缺失"}`);
}
if (steps.handoff.destination_type === "external_checkout_url" && typeof steps.handoff.url !== "string"
  || steps.handoff.destination_type === "external_checkout_url" && steps.handoff.url.trim() === "") {
  fail("handoff 是 external_checkout_url 但没有 url——买家拿不到成交入口");
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (receipt.kiwi_version !== pkg.version) {
  fail(`回执记录的 kiwi 版本 ${receipt.kiwi_version} 与当前仓库 ${pkg.version} 不一致；重跑 run-acceptance`);
}
const shoppingPin = JSON.parse(readFileSync(path.join(root, "portfolio.lock.json"), "utf8"))
  .repositories?.["shopping-cli"]?.commit;
if (receipt.shopping_cli_commit !== undefined && receipt.shopping_cli_commit !== shoppingPin) {
  fail(`回执记录的 shopping-cli ${receipt.shopping_cli_commit} 与 lock ${shoppingPin} 不一致`);
}

console.log(
  `release acceptance OK: ${path.relative(root, file)}（${ageHours.toFixed(1)}h 前，版本 ${receipt.kiwi_version}，` +
    `成交入口 ${steps.handoff.url ?? "无"}）`,
);
