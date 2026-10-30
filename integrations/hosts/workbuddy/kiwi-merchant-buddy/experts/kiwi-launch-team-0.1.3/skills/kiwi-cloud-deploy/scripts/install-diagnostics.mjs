import {constants,closeSync,fsyncSync,openSync,writeFileSync} from 'node:fs';
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

export function classifyInstallFailure(error){
  const rawCode=field(error,'code'),rawErrno=field(error,'errno');
  const errno=typeof rawErrno==='string'&&ERRNOS.has(rawErrno)?rawErrno:
    typeof rawCode==='string'&&ERRNOS.has(rawCode)?rawCode:null;
  const rawExit=field(error,'exitCode')??(typeof rawCode==='number'?rawCode:null);
  const exitCode=Number.isInteger(rawExit)&&rawExit>=0&&rawExit<=255?rawExit:null;
  const rawSignal=field(error,'signal');
  const signal=typeof rawSignal==='string'&&SIGNALS.has(rawSignal)?rawSignal:null;
  const timeout=field(error,'timedOut')===true||errno==='ETIMEDOUT';
  const detailCode=timeout?'INSTALL_TIMEOUT':signal?'INSTALL_SIGNAL':errno?'INSTALL_SYSTEM_ERROR':exitCode!==null?'INSTALL_EXIT_NONZERO':'INSTALL_OTHER';
  return {format:1,phase:'INSTALL',category:'ISOLATED_INSTALL_FAILED',detailCode,errno,exitCode,signal,timeout};
}

export function writeInstallFailureDiagnostic(directory,error){
  const diagnostic=classifyInstallFailure(error);
  let fd;
  try{
    fd=openSync(join(directory,'npm-install-diagnostic.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify(diagnostic,null,2)+'\n','utf8');
    fsyncSync(fd);closeSync(fd);fd=undefined;
  }catch{
    // Preserve the original install failure even if safe diagnostic storage fails.
  }finally{if(fd!==undefined)try{closeSync(fd)}catch{void 0;}}
  return diagnostic;
}

export async function runIsolatedInstall({directory,install}){
  try{await install();return {status:'SUCCESS'}}
  catch(error){
    try{writeInstallFailureDiagnostic(directory,error)}catch{void 0;}
    throw new Error('ISOLATED_INSTALL_FAILED',{cause:error});
  }
}
