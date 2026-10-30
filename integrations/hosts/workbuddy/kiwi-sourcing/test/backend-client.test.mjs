import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startVerifiedBackend} from '../runtime/backend-client.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const packageRoot=dirname(here);
const raw=JSON.parse(await import('node:fs/promises').then(fs=>fs.readFile(join(packageRoot,'runtime','mcp-tools-0.12.12.json'),'utf8')));
const baseline=Array.isArray(raw)?raw:raw.tools;
function installFake(session,tools){
  const cli=join(session,'node_modules','@harrylabsj','kiwi','dist','cli.js');mkdirSync(dirname(cli),{recursive:true,mode:0o700});
  const literal=JSON.stringify(JSON.stringify(tools));
  writeFileSync(cli,`const {createInterface}=require('node:readline');const tools=JSON.parse(${literal});const r=createInterface({input:process.stdin});r.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}}));else if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools}}));else if(m.method==='tools/call')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'synthetic read'}]}}))});\n`,{mode:0o600,flag:'wx'});
}

test('verified backend subprocess performs initialize and validates the full tool contract',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-production-backend-'),session=join(root,'session');mkdirSync(session,{mode:0o700});installFake(session,baseline);
  const messages=[];
  try{
    const backend=await startVerifiedBackend({nodeBinary:process.execPath,sessionDirectory:session,baseline,clientCapabilities:{elicitation:false},sourceRoot:packageRoot,environment:{HOME:root,TMPDIR:root,PATH:'/usr/bin:/bin'},onMessage:message=>messages.push(message)});
    await backend.send({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'kiwi_get_task',arguments:{task_id:'synthetic-only'}}});
    for(let i=0;i<100&&!messages.some(m=>m.id===9);i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(messages.find(m=>m.id===9)?.result?.content,[{type:'text',text:'synthetic read'}]);
    backend.stop();await assert.rejects(backend.done,/BACKEND_STOPPED/);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('a backend schema mismatch stops before any tool becomes available',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-production-backend-'),session=join(root,'session');mkdirSync(session,{mode:0o700});installFake(session,[]);
  try{
    await assert.rejects(()=>startVerifiedBackend({nodeBinary:process.execPath,sessionDirectory:session,baseline,sourceRoot:packageRoot,environment:{HOME:root,TMPDIR:root,PATH:'/usr/bin:/bin'}}),/TOOL_SET_MISMATCH/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
