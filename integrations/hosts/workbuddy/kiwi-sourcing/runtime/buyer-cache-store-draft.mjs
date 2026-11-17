import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,lstatSync,mkdirSync,renameSync,unlinkSync,realpathSync,symlinkSync,readlinkSync} from 'node:fs';
import {isAbsolute,join,resolve,dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {resumeTransaction,ensureNoDowngrade} from './transaction.mjs';

/* eslint-disable no-unsafe-finally -- Cache cleanup and lock-integrity failures must reject, otherwise a partial update could be treated as successful. */

// Local staging bookkeeping only; does not authorize execution, defend against
// a malicious same-user process, or prove the registry latest independently.
function privateDirectory(p){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||(typeof process.getuid==='function'&&s.uid!==process.getuid())||realpathSync(p)!==p)throw new Error('CACHE_DIRECTORY_INVALID');return s}
// Create only beneath an already private, canonical parent; never repair or
// replace an existing directory. Parallel creators converge on the same lock.
export function ensureBuyerCacheDirectory(root){
 if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root)throw new Error('CACHE_ARGUMENT_INVALID');
 try{privateDirectory(root);return}catch(e){if(e.code!=='ENOENT')throw e}
 privateDirectory(dirname(root));
 try{mkdirSync(root,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}
 privateDirectory(root);
}
function readPrivate(p,max){let fd;try{fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||(typeof process.getuid==='function'&&s.uid!==process.getuid())||s.size>max)throw new Error();return readFileSync(fd)}catch(e){if(e.code==='ENOENT')throw e;throw new Error('CACHE_FILE_INVALID',{cause:e})}finally{if(fd!==undefined)closeSync(fd)}}
function lockDigest(p){let fd;try{fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||(s.mode&0o022)||(typeof process.getuid==='function'&&s.uid!==process.getuid())||s.size>16*1024*1024)throw new Error();return createHash('sha256').update(readFileSync(fd)).digest('hex')}catch{throw new Error('CACHE_TREE_LOCK_INVALID')}finally{if(fd!==undefined)closeSync(fd)}}
function validName(name){return typeof name==='string'&&/^kiwi-preflight-[A-Za-z0-9]{6}$/.test(name)}
function sessionLock(root,name){if(!validName(name))throw new Error('CACHE_SESSION_INVALID');const dir=join(root,name);privateDirectory(dir);const bytes=readPrivate(join(dir,'verified-download.tgz'),128*1024*1024);const lock=resumeTransaction(join(dir,'transaction.json'),bytes);if(lock.name!=='@harrylabsj/kiwi')throw new Error('PACKAGE_INVALID');return {dir,lock,treeLockSha256:lockDigest(join(dir,'package-lock.json'))}}
async function acquireGuard(path,options){
 const wait=options?.waitForLock===true,signal=options?.signal,deadline=options?.deadlineEpochMs;
 if(options!==undefined&&(!options||typeof options!=='object'||(wait&&(!Number.isSafeInteger(deadline)||deadline<=Date.now()))))throw new Error('CACHE_ARGUMENT_INVALID');
 const lockFile=join(dirname(path),'.update-lock.sqlite'),marker='.update-lock.sqlite';
 // Never open and close another descriptor for an existing SQLite file: on
 // POSIX that can drop locks held by another connection in this process.
 try{lstatSync(lockFile)}catch(e){if(e.code!=='ENOENT')throw e;const name='.update-lock-data-'+randomBytes(12).toString('hex'),temp=join(dirname(path),name);const fd=openSync(temp,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);let selected=false;try{try{symlinkSync(name,lockFile);selected=true}catch(err){if(err.code!=='EEXIST')throw err}}finally{if(!selected)unlinkSync(temp)}}
 const pointerStat=lstatSync(lockFile);if(!pointerStat.isSymbolicLink())throw new Error('CACHE_LOCK_INVALID');const target=readlinkSync(lockFile);if(!/^\.update-lock-data-[a-f0-9]{24}$/.test(target))throw new Error('CACHE_LOCK_INVALID');
 const fileStat=lstatSync(join(dirname(path),target));
 if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1||(fileStat.mode&0o077)||(typeof process.getuid==='function'&&fileStat.uid!==process.getuid()))throw new Error('CACHE_LOCK_INVALID');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(lockFile);db.exec('PRAGMA busy_timeout=0');let locked=false;
 try{for(;;){
  if(signal?.aborted)throw new Error('PREPARE_CANCELLED');
  if(wait&&Date.now()>=deadline)throw new Error('PREPARE_TIMEOUT');
  try{db.exec('BEGIN IMMEDIATE');locked=true}catch(e){if(e.errcode!==5)throw e}
  if(locked){
   let busy=false;
   try{
    try{const s=lstatSync(path);if(s.isSymbolicLink()&&readlinkSync(path)===marker)unlinkSync(path);else busy=true}catch(e){if(e.code!=='ENOENT')throw e}
    if(!busy){try{symlinkSync(marker,path);return {db,marker}}catch(e){if(e.code!=='EEXIST')throw e;busy=true}}
   }catch(e){db.exec('ROLLBACK');locked=false;throw e}
   db.exec('ROLLBACK');locked=false;
  }
  if(!wait)throw new Error('CACHE_BUSY');
  const remaining=deadline-Date.now();if(remaining<=0)throw new Error('PREPARE_TIMEOUT');
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(done,Math.min(50,remaining));
   function done(){signal?.removeEventListener('abort',cancel);resolve()}
   function cancel(){clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new Error('PREPARE_CANCELLED'))}
   signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  });
 }}catch(e){if(locked)try{db.exec('ROLLBACK')}catch{/* Preserve the original error. */}db.close();throw e}
}
export async function withBuyerCacheStore(root,operation,options){
 if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root||typeof operation!=='function')throw new Error('CACHE_ARGUMENT_INVALID');privateDirectory(root);
 const guard=join(root,'.update-lock');const {db,marker}=await acquireGuard(guard,options);const guardStat=lstatSync(guard);let live=true;
 const pointer=join(root,'prepared.json');
 function rejectLegacy(){try{lstatSync(join(root,'active.json'));throw new Error('CACHE_LEGACY_STATE_REQUIRES_REVIEW')}catch(e){if(e.code!=='ENOENT')throw e}}
 function prepared(){if(!live)throw new Error('CACHE_SCOPE_CLOSED');let data;try{data=JSON.parse(readPrivate(pointer,4096).toString('utf8'))}catch(e){if(e.code==='ENOENT')return null;throw new Error('CACHE_POINTER_INVALID',{cause:e})}
  if(!data||Object.keys(data).sort().join(',')!=='authorizationProven,contentTreeSha256,executionAuthorized,format,integrity,session,treeLockSha256,version'||data.format!==3||data.authorizationProven!==false||data.executionAuthorized!==false||!validName(data.session)||!/^([a-f0-9]{64})$/.test(data.contentTreeSha256??''))throw new Error('CACHE_POINTER_INVALID');const {dir,lock,treeLockSha256}=sessionLock(root,data.session);if(data.version!==lock.version||data.integrity!==lock.integrity||data.treeLockSha256!==treeLockSha256)throw new Error('CACHE_POINTER_INVALID');return {sessionDirectory:dir,version:lock.version,integrity:lock.integrity,treeLockSha256,contentTreeSha256:data.contentTreeSha256}}
 function recordPrepared(dir,minimumVersion,expected){if(!live)throw new Error('CACHE_SCOPE_CLOSED');if(typeof dir!=='string'||!isAbsolute(dir)||!dir.startsWith(root+'/')||dir.slice(root.length+1).includes('/'))throw new Error('CACHE_SESSION_INVALID');const name=dir.slice(root.length+1);const {lock,treeLockSha256}=sessionLock(root,name);if(!expected||expected.version!==lock.version||expected.integrity!==lock.integrity||expected.treeLockSha256!==treeLockSha256||!/^([a-f0-9]{64})$/.test(expected.contentTreeSha256??''))throw new Error('CACHE_RESULT_MISMATCH');if(typeof minimumVersion!=='string'||!minimumVersion)throw new Error('PREVIOUS_VERSION_REQUIRED');ensureNoDowngrade(lock.version,minimumVersion);const previous=prepared();if(previous){ensureNoDowngrade(lock.version,previous.version);if(lock.version===previous.version&&lock.integrity!==previous.integrity)throw new Error('SAME_VERSION_INTEGRITY_CHANGED')}
  const content=JSON.stringify({format:3,session:name,version:lock.version,integrity:lock.integrity,treeLockSha256,contentTreeSha256:expected.contentTreeSha256,authorizationProven:false,executionAuthorized:false})+'\n';const temp=join(root,'.prepared-'+randomBytes(12).toString('hex'));let fd;try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,content);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,pointer);const d=openSync(root,constants.O_RDONLY);try{fsyncSync(d)}finally{closeSync(d)}}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}}return {sessionDirectory:dir,version:lock.version,integrity:lock.integrity,treeLockSha256,contentTreeSha256:expected.contentTreeSha256}}
 try{rejectLegacy();return await operation({prepared,recordPrepared})}finally{live=false;try{const s=lstatSync(guard);if(!s.isSymbolicLink()||readlinkSync(guard)!==marker||s.dev!==guardStat.dev||s.ino!==guardStat.ino)throw new Error('CACHE_LOCK_CHANGED');unlinkSync(guard)}finally{try{db.exec('ROLLBACK')}finally{db.close()}}}
}
/* eslint-enable no-unsafe-finally */
