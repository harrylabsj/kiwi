import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
