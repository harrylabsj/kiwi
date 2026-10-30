import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startProductionMcpServer} from '../runtime/mcp-production-server.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const raw=JSON.parse(readFileSync(join(here,'..','runtime','mcp-tools-0.12.12.json'),'utf8'));
const baseline=Array.isArray(raw)?raw:raw.tools;
const fixedWrite={intent:{intent_id:'protocol-fixture',intent_type:'inquiry',items:[{query:'synthetic item',quantity:{value:1,unit:'unit'}}]},merchant_ids:['synthetic-only']};

function harness(){
  const input=new PassThrough(),output=new PassThrough(),messages=[],diagnostics=[],backendCalls=[];
  let buffer='',activateCount=0;
  output.on('data',chunk=>{buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)messages.push(JSON.parse(line))}});
  const server=startProductionMcpServer({
    input,output,baseline,prepare:async()=>({synthetic:true}),
    activate:async(_prepared,{onMessage})=>{
      activateCount++;
      let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve});
      return {toolCount:13,protocolVersion:'2025-06-18',done,stop:()=>resolveDone(),send:async message=>{
        backendCalls.push(structuredClone(message));
        if(message.method==='tools/call')onMessage({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'SYNTHETIC_BACKEND_ACCEPTED'}]}});
      }};
    },
    onProtocolDiagnostic:value=>diagnostics.push(structuredClone(value)),
  });
  return {input,output,messages,diagnostics,backendCalls,server,get activateCount(){return activateCount},async send(message){input.write(`${JSON.stringify(message)}\n`);await new Promise(resolve=>setImmediate(resolve))},async close(){input.end();await Promise.race([server.done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('PROTOCOL_TEST_CLEANUP_TIMEOUT')),1000))])}};
}
async function until(testHarness,predicate){for(let i=0;i<150;i++){const found=testHarness.messages.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,4))}throw new Error('PROTOCOL_TEST_MESSAGE_TIMEOUT')}
async function ready(testHarness){await until(testHarness,()=>testHarness.server.status==='ready')}
async function initialize(testHarness,protocolVersion='2025-06-18',capabilities={}){
  await testHarness.send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion,capabilities}});
  return until(testHarness,message=>message.id===1);
}
const initialized={jsonrpc:'2.0',method:'notifications/initialized'};

test('supported client protocol is echoed exactly',async()=>{
  const h=harness();try{
    const response=await initialize(h,'2025-06-18',{elicitation:{}});
    assert.equal(response.result.protocolVersion,'2025-06-18');
    assert.equal(response.error,undefined);
    assert.deepEqual(h.diagnostics[0],{clientProtocolVersionClass:'EXACT_MATCH',negotiatedProtocolVersion:'2025-06-18',state:'MATCHED'});
    assert.equal(response.result.capabilities.elicitation,undefined);
  }finally{await h.close()}
});

test('unsupported but well-formed version receives the server-supported counteroffer',async()=>{
  const h=harness();try{
    const response=await initialize(h,'2025-11-25',{elicitation:{form:{}}});
    assert.equal(response.error,undefined);
    assert.equal(response.result.protocolVersion,'2025-06-18');
    assert.deepEqual(h.diagnostics[0],{clientProtocolVersionClass:'UNSUPPORTED_COUNTEROFFER',negotiatedProtocolVersion:'2025-06-18',state:'COUNTEROFFER_SENT'});
    assert.equal(JSON.stringify(h.diagnostics).includes('2025-11-25'),false);
  }finally{await h.close()}
});

test('backend is activated only after client continues with initialized notification',async()=>{
  const h=harness();try{
    const response=await initialize(h,'2025-11-25',{elicitation:{form:{}}});
    assert.equal(response.result.protocolVersion,'2025-06-18');
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(h.activateCount,0);
    assert.equal(h.server.status,'preparing');
    await h.send(initialized);await ready(h);
    assert.equal(h.activateCount,1);
    assert.equal(h.diagnostics.at(-1).state,'CLIENT_ACCEPTED_NEGOTIATED_VERSION');
  }finally{await h.close()}
});

test('client disconnect after counteroffer never activates the backend',async()=>{
  const h=harness();
  await initialize(h,'2025-11-25',{elicitation:{form:{}}});
  h.input.end();await h.server.done;
  assert.equal(h.activateCount,0);
  assert.equal(h.backendCalls.length,0);
});

test('2025-06 legacy empty capability allows transparent RFQ forwarding without per-call elicitation',async()=>{
  const h=harness();try{
    await initialize(h,'2025-06-18',{elicitation:{}});await h.send(initialized);await ready(h);
    await h.send({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'kiwi_request_quotes',arguments:fixedWrite}});
    const result=await until(h,message=>message.id===10);
    assert.equal(result.result.content[0].text,'SYNTHETIC_BACKEND_ACCEPTED');
    assert.equal(h.backendCalls.length,1);
    assert.equal(h.messages.some(message=>message.method==='elicitation/create'),false);
  }finally{await h.close()}
});

test('newer host version counteroffer preserves transparent RFQ forwarding without elicitation',async()=>{
  const h=harness();try{
    const response=await initialize(h,'2025-11-25',{elicitation:{form:{}}});
    assert.equal(response.result.protocolVersion,'2025-06-18');
    await h.send(initialized);await ready(h);
    await h.send({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'kiwi_request_quotes',arguments:fixedWrite}});
    const result=await until(h,message=>message.id===10);
    assert.equal(result.result.content[0].text,'SYNTHETIC_BACKEND_ACCEPTED');
    assert.equal(h.backendCalls.length,1);
    assert.equal(h.messages.some(message=>message.method==='elicitation/create'),false);
  }finally{await h.close()}
});

test('URL-only host capability does not change transparent agreement forwarding after downgrade',async()=>{
  const h=harness();try{
    const response=await initialize(h,'2025-11-25',{elicitation:{url:{}}});
    assert.equal(response.result.protocolVersion,'2025-06-18');
    await h.send(initialized);await ready(h);
    await h.send({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'kiwi_accept_agreement',arguments:{task_id:'synthetic-task',candidate_id:'synthetic-candidate'}}});
    const result=await until(h,message=>message.id===10);
    assert.equal(result.result.content[0].text,'SYNTHETIC_BACKEND_ACCEPTED');
    assert.equal(h.messages.some(message=>message.method==='elicitation/create'),false);
    assert.equal(h.backendCalls.length,1);
  }finally{await h.close()}
});

test('missing or invalid version is rejected with fixed response and safe diagnostics',async()=>{
  for(const [params,expectedClass] of [[{capabilities:{}},'MISSING'],[{protocolVersion:17,capabilities:{}},'INVALID']]){
    const h=harness();try{
      await h.send({jsonrpc:'2.0',id:1,method:'initialize',params});
      const response=await until(h,message=>message.id===1);
      assert.equal(response.error.code,-32602);
      assert.equal(response.error.message,'Invalid initialize parameters');
      assert.equal(h.diagnostics[0].clientProtocolVersionClass,expectedClass);
      assert.equal(JSON.stringify(h.diagnostics).includes('protocolVersion'),false);
      assert.equal(h.activateCount,0);
    }finally{await h.close()}
  }
});
