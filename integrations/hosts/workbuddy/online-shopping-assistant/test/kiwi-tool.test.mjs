import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {invoke} from '../scripts/kiwi-tool.mjs';
const fake=`import readline from 'node:readline';let count=0;readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{protocolVersion:'2025-06-18'}}));if(x.method==='tools/call'){count++;let result=count===1?{isError:true,structuredContent:{code:'PREPARATION_IN_PROGRESS',requestSent:false}}:{content:[{type:'text',text:'ok'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result}))}});`;
test('retries only explicit not-sent preparation and returns actual result',async()=>{const dir=mkdtempSync(join(tmpdir(),'kiwi-skill-'));try{const p=join(dir,'server.mjs');writeFileSync(p,fake);assert.deepEqual(await invoke({tool:'kiwi_search',args:{query:'test'},launcher:p,timeoutMs:5000}),{content:[{type:'text',text:'ok'}]})}finally{rmSync(dir,{recursive:true,force:true})}});
test('rejects unapproved tool names',async()=>{await assert.rejects(()=>invoke({tool:'kiwi_approve',args:{},launcher:'/missing'}),/INVALID_TOOL_REQUEST/)});
test('does not retry when a business request may have been sent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kiwi-skill-'));
 try{
  const p=join(dir,'server.mjs');
  writeFileSync(p,`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{}}));if(x.method==='tools/call')console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{isError:true,structuredContent:{code:'PREPARATION_IN_PROGRESS',requestSent:true}}}))});`);
  assert.deepEqual(await invoke({tool:'kiwi_request_quotes',args:{},launcher:p,timeoutMs:3000}),{isError:true,structuredContent:{code:'PREPARATION_IN_PROGRESS',requestSent:true}});
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('the built skill excludes the legacy expert launcher and rejects a damaged runtime before opening buyer data', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kiwi-skill-archive-'));
  try {
    const archive = join(root, 'skill.zip');
    const packager = fileURLToPath(new URL('../../package-online-shopping-skill.mjs', import.meta.url));
    execFileSync(process.execPath, [packager, '--out', archive]);
    execFileSync('unzip', ['-q', archive, '-d', root]);
    const scripts = join(root, 'online-shopping-assistant', 'scripts');
    const runtime = join(scripts, 'runtime');
    const manifest = JSON.parse(readFileSync(join(scripts, 'runtime-files.json'), 'utf8'));
    assert.match(manifest['production-launcher.mjs'], /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(runtime, 'expert-launcher.mjs')), false);

    appendFileSync(join(runtime, 'production-launcher.mjs'), '\n// damaged package fixture\n');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, {mode: 0o700});
    const result = spawnSync(process.execPath, [join(scripts, 'kiwi-tool.mjs'), '--workspace', workspace], {
      cwd: workspace,
      input: JSON.stringify({tool: 'kiwi_search', arguments: {query: 'fixture'}}),
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'KIWI_SKILL_HOLD:BUNDLED_RUNTIME_INVALID\n');
    assert.equal(existsSync(join(workspace, '.kiwi-workbuddy-buyer-v1')), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
