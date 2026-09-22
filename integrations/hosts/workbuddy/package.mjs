import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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

function frontmatter(relative) {
  const text = read(relative).toString("utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(match, `Missing frontmatter: ${relative}`);
  const meta = parse(match[1]);
  assert(meta && typeof meta.description === "string" && meta.description.trim());
  assert(/^[a-z0-9-]{1,64}$/.test(meta.name));
  files.push(relative);
  return { meta, text };
}

function bilingual(value) {
  for (const lang of ["zh", "en"]) assert(typeof value?.[lang] === "string" && value[lang].trim());
}

const manifest = JSON.parse(read(manifestPath));
assert.equal(manifest.expertType, "agent");
assert.equal(manifest.plugin, manifest.name);
assert(/^\d+\.\d+\.\d+$/.test(manifest.version));
for (const field of ["displayName", "profession", "displayDescription", "defaultInitPrompt"]) {
  bilingual(manifest[field]);
}
const descriptionLength = [...manifest.displayDescription.zh].length;
assert(
  descriptionLength >= 40 && descriptionLength <= 50,
  `Chinese description: ${descriptionLength} chars, expected 40–50`,
);
assert.equal(manifest.quickPrompts.length, 3);
assert.equal(manifest.tags.length, 3);
manifest.quickPrompts.forEach(bilingual);
manifest.tags.forEach(bilingual);
assert.deepEqual(manifest.defaultInitPrompt, manifest.quickPrompts[0]);
assert.equal(manifest.dependencies.connectors.length, 1);
// Desktop 5.6.0 resolves connector dependencies by source, not open-platform asset ID.
assert.equal(manifest.dependencies.connectors[0], "kiwi-sourcing");
assert.equal(manifest.agents.length, 1);
const agent = frontmatter(manifest.agents[0]);
assert.equal(agent.meta.name, manifest.agentName);
assert.equal(path.basename(manifest.agents[0], ".md"), manifest.agentName);
assert.deepEqual(agent.meta.displayName, manifest.displayName);
assert.deepEqual(agent.meta.profession, manifest.profession);
assert(!Object.hasOwn(agent.meta, "tools"), "WorkBuddy assigns tool permissions; do not set tools");

const skillNames = [];
let instructions = agent.text;
for (const directory of manifest.skills) {
  const skill = frontmatter(`${directory}/SKILL.md`);
  assert.equal(skill.meta.name, path.basename(directory));
  skillNames.push(skill.meta.name);
  instructions += `\n${skill.text}`;
}
assert.equal(new Set(skillNames).size, skillNames.length);
assert.deepEqual([...agent.meta.skills].sort(), skillNames.sort());

const toolSource = readFileSync(path.join(root, "src/mcp/tools.ts"), "utf8");
const toolNames = new Set([...toolSource.matchAll(/name: "(kiwi_[a-z_]+)"/g)].map((m) => m[1]));
const usedTools = new Set(instructions.match(/\bkiwi_[a-z_]+\b/g));
for (const name of usedTools) assert(toolNames.has(name), `Unknown tool: ${name}`);
for (const name of toolNames) assert(usedTools.has(name), `Missing workflow for tool: ${name}`);

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

const avatar = read(manifest.avatar);
assert.equal(avatar.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(avatar.readUInt32BE(16), 512);
assert.equal(avatar.readUInt32BE(20), 512);
assert(avatar.length <= 500 * 1024, "Avatar exceeds 500 KB");
files.push(manifest.avatar);
console.log(
  `Validated ${manifest.profession.zh} | ${manifest.displayName.zh} v${manifest.version}: ${skillNames.length} skills, ${toolNames.size} tools, CommerceIntent and avatar.`,
);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") process.exit(0);
assert(
  args.length === 2 && args[0] === "--out",
  "Usage: node package.mjs --check | --out /path/package.zip",
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
