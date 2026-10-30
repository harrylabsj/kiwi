import {spawn} from 'node:child_process';

export function remainingPrepareBudgetMs(env=process.env,now=Date.now()){
 const deadline=Number(env?.KIWI_PREPARE_DEADLINE_EPOCH_MS);
 if(!Number.isSafeInteger(deadline)||deadline<=0)throw new Error('PREPARE_BUDGET_INVALID');
 const remaining=deadline-now;
 if(!Number.isFinite(remaining)||remaining<=0)throw new Error('PREPARE_TIMEOUT');
 return Math.max(1,Math.floor(remaining));
}

// Run npm and its descendants in one process group so a timeout or launcher
// cancellation cannot leave install workers running in the background.
export function runPrepareCommand(command,args,{cwd,env,timeoutMs,maxBuffer=4*1024*1024}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||!Number.isInteger(maxBuffer)||maxBuffer<1)return Promise.reject(new Error('PREPARE_ARGUMENT_INVALID'));
 let budget;try{budget=Math.min(timeoutMs,remainingPrepareBudgetMs(env))}catch(error){return Promise.reject(error)}
 return new Promise((resolve,reject)=>{
  let child,settled=false,timer,killTimer,forcedTimer,stdout=[],stderr=[],outBytes=0,errBytes=0,stopping;
  const onInterrupt=()=>stop('PREPARE_CANCELLED');
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);clearTimeout(forcedTimer);process.off('SIGTERM',onInterrupt);process.off('SIGINT',onInterrupt);if(error)reject(error);else resolve(result)};
  const stop=code=>{if(stopping||settled)return;stopping=code;try{process.kill(-child.pid,'SIGTERM')}catch{try{child.kill('SIGTERM')}catch{void 0;}}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{try{child.kill('SIGKILL')}catch{void 0;}}},750);forcedTimer=setTimeout(()=>finish(new Error('PREPARE_TERMINATION_UNCONFIRMED')),3000)};
  try{child=spawn(command,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']})}catch{return finish(new Error('PREPARE_COMMAND_START_FAILED'))}
  child.once('error',()=>finish(new Error('PREPARE_COMMAND_START_FAILED')));
  process.once('SIGTERM',onInterrupt);process.once('SIGINT',onInterrupt);
  const collect=(target,stream)=>stream.on('data',chunk=>{const bytes=target==='stdout'?outBytes:errBytes;if(bytes+chunk.length>maxBuffer)return stop('PREPARE_OUTPUT_INVALID');if(target==='stdout'){outBytes+=chunk.length;stdout.push(chunk)}else{errBytes+=chunk.length;stderr.push(chunk)}});
  collect('stdout',child.stdout);collect('stderr',child.stderr);
  child.once('close',(code,signal)=>{
   if(stopping)return finish(new Error(stopping));
   if(code!==0||signal)return finish(new Error('PREPARE_COMMAND_FAILED'));
   finish(null,{stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')});
  });
  timer=setTimeout(()=>stop('PREPARE_TIMEOUT'),budget);
 });
}
