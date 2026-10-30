import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {remainingPrepareBudgetMs,runPrepareCommand} from '../runtime/prepare-budget.mjs';

test('nested install budget is the remaining part of the outer deadline',()=>{
  const now=Date.now();
  assert.equal(remainingPrepareBudgetMs({KIWI_PREPARE_DEADLINE_EPOCH_MS:String(now+4000)},now),4000);
  assert.throws(()=>remainingPrepareBudgetMs({KIWI_PREPARE_DEADLINE_EPOCH_MS:String(now-1)},now),/PREPARE_TIMEOUT/);
});

test('prepare command timeout uses the remaining outer budget and kills its process group',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kiwi-prepare-budget-'));
  const pidFile=join(dir,'descendant.pid');
  try{
    const script=join(dir,'tree.mjs');
    await writeFile(script,"import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(process.argv[2],String(child.pid)); setInterval(()=>{},1000);\n");
    const deadline=Date.now()+700;
    await assert.rejects(()=>runPrepareCommand(process.execPath,[script,pidFile],{cwd:dir,env:{PATH:process.env.PATH,KIWI_PREPARE_DEADLINE_EPOCH_MS:String(deadline)},timeoutMs:5000}),/PREPARE_TIMEOUT/);
    const pid=Number(await readFile(pidFile,'utf8'));
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }finally{await rm(dir,{recursive:true,force:true})}
});
