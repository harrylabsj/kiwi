import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {startVerifiedBackend} from '../runtime/backend-client.mjs';

const packageRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const raw=JSON.parse(readFileSync(join(packageRoot,'runtime','mcp-tools-0.12.12.json'),'utf8'));
const baseline=Array.isArray(raw)?raw:raw.tools;
function fakeBackend(session){
 const cli=join(session,'node_modules','@harrylabsj','kiwi','dist','cli.js');mkdirSync(dirname(cli),{recursive:true,mode:0o700});
 const record=join(session,'arguments.json');
 writeFileSync(cli,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv));const tools=${JSON.stringify(baseline)};require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}}));else if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools}}))});`);
 return record;
}
test('catalog buyer identity stays stable for an instance and differs across instances',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'kiwi-buyer-identity-'));
 try{
  async function launch(sessionName,identityName){
   const session=join(root,sessionName);mkdirSync(session,{mode:0o700});const argsFile=fakeBackend(session);
   const backend=await startVerifiedBackend({nodeBinary:process.execPath,sessionDirectory:session,dataDirectory:join(root,identityName),baseline,sourceRoot:packageRoot,environment:{HOME:root,TMPDIR:root,PATH:'/usr/bin:/bin'}});
   const args=JSON.parse(readFileSync(argsFile,'utf8'));const index=args.indexOf('--buyer-id');assert.notEqual(index,-1);const id=args[index+1];assert.match(id,/^workbuddy:[0-9a-f-]{36}$/);
   backend.stop();await assert.rejects(backend.done,/BACKEND_STOPPED/);return id;
  }
  const first=await launch('first','instance-a');assert.equal(await launch('second','instance-a'),first);assert.notEqual(await launch('third','instance-b'),first);
 }finally{rmSync(root,{recursive:true,force:true})}
});
