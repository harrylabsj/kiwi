import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMcpIdentity } from './kiwi-sourcing/runtime/mcp-identity-probe.mjs';
import { probeMcpSchema } from './kiwi-sourcing/runtime/mcp-schema-probe.mjs';
import { stageEmbeddedBuyer } from './stage-embedded-buyer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const sourcingRuntime = join(here, 'kiwi-sourcing/runtime');
const expertRuntime = join(here, 'kiwi-procurement-expert/runtime');

export const embeddedExpertLauncher = './runtime/embedded-expert-launcher.mjs';

const runtimeSources = new Map([
  ...['embedded-expert-launcher.mjs', 'expert-data.mjs'].map(file => [file, join(expertRuntime, file)]),
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

export async function packageEmbeddedExpert({bundle, files, output}) {
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
    mkdirSync(fixtureHome, {mode: 0o700});
    const probe = {
      nodeBinary: process.execPath,
      packageRoot: join(stage, 'runtime/buyer/node_modules/@harrylabsj/kiwi'),
      fixtureHome,
    };
    for (const [locale, file] of [['en', 'mcp-tools-0.12.12.json'], ['zh', 'mcp-tools-0.12.12-zh.json']]) {
      const baseline = JSON.parse(readFileSync(join(sourcingRuntime, file), 'utf8'));
      assert.equal((await probeMcpSchema({...probe, baseline, locale})).toolCount, 13);
    }
    assert.equal((await probeMcpIdentity(probe)).identity, 'supported');

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
    cpSync(archive, output, {force: false, errorOnExist: true});
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}
