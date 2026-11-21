import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {remainingPrepareBudgetMs,runPrepareCommand} from '../runtime/prepare-budget.mjs';
import {snapshotInstallTarballs} from '../runtime/preflight.mjs';
import {sharedInstallCacheDirectory} from '../runtime/buyer-managed-prepare-draft.mjs';

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

test('shared downloads are copied into per-install verification evidence without following links',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'kiwi-install-cache-')));
  const shared=join(root,'shared');
  const stage=join(root,'stage');
  const data=Buffer.from('dependency archive fixture');
  const digest=createHash('sha512').update(data).digest();
  const hex=digest.toString('hex');
  const cachePath=join('_cacache','content-v2','sha512',hex.slice(0,2),hex.slice(2,4));
  const archive=join(shared,cachePath,hex.slice(4));
  const lock={packages:{
    '':{},
    'node_modules/one':{integrity:`sha512-${digest.toString('base64')}`},
    'node_modules/two':{integrity:`sha512-${digest.toString('base64')}`},
  }};
  try {
    await mkdir(join(shared,cachePath),{recursive:true});
    await mkdir(stage);
    await writeFile(join(stage,'package-lock.json'),JSON.stringify(lock));
    await writeFile(archive,data);
    await snapshotInstallTarballs(stage,shared);
    const copied=join(stage,'npm-cache',cachePath,hex.slice(4));
    await rm(archive);
    assert.deepEqual(await readFile(copied),data);
    await symlink(copied,archive);
    await assert.rejects(()=>snapshotInstallTarballs(stage,shared),/CACHE_TARBALL_INVALID/);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('a missing shared tarball reports a cache error, not an install failure',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'kiwi-install-cache-')));
  const shared=join(root,'shared');
  const stage=join(root,'stage');
  const digest=createHash('sha512').update('missing fixture').digest();
  const lock={packages:{'':{},'node_modules/one':{integrity:`sha512-${digest.toString('base64')}`}}};
  try {
    await mkdir(join(shared),{recursive:true});
    await mkdir(join(stage),{recursive:true});
    await writeFile(join(stage,'package-lock.json'),JSON.stringify(lock));
    await assert.rejects(()=>snapshotInstallTarballs(stage,shared),/CACHE_TARBALL_INVALID/);
    await assert.rejects(()=>snapshotInstallTarballs(stage,shared,{deadlineEpochMs:Date.now()-1}),/PREPARE_TIMEOUT/);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('the shared download cache is skipped when the store parent is not private',async()=>{
  const base=await realpath(await mkdtemp(join(tmpdir(),'kiwi-install-cache-parent-')));
  try {
    await chmod(base,0o755);
    const store=join(base,'store');
    await mkdir(store,{mode:0o700});
    assert.equal(sharedInstallCacheDirectory(store),undefined);
    await chmod(base,0o700);
    assert.equal(sharedInstallCacheDirectory(store),join(base,'kiwi-buyer-npm-downloads'));
  } finally {
    await rm(base,{recursive:true,force:true});
  }
});
