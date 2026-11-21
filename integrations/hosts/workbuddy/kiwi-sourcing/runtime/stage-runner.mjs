import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {selectEnvironment} from './environment-policy.mjs';
import {StringDecoder} from 'node:string_decoder';
import {PREPARE_CODE_CATEGORIES} from './prepare-error-codes.mjs';

// Draft: launches only a preparation subprocess. Its result never grants
// permission for purchase actions or itself launches the product.
export function runPreparation({nodeBinary,cliPath,args,env,timeoutMs=600000,progressIntervalMs=15000,onProgress=()=>{},signal}){
 if(process.platform==='win32')return Promise.reject(new Error('PLATFORM_UNSUPPORTED'));
 if(!isAbsolute(nodeBinary??'')||!isAbsolute(cliPath??'')||!Array.isArray(args)||args.some(x=>typeof x!=='string')||!env||typeof env!=='object'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isInteger(progressIntervalMs)||progressIntervalMs<1000||progressIntervalMs>60000||typeof onProgress!=='function')return Promise.reject(new Error('PREPARE_ARGUMENT_INVALID'));
 if(signal?.aborted)return Promise.reject(new Error('PREPARE_CANCELLED'));
 return new Promise((resolve,reject)=>{
  let child,done=false,stopping,timer,terminationTimer,progressTimer,size=0,chunks=[],stderrPending='',stderrBytes=0,prepareCategory;const stderrDecoder=new StringDecoder('utf8'),startedAt=Date.now();
  const settle=(error,result)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(terminationTimer);clearInterval(progressTimer);signal?.removeEventListener('abort',cancel);if(error)reject(new Error(error));else resolve(result)};
  const terminate=()=>{if(child?.pid&&child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGTERM')}catch{try{child.kill('SIGTERM')}catch{void 0;}}}};
  const stop=code=>{if(done||stopping)return;stopping=code;chunks=[];clearTimeout(timer);terminate();terminationTimer=setTimeout(()=>settle('PREPARE_TERMINATION_UNCONFIRMED'),3000)};
  const cancel=()=>stop('PREPARE_CANCELLED');
  const cleanEnv=selectEnvironment(env,'prepare');cleanEnv.KIWI_PREPARE_DEADLINE_EPOCH_MS=String(Date.now()+timeoutMs);
  try{child=spawn(nodeBinary,[cliPath,...args],{env:cleanEnv,detached:true,stdio:['ignore','pipe','pipe']})}catch{return settle('PREPARE_START_FAILED')}
  child.stderr.on('data',data=>{if(stderrBytes>=8192)return;stderrBytes+=data.length;stderrPending+=stderrDecoder.write(data.subarray(0,Math.max(0,8192-(stderrBytes-data.length))));let i;while((i=stderrPending.indexOf('\n'))>=0){const line=stderrPending.slice(0,i);stderrPending=stderrPending.slice(i+1);const m=/^HOLD: ([A-Z_]+)$/.exec(line);if(m&&PREPARE_CODE_CATEGORIES.has(m[1]))prepareCategory=PREPARE_CODE_CATEGORIES.get(m[1]);}});child.stdout.on('data',data=>{if(done||stopping)return;size+=data.length;if(size>65536)return stop('PREPARE_OUTPUT_INVALID');chunks.push(data)});
  child.once('error',()=>settle('PREPARE_START_FAILED'));
  child.once('close',(code,terminated)=>{
   if(done)return;if(stopping)return settle(stopping);if(code!==0||terminated)return settle(prepareCategory?'PREPARE_FAILED:'+prepareCategory:'PREPARE_FAILED');
   let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return settle('PREPARE_OUTPUT_INVALID')}finally{chunks=[]}
   if(!result||result.name!=='@harrylabsj/kiwi'||result.latestChecked!==true||result.authorizationProven!==false||result.executionAuthorized!==false||typeof result.sessionDirectory!=='string'||!isAbsolute(result.sessionDirectory))return settle('PREPARE_OUTPUT_INVALID');
   settle(null,result);
  });
  timer=setTimeout(()=>stop('PREPARE_TIMEOUT'),timeoutMs);
  progressTimer=setInterval(()=>{try{onProgress({stage:'PREPARE',elapsedMs:Date.now()-startedAt})}catch{void 0;}},progressIntervalMs);progressTimer.unref?.();
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 });
}
