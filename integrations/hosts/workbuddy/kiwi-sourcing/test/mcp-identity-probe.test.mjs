import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {probeMcpIdentity} from '../runtime/mcp-identity-probe.mjs';

function runtime(mode){
  const root=mkdtempSync(join(tmpdir(),'kiwi-identity-runtime-'));
  const pkg=join(root,'pkg'),home=join(root,'home');
  mkdirSync(join(pkg,'dist'),{recursive:true});mkdirSync(home,{mode:0o700});
  const source=`
const {createInterface}=require('node:readline');
const mode=${JSON.stringify(mode)};
const r=createInterface({input:process.stdin});
const emit=x=>console.log(JSON.stringify(x));
r.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
 if(m.method==='initialize'){emit({jsonrpc:'2.0',id:m.id,result:{protocolVersion:mode==='init-invalid'?'2024-01-01':'2025-06-18',capabilities:{tools:{}},serverInfo:{name:mode==='init-invalid'?'old-runtime':'kiwi-buyer-mcp'}}});return}
 if(m.method==='tools/call'&&mode!=='timeout'){
  if(m.id===3){
   if(mode==='foreign-internal')emit({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'error internal_error: boom'}]}});
   else if(mode==='foreign-malformed')emit({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[]}});
   else if(mode==='foreign-jsonrpc')emit({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'internal'}});
   else emit({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'error task_not_found: task probe-foreign-task not found'}]}});
   return;
  }
  if(m.id===2){
   if(mode==='owner-malformed')emit({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'{}'}]}});
   else emit({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify({task:{task_id:'probe-owner-task',task_kind:'request_quotes'}})}]}});
  }
 }
});
if(mode==='timeout')setInterval(()=>{},1000);
`;
  writeFileSync(join(pkg,'dist','cli.js'),source,{mode:0o600});
  return {root,pkg,home};
}
async function run(mode){
  const x=runtime(mode);
  try{return await probeMcpIdentity({nodeBinary:process.execPath,packageRoot:x.pkg,fixtureHome:x.home,timeoutMs:500})}
  finally{rmSync(x.root,{recursive:true,force:true})}
}

test('strict identity probe accepts a complete, structured owner/not-found pair',async()=>{
  const result=await run('good');
  assert.deepEqual(result,{identity:'supported',probeTasks:2});
});

for(const [mode,pattern] of [
  ['foreign-internal',/MCP_IDENTITY_FOREIGN_NOT_STRUCTURED/],
  ['foreign-malformed',/MCP_IDENTITY_FOREIGN_NOT_STRUCTURED/],
  ['foreign-jsonrpc',/MCP_IDENTITY_FOREIGN_NOT_STRUCTURED/],
  ['owner-malformed',/MCP_IDENTITY_OWNER_READ_FAILED/],
  ['init-invalid',/MCP_IDENTITY_INITIALIZE_INVALID/],
]){
  test(`strict identity probe rejects ${mode}`,async()=>{
    await assert.rejects(()=>run(mode),pattern);
  });
}

test('strict identity probe rejects a silent/crashed runtime',async()=>{
  await assert.rejects(()=>run('timeout'),/MCP_IDENTITY_TIMEOUT|MCP_IDENTITY_FAILED/);
});
