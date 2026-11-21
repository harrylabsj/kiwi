import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runtimeFiles } from './kiwi-sourcing/scripts/package-manifest.mjs';
import { verifyFiles } from './kiwi-procurement-expert/runtime/bundle-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'online-shopping-assistant');
const runtime = join(here, 'kiwi-sourcing/runtime');
const expert = join(here, 'kiwi-procurement-expert/runtime');
const local = [
  'SKILL.md',
  'scripts/kiwi-tool.mjs',
  ...['comparison-rules.md', 'kiwi-inquiry-and-negotiation.md', 'output-format.md', 'platform-research.md']
    .map(file => `references/${file}`),
];

function safe(base, file) {
  const target = resolve(base, file);
  assert(target.startsWith(base + sep));
  assert(lstatSync(target).isFile());
  assert(realpathSync(target).startsWith(realpathSync(base) + sep));
  return target;
}

const runtimeSources = new Map(runtimeFiles.map(file => [file, safe(runtime, file)]));
runtimeSources.set('expert-data.mjs', safe(expert, 'expert-data.mjs'));

const sources = new Map(local.map(file => [file, safe(root, file)]));
sources.set('scripts/bundle-verify.mjs', safe(expert, 'bundle-verify.mjs'));

const skill = readFileSync(sources.get('SKILL.md'), 'utf8');
assert.match(skill, /^name: online-shopping-assistant$/m);
assert.match(skill, /^version: 1\.3\.0$/m);
assert(skill.includes('scripts/kiwi-tool.mjs'));
assert(!skill.includes('`kiwi-sourcing` 连接器'));
const reference = readFileSync(sources.get('references/kiwi-inquiry-and-negotiation.md'), 'utf8');
assert(reference.includes('scripts/kiwi-tool.mjs'));
console.log(`Validated 网上购物助手 1.3.0 with bundled Kiwi runtime (${runtimeSources.size} files).`);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--check') process.exit(0);
assert(args.length === 2 && args[0] === '--out', 'Usage: node package-online-shopping-skill.mjs --check | --out /path/package.zip');
const output = resolve(args[1]);
assert(output.endsWith('.zip') && !existsSync(output), 'Choose a new ZIP path');
mkdirSync(dirname(output), { recursive: true });
const stage = mkdtempSync(join(tmpdir(), 'kiwi-skill-'));

try {
  const name = 'online-shopping-assistant';
  const dir = join(stage, name);
  const entries = [];
  function stageFile(relative, source) {
    const destination = join(dir, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
    entries.push(`${name}/${relative}`);
    return destination;
  }

  for (const [file, source] of sources) stageFile(file, source);
  const hashes = new Map();
  for (const [file, source] of runtimeSources) {
    const destination = stageFile(`scripts/runtime/${file}`, source);
    hashes.set(file, createHash('sha256').update(readFileSync(destination)).digest('hex'));
  }
  const expected = new Map(hashes);
  verifyFiles(join(dir, 'scripts/runtime'), expected);
  assert.equal(expected.size, 0, 'Missing runtime files in the staged skill');
  const manifest = 'scripts/runtime-files.json';
  writeFileSync(join(dir, manifest), JSON.stringify(Object.fromEntries(hashes)) + '\n');
  entries.push(`${name}/${manifest}`);

  const archive = join(stage, 'skill.zip');
  const zip = spawnSync('zip', ['-X', archive, ...entries], { cwd: stage, encoding: 'utf8' });
  assert.equal(zip.status, 0, zip.error?.message ?? zip.stderr);
  const list = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split('\n').sort(), entries.sort());
  const check = spawnSync('unzip', ['-t', archive], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  cpSync(archive, output, { force: false, errorOnExist: true });
  console.log(`Created ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
