import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { build } from 'esbuild';

const kiwi = 'node_modules/@harrylabsj/kiwi';
const runtimePrefix = 'runtime/buyer';
const notices = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md', 'COPYING'];

export async function stageEmbeddedBuyer(root, stage) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = new Map();
  const npmPackages = new Set();

  function add(source, destination = source) {
    const file = join(root, source);
    assert(lstatSync(file).isFile(), `Expected a regular runtime file: ${source}`);
    files.set(destination, readFileSync(file));
  }

  function addDirectory(directory) {
    for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = posix.join(directory, item.name);
      if (item.isDirectory()) addDirectory(file);
      else add(file, `${kiwi}/${file}`);
    }
  }

  // Use the graph only as a file list. Copy the compiled modules byte for byte
  // to keep relative imports, import.meta.url and JSON schema lookups working.
  // AJV is loaded with createRequire at runtime, so trace its entry points too.
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: ['dist/mcp/cli.js', 'node_modules/ajv/dist/2020.js', 'node_modules/ajv-formats/dist/index.js'],
    outdir: 'embedded-buyer-trace',
    bundle: true,
    platform: 'node',
    format: 'esm',
    preserveSymlinks: true,
    write: false,
    metafile: true,
  });
  for (const input of Object.keys(metafile.inputs)) {
    assert.equal(posix.normalize(input), input);
    if (input === 'package.json') continue; // The embedded package metadata is written below.
    if (input.startsWith('dist/')) {
      add(input, `${kiwi}/${input}`);
      continue;
    }
    const match = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    assert(match && lock.packages[match[1]], `Unexpected runtime dependency: ${input}`);
    npmPackages.add(match[1]);
    add(input);
  }

  for (const directory of npmPackages) {
    const meta = `${directory}/package.json`;
    const installed = JSON.parse(readFileSync(join(root, meta), 'utf8'));
    assert.equal(installed.version, lock.packages[directory].version, `Run npm ci for ${directory}`);
    add(meta);
    for (const notice of notices) {
      const source = `${directory}/${notice}`;
      if (existsSync(join(root, source))) add(source);
    }
  }
  addDirectory('contracts');
  add('LICENSE', `${kiwi}/LICENSE`);
  files.set(`${kiwi}/package.json`, JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    license: pkg.license,
  }) + '\n');
  files.set(`${kiwi}/dist/cli.js`, [
    "import { runMcpServe } from './mcp/cli.js';",
    "if (process.argv[2] !== 'mcp' || process.argv[3] !== 'serve') process.exit(2);",
    'process.exitCode = await runMcpServe(process.argv.slice(4));',
    '',
  ].join('\n'));

  const digests = {};
  const staged = [];
  for (const file of [...files.keys()].sort()) {
    const content = files.get(file);
    const relative = `${runtimePrefix}/${file}`;
    const destination = join(stage, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
    digests[file] = createHash('sha256').update(content).digest('hex');
    staged.push(relative);
  }
  const manifest = 'runtime/buyer-files.json';
  writeFileSync(join(stage, manifest), JSON.stringify(digests) + '\n');
  return [...staged, manifest];
}
