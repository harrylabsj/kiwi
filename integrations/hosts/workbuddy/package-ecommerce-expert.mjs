import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkEmbeddedExpertRuntime, embeddedExpertLauncher, packageEmbeddedExpert,
  validateExpertAvatar, validateExpertDisplay, validateExpertToolReferences,
} from './package-embedded-expert.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const bundle=join(here,'haina-ecommerce-expert');
const files=['.codebuddy-plugin/plugin.json','.mcp.json','agents/haina-ecommerce-expert.md','avatars/expert.png','skills/online-shopping-assistant/SKILL.md',...['comparison-rules.md','kiwi-inquiry-and-negotiation.md','output-format.md','platform-research.md'].map(x=>`skills/online-shopping-assistant/references/${x}`)];
function safeFile(root,name){const p=resolve(root,name);assert(p.startsWith(root+sep));assert(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink());assert(realpathSync(p).startsWith(realpathSync(root)+sep));return p}
for(const f of files)safeFile(bundle,f);
const meta=JSON.parse(readFileSync(join(bundle,files[0]),'utf8'));
const mcp=JSON.parse(readFileSync(join(bundle,'.mcp.json'),'utf8'));
validateExpertDisplay(meta);
assert(files.includes(meta.avatar), 'Avatar must be included in the expert ZIP');
validateExpertAvatar(readFileSync(safeFile(bundle,meta.avatar)));
assert.equal(meta.version,'1.2.8');assert.equal(meta.dependencies.mcpServers,'./.mcp.json');assert(!meta.dependencies.connectors?.length);
assert.deepEqual(Object.keys(mcp.mcpServers),['kiwi-shopping-buyer']);
const server=mcp.mcpServers['kiwi-shopping-buyer'];assert.equal(server.type,'stdio');assert.equal(server.command,'node');assert.deepEqual(server.args,[embeddedExpertLauncher,'kiwi-shopping-buyer']);assert.equal(server['x-workbuddy'].auth.type,'none');
checkEmbeddedExpertRuntime();
const instructions=files.filter(file=>file.endsWith('.md')).map(file=>readFileSync(join(bundle,file),'utf8')).join('\n');
validateExpertToolReferences(instructions,['kiwi_search','kiwi_request_quotes','kiwi_get_task','kiwi_negotiate']);
assert(instructions.includes('kiwi-shopping-buyer'));assert(!instructions.includes('`kiwi-sourcing` 连接器'));assert(!instructions.includes('scripts/kiwi-tool.mjs'));
console.log(`Validated ${meta.profession.zh} v${meta.version}: built-in MCP and embedded runtime.`);
const args=process.argv.slice(2);if(args.length===1&&args[0]==='--check')process.exit(0);
assert(args.length===2&&args[0]==='--out','Usage: node package-ecommerce-expert.mjs --check | --out /absolute/path.zip');
const output=resolve(args[1]);
function verifyShoppingExpert(extracted, fixtureDirectory) {
  const home = mkdtempSync(join(fixtureDirectory, 'shopping-home-'));
  const result = spawnSync(process.execPath, [join(here, 'test/verify-expert-audit.mjs'), extracted], {
    cwd: extracted, env: {HOME: home, TMPDIR: home, PATH: dirname(process.execPath)}, encoding: 'utf8', timeout: 90000,
  });
  assert.equal(result.status, 0, result.error?.message ?? (result.stdout + result.stderr));
}
await packageEmbeddedExpert({bundle, files, output, verifyExtracted:verifyShoppingExpert});
console.log(`Created ${output}`);
