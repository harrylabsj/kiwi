import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startProductionMcpServer} from '../runtime/mcp-production-server.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const raw=JSON.parse(readFileSync(join(root,'..','runtime','mcp-tools-0.12.12.json'),'utf8'));
const baseline=Array.isArray(raw)?raw:raw.tools;
const prepared={name:'@harrylabsj/kiwi',latestChecked:true,authorizationProven:false,executionAuthorized:false,sessionDirectory:'/private/tmp/synthetic-prepared'};
const response=(id,params)=>({jsonrpc:'2.0',id,result:params});
function harness({prepare=async()=>prepared,activate,consentTimeoutMs=50}={}){
  const input=new PassThrough(),output=new PassThrough(),messages=[],statuses=[];let buffer='';
  output.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)messages.push(JSON.parse(line))}});
  const server=startProductionMcpServer({input,output,baseline,prepare,activate:activate??(async()=>fakeBackend()),onStatus:code=>statuses.push(code),consentTimeoutMs,backendRequestTimeoutMs:50});
  return {input,messages,statuses,server,async send(message){input.write(JSON.stringify(message)+'\n');await new Promise(resolve=>setImmediate(resolve))}};
}
function fakeBackend(){
  let resolveDone;const calls=[];const done=new Promise(resolve=>{resolveDone=resolve});
  return {calls,done,send:async message=>{calls.push(message)},stop:()=>resolveDone(),toolCount:13,protocolVersion:'2025-06-18'};
}
async function until(messages,predicate){
  for(let i=0;i<100;i++){const found=messages.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,5))}
  throw new Error('MESSAGE_TIMEOUT');
}
async function close(h){h.input.end();await Promise.race([h.server.done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('SHUTDOWN_TIMEOUT')),1000))])}
async function initialize(h,capabilities={}){await h.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities}});await h.send({jsonrpc:'2.0',method:'notifications/initialized'})}

test('tool list and fast init are available while latest preparation is pending; failure stops calls',async()=>{
  let rejectPrepare,activateCount=0;
  const prep=new Promise((_,reject)=>{rejectPrepare=reject});
  const h=harness({prepare:()=>prep,activate:async()=>{activateCount++;return fakeBackend()}});
  try{
    await initialize(h);
    await h.send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
    assert.equal((await until(h.messages,m=>m.id===2)).result.tools.length,13);
    await h.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'kiwi_search',arguments:{query:'fixture'}}});
    assert.match((await until(h.messages,m=>m.id===3)).result.content[0].text,/verification is in progress/);
    rejectPrepare(new Error('PRIVATE_SIGNATURE_FAILURE'));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(activateCount,0);
    await h.send({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'kiwi_search',arguments:{query:'fixture'}}});
    assert.match((await until(h.messages,m=>m.id===4)).result.content[0].text,/verification failed/);
  }finally{await close(h)}
});

test('all 13 tools and exact arguments pass through without connector elicitation or fabricated approval',async()=>{
  let backend;
  const expectedResults=new Map();
  const h=harness({activate:async(_prepared,{onMessage})=>{backend=fakeBackend();backend.send=async message=>{backend.calls.push(structuredClone(message));if(message.method==='tools/call')onMessage({jsonrpc:'2.0',id:message.id,result:expectedResults.get(message.params.name)})};return backend}});
  try{
    await initialize(h,{});
    await h.send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
    assert.equal((await until(h.messages,m=>m.id===2)).result.tools.length,13);
    await until(h.messages,()=>h.server.status==='ready');
    for(const [index,tool] of baseline.entries()){
      const args={synthetic_marker:`args-${tool.name}`,nested:{index,exact:true}};
      const result=tool.name==='kiwi_accept_agreement'||tool.name==='kiwi_handoff'
        ?{isError:false,content:[{type:'text',text:JSON.stringify({status:'approval_required',approval_id:`backend-${tool.name}`})}]}
        :tool.name==='kiwi_approve'
          ?{isError:true,content:[{type:'text',text:'BACKEND_APPROVAL_REJECTED'}]}
          :{isError:false,content:[{type:'text',text:`backend-${tool.name}`}],_meta:{index}};
      expectedResults.set(tool.name,result);
      const id=10+index;
      await h.send({jsonrpc:'2.0',id,method:'tools/call',params:{name:tool.name,arguments:args}});
      assert.deepEqual((await until(h.messages,m=>m.id===id)).result,result);
      assert.deepEqual(backend.calls.filter(m=>m.method==='tools/call').at(-1),{jsonrpc:'2.0',id,method:'tools/call',params:{name:tool.name,arguments:args}});
    }
    assert.equal(h.messages.some(m=>m.method==='elicitation/create'),false);
    assert.deepEqual(backend.calls.filter(m=>m.method==='tools/call').map(m=>m.params.name),baseline.map(tool=>tool.name));
  }finally{await close(h)}
});

test('unknown names and malformed argument types are rejected without backend calls',async()=>{
  let backend;const h=harness({activate:async()=>{backend=fakeBackend();return backend}});
  try{
    await initialize(h,{});await until(h.messages,()=>h.server.status==='ready');
    await h.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'kiwi_unknown',arguments:{synthetic:true}}});
    assert.equal((await until(h.messages,m=>m.id===2)).error.code,-32602);
    await h.send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'kiwi_request_quotes',arguments:['invalid']}});
    assert.equal((await until(h.messages,m=>m.id===3)).error.code,-32602);
    assert.equal(h.messages.some(m=>m.method==='elicitation/create'),false);
    assert.equal(backend.calls.some(m=>m.method==='tools/call'),false);
  }finally{await close(h)}
});

test('shutdown aborts preparation and waits for backend cleanup',async()=>{
  let abortSeen=false,stopSeen=false,resolveDone;
  const backendDone=new Promise(resolve=>{resolveDone=resolve});
  const h=harness({prepare:({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{abortSeen=true;reject(new Error('PREPARE_CANCELLED'))},{once:true})),activate:async()=>({send:async()=>{},done:backendDone,stop:()=>{stopSeen=true;resolveDone()},toolCount:13,protocolVersion:'2025-06-18'})});
  await initialize(h);
  h.input.end();await h.server.done;
  assert.equal(abortSeen,true);assert.equal(stopSeen,false);
  let release,backendResolve;
  const running=harness({activate:async()=>({send:async()=>{},done:new Promise(resolve=>{backendResolve=resolve}),stop:()=>{stopSeen=true;backendResolve()},toolCount:13,protocolVersion:'2025-06-18'})});
  try{
    await initialize(running);
    await until(running.messages,()=>running.server.status==='ready');
    running.input.end();await running.server.done;assert.equal(stopSeen,true);
  }finally{void release}
});

test('fixed READY status follows verified 13-tool activation; failures and shutdown are fixed and never enter MCP stdout',async()=>{
  const good=harness();
  try{
    await initialize(good);
    await until(good.messages,()=>good.server.status==='ready');
    assert.deepEqual(good.statuses,['READY']);
    assert.equal(good.messages.every(m=>m&&m.jsonrpc==='2.0'),true);
  }finally{await close(good)}
  assert.deepEqual(good.statuses,['READY','STOPPED']);

  for(const scenario of [
    {prepare:async()=>{throw new Error('sensitive synthetic detail')},status:'FAILED_PREPARE'},
    {activate:async()=>{throw new Error('sensitive synthetic detail')},status:'FAILED_BACKEND'},
    {activate:async()=>{throw new Error('BACKEND_HANDSHAKE_TIMEOUT')},status:'TIMEOUT_BACKEND'},
    {prepare:async()=>{throw new Error('PREPARE_TIMEOUT')},status:'TIMEOUT_PREPARE'},
    {activate:async()=>({send:async()=>{},done:new Promise(()=>{}),stop:()=>{},toolCount:12,protocolVersion:'2025-06-18'}),status:'FAILED_BACKEND'},
    {activate:async()=>({send:async()=>{},done:new Promise(()=>{}),stop:()=>{},toolCount:13,protocolVersion:'forged'}),status:'FAILED_BACKEND'},
    {prepare:async()=>({...prepared,status:'READY'}),activate:async()=>({send:async()=>{},done:new Promise(()=>{}),stop:()=>{},toolCount:12,protocolVersion:'2025-06-18'}),status:'FAILED_BACKEND'},
  ]){
    const h=harness(scenario);
    try{
      await initialize(h);
      await new Promise(resolve=>setTimeout(resolve,15));
      assert.deepEqual(h.statuses,[scenario.status]);
      assert.equal(h.statuses.includes('READY'),false);
      assert.equal(JSON.stringify(h.messages).includes('sensitive synthetic detail'),false);
      assert.equal(h.messages.every(m=>m&&m.jsonrpc==='2.0'),true);
    }finally{await close(h)}
  }
});
