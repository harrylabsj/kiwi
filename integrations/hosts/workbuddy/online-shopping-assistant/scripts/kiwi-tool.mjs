import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One explicit tool call per invocation. Retry ONLY a definitive not-sent
// preparation response; never retry an uncertain business action.
export async function invoke({tool, args, launcher, node=process.execPath, timeoutMs=600000, dataDirectory}) {
 const allowed=new Set(['kiwi_search','kiwi_request_quotes','kiwi_get_task','kiwi_negotiate']);
 if(!allowed.has(tool)||!args||typeof args!=='object'||Array.isArray(args))throw new Error('INVALID_TOOL_REQUEST');
 return await new Promise((resolve,reject)=>{
  const child=spawn(node,[launcher],{stdio:['pipe','pipe','pipe'],env:{...process.env,...(dataDirectory?{CODEBUDDY_PLUGIN_DATA:dataDirectory,KIWI_EXPERT_DEFER_PREPARE:'1'}:{})}});
  const reader=createInterface({input:child.stdout,crlfDelay:Infinity});let buffer='',settled=false,id=10,timer;
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);reader.close();child.kill('SIGTERM');error?reject(error):resolve(value)}
  // 子进程已退出时写入会触发 EPIPE；交给 child 'exit' 收敛为
  // KIWI_RUNTIME_STOPPED，避免未监听的 stdin error 直接崩溃。
  child.stdin.on('error',()=>{/* 交给 child exit 收敛 */});
  function send(message){try{child.stdin.write(JSON.stringify(message)+'\n')}catch{/* 同上 */}}
  function call(){send({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:tool,arguments:args}})}
  timer=setTimeout(()=>finish(new Error('KIWI_STARTUP_TIMEOUT')),timeoutMs);
  child.stderr.on('data',data=>{buffer=(buffer+data.toString()).slice(-2048)});
  child.on('error',()=>finish(new Error('KIWI_STARTUP_FAILED')));
  child.on('exit',()=>{if(!settled)finish(new Error(/NPM_12_UNAVAILABLE/.test(buffer)?'NPM_12_UNAVAILABLE':'KIWI_RUNTIME_STOPPED'))});
  reader.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return finish(new Error('KIWI_PROTOCOL_ERROR'))}
   if(m.id===1){if(m.error)return finish(new Error('KIWI_INITIALIZATION_FAILED'));send({jsonrpc:'2.0',method:'notifications/initialized'});call();return}
   if(m.id!==id)return;
   if(m.error)return finish(null,{isError:true,error:m.error});
   const r=m.result;
   if(r?.isError&&r?.structuredContent?.code==='PREPARATION_IN_PROGRESS'&&r.structuredContent.requestSent===false){setTimeout(()=>{if(!settled)call()},1000);return}
   finish(null,r);
  });
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'workbuddy-shopping-skill',version:'1.0.0'}}});
 });
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]){
 try{
  if(process.argv.length!==4||process.argv[2]!=='--workspace'||!isAbsolute(process.argv[3]))throw new Error('KIWI_WORKSPACE_REQUIRED');
  const workspace=realpathSync(process.argv[3]);
  if(realpathSync(process.cwd())!==workspace)throw new Error('KIWI_WORKSPACE_MISMATCH');
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>256*1024)throw new Error('INPUT_TOO_LARGE')}
  const data=JSON.parse(input);const root=dirname(dirname(fileURLToPath(import.meta.url)));
  const {expertDataDirectory}=await import(join(root,'scripts','runtime','expert-data.mjs'));
  const dataDirectory=expertDataDirectory(workspace);
  const result=await invoke({tool:data.tool,args:data.arguments??{},dataDirectory,launcher:join(root,'scripts','runtime','production-launcher.mjs')});
  process.stdout.write(JSON.stringify(result)+'\n');if(result?.isError)process.exitCode=1;
 }catch(e){process.stderr.write(`KIWI_SKILL_HOLD:${/^[A-Z0-9_]+$/.test(e?.message??'')?e.message:'INVALID_REQUEST'}\n`);process.exitCode=1}
}
