import {withBuyerCacheStore,ensureBuyerCacheDirectory} from './buyer-cache-store-draft.mjs';
import {stageBuyerCandidate} from './candidate-check.mjs';
import {prepareLatestBuyer} from './buyer-session.mjs';
import {ensureNoDowngrade} from './transaction.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname,delimiter,join,isAbsolute} from 'node:path';
const exec=promisify(execFile);
export function assertManagedTree(expected,actual){if(!expected||!actual||JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('TREE_DRIFT')}
export async function recheckTree(result,options){
 if(!isAbsolute(options.pythonBinary??'')||!isAbsolute(options.nodeBinary??''))throw new Error('ABSOLUTE_PATH_REQUIRED');
 const dir=result.sessionDirectory,script=fileURLToPath(new URL('./inspect_tree_cli.py',import.meta.url));
 const remaining=options.deadlineEpochMs===undefined?120000:options.deadlineEpochMs-Date.now();if(remaining<1)throw new Error('PREPARE_TIMEOUT');
 const env={HOME:dir,TMPDIR:dir,PATH:[dirname(options.nodeBinary),'/usr/bin','/bin'].join(delimiter),NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_CACHE:join(dir,'npm-cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_IGNORE_SCRIPTS:'true',PYTHONDONTWRITEBYTECODE:'1'};
 try{const r=await exec(options.pythonBinary,[script,dir],{cwd:dir,env,timeout:Math.min(120000,remaining),maxBuffer:1024*1024,signal:options.signal});assertManagedTree(result.tree,JSON.parse(r.stdout))}catch{if(options.signal?.aborted)throw new Error('PREPARE_CANCELLED');if(options.deadlineEpochMs!==undefined&&Date.now()>=options.deadlineEpochMs)throw new Error('PREPARE_TIMEOUT');throw new Error('TREE_RECHECK_FAILED')}
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
  if(active)ensureNoDowngrade(active.version,floorVersion);
  const result=active?await prepareLatestBuyer({...options,sessionDirectory:active.sessionDirectory,stagingParent:storeDirectory}):await stageBuyerCandidate({...options,stagingParent:storeDirectory,previousVersion:floorVersion});
  if(result.name!=='@harrylabsj/kiwi'||result.authorizationProven!==false||result.executionAuthorized!==false||typeof result.sessionDirectory!=='string')throw new Error('PREPARE_RESULT_INVALID');
  await recheckTree(result,{...options,signal,deadlineEpochMs});
  const selected=store.recordPrepared(result.sessionDirectory,floorVersion,{version:result.version,integrity:result.integrity,treeLockSha256:result.tree?.lock_sha256,contentTreeSha256:result.tree?.content_tree_sha256});
  return {...result,strategy:active?result.strategy:'initial',sessionDirectory:selected.sessionDirectory,latestChecked:true,authorizationProven:false,executionAuthorized:false};
 },{waitForLock:true,signal,deadlineEpochMs});
}
