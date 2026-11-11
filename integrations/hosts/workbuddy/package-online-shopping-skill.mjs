import assert from 'node:assert/strict';
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runtimeFiles} from './kiwi-sourcing/scripts/package-manifest.mjs';
const here=dirname(fileURLToPath(import.meta.url));const root=join(here,'online-shopping-assistant');const runtime=join(here,'kiwi-sourcing/runtime');const expert=join(here,'kiwi-procurement-expert/runtime');
const local=['SKILL.md','scripts/kiwi-tool.mjs',...['comparison-rules.md','kiwi-inquiry-and-negotiation.md','output-format.md','platform-research.md'].map(x=>`references/${x}`)];
function safe(base,rel){const p=resolve(base,rel);assert(p.startsWith(base+sep));assert(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink());assert(realpathSync(p).startsWith(realpathSync(base)+sep));return p}
for(const x of local)safe(root,x);for(const x of runtimeFiles)safe(runtime,x);for(const x of ['expert-data.mjs','expert-launcher.mjs'])safe(expert,x);
const skill=readFileSync(join(root,'SKILL.md'),'utf8');assert.match(skill,/^name: online-shopping-assistant$/m);assert.match(skill,/^version: 1\.2\.1$/m);assert(skill.includes('scripts/kiwi-tool.mjs'));assert(!skill.includes('`kiwi-sourcing` 连接器'));
console.log(`Validated 网上购物助手 1.2.1 with bundled Kiwi runtime (${runtimeFiles.length+2} files).`);
const args=process.argv.slice(2);if(args.length===1&&args[0]==='--check')process.exit(0);assert(args.length===2&&args[0]==='--out');const output=resolve(args[1]);assert(output.endsWith('.zip')&&!existsSync(output));mkdirSync(dirname(output),{recursive:true});
const stage=mkdtempSync(join(tmpdir(),'kiwi-skill-'));const dir=join(stage,'online-shopping-assistant');const entries=[];
try{
 for(const x of local){const dest=join(dir,x);mkdirSync(dirname(dest),{recursive:true});cpSync(safe(root,x),dest);entries.push(`online-shopping-assistant/${x}`)}
 for(const x of runtimeFiles){const dest=join(dir,'scripts/runtime',x);mkdirSync(dirname(dest),{recursive:true});cpSync(safe(runtime,x),dest);entries.push(`online-shopping-assistant/scripts/runtime/${x}`)}
 for(const x of ['expert-data.mjs','expert-launcher.mjs']){const dest=join(dir,'scripts/runtime',x);cpSync(safe(expert,x),dest);entries.push(`online-shopping-assistant/scripts/runtime/${x}`)}
 const z=spawnSync('zip',['-X',output,...entries],{cwd:stage,encoding:'utf8'});assert.equal(z.status,0,z.stderr);const list=spawnSync('unzip',['-Z1',output],{encoding:'utf8'});assert.equal(list.status,0,list.stderr);assert.deepEqual(list.stdout.trim().split('\n').sort(),entries.sort());const check=spawnSync('unzip',['-t',output],{encoding:'utf8'});assert.equal(check.status,0,check.stdout);console.log(`Created ${output}`);
}finally{rmSync(stage,{recursive:true,force:true})}
