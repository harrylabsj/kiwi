import {constants} from 'node:fs';
import {lstat,open,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,dirname,delimiter,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resumeTransaction} from './transaction.mjs';
import {resolveLatestMetadata,downloadLockedArtifact} from './latest-resolver.mjs';
import {auditStagedPackage} from './audit-gate.mjs';
import {probeMcpSchema} from './mcp-schema-probe.mjs';
import {stageBuyerCandidateFromResolution} from './candidate-check.mjs';
import {ensureNoDowngrade} from './transaction.mjs';

const exec=promisify(execFile);

// Private cache inspection only: no production process is started. A matching
// artifact and signatures are not a WorkBuddy human approval. Same-user TOCTOU,
// host integration and cross-platform behavior remain unproven.
export async function inspectBuyerSession({sessionDirectory,npmBinary,nodeBinary,pythonBinary,baselineFile,baselineZhFile}) {
  if (![sessionDirectory,npmBinary,nodeBinary,pythonBinary,baselineFile,baselineZhFile].every(x=>typeof x==='string'&&isAbsolute(x)))throw new Error('ABSOLUTE_PATH_REQUIRED');
  const st=await lstat(sessionDirectory);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw new Error('SESSION_DIRECTORY_INVALID');
  const archive=join(sessionDirectory,'verified-download.tgz');let fd,bytes;
  try{
    fd=await open(archive,constants.O_RDONLY|constants.O_NOFOLLOW);const s=await fd.stat();
    if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||(typeof process.getuid==='function'&&s.uid!==process.getuid())||s.size>128*1024*1024)throw new Error();
    bytes=await fd.readFile();
  } catch {throw new Error('ARCHIVE_INVALID')} finally {await fd?.close()}
  // Resume the first resolution; never follow a changed latest tag mid-session.
  let lock;
  try {lock=resumeTransaction(join(sessionDirectory,'transaction.json'),bytes)}
  catch {throw new Error('BUYER_TRANSACTION_INVALID')}
  if(lock.name!=='@harrylabsj/kiwi') throw new Error('PACKAGE_INVALID');
  const env={HOME:sessionDirectory,TMPDIR:sessionDirectory,PATH:[dirname(nodeBinary),'/usr/bin','/bin'].join(delimiter),NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_CACHE:join(sessionDirectory,'npm-cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',PYTHONDONTWRITEBYTECODE:'1'};
  const provenance=await auditStagedPackage({directory:sessionDirectory,npmBinary,lock:lock,tarball:bytes,env});
  const treeCli=fileURLToPath(new URL('./inspect_tree_cli.py',import.meta.url));
  async function inspect(){try{const r=await exec(pythonBinary,[treeCli,sessionDirectory],{env,cwd:sessionDirectory,timeout:120000,maxBuffer:1024*1024});const x=JSON.parse(r.stdout);if(!Number.isInteger(x.packages)||x.packages<1)throw new Error();return x}catch{throw new Error('TREE_INSPECTION_FAILED')}}
  const before=await inspect();
  const packageRoot=join(sessionDirectory,'node_modules','@harrylabsj','kiwi');
  const baseline=JSON.parse(await readFile(baselineFile,'utf8')),baselineZh=JSON.parse(await readFile(baselineZhFile,'utf8'));
  const en=await probeMcpSchema({nodeBinary,packageRoot,fixtureHome:sessionDirectory,baseline,locale:'en'});
  const zh=await probeMcpSchema({nodeBinary,packageRoot,fixtureHome:sessionDirectory,baseline:baselineZh,locale:'zh'});
  const after=await inspect();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('TREE_DRIFT');
  return {name:lock.name,version:lock.version,integrity:lock.integrity,sourceCommit:provenance.sourceCommit,tree:after,schema:{en,zh},authorizationProven:false,executionAuthorized:false};
}

// This verifies the locked package and tool schema only; it does not authorize business actions.
export async function verifyLatestBuyerSession(options){
  return inspectBuyerSession(options);
}

// Latest is resolved once for this cache check. A mismatch is never a stale fallback.
export function assertLatestMatchesLocked(locked,latest){
  for(const k of ['name','version','integrity','tarball'])if(locked?.[k]!==latest?.[k])throw new Error('LATEST_CHANGED_STAGE_REQUIRED');
}
async function readBuyerLock(dir){
  if(typeof dir!=='string'||!isAbsolute(dir))throw new Error('ABSOLUTE_PATH_REQUIRED');
  const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw new Error('SESSION_DIRECTORY_INVALID');
  let handle,bytes;try{handle=await open(join(dir,'verified-download.tgz'),constants.O_RDONLY|constants.O_NOFOLLOW);const s=await handle.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||(typeof process.getuid==='function'&&s.uid!==process.getuid())||s.size>128*1024*1024)throw new Error();bytes=await handle.readFile()}catch{throw new Error('ARCHIVE_INVALID')}finally{await handle?.close()}
  const locked=resumeTransaction(join(dir,'transaction.json'),bytes);if(locked.name!=='@harrylabsj/kiwi')throw new Error('PACKAGE_INVALID');
  return locked;
}
export async function inspectLatestBuyerCache(options){
  const locked=await readBuyerLock(options.sessionDirectory);
  const latest=await resolveLatestMetadata('@harrylabsj/kiwi');assertLatestMatchesLocked(locked,latest);
  const inspected=await inspectBuyerSession(options);if((inspected.version!==latest.version||inspected.integrity!==latest.integrity)||inspected.executionAuthorized!==false||inspected.authorizationProven!==false)throw new Error('CACHE_CHECK_INVALID');
  return {...inspected,latestChecked:true};
}

// Resolve latest once. Never return the old cache after a registry/update failure.
export function decideBuyerUpdate(locked,latest){
 if(locked?.name!=='@harrylabsj/kiwi'||latest?.name!==locked.name)throw new Error('PACKAGE_INVALID');
 ensureNoDowngrade(latest.version,locked.version);
 if(latest.version===locked.version){assertLatestMatchesLocked(locked,latest);return 'cached'}
 return 'stage';
}
export async function prepareLatestBuyer(options){
 if(typeof options.stagingParent!=='string'||!isAbsolute(options.stagingParent))throw new Error('ABSOLUTE_PATH_REQUIRED');
 const locked=await readBuyerLock(options.sessionDirectory);
 const latest=await resolveLatestMetadata('@harrylabsj/kiwi');const strategy=decideBuyerUpdate(locked,latest);
 if(strategy==='cached'){const result=await inspectBuyerSession(options);if(result.version!==latest.version||result.integrity!==latest.integrity||result.executionAuthorized!==false||result.authorizationProven!==false)throw new Error('CACHE_CHECK_INVALID');return {...result,sessionDirectory:options.sessionDirectory,latestChecked:true,strategy}}
 const resolvedLatest=await downloadLockedArtifact(latest);
 const result=await stageBuyerCandidateFromResolution({...options,previousVersion:locked.version,resolvedLatest});
 if(result.version!==latest.version||result.integrity!==latest.integrity||result.executionAuthorized!==false||result.authorizationProven!==false)throw new Error('STAGE_CHECK_INVALID');
 return {...result,latestChecked:true,strategy};
}
