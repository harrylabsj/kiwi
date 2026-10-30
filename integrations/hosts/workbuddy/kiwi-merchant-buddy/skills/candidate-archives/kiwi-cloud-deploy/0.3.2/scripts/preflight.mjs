import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLatest } from './latest-resolver.mjs';
import { auditStagedPackage } from './audit-gate.mjs';
import { verifyPublishedArtifact } from './published-provenance.mjs';
import { runIsolatedInstall } from './install-diagnostics.mjs';

const exec = promisify(execFile);

// Offline/online inspection prototype. Intentionally does not execute the
// downloaded package, enable a connector, or touch any cloud application.
// Installation bytes, archive safety, WorkBuddy integration and runtime
// authorization remain separate, unfinished requirements.
export async function preflight({name, stagingParent, npmBinary, nodeBinary, pythonBinary}) {
  if (!isAbsolute(stagingParent) || !isAbsolute(npmBinary) || !isAbsolute(nodeBinary) || !pythonBinary || !isAbsolute(pythonBinary)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const {lock, bytes} = await resolveLatest(name);
  const directory = await mkdtemp(join(stagingParent, 'kiwi-preflight-'));
  await chmod(directory, 0o700);
  const environment = {
    HOME:directory, TMPDIR:directory, PATH:`${dirname(nodeBinary)}:/usr/bin:/bin`,
    NPM_CONFIG_USERCONFIG:'/dev/null', NPM_CONFIG_CACHE:join(directory,'npm-cache'),
    NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/', NPM_CONFIG_IGNORE_SCRIPTS:'true',
    NPM_CONFIG_AUDIT:'false', NPM_CONFIG_FUND:'false',
  };
  const project = {name:'kiwi-latest-private-preflight',version:'1.0.0',private:true,dependencies:{[name]:lock.version}};
  await writeFile(join(directory,'package.json'),JSON.stringify(project),{mode:0o600,flag:'wx'});
  const archive=join(directory,'verified-download.tgz');
  await writeFile(archive,bytes,{mode:0o600,flag:'wx'});
  const published=await verifyPublishedArtifact({lock,bytes,npmBinary,stagingDirectory:directory});
  // Check the top-level archive before letting npm parse/install it. No code
  // from the downloaded archive is executed in these inspection subprocesses.
  try {
    const script=fileURLToPath(new URL(name==='@harrylabsj/kiwi'?'./inspect_buyer_archive_cli.py':'./inspect_cloud_cli.py', import.meta.url));
    const r=await exec(pythonBinary,[script,archive,lock.version],{cwd:directory,env:environment,timeout:120_000,maxBuffer:1024*1024});
    const result=JSON.parse(r.stdout);
    if(result.version!==lock.version || (name==='@harrylabsj/kiwi' && result.name!==name) || (name==='@harrylabsj/kiwi-merchant-cloud' && result.sourceCommit!==published.sourceCommit)) throw new Error('ARCHIVE_IDENTITY_MISMATCH');
  } catch {throw new Error('ARCHIVE_INSPECTION_FAILED')}
  await runIsolatedInstall({directory,install:()=>exec(npmBinary,['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,env:environment,timeout:120_000,maxBuffer:4*1024*1024})});
  const verified = await auditStagedPackage({directory,npmBinary,lock,tarball:bytes,env:environment});
  if(verified.sourceCommit!==published.sourceCommit) throw new Error('SOURCE_COMMIT_MISMATCH');
  let treeInspection = null;
  if (name === '@harrylabsj/kiwi' && pythonBinary) {
    try {
      const script=fileURLToPath(new URL('./inspect_tree_cli.py', import.meta.url));
      const result=await exec(pythonBinary,[script,directory],{cwd:directory,env:environment,timeout:120_000,maxBuffer:1024*1024});
      treeInspection=JSON.parse(result.stdout);
      if (!Number.isInteger(treeInspection.packages) || treeInspection.packages < 1 || !Number.isInteger(treeInspection.files)) throw new Error('TREE_OUTPUT_INVALID');
    } catch { throw new Error('TREE_INSPECTION_FAILED'); }
  }
  if (name === '@harrylabsj/kiwi-merchant-cloud' && pythonBinary) {
    try {
      const script=fileURLToPath(new URL('./inspect_cloud_cli.py', import.meta.url));
      const installed=join(directory,'node_modules','@harrylabsj','kiwi-merchant-cloud');
      const result=await exec(pythonBinary,[script,archive,lock.version,installed],{cwd:directory,env:environment,timeout:120_000,maxBuffer:1024*1024});
      treeInspection=JSON.parse(result.stdout);
      if (treeInspection.version !== lock.version || treeInspection.sourceCommit !== verified.sourceCommit || !Number.isInteger(treeInspection.files) || treeInspection.files < 1 || treeInspection.installed?.files !== treeInspection.files) throw new Error('CLOUD_OUTPUT_INVALID');
    } catch { throw new Error('CLOUD_INSPECTION_FAILED'); }
  }
  return {directory,lock,sourceCommit:verified.sourceCommit,treeInspection,executionAuthorized:false};
}
