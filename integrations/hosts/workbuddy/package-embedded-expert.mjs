import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { probeMcpIdentity } from './kiwi-sourcing/runtime/mcp-identity-probe.mjs';
import { probeMcpSchema } from './kiwi-sourcing/runtime/mcp-schema-probe.mjs';
import { toolNames, enableTargetedNegotiation } from './kiwi-sourcing/runtime/tool-contract.mjs';
import { probeCompanyProcurementExpert } from './probe-company-procurement-expert.mjs';
import { stageEmbeddedBuyer } from './stage-embedded-buyer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const sourcingRuntime = join(here, 'kiwi-sourcing/runtime');
const expertRuntime = join(here, 'kiwi-procurement-expert/runtime');

export const embeddedExpertLauncher = './runtime/embedded-expert-launcher.mjs';

export function validateExpertDisplay(manifest) {
  function bilingual(value) {
    for (const language of ['zh', 'en']) {
      assert(typeof value?.[language] === 'string' && value[language].trim(), `Missing ${language} text`);
    }
  }

  assert.equal(manifest.expertType, 'agent');
  assert.equal(manifest.plugin, manifest.name);
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version));
  for (const field of ['displayName', 'profession', 'displayDescription', 'defaultInitPrompt']) {
    bilingual(manifest[field]);
  }
  const descriptionLength = [...manifest.displayDescription.zh].length;
  assert(descriptionLength >= 40 && descriptionLength <= 50,
    `Chinese description: ${descriptionLength} chars, expected 40–50`);
  assert.equal(manifest.quickPrompts.length, 3);
  assert.equal(manifest.tags.length, 3);
  manifest.quickPrompts.forEach(bilingual);
  manifest.tags.forEach(bilingual);
  assert.deepEqual(manifest.defaultInitPrompt, manifest.quickPrompts[0]);
}

function frontmatter(relative, read) {
  const text = read(relative).toString("utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(match, `Missing frontmatter: ${relative}`);
  const meta = parse(match[1]);
  assert(meta && typeof meta.description === "string" && meta.description.trim());
  assert(/^[a-z0-9-]{1,64}$/.test(meta.name));
  return { meta, text };
}

export function validateExpertFrontmatter(manifest, read) {
  assert.equal(manifest.agents.length, 1);
  const agent = frontmatter(manifest.agents[0], read);
  assert.equal(agent.meta.name, manifest.agentName);
  assert.equal(basename(manifest.agents[0], ".md"), manifest.agentName);
  assert.deepEqual(agent.meta.displayName, manifest.displayName);
  assert.deepEqual(agent.meta.profession, manifest.profession);
  assert(!Object.hasOwn(agent.meta, "tools"), "WorkBuddy assigns tool permissions; do not set tools");

  const skillNames = [];
  let instructions = agent.text;
  for (const directory of manifest.skills) {
    const skill = frontmatter(`${directory}/SKILL.md`, read);
    assert.equal(skill.meta.name, basename(directory));
    skillNames.push(skill.meta.name);
    instructions += `\n${skill.text}`;
  }
  assert.equal(new Set(skillNames).size, skillNames.length);
  assert.deepEqual([...agent.meta.skills].sort(), skillNames.sort());
  return instructions;
}

export function validateExpertAvatar(avatar) {
  assert.equal(avatar.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(avatar.readUInt32BE(16), 512);
  assert.equal(avatar.readUInt32BE(20), 512);
  assert(avatar.length <= 500 * 1024, 'Avatar exceeds 500 KB');
}

export function validateExpertToolReferences(instructions, requiredTools, profile = 'legacy13') {
  const names = new Set(toolNames(profile));
  const usedTools = new Set(instructions.match(/\bkiwi_[a-z_]+\b/g));
  for (const name of usedTools) assert(names.has(name), `Unknown tool: ${name}`);
  for (const name of requiredTools ?? names) assert(usedTools.has(name), `Missing workflow for tool: ${name}`);
  return names.size;
}

const runtimeSources = new Map([
  ...['bundle-verify.mjs', 'embedded-expert-launcher.mjs', 'expert-data.mjs'].map(file => [file, join(expertRuntime, file)]),
  ...[
    'backend-client.mjs', 'environment-policy.mjs', 'instance-store.mjs',
    'mcp-production-server.mjs', 'mcp-tools-0.12.12.json', 'prepare-error-codes.mjs', 'tool-contract.mjs',
  ].map(file => [file, join(sourcingRuntime, file)]),
]);

export function checkEmbeddedExpertRuntime() {
  for (const source of runtimeSources.values()) {
    assert(lstatSync(source).isFile(), `Invalid runtime file: ${source}`);
  }
}

export async function packageEmbeddedExpert({bundle, files, output, profile = 'legacy13', verifyExtracted = profile === 'company-procurement-v1' ? probeCompanyProcurementExpert : undefined}) {
  assert(output.endsWith('.zip'), 'Output must be .zip');
  assert(!existsSync(output), 'Output already exists; choose a new path');
  assert(!output.startsWith(bundle + sep), 'Keep ZIP outside the bundle');
  mkdirSync(dirname(output), {recursive: true});
  const build = spawnSync('npm', ['run', 'build'], {cwd: root, stdio: 'inherit'});
  assert.equal(build.status, 0, build.error?.message ?? 'Unable to compile the buyer runtime');

  const workspace = mkdtempSync(join(tmpdir(), 'kiwi-expert-'));
  try {
    const stage = join(workspace, 'stage');
    const fixtureHome = join(workspace, 'fixture');
    const sources = new Map(files.map(file => [file.replace(/^\.\//, ''), join(bundle, file)]));
    for (const [file, source] of runtimeSources) sources.set(`runtime/${file}`, source);
    for (const [file, source] of sources) {
      const destination = join(stage, file);
      mkdirSync(dirname(destination), {recursive: true});
      cpSync(source, destination);
    }
    const embedded = await stageEmbeddedBuyer(root, stage);
    // Load the staged launcher itself: this catches imports that are missing
    // from runtimeSources, which file-existence checks and the buyer probes
    // cannot see.
    const selfCheck = spawnSync(process.execPath, [join(stage, 'runtime/embedded-expert-launcher.mjs'), '--self-check'], {encoding: 'utf8'});
    assert.equal(selfCheck.status, 0, `Embedded launcher failed to load: ${(selfCheck.stderr || selfCheck.error?.message || '').trim()}`);
    mkdirSync(fixtureHome, {mode: 0o700});
    const probe = {
      nodeBinary: process.execPath,
      packageRoot: join(stage, 'runtime/buyer/node_modules/@harrylabsj/kiwi'),
      fixtureHome,
    };
    for (const [locale, file] of [['en', 'mcp-tools-0.12.12.json'], ['zh', 'mcp-tools-0.12.12-zh.json']]) {
      const path = profile === 'legacy13' ? join(sourcingRuntime, file) : join(stage, 'runtime', `mcp-tools-company-${locale}.json`);
      const baseline = JSON.parse(readFileSync(path, 'utf8'));
      if (profile === 'legacy13') {
        // The standalone connector retains its pinned schema. Embedded experts ship the current buyer.
        const companyCatalog = join(here, 'kiwi-company-procurement-expert/runtime', `mcp-tools-company-${locale}.json`);
        const followUpdates = JSON.parse(readFileSync(companyCatalog, 'utf8')).find(tool => tool.name === 'kiwi_get_follow_updates');
        const index = baseline.findIndex(tool => tool.name === 'kiwi_get_follow_updates');
        assert(followUpdates && index >= 0, 'Missing follow updates tool');
        baseline[index] = followUpdates;
        if (sources.has(`runtime/${file}`)) writeFileSync(join(stage, 'runtime', file), JSON.stringify(baseline));
        enableTargetedNegotiation(baseline);
      }
      assert.equal((await probeMcpSchema({...probe, baseline, locale, profile})).toolCount, toolNames(profile).length);
    }
    assert.equal((await probeMcpIdentity({...probe, profile})).identity, 'supported');

    const entries = [...sources.keys(), ...embedded].sort();
    const archive = join(workspace, 'expert.zip');
    const result = spawnSync('zip', ['-X', archive, ...entries], {cwd: stage, encoding: 'utf8'});
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert(lstatSync(archive).size <= 20_000_000, 'WorkBuddy limits expert ZIPs to 20 MB');
    const listed = spawnSync('unzip', ['-Z1', archive], {encoding: 'utf8'});
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n').sort(), entries);
    for (const file of entries) {
      const extracted = spawnSync('unzip', ['-p', archive, file], {maxBuffer: 20_000_000});
      assert.equal(extracted.status, 0, `Cannot read ${file} from package`);
      assert.deepEqual(extracted.stdout, readFileSync(join(stage, file)), `Package content differs: ${file}`);
    }
    const checked = spawnSync('unzip', ['-t', archive], {encoding: 'utf8'});
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    if (verifyExtracted) {
      const extracted = join(workspace, 'extracted');
      const unpack = spawnSync('unzip', ['-q', archive, '-d', extracted], {encoding: 'utf8'});
      assert.equal(unpack.status, 0, unpack.stderr);
      await verifyExtracted(extracted, fixtureHome);
    }
    cpSync(archive, output, {force: false, errorOnExist: true});
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}
