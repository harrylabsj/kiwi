import {constants,closeSync,existsSync,fsyncSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const ERRNOS=new Set([
  'EACCES','ECONNABORTED','ECONNREFUSED','ECONNRESET','EEXIST','EINTEGRITY','EAI_AGAIN',
  'EBADENGINE','ENETUNREACH','ENOENT','ENOSPC','ENOTEMPTY','ENOTFOUND','EPERM','EPIPE',
  'ERESOLVE','ETARGET','ETIMEDOUT','E401','E403','E404','E429','E500','ERR_SSL',
  'CERT_HAS_EXPIRED','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const SIGNALS=new Set(['SIGABRT','SIGALRM','SIGBUS','SIGFPE','SIGHUP','SIGILL','SIGINT','SIGKILL','SIGPIPE','SIGQUIT','SIGSEGV','SIGTERM','SIGTRAP','SIGUSR1','SIGUSR2']);

function field(error,name){
  try{return error?.[name]}catch{void 0;return undefined}
}

// Detail codes stay a fixed whitelist: never npm stdout/stderr, URLs, command
// arguments or credentials. `INSTALL_TIMEOUT_KILLED` is the code that was
// missing on 2026-11-27: the outer budget SIGTERMed npm, npm caught the signal
// and exited 1 itself, so exitCode=1 and signal=null looked like an ordinary
// dependency failure. A near-budget elapsed time now classifies it as a
// timeout kill, and every install failure reports the supported resume path.
export function classifyInstallFailure(error, timing = {}) {
  const rawCode=field(error,'code'),rawErrno=field(error,'errno');
  const errno=typeof rawErrno==='string'&&ERRNOS.has(rawErrno)?rawErrno:
    typeof rawCode==='string'&&ERRNOS.has(rawCode)?rawCode:null;
  const rawExit=field(error,'exitCode')??(typeof rawCode==='number'?rawCode:null);
  const exitCode=Number.isInteger(rawExit)&&rawExit>=0&&rawExit<=255?rawExit:null;
  const rawSignal=field(error,'signal');
  const signal=typeof rawSignal==='string'&&SIGNALS.has(rawSignal)?rawSignal:null;
  const timeout=field(error,'timedOut')===true||errno==='ETIMEDOUT';
  const rawTimeoutMs=timing?.timeoutMs,rawElapsedMs=timing?.elapsedMs;
  const timeoutMs=Number.isInteger(rawTimeoutMs)&&rawTimeoutMs>0?rawTimeoutMs:null;
  const elapsedMs=Number.isInteger(rawElapsedMs)&&rawElapsedMs>=0?rawElapsedMs:null;
  const killedByTimeout=timeout||(timeoutMs!==null&&elapsedMs!==null&&elapsedMs>=timeoutMs*0.9);
  const detailCode=killedByTimeout?'INSTALL_TIMEOUT_KILLED':signal?'INSTALL_SIGNAL':errno?'INSTALL_SYSTEM_ERROR':exitCode!==null?'INSTALL_EXIT_NONZERO':'INSTALL_OTHER';
  return {
    format:2,
    phase:'INSTALL',
    category:'ISOLATED_INSTALL_FAILED',
    detailCode,
    errno,
    exitCode,
    signal,
    timeout,
    killed_by_timeout:killedByTimeout,
    elapsed_ms:elapsedMs,
    timeout_ms:timeoutMs,
    resumable:true,
    resume_action:'cloud-session-cli.mjs resume --session <sessionDirectory>',
  };
}

export function writeInstallFailureDiagnostic(directory,error,timing = {}){
  const diagnostic=classifyInstallFailure(error,timing);
  let fd;
  try{
    // A resumed session may already hold the previous attempt's diagnostic.
    // Replace it (still 0600, no symlink) so the file describes the latest try.
    const path=join(directory,'npm-install-diagnostic.json');
    if(existsSync(path))try{unlinkSync(path)}catch{void 0;}
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify(diagnostic,null,2)+'\n','utf8');
    fsyncSync(fd);closeSync(fd);fd=undefined;
  }catch{
    // Preserve the original install failure even if safe diagnostic storage fails.
  }finally{if(fd!==undefined)try{closeSync(fd)}catch{void 0;}}
  return diagnostic;
}

export async function runIsolatedInstall({directory,install,timeoutMs}){
  const startedAt=Date.now();
  try{await install();return {status:'SUCCESS'}}
  catch(error){
    const timing={elapsedMs:Date.now()-startedAt,timeoutMs};
    try{writeInstallFailureDiagnostic(directory,error,timing)}catch{void 0;}
    throw new Error('ISOLATED_INSTALL_FAILED',{cause:error});
  }
}
