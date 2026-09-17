import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

// kiwi-merchant 连接器打包校验（WorkBuddy Buddy 应用 阶段三/阶段五）。
// 风格对齐 package.mjs：Node assert、项目已有依赖（yaml）、系统 zip；
// 只读校验不联网，只打包明确列出的文件，不覆盖已有压缩包。
// 双 bundle：--bundle token（缺省，过渡）| --bundle oauth（正式）。

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const argvBundle = process.argv.find((a) => a.startsWith("--bundle="));
const bundleKind = argvBundle === undefined ? "token" : argvBundle.split("=")[1];
assert(
  bundleKind === "token" || bundleKind === "oauth",
  `--bundle 只支持 token|oauth（实际 ${bundleKind}）`,
);
const bundle = path.join(here, `kiwi-merchant-connector${bundleKind === "oauth" ? "-oauth" : ""}`);
const files =
  bundleKind === "oauth"
    ? ["connector-meta.json", "mcp.json", "icon.svg"]
    : ["connector-meta.json", "mcp.json", "token-schema.json", "icon.svg"];

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

function bilingualList(value, field) {
  for (const lang of ["zh", "en"]) {
    const list = value?.[`${field}_${lang}`];
    assert(
      Array.isArray(list) &&
        list.length > 0 &&
        list.every((s) => typeof s === "string" && s.trim()),
      `connector-meta 缺 ${field}_${lang}（字符串数组）`,
    );
  }
}

// ── connector-meta.json ─────────────────────────────────────────────
const meta = readJson("connector-meta.json");
assert(/^[a-z0-9-]+$/.test(meta.source), "source 必须 kebab-case");
assert.equal(meta.type, "mcp");
if (bundleKind === "token") {
  assert.equal(meta.auth_mode, "token");
  assert.equal(meta.source, "kiwi-merchant-token", "token 过渡包 source 须与 OAuth 包区分");
} else {
  assert(!("auth_mode" in meta), "OAuth 包省略 auth_mode（走 MCP 自带 OAuth 流程）");
  assert.equal(meta.source, "kiwi-merchant", "OAuth 正式包 source");
}
assert(/^\d+\.\d+\.\d+$/.test(meta.version), "version 必须语义化");
assert(
  /^\d+\.\d+\.\d+$/.test(meta.minWorkbuddyVersion),
  "需声明 minWorkbuddyVersion（examples_* 需 4.24.0）",
);
bilingual(meta, "name");
bilingual(meta, "description");
bilingualList(meta, "examples");
assert(meta.examples_zh.length >= 2 && meta.examples_zh.length <= 5, "examples_zh 建议 2–5 条");
assert.equal(meta.examples_zh.length, meta.examples_en.length);

// ── mcp.json ────────────────────────────────────────────────────────
const mcp = readJson("mcp.json");
const servers = Object.entries(mcp.mcpServers ?? {});
assert.equal(servers.length, 1, "一个连接器只配置一个 MCP Server");
const [serverName, server] = servers[0];
assert(/^[a-z0-9-]+$/.test(serverName), "mcpServers 键名必须 kebab-case");
assert.equal(server.type, "streamableHttp");
// 审查 P2：host 整体锚定——原正则只锚定开头，`https://mcp.example.com.evil.io/mcp`
// 这类 attached-domain 可绕过「必须用占位域」的防泄漏校验。改用 URL 解析后
// 校验 hostname 整体属于 example.com（或等于已批准的生产地址）。
const isApprovedUrl = server.url === "https://merchant.kiwi.harrylabsj.com/mcp";
let isTemplateUrl = false;
if (!isApprovedUrl) {
  try {
    const parsed = new globalThis.URL(server.url);
    isTemplateUrl =
      parsed.protocol === "https:" &&
      parsed.pathname === "/mcp" &&
      (parsed.hostname === "example.com" || parsed.hostname.endsWith(".example.com"));
  } catch {
    isTemplateUrl = false;
  }
}
assert(
  isApprovedUrl || isTemplateUrl,
  "url 必须为已批准的生产 HTTPS MCP 地址或 example.com 模板地址",
);
assert.equal(server.timeout, 30000, "timeout 30000（30s 上限）");
const headerRefs = new Set(
  Object.values(server.headers ?? {}).flatMap((v) =>
    [...String(v).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]),
  ),
);
if (bundleKind === "token") {
  assert(headerRefs.size > 0, "headers 必须用 ${VAR} 占位引用 token");
} else {
  assert.deepEqual([...headerRefs], [], "OAuth 包不得携带 token 占位（走 OAuth 流程）");
  assert(!("headers" in server), "OAuth 包不得配置 Authorization 头");
}

// 工具声明与 src/mcp/merchant-tools.ts 的工具名集合完全一致（防漂移；
// description/inputSchema 全等比对见 tests/workbuddy-merchant-connector.test.ts）。
const toolSource = readFileSync(path.join(root, "src/mcp/merchant-tools.ts"), "utf8");
const sourceToolNames = new Set(
  [...toolSource.matchAll(/name: "(kiwi_merchant_[a-z0-9_]+)"/g)].map((m) => m[1]),
);
assert.equal(sourceToolNames.size, 15, `源码应有 15 个工具，实际 ${sourceToolNames.size}`);
const declared = mcp.tools ?? [];
assert.equal(declared.length, 15, "mcp.json tools 应声明 15 个工具");
const declaredNames = new Set(declared.map((t) => t.name));
assert.deepEqual(
  [...declaredNames].sort(),
  [...sourceToolNames].sort(),
  "mcp.json 工具名与源码不一致",
);
for (const tool of declared) {
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

// ── token-schema.json（仅 token 过渡包；OAuth 包无此文件）───────────────
if (bundleKind === "token") {
  const tokenSchema = readJson("token-schema.json");
  assert(typeof tokenSchema.title === "string" && tokenSchema.title.trim());
  assert(typeof tokenSchema.description === "string" && tokenSchema.description.trim());
  assert(Array.isArray(tokenSchema.fields) && tokenSchema.fields.length >= 1, "fields 至少一项");
  const fieldKeys = new Set();
  for (const field of tokenSchema.fields) {
    assert(/^[A-Z][A-Z0-9_]*$/.test(field.key), `fields[].key 非法: ${field.key}`);
    assert(typeof field.label === "string" && field.label.trim(), `${field.key} 缺 label`);
    assert(
      field.type === "text" || field.type === "password",
      `${field.key} type 只能 text/password`,
    );
    assert(typeof field.required === "boolean", `${field.key} 缺 required`);
    fieldKeys.add(field.key);
  }
  // ${VAR} 占位符与表单字段 key 一一对应（区分大小写）
  assert.deepEqual(
    [...headerRefs].sort(),
    [...fieldKeys].sort(),
    "mcp.json 占位符与 token-schema 字段 key 不一致",
  );
  const tokenField = tokenSchema.fields.find((f) => f.key === "KIWI_MERCHANT_MCP_TOKEN");
  assert(tokenField, "缺 KIWI_MERCHANT_MCP_TOKEN 字段");
  assert.equal(tokenField.type, "password", "敏感凭证字段必须 password 类型");
  assert.equal(tokenField.required, true);
}

// ── icon.svg ────────────────────────────────────────────────────────
const icon = read("icon.svg").toString("utf8");
assert(/<svg[\s>]/.test(icon), "icon.svg 不是 SVG");
assert(!/<script/i.test(icon), "icon.svg 不得含 script");
assert(!/[\u4e00-\u9fff]/.test(icon), "icon.svg 不得含文字");

// ── SKILL.md frontmatter ────────────────────────────────────────────
const skillPath = "skills/kiwi-merchant/SKILL.md";
const skillText = read(skillPath).toString("utf8");
const fm = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
assert(fm, "SKILL.md 缺 frontmatter");
const skillMeta = parse(fm[1]);
assert.equal(skillMeta.name, "kiwi-merchant");
assert(/^[a-z0-9-]{1,64}$/.test(skillMeta.name));
assert(typeof skillMeta.description === "string" && skillMeta.description.trim());
files.push(skillPath);

// ── 凭据扫描（简单正则；占位符 ${VAR} 不算凭据）─────────────────────
const SECRET_PATTERNS = [
  { re: /SHOPPING_[A-Z_]*TOKEN/, label: "shopping-cli 后端凭据引用" },
  { re: /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{16,}/, label: "疑似内联 Bearer token" },
  { re: /sk-[A-Za-z0-9_-]{16,}/, label: "疑似 API key" },
];
for (const relative of files) {
  if (!/\.(json|md|svg)$/.test(relative)) continue;
  const text = read(relative).toString("utf8");
  for (const { re, label } of SECRET_PATTERNS) {
    assert(!re.test(text), `${relative} 含${label}`);
  }
}

console.log(
  `Validated ${meta.name} v${meta.version} [${bundleKind}]: ${declared.length} tools, icon and skill.`,
);

const args = process.argv.slice(2).filter((a) => !a.startsWith("--bundle="));
if (args.length === 1 && args[0] === "--check") process.exit(0);
assert(
  args.length === 2 && args[0] === "--out",
  "Usage: node package-merchant-connector.mjs [--bundle token|oauth] --check | --out /path/package.zip",
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
