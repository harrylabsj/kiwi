import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preflight} from './preflight.mjs';
import {createTransaction,ensureNoDowngrade} from './transaction.mjs';
import {probeMcpSchema} from './mcp-schema-probe.mjs';
import {consumeOfficialLatestResolution} from './latest-resolver.mjs';

const exec=promisify(execFile);

// Stage and verify only the latest package source, integrity, tree and exact
// MCP tool schema. Business approval semantics are outside this connector.
async function stageBuyerCandidateInternal({stagingParent,npmBinary,nodeBinary,pythonBinary,baselineFile,baselineZhFile,previousVersion,resolvedLatest}) {
  if (!pythonBinary || !baselineFile || !baselineZhFile) throw new Error('REQUIRED_GATE_MISSING');
  if (typeof previousVersion!=='string' || !previousVersion) throw new Error('PREVIOUS_VERSION_REQUIRED');
  if (previousVersion!=='initial') ensureNoDowngrade(previousVersion,previousVersion);
  const baseline=JSON.parse(await readFile(baselineFile,'utf8'));
  const baselineZh=JSON.parse(await readFile(baselineZhFile,'utf8'));
  const checked=await preflight({name:'@harrylabsj/kiwi',stagingParent,npmBinary,nodeBinary,pythonBinary,resolvedLatest});
  if (!checked.treeInspection || checked.executionAuthorized !== false) throw new Error('PREFLIGHT_INVALID');
  if(previousVersion!=='initial')ensureNoDowngrade(checked.lock.version,previousVersion);
  const packageRoot=join(checked.directory,'node_modules','@harrylabsj','kiwi');
  const fixtureHome=join(checked.directory,'fixture-home');
  await mkdir(fixtureHome,{mode:0o700});
  const env={HOME:fixtureHome,TMPDIR:fixtureHome,PATH:[dirname(nodeBinary),'/usr/bin','/bin'].join(delimiter),NODE_ENV:'test',PYTHONDONTWRITEBYTECODE:'1'};
  const schema=await probeMcpSchema({nodeBinary,packageRoot,fixtureHome,baseline,locale:'en'});
  const schemaZh=await probeMcpSchema({nodeBinary,packageRoot,fixtureHome,baseline:baselineZh,locale:'zh'});
  // Recheck installed bytes after schema probes. This detects changes but cannot
  // rule out an adversary mutating them after this check.
  let tree;
  try {
    const cli=fileURLToPath(new URL('./inspect_tree_cli.py',import.meta.url));
    const r=await exec(pythonBinary,[cli,checked.directory],{env,cwd:fixtureHome,timeout:120000,maxBuffer:1024*1024});
    tree=JSON.parse(r.stdout);
    if (JSON.stringify(tree)!==JSON.stringify(checked.treeInspection)) throw new Error('TREE_DRIFT');
  } catch { throw new Error('TREE_RECHECK_FAILED'); }
  // Commit the lock only after source, tree and tool-schema checks pass.
  createTransaction(join(checked.directory,'transaction.json'),checked.lock.name,
    {name:checked.lock.name,version:checked.lock.version,dist:{integrity:checked.lock.integrity,tarball:checked.lock.tarball}},
    await readFile(join(checked.directory,'verified-download.tgz')),previousVersion==='initial'?undefined:previousVersion);
  return {name:checked.lock.name,version:checked.lock.version,integrity:checked.lock.integrity,sourceCommit:checked.sourceCommit,sessionDirectory:checked.directory,tree,schema,schemaZh,authorizationProven:false,executionAuthorized:false};
}

// The public standalone stage resolves the official tag itself. The auto-update
// path accepts only a non-serializable token minted by the official resolver.
export async function stageBuyerCandidate(options){
  if(options?.resolvedLatest!==undefined)throw new Error('RESOLVED_LATEST_UNTRUSTED');
  return stageBuyerCandidateInternal(options);
}
export async function stageBuyerCandidateFromResolution(options){
  if(!consumeOfficialLatestResolution(options?.resolvedLatest))throw new Error('RESOLVED_LATEST_UNTRUSTED');
  return stageBuyerCandidateInternal(options);
}
