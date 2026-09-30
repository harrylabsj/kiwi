import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const connectorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(connectorRoot, "../../../..");
const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};
const read = (path) => readFileSync(path, "utf8");
const parseJson = (path) => {
  try {
    return JSON.parse(read(path));
  } catch (error) {
    errors.push(`${relative(connectorRoot, path)} 不是合法 JSON：${error.message}`);
    return {};
  }
};

const requiredFiles = [
  "connector-meta.json",
  "mcp.json",
  "icon.svg",
  "README.md",
  "skills/kiwi-sourcing/SKILL.md",
  "skills/kiwi-sourcing/references/commerce-intent.md",
  "skills/kiwi-sourcing/references/approval-flow.md",
  "skills/kiwi-sourcing/references/error-recovery.md",
  "fixtures/initialize-tools-list.jsonl",
];

for (const file of requiredFiles) {
  const absolute = join(connectorRoot, file);
  check(existsSync(absolute), `缺少 ${file}`);
  if (existsSync(absolute)) check(!lstatSync(absolute).isSymbolicLink(), `${file} 不得是符号链接`);
}

const meta = parseJson(join(connectorRoot, "connector-meta.json"));
check(meta.source === "kiwi-sourcing", "connector source 必须为 kiwi-sourcing");
check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.source ?? ""), "connector source 必须是 kebab-case");
check(meta.type === "mcp", "connector type 必须为 mcp");
check(/^\d+\.\d+\.\d+$/.test(meta.version ?? ""), "connector version 必须是 semver");
check(/^\d+\.\d+\.\d+$/.test(meta.minWorkbuddyVersion ?? ""), "minWorkbuddyVersion 必须是 semver");
for (const field of ["name", "name_en", "description", "description_zh", "description_en"]) {
  check(
    typeof meta[field] === "string" && meta[field].trim().length > 0,
    `connector-meta.${field} 必填`,
  );
}
for (const field of ["examples_zh", "examples_en"]) {
  check(
    Array.isArray(meta[field]) && meta[field].length >= 2 && meta[field].length <= 5,
    `${field} 必须有 2–5 条`,
  );
}
check(!("auth_mode" in meta), "公共本地连接器首版不得配置 auth_mode");

const mcp = parseJson(join(connectorRoot, "mcp.json"));
const servers = Object.entries(mcp.mcpServers ?? {});
check(servers.length === 1, "一个 WorkBuddy 连接器必须且只能配置一个 MCP Server");
const [serverName, server = {}] = servers[0] ?? [];
check(serverName === "kiwi-sourcing", "MCP Server 名称必须为 kiwi-sourcing");
check(server.type === "stdio", "首版 MCP transport 必须为 stdio");
check(server.command === "npx", "stdio MCP 必须通过 npx 启动");
check(
  server.runtime?.type === "node" && server.runtime?.version === "22",
  "必须声明 Node 22 runtime",
);
check(
  Number.isInteger(server.timeout) && server.timeout > 0 && server.timeout <= 30000,
  "timeout 必须在 1–30000 ms",
);
check(Array.isArray(server.args), "MCP args 必须是数组");
const args = Array.isArray(server.args) ? server.args : [];
const packageArg = args.find(
  (arg) => typeof arg === "string" && arg.startsWith("@harrylabsj/kiwi@"),
);
// 1.0.1（在审版）= 13 工具 + 跟随 npm latest：--prefer-online 让启动时检查包元数据
// 新鲜度，避免每次新增工具都要重新送审。两种形态都接受，固定 pin 的变体留给后续版本：
//   a) @harrylabsj/kiwi@latest + --prefer-online
//   b) @harrylabsj/kiwi@<明确 semver>（不带 --prefer-online）
const isLatest = packageArg === "@harrylabsj/kiwi@latest";
const isPinned = /^@harrylabsj\/kiwi@\d+\.\d+\.\d+$/.test(packageArg ?? "");
check(isLatest || isPinned, "Kiwi npm 包必须是 @latest 或明确 semver");
check(
  !isLatest || args.includes("--prefer-online"),
  "使用 @latest 时必须带 --prefer-online（强制检查 npm 元数据）",
);
const sequence = args.join(" ");
for (const expected of [
  "mcp serve",
  "--principal workbuddy:local",
  "--agent buyer-agent:workbuddy",
  "--a2a-timeout-ms 15000",
]) {
  check(sequence.includes(expected), `MCP args 缺少：${expected}`);
}

const skillPath = join(connectorRoot, "skills/kiwi-sourcing/SKILL.md");
const skill = existsSync(skillPath) ? read(skillPath) : "";
const frontmatterMatch = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
check(Boolean(frontmatterMatch), "SKILL.md 必须包含 YAML frontmatter");
const frontmatter = frontmatterMatch?.[1] ?? "";
for (const field of ["description", "description_zh", "description_en", "version", "author"]) {
  check(
    new RegExp(`^${field}:\\s*\\S+`, "m").test(frontmatter),
    `SKILL.md frontmatter 缺少 ${field}`,
  );
}
const allowedLine = frontmatter.match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? "";
const allowedTools = allowedLine
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const expectedTools = [
  "kiwi_search",
  "kiwi_request_quotes",
  "kiwi_get_task",
  "kiwi_negotiate",
  "kiwi_accept_agreement",
  "kiwi_get_agreement",
  "kiwi_handoff",
  "kiwi_approve",
  "kiwi_reject",
  "kiwi_follow_merchant",
  "kiwi_unfollow_merchant",
  "kiwi_list_follows",
  "kiwi_get_follow_updates",
];
check(
  JSON.stringify(allowedTools) === JSON.stringify(expectedTools),
  "allowed-tools 必须精确列出 13 个 Kiwi 工具",
);
for (const tool of expectedTools)
  check(skill.includes(`\`${tool}\``), `SKILL.md 正文未说明 ${tool}`);
for (const reference of ["commerce-intent.md", "approval-flow.md", "error-recovery.md"]) {
  check(skill.includes(`@references/${reference}`), `SKILL.md 未引用 ${reference}`);
}
check(skill.includes("最多选择 3 家"), "SKILL.md 必须限制首发询价最多 3 家商家");
check(skill.includes("不创建订单、不支付、不锁库存"), "SKILL.md 必须声明非绑定边界");

const walkFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolute);
    return entry.isFile() ? [absolute] : [];
  });
const packageFiles = walkFiles(connectorRoot).filter(
  (path) => !path.includes(`${sep}scripts${sep}`),
);
const packageText = packageFiles.map((path) => read(path)).join("\n");
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /(?:authorization|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?(?!\$\{)[A-Za-z0-9._-]{16,}/i,
];
for (const pattern of secretPatterns)
  check(!pattern.test(packageText), `连接器包命中疑似密钥模式：${pattern}`);

const escaped = packageFiles.find((path) => {
  const rel = relative(connectorRoot, resolve(path));
  return rel.startsWith(`..${sep}`) || rel === "..";
});
check(!escaped, "连接器包存在越界文件");
check(existsSync(join(repositoryRoot, "package.json")), "无法定位 Kiwi 仓库根目录");

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}

console.log(`✓ WorkBuddy connector ${meta.version} validation OK (${expectedTools.length} tools)`);
