import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkEmbeddedExpertRuntime, embeddedExpertLauncher, packageEmbeddedExpert,
  validateExpertAvatar, validateExpertDisplay, validateExpertToolReferences,
} from './package-embedded-expert.mjs';

const bundle = join(dirname(fileURLToPath(import.meta.url)), 'kiwi-company-procurement-expert');
const profile = 'company-procurement-v1';
const serverName = 'kiwi-company-procurement-buyer';

function bundleFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return bundleFiles(join(directory, entry.name), relative + '/');
    assert(entry.isFile(), `Expected a regular file: ${relative}`);
    return [relative];
  });
}
const files = bundleFiles(bundle);
const read = file => readFileSync(join(bundle, file), 'utf8');
const meta = JSON.parse(read('.codebuddy-plugin/plugin.json'));
const mcp = JSON.parse(read('.mcp.json'));
const config = JSON.parse(read('runtime/expert-config.json'));
validateExpertDisplay(meta);
assert.equal(meta.name, 'kiwi-company-procurement-expert');
assert.equal(meta.agentName, 'kiwi-company-procurement');
assert.equal(meta.agents.length, 1);
assert.equal(meta.skills.length, 3);
assert(meta.agents.every(file => files.includes(file.slice(2))));
assert(meta.skills.every(dir => files.includes(dir.slice(2) + '/SKILL.md')));
assert(files.includes(meta.avatar));
validateExpertAvatar(readFileSync(join(bundle, meta.avatar)));
assert.equal(meta.version, '1.0.1');
assert.equal(meta.dependencies.mcpServers, './.mcp.json');
assert(!meta.dependencies.connectors?.length);
assert.deepEqual(Object.keys(mcp.mcpServers), [serverName]);
const server = mcp.mcpServers[serverName];
assert.equal(server.type, 'stdio');
assert.equal(server.command, 'node');
assert.deepEqual(server.args, [embeddedExpertLauncher, serverName]);
assert.equal(server['x-workbuddy'].auth.type, 'none');
assert.deepEqual(config, { profile, namespace: '.kiwi-workbuddy-company-procurement-v1' });
checkEmbeddedExpertRuntime();
const instructions = files.filter(file => file.endsWith('.md')).map(read).join('\n');
assert.equal(validateExpertToolReferences(instructions, undefined, profile), 17);

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--check') {
  console.log('Validated Kiwi company procurement expert');
} else {
  assert(args.length === 2 && args[0] === '--out', 'Usage: package-company-procurement-expert.mjs --check | --out /absolute/path.zip');
  const output = resolve(args[1]);
  await packageEmbeddedExpert({ bundle, files, output, profile });
  console.log(`Created ${output}`);
}
