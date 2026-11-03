#!/usr/bin/env node
/**
 * 发布前闸门：核实**目标运行环境**（WorkBuddy 云端应用）的 Node 版本。
 *
 * 为什么需要它：prepare 产物与安装包声明 engines.node（当前 >=22.19.0），
 * 但平台沙箱的 Node 版本与操作者本机无关；等到 preinstall/启动阶段才发现
 * 版本不符，意味着已经发生了一次安装或覆盖发布。本脚本在发布/安装**之前**
 * 校验，未知或不满足即停止。
 *
 * 证据规则（不把本机版本当远端证据）：
 *   - 本脚本**不读取** process.version；本机 `node --version` 只能说明取包机。
 *   - 唯一可接受的输入是 `--evidence` 指向的 JSON，其 evidence.kind 必须是
 *     `platform-readonly`（平台只读界面/回执的原文）或 `runtime-config`
 *     （操作者在平台侧确认的运行时配置）。`local`/`assistant`/`inferred`
 *     一律拒绝。
 *   - 平台没有只读接口时，本脚本无法核实：给出 UNKNOWN 并停止，要求商家
 *     在平台侧确认或开单，不自动探测、不猜测。
 *   - **本脚本只校验证据的形状、来源类别与新鲜度，不认证其内容确实来自平台**；
 *     手填/转录的 JSON 只是记录，来源真实性必须由操作者从平台只读界面或可信
 *     回执人工核验。成功输出会明确标注证据为"操作者声明、未经平台认证"。
 *
 * 用法：
 *   node scripts/verify-target-node.mjs \
 *     --package-json <解包目录>/package/package.json \
 *     --evidence <部署证据>/target-runtime.json \
 *     [--max-age-hours 24]
 *
 * 证据文件（kiwi.deploy-target-runtime/1）：
 *   {
 *     "format": "kiwi.deploy-target-runtime/1",
 *     "target": "workbuddy-cloud-app",
 *     "install_node": "v22.19.0",
 *     "start_node": "v22.19.0",
 *     "evidence": {
 *       "kind": "platform-readonly",
 *       "interface": "WorkBuddy 应用 → 运行环境（只读页面）",
 *       "observed_at": "2026-11-02T19:30:00Z",
 *       "quote": "Node.js v22.19.0"
 *     }
 *   }
 *
 * 退出码：0 通过；1 停止（错误码见 stderr 的 [deploy-target] 前缀）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const fail = (code, message) => {
  console.error(`[deploy-target] ${code}: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const packageJsonPath = option("--package-json");
const evidencePath = option("--evidence");
const maxAgeHoursRaw = option("--max-age-hours") ?? "24";
if (packageJsonPath === undefined || evidencePath === undefined) {
  fail(
    "DEPLOY_TARGET_ARGS",
    "用法：node scripts/verify-target-node.mjs --package-json <package.json> --evidence <target-runtime.json> [--max-age-hours 24]",
  );
}
const maxAgeHours = Number(maxAgeHoursRaw);
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  fail("DEPLOY_TARGET_ARGS", `--max-age-hours 非法：${maxAgeHoursRaw}`);
}

// 1) 版本下界：取被部署包自己的 engines.node（不读本机版本）。
if (!existsSync(packageJsonPath)) {
  fail("DEPLOY_TARGET_PACKAGE_MISSING", `找不到被部署包的 package.json：${packageJsonPath}`);
}
let enginesNode = "";
try {
  enginesNode = String(
    JSON.parse(readFileSync(packageJsonPath, "utf8")).engines?.node ?? "",
  ).trim();
} catch (error) {
  fail(
    "DEPLOY_TARGET_PACKAGE_INVALID",
    `无法解析 ${packageJsonPath}：${error instanceof Error ? error.message : String(error)}`,
  );
}
const floor = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(enginesNode);
if (floor === null) {
  fail(
    "DEPLOY_TARGET_ENGINES_UNPARSEABLE",
    `engines.node=${JSON.stringify(enginesNode)} 不是可比较的 ">=x.y[.z]" 形式；请先在包内固定下界，不能跳过版本闸门`,
  );
}
const need = [Number(floor[1]), Number(floor[2]), Number(floor[3] ?? "0")];

// 2) 证据：只接受平台只读证据或已确认的运行时配置。
if (!existsSync(evidencePath)) {
  fail(
    "DEPLOY_TARGET_NODE_UNKNOWN",
    `缺少目标运行环境证据 ${evidencePath}。请在平台侧只读查看应用运行环境（或已确认的运行时配置）后按格式填写；` +
      "平台没有只读接口时请让商家确认或开单，不要用本机 node --version 代替，也不要发布",
  );
}
let evidence;
try {
  evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
} catch (error) {
  fail(
    "DEPLOY_TARGET_EVIDENCE_INVALID",
    `证据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
  );
}
if (evidence?.format !== "kiwi.deploy-target-runtime/1") {
  fail("DEPLOY_TARGET_EVIDENCE_INVALID", "证据 format 必须是 kiwi.deploy-target-runtime/1");
}
const allowedKinds = new Set(["platform-readonly", "runtime-config"]);
const kind = evidence?.evidence?.kind;
if (typeof kind !== "string" || !allowedKinds.has(kind)) {
  fail(
    "DEPLOY_TARGET_EVIDENCE_UNTRUSTED",
    `evidence.kind=${JSON.stringify(kind)} 不可接受：只允许 platform-readonly（平台只读界面/回执）或 runtime-config（平台侧已确认的运行时配置）；` +
      "本机版本、助手推断或自动探测都不能作为目标环境证据",
  );
}
const iface = String(evidence?.evidence?.interface ?? "").trim();
const quote = String(evidence?.evidence?.quote ?? "").trim();
if (iface === "" || quote === "") {
  fail(
    "DEPLOY_TARGET_EVIDENCE_UNTRUSTED",
    "证据必须包含 evidence.interface（只读界面/回执名称）与 evidence.quote（原文摘录，≤500 字）",
  );
}
if (quote.length > 500) {
  fail("DEPLOY_TARGET_EVIDENCE_INVALID", "evidence.quote 过长（>500 字），请只摘录版本行");
}
const observedAt = Date.parse(String(evidence?.evidence?.observed_at ?? ""));
if (!Number.isFinite(observedAt)) {
  fail("DEPLOY_TARGET_EVIDENCE_INVALID", "证据缺少可解析的 evidence.observed_at（RFC3339）");
}
const ageHours = (Date.now() - observedAt) / 3_600_000;
if (ageHours < -0.1) {
  fail("DEPLOY_TARGET_EVIDENCE_INVALID", "evidence.observed_at 位于未来，拒绝采信");
}
if (ageHours > maxAgeHours) {
  fail(
    "DEPLOY_TARGET_EVIDENCE_STALE",
    `证据已过期 ${ageHours.toFixed(1)}h > ${maxAgeHours}h；请重新在平台侧只读确认目标运行环境`,
  );
}

// 3) 目标版本：安装与启动两个阶段都必须满足下界。
const parseNode = (value, field) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  if (match === null) {
    fail("DEPLOY_TARGET_EVIDENCE_INVALID", `${field}=${JSON.stringify(value)} 不是 vX.Y.Z 形式`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};
const compare = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2]);
const install = parseNode(evidence.install_node, "install_node");
const start = parseNode(evidence.start_node, "start_node");
const floorText = `>=${need[0]}.${need[1]}.${need[2]}`;
for (const [field, actual] of [
  ["install_node", install],
  ["start_node", start],
]) {
  if (compare(actual, need) < 0) {
    fail(
      "DEPLOY_TARGET_NODE_UNSUPPORTED",
      `目标环境 ${field}=v${actual.join(".")} 低于包要求 ${floorText}；请先在平台侧把运行时升级到 ${floorText}（推荐 22.19.0 或更新），升级前不要安装或覆盖发布`,
    );
  }
}

console.log(
  `[deploy-target] OK install=v${install.join(".")} start=v${start.join(".")} ` +
    `(floor ${floorText}, evidence ${kind} @ ${iface}, observed ${new Date(observedAt).toISOString()}; ` +
    "evidence is operator-declared and NOT platform-authenticated — verify the source read-only before publishing)",
);
