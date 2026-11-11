import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {isAbsolute,join,dirname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resumeTransaction} from './transaction.mjs';
import {auditStagedPackage} from './audit-gate.mjs';
import {verifyBytes} from './artifact.mjs';

const exec=promisify(execFile);
export async function assertCloudTreeStable(first,inspectAgain){
  if(typeof inspectAgain!=='function')throw new Error('CLOUD_RECHECK_INVALID');
  let second;try{second=await inspectAgain()}catch{throw new Error('CLOUD_TREE_CHANGED')}
  if(!first||!second||JSON.stringify(first)!==JSON.stringify(second))throw new Error('CLOUD_TREE_CHANGED');
}

// Rechecks a staged transaction without resolving latest again or publishing.
// This cannot attest WorkBuddy identity, user approval, backups or protect
// against all same-user TOCTOU changes. Not production deployment authority.
export async function verifyCloudSession({sessionDirectory,npmBinary,nodeBinary,pythonBinary}) {
  if (![sessionDirectory,npmBinary,nodeBinary,pythonBinary].every(x=>typeof x==='string' && isAbsolute(x))) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const dir=await lstat(sessionDirectory);
  if(!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (typeof process.getuid==='function' && dir.uid!==process.getuid())) throw new Error('SESSION_DIRECTORY_INVALID');
  const archive=join(sessionDirectory,'verified-download.tgz');
  let handle,stat,bytes;
  try {
    handle=await open(archive,constants.O_RDONLY|constants.O_NOFOLLOW);
    stat=await handle.stat();
    if(!stat.isFile() || stat.nlink!==1 || (stat.mode & 0o077) || (typeof process.getuid==='function' && stat.uid!==process.getuid()) || stat.size>128*1024*1024) throw new Error('ARCHIVE_INVALID');
    bytes=await handle.readFile();
  } catch {throw new Error('ARCHIVE_INVALID')}
  finally {await handle?.close()}
  const lock=resumeTransaction(join(sessionDirectory,'transaction.json'),bytes);
  if(lock.name!=='@harrylabsj/kiwi-merchant-cloud') throw new Error('PACKAGE_INVALID');
  const environment={HOME:sessionDirectory,TMPDIR:sessionDirectory,PATH:[dirname(nodeBinary),'/usr/bin','/bin'].join(delimiter),NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_CACHE:join(sessionDirectory,'npm-cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'};
  const verified=await auditStagedPackage({directory:sessionDirectory,npmBinary,lock,tarball:bytes,env:environment});
  async function inspectTree(){
    const cli=fileURLToPath(new URL('./inspect_cloud_cli.py',import.meta.url));
    const installed=join(sessionDirectory,'node_modules','@harrylabsj','kiwi-merchant-cloud');
    const r=await exec(pythonBinary,[cli,archive,lock.version,installed],{cwd:sessionDirectory,env:environment,timeout:120000,maxBuffer:1024*1024});
    const value=JSON.parse(r.stdout);
    if(value.version!==lock.version || value.sourceCommit!==verified.sourceCommit || !Number.isInteger(value.files) || value.files<1 || value.installed?.files!==value.files) throw new Error('CLOUD_OUTPUT_INVALID');
    return value;
  }
  let tree;try{tree=await inspectTree()}catch{throw new Error('CLOUD_INSPECTION_FAILED')}
  // Detect accidental replacement or mutation during the audit/inspection.
  // This reduces a race but cannot defeat a same-user attacker that swaps and
  // restores content between checks; production still needs a stronger boundary.
  let again;
  try {
    again=await open(archive,constants.O_RDONLY|constants.O_NOFOLLOW);
    const after=await again.stat();
    if(!after.isFile() || after.nlink!==1 || after.dev!==stat.dev || after.ino!==stat.ino || after.size!==stat.size || (after.mode & 0o077) || (typeof process.getuid==='function' && after.uid!==process.getuid())) throw new Error('ARCHIVE_CHANGED');
    verifyBytes(lock,await again.readFile());
  } catch {throw new Error('ARCHIVE_CHANGED')}
  finally {await again?.close()}
  await assertCloudTreeStable(tree,inspectTree);
  return {name:lock.name,version:lock.version,integrity:lock.integrity,sourceCommit:verified.sourceCommit,tree,executionAuthorized:false};
}
