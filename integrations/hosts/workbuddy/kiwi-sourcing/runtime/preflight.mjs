import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLatest } from './latest-resolver.mjs';
import { auditStagedPackage, readStagedPackageLock } from './audit-gate.mjs';
import {resolveMetadata,verifyBytes} from './artifact.mjs';
import { verifyPublishedArtifact } from './published-provenance.mjs';
import {remainingPrepareBudgetMs,runPrepareCommand} from './prepare-budget.mjs';

const exec = promisify(execFile);

// Keep verification evidence in each session so later downloads or cache
// eviction cannot invalidate a previously prepared runtime. Copies run with
// bounded concurrency and observe the outer prepare deadline; the loop is
// otherwise serial over ~240 lock entries and can outlive the budget.
export async function snapshotInstallTarballs(directory, installCacheDirectory, options = {}) {
  const { packages } = await readStagedPackageLock(directory);
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) throw new Error('PACKAGE_LOCK_INVALID');
  const integrities = new Set();
  for (const [location, entry] of Object.entries(packages)) {
    if (location !== '') integrities.add(entry?.integrity);
  }
  const entries = [];
  for (const integrity of integrities) {
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('PACKAGE_LOCK_INVALID');
    const hash = Buffer.from(integrity.slice(7), 'base64').toString('hex');
    entries.push(join('_cacache', 'content-v2', 'sha512', hash.slice(0, 2), hash.slice(2, 4), hash.slice(4)));
  }
  const signal = options.signal;
  const deadlineEpochMs = options.deadlineEpochMs ?? (Number(process.env.KIWI_PREPARE_DEADLINE_EPOCH_MS) || undefined);
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8));
  let index = 0;
  async function worker() {
    for (;;) {
      if (signal?.aborted) throw new Error('PREPARE_CANCELLED');
      if (deadlineEpochMs !== undefined && Date.now() >= deadlineEpochMs) throw new Error('PREPARE_TIMEOUT');
      const path = entries[index++];
      if (path === undefined) return;
      const source = join(installCacheDirectory, path);
      const destination = join(directory, 'npm-cache', path);
      let stat;
      try { stat = await lstat(source); } catch (error) {
        if (error.code === 'ENOENT') throw new Error('CACHE_TARBALL_INVALID', { cause: error });
        throw error;
      }
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) || await realpath(source) !== source) {
        throw new Error('CACHE_TARBALL_INVALID');
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
}

// Offline/online inspection prototype. Intentionally does not execute the
// downloaded package, enable a connector, or touch any cloud application.
// Installation bytes, archive safety, WorkBuddy integration and runtime
// authorization remain separate, unfinished requirements.
export async function preflight({name, stagingParent, npmBinary, nodeBinary, pythonBinary, resolvedLatest, installCacheDirectory, signal}) {
  if (!isAbsolute(stagingParent) || !isAbsolute(npmBinary) || !isAbsolute(nodeBinary) || !pythonBinary || !isAbsolute(pythonBinary)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const resolved=resolvedLatest??await resolveLatest(name);
  const lock=resolveMetadata(name,{name:resolved.lock?.name,version:resolved.lock?.version,dist:{integrity:resolved.lock?.integrity,tarball:resolved.lock?.tarball}});
  const bytes=resolved.bytes;verifyBytes(lock,bytes);
  const directory = await mkdtemp(join(stagingParent, 'kiwi-preflight-'));
  await chmod(directory, 0o700);
  const environment = {
    HOME:directory, TMPDIR:directory, PATH:`${dirname(nodeBinary)}:/usr/bin:/bin`,
    NPM_CONFIG_USERCONFIG:'/dev/null', NPM_CONFIG_CACHE:join(directory,'npm-cache'),
    NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/', NPM_CONFIG_IGNORE_SCRIPTS:'true',
    NPM_CONFIG_AUDIT:'false', NPM_CONFIG_FUND:'false', PYTHONDONTWRITEBYTECODE:'1',
    KIWI_PREPARE_DEADLINE_EPOCH_MS:process.env.KIWI_PREPARE_DEADLINE_EPOCH_MS??String(Date.now()+600_000),
  };
  const npmEnvironment = installCacheDirectory
    ? { ...environment, NPM_CONFIG_CACHE: installCacheDirectory }
    : environment;
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
  } catch(error) {throw new Error('ARCHIVE_INSPECTION_FAILED',{cause:error})}
  try {
    await runPrepareCommand(npmBinary,['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,env:npmEnvironment,timeoutMs:remainingPrepareBudgetMs(environment),maxBuffer:4*1024*1024});
  } catch(error) { if(error?.message==='PREPARE_TIMEOUT'||error?.message==='PREPARE_CANCELLED'||error?.message==='PREPARE_TERMINATION_UNCONFIRMED')throw error;throw new Error('ISOLATED_INSTALL_FAILED',{cause:error}); }
  // Cache/evidence copying is not an npm install: keep its own codes so the
  // host reports "cache needs review" instead of "dependencies could not be
  // installed", which the expert treats as a terminal install failure.
  if (installCacheDirectory) await snapshotInstallTarballs(directory, installCacheDirectory, {signal, deadlineEpochMs: Number(environment.KIWI_PREPARE_DEADLINE_EPOCH_MS)});
  const verified = await auditStagedPackage({directory,npmBinary,lock,tarball:bytes,env:npmEnvironment});
  if(verified.sourceCommit!==published.sourceCommit) throw new Error('SOURCE_COMMIT_MISMATCH');
  let treeInspection = null;
  if (name === '@harrylabsj/kiwi' && pythonBinary) {
    try {
      const script=fileURLToPath(new URL('./inspect_tree_cli.py', import.meta.url));
      const result=await exec(pythonBinary,[script,directory],{cwd:directory,env:environment,timeout:120_000,maxBuffer:1024*1024});
      treeInspection=JSON.parse(result.stdout);
      if (!Number.isInteger(treeInspection.packages) || treeInspection.packages < 1 || !Number.isInteger(treeInspection.files) || treeInspection.files < 1 || !/^[a-f0-9]{64}$/.test(treeInspection.lock_sha256??'') || !/^[a-f0-9]{64}$/.test(treeInspection.content_tree_sha256??'')) throw new Error('TREE_OUTPUT_INVALID');
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
