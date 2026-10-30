import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,join,delimiter,isAbsolute} from 'node:path';
import {checkToolContract} from './tool-contract.mjs';
import {selectEnvironment} from './environment-policy.mjs';

const PROTOCOL='2025-06-18';
const key=id=>`${typeof id}:${String(id)}`;
function writeLine(stream,line){return new Promise((resolve,reject)=>{
  const error=e=>{cleanup();reject(e)};const cleanup=()=>stream.off('error',error);stream.once('error',error);
  try{if(stream.write(line+'\n')){cleanup();resolve()}else stream.once('drain',()=>{cleanup();resolve()})}catch(e){cleanup();reject(e)}
})}

export async function startVerifiedBackend({nodeBinary,sessionDirectory,baseline,clientCapabilities={},onMessage=()=>{},timeoutMs=15000,sourceRoot,environment=process.env,signal}){
  if(!isAbsolute(nodeBinary??'')||!isAbsolute(sessionDirectory??'')||!isAbsolute(sourceRoot??'')||!Array.isArray(baseline)||typeof onMessage!=='function'||!environment||typeof environment!=='object')throw new Error('BACKEND_ARGUMENT_INVALID');
  if(signal?.aborted)throw new Error('BACKEND_CANCELLED');
  if(realpathSync(sourceRoot)!==sourceRoot)throw new Error('BACKEND_SOURCE_ROOT_INVALID');
  const cli=join(sessionDirectory,'node_modules','@harrylabsj','kiwi','dist','cli.js');
  if(realpathSync(cli)!==cli){throw new Error('BACKEND_PATH_INVALID')}
  const cliStat=lstatSync(cli);if(!cliStat.isFile()||cliStat.isSymbolicLink())throw new Error('BACKEND_PATH_INVALID');
  const env={...selectEnvironment(environment,'backend'),HOME:sessionDirectory,TMPDIR:sessionDirectory,PATH:[dirname(nodeBinary),'/usr/bin','/bin'].join(delimiter),PYTHONDONTWRITEBYTECODE:'1'};
  const child=spawn(nodeBinary,[cli,'mcp','serve','--principal','workbuddy:local','--agent','buyer-agent:workbuddy','--a2a-timeout-ms','15000'],{env,stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const sendToChild=message=>writeLine(child.stdin,JSON.stringify(message));
  const reader=createInterface({input:child.stdout,crlfDelay:Infinity}),waiters=new Map();let stopped=false,requestCounter=0;
  let resolveClose,rejectClose;const done=new Promise((resolve,reject)=>{resolveClose=resolve;rejectClose=reject});done.catch(()=>{});
  reader.on('line',line=>{
    if(stopped)return;
    if(Buffer.byteLength(line)>2*1024*1024){stop('BACKEND_OUTPUT_TOO_LARGE');return}
    let message;try{message=JSON.parse(line)}catch{stop('BACKEND_NON_JSON_STDOUT');return}
    if(message&&Object.hasOwn(message,'id')){const entry=waiters.get(key(message.id));if(entry){waiters.delete(key(message.id));clearTimeout(entry.timer);entry.resolve(message);return}}
    try{onMessage(message,sendToChild)}catch{stop('BACKEND_MESSAGE_HANDLER_FAILED')}
  });
  child.once('error',()=>{rejectWaiters('BACKEND_START_FAILED');rejectClose?.(new Error('BACKEND_START_FAILED'))});
  child.once('close',(code,signal)=>{
    stopped=true;reader.close();rejectWaiters('BACKEND_STOPPED');
    if(code===0&&!signal)resolveClose?.();else rejectClose?.(new Error('BACKEND_STOPPED'));
  });
  function rejectWaiters(code){for(const [id,w] of waiters){clearTimeout(w.timer);w.reject(new Error(code));waiters.delete(id)}}
  function request(method,params){
    const id=`kiwi-init:${++requestCounter}:${randomUUID()}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waiters.delete(key(id));reject(new Error('BACKEND_HANDSHAKE_TIMEOUT'))},timeoutMs);timer.unref?.();
      waiters.set(key(id),{resolve,reject,timer});
      void writeLine(child.stdin,JSON.stringify({jsonrpc:'2.0',id,method,params})).catch(()=>{const entry=waiters.get(key(id));if(entry){waiters.delete(key(id));clearTimeout(entry.timer);entry.reject(new Error('BACKEND_WRITE_FAILED'))}});
    });
  }
  async function notification(method,params){await writeLine(child.stdin,JSON.stringify({jsonrpc:'2.0',method,params}))}
  function stop(){
    if(stopped)return;stopped=true;rejectWaiters('BACKEND_STOPPED');try{child.kill('SIGTERM')}catch{void 0;}
    const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)try{child.kill('SIGKILL')}catch{void 0;}},1500);timer.unref?.();
  }
  const cancel=()=>stop('BACKEND_CANCELLED');signal?.addEventListener('abort',cancel,{once:true});
  done.finally(()=>signal?.removeEventListener('abort',cancel)).catch(()=>{});
  try{
    const capabilities={};if(clientCapabilities.elicitation)capabilities.elicitation={form:{}};
    const initialized=await request('initialize',{protocolVersion:PROTOCOL,clientInfo:{name:'kiwi-production-launcher',version:'1.0.0'},capabilities});
    if(initialized.error||initialized.result?.protocolVersion!==PROTOCOL)throw new Error('BACKEND_PROTOCOL_MISMATCH');
    await notification('notifications/initialized');
    const listed=await request('tools/list',{});
    if(listed.error||!Array.isArray(listed.result?.tools))throw new Error('BACKEND_TOOL_LIST_INVALID');
    checkToolContract(baseline,listed.result.tools);
    return {send:sendToChild,done,stop,toolCount:listed.result.tools.length,protocolVersion:initialized.result.protocolVersion};
  }catch(error){stop();throw error}
}
