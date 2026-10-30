import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runPreparation} from '../runtime/stage-runner.mjs';

test('preparation accepts the bounded cold-start budget and reports elapsed progress',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kiwi-stage-runner-'));
  try{
    const child=join(dir,'child.mjs');
    await writeFile(child,"setTimeout(()=>process.stdout.write(JSON.stringify({name:'@harrylabsj/kiwi',latestChecked:true,authorizationProven:false,executionAuthorized:false,sessionDirectory:'/private/session'})+'\\n'),1100);\n");
    const progress=[];
    const result=await runPreparation({nodeBinary:process.execPath,cliPath:child,args:[],env:{HOME:dir,TMPDIR:dir,PATH:process.env.PATH},timeoutMs:600000,progressIntervalMs:1000,onProgress:event=>progress.push(event)});
    assert.equal(result.name,'@harrylabsj/kiwi');
    assert.ok(progress.length>0);
    assert.ok(progress.every(event=>event.stage==='PREPARE'&&event.elapsedMs>=0));
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('preparation budget stays bounded at ten minutes',async()=>{
  await assert.rejects(()=>runPreparation({nodeBinary:process.execPath,cliPath:'/tmp/unused.mjs',args:[],env:{},timeoutMs:600001}),/PREPARE_ARGUMENT_INVALID/);
});
