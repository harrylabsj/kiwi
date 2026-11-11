import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runtimeFiles } from './kiwi-sourcing/scripts/package-manifest.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const bundle=join(here,'haina-ecommerce-expert');
const expertRuntime=join(here,'kiwi-procurement-expert','runtime');
const runtime=join(here,'kiwi-sourcing','runtime');
const files=['.codebuddy-plugin/plugin.json','.mcp.json','agents/haina-ecommerce-expert.md','avatars/expert.png','skills/online-shopping-assistant/SKILL.md',...['comparison-rules.md','kiwi-inquiry-and-negotiation.md','output-format.md','platform-research.md'].map(x=>`skills/online-shopping-assistant/references/${x}`)];
function safeFile(root,name){const p=resolve(root,name);assert(p.startsWith(root+sep));assert(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink());assert(realpathSync(p).startsWith(realpathSync(root)+sep));return p}
for(const f of files)safeFile(bundle,f);
const meta=JSON.parse(readFileSync(join(bundle,files[0]),'utf8'));
const mcp=JSON.parse(readFileSync(join(bundle,'.mcp.json'),'utf8'));
assert.equal(meta.version,'1.2.2');assert.equal(meta.dependencies.mcpServers,'./.mcp.json');assert(!meta.dependencies.connectors?.length);
assert.deepEqual(Object.keys(mcp.mcpServers),['kiwi-shopping-buyer']);
const server=mcp.mcpServers['kiwi-shopping-buyer'];assert.equal(server.type,'stdio');assert.equal(server.command,'node');assert.deepEqual(server.args,['./runtime/expert-launcher.mjs']);assert.equal(server['x-workbuddy'].auth.type,'none');
for(const f of runtimeFiles)safeFile(runtime,f);
for(const f of ['expert-data.mjs','expert-launcher.mjs'])safeFile(expertRuntime,f);
const instructions=['agents/haina-ecommerce-expert.md','skills/online-shopping-assistant/SKILL.md','skills/online-shopping-assistant/references/kiwi-inquiry-and-negotiation.md'].map(f=>readFileSync(join(bundle,f),'utf8')).join('\n');
assert(instructions.includes('kiwi-shopping-buyer'));assert(!instructions.includes('`kiwi-sourcing` 连接器'));
console.log(`Validated ${meta.profession.zh} v${meta.version}: built-in MCP and ${runtimeFiles.length+2} runtime files.`);
const args=process.argv.slice(2);if(args.length===1&&args[0]==='--check')process.exit(0);
assert(args.length===2&&args[0]==='--out','Usage: node package-ecommerce-expert.mjs --check | --out /absolute/path.zip');
const output=resolve(args[1]);assert(output.endsWith('.zip')&&!existsSync(output));mkdirSync(dirname(output),{recursive:true});
const stage=mkdtempSync(join(tmpdir(),'kiwi-shopping-expert-'));
try{
 for(const f of files){const dest=join(stage,f);mkdirSync(dirname(dest),{recursive:true});cpSync(safeFile(bundle,f),dest)}
 mkdirSync(join(stage,'runtime'),{recursive:true});
 for(const f of runtimeFiles){cpSync(safeFile(runtime,f),join(stage,'runtime',f));files.push(`runtime/${f}`)}
 for(const f of ['expert-data.mjs','expert-launcher.mjs']){cpSync(safeFile(expertRuntime,f),join(stage,'runtime',f));files.push(`runtime/${f}`)}
 const result=spawnSync('zip',['-X',output,...files],{cwd:stage,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const list=spawnSync('unzip',['-Z1',output],{encoding:'utf8'});assert.equal(list.status,0,list.stderr);assert.deepEqual(list.stdout.trim().split('\n').sort(),files.sort());
 const check=spawnSync('unzip',['-t',output],{encoding:'utf8'});assert.equal(check.status,0,check.stdout+check.stderr);
 console.log(`Created ${output}`);
}finally{rmSync(stage,{recursive:true,force:true})}
