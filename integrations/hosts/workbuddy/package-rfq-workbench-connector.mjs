import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

// kiwi-rfq-workbench 连接器打包校验（询报价设计 v0.1.1 §12.2/§12.3；M4 私有宿主）。
// 风格对齐 package-merchant-connector.mjs：Node assert、项目已有依赖（yaml）、
// 系统 zip；只读校验不联网，只打包明确列出的文件，不覆盖已有压缩包。
//
// 边界（§12.2）：本包是「自定义连接器直连商家实例 MCP」的 M4 私有试点资产，
// 不改公共网关、不宣称平台审核通过；发布类工具（prepare_release/prepare_handoff/
// get_release）要求实例侧 KIWI_RFQ_RELEASE=1（缺省关闭，§17.2）。

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const bundle = path.join(here, "kiwi-rfq-workbench");
const skills = [
  "skills/rfq-intake/SKILL.md",
  "skills/quote-build-review/SKILL.md",
  "skills/quote-release-followup/SKILL.md",
];
const files = ["connector-meta.json", "mcp.json", "token-schema.json", "icon.svg", ...skills];

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
assert.equal(meta.auth_mode, "token");
assert.equal(meta.source, "kiwi-rfq-workbench-token", "token 过渡包 source");
assert(/^\d+\.\d+\.\d+$/.test(meta.version), "version 必须语义化");
assert(
  /^\d+\.\d+\.\d+$/.test(meta.minWorkbuddyVersion),
  "需声明 minWorkbuddyVersion（examples_* 需 4.24.0）",
);
bilingual(meta, "name");
bilingual(meta, "description");
bilingualList(meta, "examples");
assert.equal(meta.examples_zh.length, 5, "examples 对应 §12.3 首页五场景");
assert.equal(meta.examples_zh.length, meta.examples_en.length);

// ── mcp.json ────────────────────────────────────────────────────────
const mcp = readJson("mcp.json");
const servers = Object.entries(mcp.mcpServers ?? {});
assert.equal(servers.length, 1, "一个连接器只配置一个 MCP Server（§12.2）");
const [serverName, server] = servers[0];
assert(/^[a-z0-9-]+$/.test(serverName), "mcpServers 键名必须 kebab-case");
assert.equal(server.type, "streamableHttp");
// host 整体锚定：hostname 必须精确为 rfq-workbench.example.com 模板域
// （防 attached-domain 绕过；生产地址由试点部署批准后替换）。
const url = new globalThis.URL(server.url);
assert.equal(url.protocol, "https:", "url 必须 HTTPS");
assert.equal(url.pathname, "/mcp", "url 路径必须 /mcp");
assert.equal(url.hostname, "rfq-workbench.example.com", "url 必须为模板域（生产地址部署时批准）");
assert.equal(server.timeout, 30000, "timeout 30000（30s 上限，§17.3）");
const headerRefs = new Set(
  Object.values(server.headers ?? {}).flatMap((v) =>
    [...String(v).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]),
  ),
);
assert(headerRefs.size > 0, "headers 必须用 ${VAR} 占位引用 token");

// 工具声明与 src/mcp/merchant-rfq-tools.ts 的工具名集合完全一致（防漂移；
// description/inputSchema 全等比对见 tests/workbuddy-rfq-connector.test.ts）。
const toolSource = readFileSync(path.join(root, "src/mcp/merchant-rfq-tools.ts"), "utf8");
const sourceToolNames = new Set(
  [...toolSource.matchAll(/name: "(kiwi_merchant_rfq_[a-z0-9_]+)"/g)].map((m) => m[1]),
);
assert.equal(sourceToolNames.size, 14, `源码应有 14 个 RFQ 工具，实际 ${sourceToolNames.size}`);
const declared = mcp.tools ?? [];
assert.equal(declared.length, 14, "mcp.json tools 应声明 14 个工具");
const declaredNames = new Set(declared.map((t) => t.name));
assert.deepEqual(
  [...declaredNames].sort(),
  [...sourceToolNames].sort(),
  "mcp.json 工具名与源码不一致",
);
const releaseGated = new Set([
  "kiwi_merchant_rfq_prepare_release",
  "kiwi_merchant_rfq_get_release",
  "kiwi_merchant_rfq_prepare_handoff",
]);
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
  if (releaseGated.has(tool.name)) {
    assert(
      /批准|管理页/u.test(tool.description),
      `${tool.name} description 必须标注批准走可信管理页`,
    );
  }
}
// 模型工具面没有 approve（§9.4）
assert(![...declaredNames].some((n) => n.includes("approve")), "RFQ 工具面不得包含 approve");

// ── token-schema.json ───────────────────────────────────────────────
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
assert.deepEqual(
  [...headerRefs].sort(),
  [...fieldKeys].sort(),
  "mcp.json 占位符与 token-schema 字段 key 不一致",
);
const tokenField = tokenSchema.fields.find((f) => f.key === "KIWI_RFQ_MCP_TOKEN");
assert(tokenField, "缺 KIWI_RFQ_MCP_TOKEN 字段");
assert.equal(tokenField.type, "password", "敏感凭证字段必须 password 类型");
assert.equal(tokenField.required, true);
// 三层凭据隔离（§12.1）：不得引导填写 shopping-cli/目录网关凭据。
assert(!/SHOPPING_[A-Z_]*TOKEN/.test(JSON.stringify(tokenSchema)), "token-schema 不得引用 shopping-cli 凭据");

// ── icon.svg ────────────────────────────────────────────────────────
const icon = read("icon.svg").toString("utf8");
assert(/<svg[\s>]/.test(icon), "icon.svg 不是 SVG");
assert(!/<script/i.test(icon), "icon.svg 不得含 script");
assert(!/[\u4e00-\u9fff]/.test(icon), "icon.svg 不得含文字");

// ── SKILL.md frontmatter（§12.3：一个专家三个技能）──────────────────
for (const skillPath of skills) {
  const skillText = read(skillPath).toString("utf8");
  const fm = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(fm, `${skillPath} 缺 frontmatter`);
  const skillMeta = parse(fm[1]);
  const expectedName = skillPath.split("/")[1];
  assert.equal(skillMeta.name, expectedName, `${skillPath} frontmatter name 与目录名不一致`);
  assert(/^[a-z0-9-]{1,64}$/.test(skillMeta.name));
  assert(typeof skillMeta.description === "string" && skillMeta.description.trim());
}

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
  `Validated ${meta.name} v${meta.version}: ${declared.length} tools, ${skills.length} skills, icon and token schema.`,
);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") process.exit(0);
assert(
  args.length === 2 && args[0] === "--out",
  "Usage: node package-rfq-workbench-connector.mjs --check | --out /path/package.zip",
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
