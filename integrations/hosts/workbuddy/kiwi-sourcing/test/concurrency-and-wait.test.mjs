import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {readFileSync as read} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createTransaction} from '../runtime/transaction.mjs';
import {withBuyerCacheStore} from '../runtime/buyer-cache-store-draft.mjs';
import {startBackendWithPreparedLock} from '../runtime/locked-backend-session.mjs';
import {startProductionMcpServer} from '../runtime/mcp-production-server.mjs';

function fixture(root, suffix='abcdef', version='0.12.14') {
  const store=join(root,'store');try{mkdirSync(store,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}
  const session=join(store,`kiwi-preflight-${suffix}`);mkdirSync(session,{mode:0o700});
  const archive=Buffer.from(`fixture-${suffix}`);writeFileSync(join(session,'verified-download.tgz'),archive,{mode:0o600});
  const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');
  const tarball=`https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-${version}.tgz`;
  createTransaction(join(session,'transaction.json'),'@harrylabsj/kiwi',{name:'@harrylabsj/kiwi',version,dist:{integrity,tarball}},archive);
  const lock=Buffer.from(`lock-${suffix}`);writeFileSync(join(session,'package-lock.json'),lock,{mode:0o600});
  const record={version,integrity,treeLockSha256:createHash('sha256').update(lock).digest('hex'),contentTreeSha256:(suffix[0]??'a').repeat(64)};
  const prepared={name:'@harrylabsj/kiwi',version,integrity,sessionDirectory:session,tree:{content_tree_sha256:record.contentTreeSha256,lock_sha256:record.treeLockSha256}};
  return {store,session,record,prepared};
}
function handle(pin, resolveDone) { return {pin,send:async()=>{},done:new Promise(resolve=>{resolveDone.push(resolve)}),stop(){resolveDone.forEach(resolve=>resolve())}} }

test('two live instances start without lifetime update lock; latest pointer changes without changing A pin',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-two-instance-');const a=fixture(root);const resolutions=[];let verifyA,verifyB;
  try {
    await withBuyerCacheStore(a.store,s=>s.recordPrepared(a.session,'0.12.9',a.record));
    const first=await startBackendWithPreparedLock({storeDirectory:a.store,prepared:a.prepared,verifyTree:async selected=>{verifyA=selected.sessionDirectory},backendFactory:async selected=>handle(selected.sessionDirectory,resolutions)});
    assert.equal(verifyA,a.session);assert.equal(existsSync(join(a.store,'.update-lock')),false);
    const b=fixture(root,'bcdefg','0.12.15');await withBuyerCacheStore(b.store,s=>s.recordPrepared(b.session,'0.12.14',b.record));
    const second=await startBackendWithPreparedLock({storeDirectory:b.store,prepared:b.prepared,verifyTree:async selected=>{verifyB=selected.sessionDirectory},backendFactory:async selected=>handle(selected.sessionDirectory,resolutions)});
    assert.equal(verifyB,b.session);assert.equal(existsSync(join(a.store,'.update-lock')),false);
    assert.equal(first.pin,a.session);assert.equal(second.pin,b.session);assert.equal(existsSync(a.session),true);assert.equal(readFileSync(join(a.session,'verified-download.tgz'),'utf8'),'fixture-abcdef');
    await assert.rejects(()=>withBuyerCacheStore(a.store,async()=>{throw new Error('synthetic update contention')}),/synthetic update contention/);
    resolutions.forEach(resolve=>resolve());await Promise.all([first.done,second.done]);
  } finally {rmSync(root,{recursive:true,force:true})}
});

const here=fileURLToPath(new URL('.',import.meta.url));
const raw=read(join(here,'..','runtime','mcp-tools-0.12.12.json'),'utf8');
const toolsData=JSON.parse(raw);const baseline=Array.isArray(toolsData)?toolsData:toolsData.tools;
function fakeBackend(){let resolveDone;const calls=[];return {calls,done:new Promise(resolve=>{resolveDone=resolve}),send:async m=>{calls.push(m)},stop(){resolveDone()},toolCount:13,protocolVersion:'2025-06-18'}}
function harness({prepare,activate,toolTimeoutMs=30000,prepareWaitTimeoutMs=25000}={}){
  const input=new PassThrough(),output=new PassThrough(),messages=[];let buffer='';output.on('data',c=>{buffer+=c.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)messages.push(JSON.parse(line))}});
  const server=startProductionMcpServer({input,output,baseline,prepare:prepare??(async()=>({})),activate:activate??(async()=>fakeBackend()),toolTimeoutMs,prepareWaitTimeoutMs});
  return {input,messages,server,send:async m=>{input.write(JSON.stringify(m)+'\n');await new Promise(resolve=>setImmediate(resolve))}};
}
async function until(messages,predicate){for(let i=0;i<200;i++){const v=messages.find(predicate);if(v)return v;await new Promise(resolve=>setTimeout(resolve,5))}throw new Error('SYNTHETIC_TIMEOUT')}
async function init(h){await h.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{}}});await h.send({jsonrpc:'2.0',method:'notifications/initialized'})}
async function close(h){h.input.end();await h.server.done}

test('tools/list stays immediate; read-only calls queue once during prepare and writes are not queued',async()=>{
  let resolvePrepare;const prep=new Promise(resolve=>{resolvePrepare=resolve});const backend=fakeBackend();
  const h=harness({prepare:()=>prep,activate:async()=>backend,toolTimeoutMs:600000,prepareWaitTimeoutMs:25000});
  try{
    await init(h);await h.send({jsonrpc:'2.0',id:2,method:'tools/list'});assert.equal((await until(h.messages,m=>m.id===2)).result.tools.length,13);
    await h.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'kiwi_search',arguments:{query:'synthetic'}}});
    await h.send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'kiwi_accept_agreement',arguments:{agreement_id:'synthetic'}}});
    assert.equal(h.messages.some(m=>m.id===3),false);assert.match(h.messages.find(m=>m.id===4).result.content[0].text,/PREPARATION_IN_PROGRESS/);assert.deepEqual(h.messages.find(m=>m.id===4).result.structuredContent,{status:'retryable',code:'PREPARATION_IN_PROGRESS',requestSent:false});
    assert.equal(backend.calls.length,0);resolvePrepare({});await until(h.messages,()=>h.server.status==='ready');
    assert.equal(backend.calls.filter(m=>m.method==='tools/call').length,1);assert.equal(backend.calls[0].id,3);assert.equal(backend.calls[0].params.name,'kiwi_search');
  } finally {await close(h)}
});

test('bounded prepare wait expires safely; canceled queued read-only call is never dispatched',async()=>{
  let resolvePrepare;const prep=new Promise(resolve=>{resolvePrepare=resolve});const backend=fakeBackend();
  const h=harness({prepare:()=>prep,activate:async()=>backend,toolTimeoutMs:30000,prepareWaitTimeoutMs:20});
  try{
    await init(h);await h.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'kiwi_search',arguments:{query:'synthetic'}}});
    await h.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:3}});
    await h.send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'kiwi_get_task',arguments:{task_id:'synthetic'}}});
    assert.match((await until(h.messages,m=>m.id===4)).result.content[0].text,/PREPARATION_IN_PROGRESS/);
    resolvePrepare({});await until(h.messages,()=>h.server.status==='ready');await new Promise(resolve=>setTimeout(resolve,30));
    assert.deepEqual(backend.calls.filter(m=>m.method==='tools/call'),[]);
  } finally {await close(h)}
});

test('preparation wait cannot be configured to exceed the 30 second host ceiling',()=>{
  assert.throws(()=>harness({toolTimeoutMs:600000,prepareWaitTimeoutMs:30000}),/SERVER_ARGUMENT_INVALID/);
});

test('simultaneous cold prepares serialize instead of permanently failing; startup respects abort and deadline',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-cold-start-');const a=fixture(root);let active=0,maxActive=0;
  try{
    const deadlineEpochMs=Date.now()+2000;
    const prep=(delay)=>withBuyerCacheStore(a.store,async state=>{
      active++;maxActive=Math.max(maxActive,active);
      try{
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        const existing=state.prepared();if(existing)return existing;
        return state.recordPrepared(a.session,'0.12.9',a.record);
      } finally {active--}
    },{waitForLock:true,deadlineEpochMs});
    const [firstPin,secondPin]=await Promise.all([prep(80),prep(0)]);
    assert.equal(maxActive,1);assert.equal(firstPin.sessionDirectory,a.session);assert.equal(secondPin.sessionDirectory,a.session);
    const exits=[];const [coldA,coldB]=await Promise.all([a.prepared,a.prepared].map(prepared=>startBackendWithPreparedLock({storeDirectory:a.store,prepared,verifyTree:async selected=>assert.equal(selected.sessionDirectory,a.session),backendFactory:async selected=>handle(selected.sessionDirectory,exits)})));
    assert.equal(coldA.pin,a.session);assert.equal(coldB.pin,a.session);assert.equal(existsSync(join(a.store,'.update-lock')),false);
    exits.forEach(resolve=>resolve());await Promise.all([coldA.done,coldB.done]);
    const controller=new AbortController();let release;const held=withBuyerCacheStore(a.store,()=>new Promise(resolve=>{release=resolve}));
    while(!existsSync(join(a.store,'.update-lock')))await new Promise(resolve=>setTimeout(resolve,1));
    const waiting=withBuyerCacheStore(a.store,async()=>assert.fail('aborted waiter acquired lock'),{waitForLock:true,deadlineEpochMs:Date.now()+1000,signal:controller.signal});
    setTimeout(()=>controller.abort(),10);await assert.rejects(waiting,/PREPARE_CANCELLED/);release();await held;
    let releaseTimeout;const heldTimeout=withBuyerCacheStore(a.store,()=>new Promise(resolve=>{releaseTimeout=resolve}));
    while(!existsSync(join(a.store,'.update-lock')))await new Promise(resolve=>setTimeout(resolve,1));
    const timeoutWait=withBuyerCacheStore(a.store,async()=>assert.fail('expired waiter acquired lock'),{waitForLock:true,deadlineEpochMs:Date.now()+10});
    await assert.rejects(timeoutWait,/PREPARE_TIMEOUT/);releaseTimeout();await heldTimeout;
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('read-only request that reaches its deadline before backend readiness is never sent',async()=>{
  let resolvePrepare;const prep=new Promise(resolve=>{resolvePrepare=resolve});const backend=fakeBackend();
  const h=harness({prepare:()=>prep,activate:async()=>backend,toolTimeoutMs:30,prepareWaitTimeoutMs:25000});
  try{
    await init(h);await h.send({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'kiwi_search',arguments:{query:'synthetic'}}});
    await new Promise(resolve=>setTimeout(resolve,35));resolvePrepare({});await until(h.messages,()=>h.server.status==='ready');
    assert.deepEqual(backend.calls.filter(m=>m.method==='tools/call'),[]);
    assert.match(h.messages.find(m=>m.id===7).result.content[0].text,/PREPARATION_IN_PROGRESS/);
  } finally {await close(h)}
});
