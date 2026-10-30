import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startProductionMcpServer} from '../runtime/mcp-production-server.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const raw=JSON.parse(readFileSync(join(here,'..','runtime','mcp-tools-0.12.12.json'),'utf8'));
const baseline=Array.isArray(raw)?raw:raw.tools;
async function until(list,pred){for(let i=0;i<100;i++){const m=list.find(pred);if(m)return m;await new Promise(r=>setTimeout(r,4))}throw new Error('synthetic event timeout')}

test('backend approval_required is returned unchanged and connector never fabricates or invokes kiwi_approve',async()=>{
  const input=new PassThrough(),output=new PassThrough(),messages=[],calls=[];let buffer='';
  output.on('data',chunk=>{buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line)messages.push(JSON.parse(line))}});
  let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve});
  const server=startProductionMcpServer({input,output,baseline,prepare:async()=>({verified:true}),activate:async(_p,{onMessage})=>({
    done,toolCount:13,protocolVersion:'2025-06-18',stop:()=>resolveDone(),send:async message=>{
      calls.push(structuredClone(message));if(message.method!=='tools/call')return;
      const name=message.params.name;
      const result=name==='kiwi_accept_agreement'
        ?{isError:false,content:[{type:'text',text:JSON.stringify({status:'approval_required',approval_id:'backend-only-id',summary:{terms:'synthetic'}})}]}
        :{isError:false,content:[{type:'text',text:'backend-result'}]};
      onMessage({jsonrpc:'2.0',id:message.id,result});
    },
  })});
  const send=async message=>{input.write(`${JSON.stringify(message)}\n`);await new Promise(resolve=>setImmediate(resolve))};
  try{
    await send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{}}});
    await send({jsonrpc:'2.0',method:'notifications/initialized'});await until(messages,()=>server.status==='ready');
    const acceptArgs={task_id:'synthetic-task',candidate_id:'synthetic-candidate'};
    await send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'kiwi_accept_agreement',arguments:acceptArgs}});
    const response=await until(messages,m=>m.id===2);
    assert.deepEqual(response.result,{isError:false,content:[{type:'text',text:JSON.stringify({status:'approval_required',approval_id:'backend-only-id',summary:{terms:'synthetic'}})}]});
    assert.deepEqual(calls.map(m=>m.params.name),['kiwi_accept_agreement']);
    assert.equal(messages.some(m=>m.method==='elicitation/create'),false);

    const approvalArgs={approval_id:'backend-only-id'};
    await send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'kiwi_approve',arguments:approvalArgs}});
    assert.equal((await until(messages,m=>m.id===3)).result.content[0].text,'backend-result');
    assert.deepEqual(calls.map(m=>m.params),[
      {name:'kiwi_accept_agreement',arguments:acceptArgs},
      {name:'kiwi_approve',arguments:approvalArgs},
    ]);
  }finally{input.end();await Promise.race([server.done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('synthetic cleanup timeout')),500))])}
});
