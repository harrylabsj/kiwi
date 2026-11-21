import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  checkEmbeddedExpertRuntime, embeddedExpertLauncher, packageEmbeddedExpert,
  validateExpertAvatar, validateExpertDisplay, validateExpertToolReferences,
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

const manifest = JSON.parse(read(manifestPath));
validateExpertDisplay(manifest);
assert.equal(manifest.dependencies.mcpServers, "./.mcp.json");
assert(!manifest.dependencies.connectors?.length, "Expert must not depend on a marketplace connector");
const mcp = JSON.parse(read(".mcp.json"));
const servers = Object.entries(mcp.mcpServers ?? {});
assert.equal(servers.length, 1);
const [serverName, server] = servers[0];
assert.equal(serverName, "kiwi-procurement-buyer");
assert.equal(server.type, "stdio");
assert.equal(server.command, "node");
assert.deepEqual(server.args, [embeddedExpertLauncher, serverName]);
assert.equal(server["x-workbuddy"].auth.type, "none");
files.push(".mcp.json");
checkEmbeddedExpertRuntime();
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
  `Validated ${manifest.profession.zh} | ${manifest.displayName.zh} v${manifest.version}: ${skillNames.length} skills, ${toolCount} tools, CommerceIntent and avatar.`,
);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--check") process.exit(0);
assert(
  args.length === 2 && args[0] === "--out",
  "Usage: node package.mjs --check | --out /path/package.zip",
);
const output = path.resolve(args[1]);
await packageEmbeddedExpert({bundle, files, output});
console.log(`Created ${output}`);
