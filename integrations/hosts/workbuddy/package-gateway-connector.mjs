import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// 商家连接器（「Kiwi 商家运营」）包校验与打包。
//
// 与 kiwi-merchant-connector（单商家 Veyquo 实例 / token 过渡）是**不同的发布对象**：
// 本包指向受信任的网关入口（多商家），source 同为 kiwi-merchant，靠 OAuth 授权页
// 由商家在目录侧确认身份后路由到各自实例。发布计划 §3.5 要求：不得把指向
// Veyquo 单实例的包当作通用商家入口提交。
//
// 校验（只读、不联网）：
//   - connector-meta / mcp.json / icon.svg 合法性；
//   - url 必须是 https 且路径 /mcp，且**不得**指向单商家实例域名（防误发布）；
//   - tools 声明与 src/merchant-gateway/catalog-tools.ts 的实现**全等**（防漂移）；
//   - 包内无疑似凭据。
// 用法：
//   node package-gateway-connector.mjs --check
//   node package-gateway-connector.mjs --out /abs/path/kiwi-merchant-gateway-1.0.0.zip

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const bundle = path.join(here, "kiwi-merchant-gateway-connector");
const files = ["connector-meta.json", "mcp.json", "icon.svg"];

/**
 * 已批准的网关入口域名：本包只允许指向这里（多商家共享入口）。
 * `merchant.kiwi.harrylabsj.com` 是**网关**域名；某个商家的自有实例域名（如
 * veyquo.com）绝不能被写进本包——那会把单实例当通用入口发布。
 */
const APPROVED_GATEWAY_HOSTS = new Set(["merchant.kiwi.harrylabsj.com"]);
/** 明确禁止出现在本包的域名：商家自有实例（发布计划 §3.5）。 */
const FORBIDDEN_INSTANCE_HOSTS = new Set(["veyquo.com"]);

function read(relative) {
  const full = path.resolve(bundle, relative);
  assert(full.startsWith(`${bundle}${path.sep}`), `Path escapes bundle: ${relative}`);
  assert(!lstatSync(full).isSymbolicLink(), `Symlink not allowed: ${relative}`);
  assert(realpathSync(full).startsWith(`${realpathSync(bundle)}${path.sep}`));
  return readFileSync(full);
}

function readJson(relative) {
  try {
    return JSON.parse(read(relative).toString("utf8"));
  } catch (err) {
    assert.fail(`${relative} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function bilingual(value, field) {
  for (const lang of ["zh", "en"]) {
    assert(
      typeof value?.[`${field}_${lang}`] === "string" && value[`${field}_${lang}`].trim(),
      `connector-meta 缺 ${field}_${lang}`,
    );
  }
}

// ── connector-meta.json ─────────────────────────────────────────────
const meta = readJson("connector-meta.json");
assert.equal(meta.source, "kiwi-merchant", "通用商家连接器 source 须为 kiwi-merchant");
assert.equal(meta.type, "mcp");
assert(!("auth_mode" in meta), "OAuth 包省略 auth_mode（走平台内置 OAuth 流程）");
assert(/^\d+\.\d+\.\d+$/.test(meta.version), "version 必须语义化");
assert(
  /^\d+\.\d+\.\d+$/.test(meta.minWorkbuddyVersion),
  "需声明 minWorkbuddyVersion（OAuth 连接器）",
);
bilingual(meta, "name");
bilingual(meta, "description");
for (const lang of ["zh", "en"]) {
  const list = meta[`examples_${lang}`];
  assert(
    Array.isArray(list) && list.length >= 2 && list.length <= 5,
    `examples_${lang} 应为 2–5 条`,
  );
}
assert.equal(meta.examples_zh.length, meta.examples_en.length);

// ── mcp.json ────────────────────────────────────────────────────────
const mcp = readJson("mcp.json");
const servers = Object.entries(mcp.mcpServers ?? {});
assert.equal(servers.length, 1, "一个连接器只配置一个 MCP Server");
const [serverName, server] = servers[0];
assert(/^[a-z0-9-]+$/.test(serverName), "mcpServers 键名必须 kebab-case");
assert.equal(server.type, "streamableHttp");
assert.equal(server.timeout, 30000, "timeout 30000（30s 上限）");
assert(!("headers" in server), "OAuth 包不得配置 Authorization 头（走 OAuth 流程）");

let parsedUrl;
try {
  parsedUrl = new URL(server.url);
} catch {
  assert.fail(`url 不是合法地址：${server.url}`);
}
assert.equal(parsedUrl.protocol, "https:", "url 必须 https");
assert.equal(parsedUrl.pathname, "/mcp", "url 路径必须是 /mcp");
assert.equal(parsedUrl.search, "", "url 不得携带查询串");
assert.equal(parsedUrl.username, "", "url 不得内嵌凭据");
assert(
  !FORBIDDEN_INSTANCE_HOSTS.has(parsedUrl.hostname) && !parsedUrl.hostname.endsWith(".veyquo.com"),
  `url 指向商家自有实例域名（${parsedUrl.hostname}）；通用商家入口必须是网关地址`,
);
const isApprovedHost = APPROVED_GATEWAY_HOSTS.has(parsedUrl.hostname);
const isTemplateHost =
  parsedUrl.hostname === "example.com" || parsedUrl.hostname.endsWith(".example.com");
assert(
  isApprovedHost || isTemplateHost,
  `url 域名未在批准列表（${parsedUrl.hostname}）；如入口域名变更，需先更新本脚本的批准列表与部署说明`,
);

// 工具声明与 src/merchant-gateway/catalog-tools.ts 实现全等（防漂移）。
const toolSource = readFileSync(path.join(root, "src/merchant-gateway/catalog-tools.ts"), "utf8");
const sourceToolNames = new Set(
  [...toolSource.matchAll(/name: "(kiwi_catalog_[a-z0-9_]+)"/g)].map((m) => m[1]),
);
assert(sourceToolNames.size > 0, "源码未解析到 kiwi_catalog_* 工具名");
const declared = mcp.tools ?? [];
assert.equal(
  declared.length,
  sourceToolNames.size,
  `mcp.json 声明 ${declared.length} 个工具，源码有 ${sourceToolNames.size} 个`,
);
assert.deepEqual(
  [...new Set(declared.map((t) => t.name))].sort(),
  [...sourceToolNames].sort(),
  "mcp.json 工具名与源码不一致",
);
for (const tool of declared) {
  assert(/^kiwi_catalog_[a-z0-9_]+$/.test(tool.name), `${tool.name} 命名不符 kiwi_catalog_*`);
  assert(
    typeof tool.description === "string" && tool.description.trim(),
    `${tool.name} 缺 description`,
  );
  assert.equal(tool.inputSchema?.type, "object", `${tool.name} inputSchema.type 应为 object`);
  assert.equal(
    tool.inputSchema?.additionalProperties,
    false,
    `${tool.name} 需 additionalProperties:false`,
  );
}

// ── icon.svg ────────────────────────────────────────────────────────
const icon = read("icon.svg").toString("utf8");
assert(/<svg[\s>]/.test(icon), "icon.svg 不是 SVG");
assert(!/<script/i.test(icon), "icon.svg 不得含 script");
assert(!/[一-鿿]/.test(icon), "icon.svg 不得含文字");

// ── 凭据扫描（占位符 ${VAR} 不算凭据）────────────────────────────────
const SECRET_PATTERNS = [
  { re: /cmt_[A-Za-z0-9_-]{16,}/, label: "商家目录凭据（cmt_）" },
  { re: /mcp_at_[A-Za-z0-9_-]{16,}/, label: "OAuth 访问令牌" },
  { re: /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{16,}/, label: "疑似内联 Bearer token" },
  { re: /sk-[A-Za-z0-9_-]{16,}/, label: "疑似 API key" },
];
for (const relative of files) {
  if (!/\.(json|svg)$/.test(relative)) continue;
  const text = read(relative).toString("utf8");
  for (const { re, label } of SECRET_PATTERNS) {
    assert(!re.test(text), `${relative} 含${label}`);
  }
}

console.log(
  `Validated ${meta.name} v${meta.version} [gateway]: ${declared.length} declared tools, url ${server.url}`,
);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") process.exit(0);
assert(
  args.length === 2 && args[0] === "--out",
  "Usage: node package-gateway-connector.mjs --check | --out /path/package.zip",
);
const output = path.resolve(args[1]);
assert(output.endsWith(".zip"), "Output must be .zip");
assert(!existsSync(output), "Output already exists; choose a new path");
assert(!output.startsWith(`${bundle}${path.sep}`), "Keep ZIP outside the bundle");
mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync("zip", ["-X", output, ...files], { cwd: bundle, encoding: "utf8" });
assert.equal(result.status, 0, result.error?.message ?? result.stderr);
const listed = spawnSync("unzip", ["-Z1", output], { encoding: "utf8" });
assert.equal(listed.status, 0, listed.stderr);
assert.deepEqual(
  listed.stdout.trim().split("\n").sort(),
  files.map((p) => p.replace(/^\.\//, "")).sort(),
);
const checked = spawnSync("unzip", ["-t", output], { encoding: "utf8" });
assert.equal(checked.status, 0, checked.stdout + checked.stderr);
console.log(`Created ${output}`);
