import {assertRecoverableBuyerCache,findRecoverableBuyerSession,withBuyerCacheStore,ensureBuyerCacheDirectory} from './buyer-cache-store-draft.mjs';
import {stageBuyerCandidate} from './candidate-check.mjs';
import {prepareLatestBuyer} from './buyer-session.mjs';
import {ensureNoDowngrade} from './transaction.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname,delimiter,join,isAbsolute} from 'node:path';
const exec=promisify(execFile);
export function assertManagedTree(expected,actual){if(!expected||!actual||JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('TREE_DRIFT')}
function assertTreeOutput(tree){
 if(!tree||!Number.isInteger(tree.packages)||tree.packages<1||!Number.isInteger(tree.files)||tree.files<1||!/^[a-f0-9]{64}$/.test(tree.lock_sha256??'')||!/^[a-f0-9]{64}$/.test(tree.content_tree_sha256??''))throw new Error('TREE_RECHECK_FAILED');
 return tree;
}
export async function inspectTree(sessionDirectory,options){
 if(typeof sessionDirectory!=='string'||!isAbsolute(sessionDirectory)||!isAbsolute(options.pythonBinary??'')||!isAbsolute(options.nodeBinary??''))throw new Error('ABSOLUTE_PATH_REQUIRED');
 const dir=sessionDirectory,script=fileURLToPath(new URL('./inspect_tree_cli.py',import.meta.url));
 const remaining=options.deadlineEpochMs===undefined?120000:options.deadlineEpochMs-Date.now();if(remaining<1)throw new Error('PREPARE_TIMEOUT');
 const env={HOME:dir,TMPDIR:dir,PATH:[dirname(options.nodeBinary),'/usr/bin','/bin'].join(delimiter),NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_CACHE:join(dir,'npm-cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_IGNORE_SCRIPTS:'true',PYTHONDONTWRITEBYTECODE:'1'};
 try{
  const r=await exec(options.pythonBinary,[script,dir],{cwd:dir,env,timeout:Math.min(120000,remaining),maxBuffer:1024*1024,signal:options.signal});
  return assertTreeOutput(JSON.parse(r.stdout));
 }catch(error){
  if(options.signal?.aborted||error?.message==='PREPARE_CANCELLED')throw new Error('PREPARE_CANCELLED',{cause:error});
  if(options.deadlineEpochMs!==undefined&&Date.now()>=options.deadlineEpochMs)throw new Error('PREPARE_TIMEOUT',{cause:error});
  if(error?.message==='PREPARE_TIMEOUT')throw error;
  throw new Error('TREE_RECHECK_FAILED',{cause:error});
 }
}
export async function recheckTree(result,options){
 const actual=await inspectTree(result.sessionDirectory,options);
 if(result.tree!==undefined){try{assertManagedTree(result.tree,actual)}catch{throw new Error('TREE_RECHECK_FAILED')}}
 return actual;
}
// The shared download cache is a sibling of the store. If the store sits under
// a non-private parent (standalone --store paths commonly do), fall back to the
// per-session npm cache instead of rejecting a layout that worked before the
// shared cache existed.
export function sharedInstallCacheDirectory(storeDirectory){
 const directory=join(dirname(storeDirectory),'kiwi-buyer-npm-downloads');
 try{ensureBuyerCacheDirectory(directory);return directory}
 catch(error){if(error?.message==='CACHE_DIRECTORY_INVALID'||error?.code==='ENOENT')return undefined;throw error}
}

// Local prepare only. No process is launched and no human consent is inferred.
// Store contents can be changed by the same OS user; production needs a
// protected rollback anchor and a WorkBuddy-supported store location.
export async function prepareManagedBuyer({storeDirectory,floorVersion,signal,...options}){
 if(typeof floorVersion!=='string'||!floorVersion)throw new Error('PREVIOUS_VERSION_REQUIRED');
 ensureNoDowngrade(floorVersion,floorVersion);
 ensureBuyerCacheDirectory(storeDirectory);
 const deadlineEpochMs=Number(process.env.KIWI_PREPARE_DEADLINE_EPOCH_MS||Date.now()+600_000);
 return withBuyerCacheStore(storeDirectory,async store=>{
  const active=store.prepared();
  let resumed=null;
  if(active)ensureNoDowngrade(active.version,floorVersion);
  else resumed=findRecoverableBuyerSession(storeDirectory);
  const installCacheDirectory=sharedInstallCacheDirectory(storeDirectory);
  const stageOptions={...options,stagingParent:storeDirectory,installCacheDirectory};
  let result;let strategy;
  if(active){
   result=await prepareLatestBuyer({...stageOptions,sessionDirectory:active.sessionDirectory});
  }else if(resumed){
   // The host stopped between staging (transaction committed) and
   // recordPrepared. Treat the finalized session like an active one: this
   // re-resolves latest, re-verifies provenance/tree/tool schema, and writes
   // the missing pointer instead of bricking the store.
   ensureNoDowngrade(resumed.lock.version,floorVersion);
   result=await prepareLatestBuyer({...stageOptions,sessionDirectory:resumed.dir});
  }else{
   assertRecoverableBuyerCache(storeDirectory);
   strategy='initial';
   result=await stageBuyerCandidate({...stageOptions,previousVersion:floorVersion});
  }
  if(result.name!=='@harrylabsj/kiwi'||result.authorizationProven!==false||result.executionAuthorized!==false||typeof result.sessionDirectory!=='string')throw new Error('PREPARE_RESULT_INVALID');
  const tree=await recheckTree(result,{...options,signal,deadlineEpochMs});
  const selected=store.recordPrepared(result.sessionDirectory,floorVersion,{version:result.version,integrity:result.integrity,treeLockSha256:tree.lock_sha256,contentTreeSha256:tree.content_tree_sha256});
  return {...result,tree,strategy:active||resumed?result.strategy:strategy,sessionDirectory:selected.sessionDirectory,latestChecked:true,authorizationProven:false,executionAuthorized:false};
 },{waitForLock:true,signal,deadlineEpochMs});
}
