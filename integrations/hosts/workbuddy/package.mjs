import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  checkEmbeddedExpertRuntime, embeddedExpertLauncher, packageEmbeddedExpert,
  validateExpertAvatar, validateExpertDisplay, validateExpertFrontmatter, validateExpertToolReferences,
} from "./package-embedded-expert.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const bundle = path.join(here, "kiwi-procurement-expert");
const manifestPath = ".codebuddy-plugin/plugin.json";
const files = [manifestPath];

function read(relative) {
  const full = path.resolve(bundle, relative);
  assert(full.startsWith(`${bundle}${path.sep}`), `Path escapes bundle: ${relative}`);
  assert(!lstatSync(full).isSymbolicLink(), `Symlink not allowed: ${relative}`);
  assert(realpathSync(full).startsWith(`${realpathSync(bundle)}${path.sep}`));
  return readFileSync(full);
}

const manifest = JSON.parse(read(manifestPath));
validateExpertDisplay(manifest);
assert(manifest.author?.name?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(manifest.author.email ?? ""),
  "WorkBuddy expert author must include a name and contact email");
assert.equal(manifest.dependencies.mcpServers, "./.mcp.json");
assert(!manifest.dependencies.connectors?.length, "Expert must not depend on a marketplace connector");
const mcp = JSON.parse(read(".mcp.json"));
const servers = Object.entries(mcp.mcpServers ?? {});
assert.equal(servers.length, 1);
const [serverName, server] = servers[0];
assert.equal(serverName, `kiwi-procurement-buyer-${manifest.version.replaceAll(".", "-")}`);
assert.equal(server.type, "stdio");
assert.equal(server.command, "node");
assert.deepEqual(server.args, [embeddedExpertLauncher, serverName]);
assert.equal(server["x-workbuddy"].auth.type, "none");
files.push(".mcp.json");
checkEmbeddedExpertRuntime();
const instructions = validateExpertFrontmatter(manifest, read);
files.push(...manifest.agents, ...manifest.skills.map(directory => `${directory}/SKILL.md`));
const toolCount = validateExpertToolReferences(instructions);

const examplePath = "skills/kiwi-source-and-quote/references/rfq-example.json";
const example = JSON.parse(read(examplePath));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(
  readFileSync(path.join(root, "contracts/commerce-intent/1.0/schema.json")),
);
const validate = ajv.compile(schema);
assert(validate(example.intent), JSON.stringify(validate.errors));
assert(example.merchant_ids.length > 0 && example.idempotency_key);
files.push(examplePath);

validateExpertAvatar(read(manifest.avatar));
files.push(manifest.avatar);
console.log(
  `Validated ${manifest.profession.zh} | ${manifest.displayName.zh} v${manifest.version}: ${manifest.skills.length} skills, ${toolCount} tools, CommerceIntent and avatar.`,
);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") process.exit(0);
assert(
  args.length === 2 && args[0] === "--out",
  "Usage: node package.mjs --check | --out /path/package.zip",
);
const output = path.resolve(args[1]);
function verifyProcurementExpert(extracted, fixture) {
  const home = path.join(fixture, "readonly-home");
  const data = path.join(fixture, "private-data");
  const workspace = path.join(fixture, "buyer workspace");
  for (const dir of [home, data, workspace]) mkdirSync(dir, {mode: 0o700});
  chmodSync(home, 0o500);
  try {
    const result = spawnSync(process.execPath, [path.join(here, "test/verify-expert-audit.mjs"), extracted, workspace], {
      cwd: workspace, env: {HOME: home, CODEBUDDY_PLUGIN_DATA: data, TMPDIR: fixture, PATH: path.dirname(process.execPath)},
      encoding: "utf8", timeout: 90000,
    });
    assert.equal(result.status, 0, result.error?.message ?? (result.stdout + result.stderr));
    assert.deepEqual(readdirSync(home), []);
    assert(lstatSync(path.join(data, ".kiwi-workbuddy-buyer-v1", "kiwi-instance-v1", "buyer.sqlite")).isFile());
  } finally { chmodSync(home, 0o700); }
}
await packageEmbeddedExpert({bundle, files, output, verifyExtracted:verifyProcurementExpert});
console.log(`Created ${output}`);
