import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {withBuyerCacheStore} from '../runtime/buyer-cache-store-draft.mjs';

const moduleUrl=pathToFileURL(fileURLToPath(new URL('../runtime/buyer-cache-store-draft.mjs',import.meta.url))).href;
const tempRoot=realpathSync(tmpdir());
const script=`import {withBuyerCacheStore} from ${JSON.stringify(moduleUrl)};await withBuyerCacheStore(process.argv[1],async()=>{console.log('HELD');await new Promise(r=>setTimeout(r,Number(process.argv[2])))},{waitForLock:true,deadlineEpochMs:Date.now()+5000});`;
const exclusionScript=`import {mkdirSync,rmdirSync} from 'node:fs';import {join} from 'node:path';import {withBuyerCacheStore} from ${JSON.stringify(moduleUrl)};await withBuyerCacheStore(process.argv[1],async()=>{const marker=join(process.argv[1],'test-critical-section');mkdirSync(marker);try{await new Promise(r=>setTimeout(r,20));console.log('HELD')}finally{rmdirSync(marker)}},{waitForLock:true,deadlineEpochMs:Date.now()+5000});`;
function start(root,ms){return spawn(process.execPath,['--input-type=module','-e',script,root,String(ms)],{stdio:['ignore','pipe','ignore']})}
function output(child){let text='';child.stdout.on('data',chunk=>{text+=chunk});return ()=>text}
async function waitFor(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}throw new Error('TEST_TIMEOUT')}
async function ended(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(r=>child.once('close',r))}
test('a live owner excludes another process; SIGKILL releases the actual owner lock',async()=>{
 const root=mkdtempSync(join(tempRoot,'kiwi-os-lock-'));let holder,waiter;
 try{
  holder=start(root,5000);const first=output(holder);await waitFor(()=>first().includes('HELD'));
  waiter=start(root,30);const second=output(waiter);await new Promise(r=>setTimeout(r,150));assert.equal(second().includes('HELD'),false);
  holder.kill('SIGKILL');await ended(holder);await waitFor(()=>second().includes('HELD'));await ended(waiter);assert.equal(waiter.exitCode,0);
  assert.equal(existsSync(join(root,'.update-lock')),false);
 }finally{holder?.kill('SIGKILL');waiter?.kill('SIGKILL');rmSync(root,{recursive:true,force:true})}
});
test('a live legacy directory lock is never removed',async()=>{
 const root=mkdtempSync(join(tempRoot,'kiwi-legacy-lock-'));
 try{mkdirSync(join(root,'.update-lock'),{mode:0o700});await assert.rejects(withBuyerCacheStore(root,async()=>assert.fail('stole old lock'),{waitForLock:true,deadlineEpochMs:Date.now()+150}),/PREPARE_TIMEOUT/);assert.equal(lstatSync(join(root,'.update-lock')).isDirectory(),true)}finally{rmSync(root,{recursive:true,force:true})}
});
test('a live new lock excludes legacy mkdir based clients',async()=>{
 const root=mkdtempSync(join(tempRoot,'kiwi-legacy-client-'));
 try{await withBuyerCacheStore(root,async()=>{assert.throws(()=>mkdirSync(join(root,'.update-lock'),{mode:0o700}),{code:'EEXIST'})})}finally{rmSync(root,{recursive:true,force:true})}
});
test('a second connection in the same process cannot release the first process lock',async()=>{
 const root=mkdtempSync(join(tempRoot,'kiwi-os-same-process-'));let release,child;
 try{
  const holding=withBuyerCacheStore(root,()=>new Promise(r=>{release=r}));await waitFor(()=>typeof release==='function');
  await assert.rejects(withBuyerCacheStore(root,async()=>assert.fail('second connection entered')),/CACHE_BUSY/);
  child=start(root,20);const text=output(child);await new Promise(r=>setTimeout(r,150));assert.equal(text().includes('HELD'),false);
  release();await holding;await waitFor(()=>text().includes('HELD'));await ended(child);assert.equal(child.exitCode,0);
 }finally{release?.();child?.kill('SIGKILL');rmSync(root,{recursive:true,force:true})}
});
test('simultaneous cold starts all complete using the same lock file',async()=>{
 const root=mkdtempSync(join(tempRoot,'kiwi-os-cold-'));const children=[];
 try{
  for(let i=0;i<8;i++)children.push(spawn(process.execPath,['--input-type=module','-e',exclusionScript,root],{stdio:['ignore','pipe','ignore']}));const texts=children.map(output);
  await Promise.all(children.map(ended));for(let i=0;i<children.length;i++){assert.equal(children[i].exitCode,0);assert.match(texts[i](),/HELD/)}
 }finally{children.forEach(c=>c.kill('SIGKILL'));rmSync(root,{recursive:true,force:true})}
});
