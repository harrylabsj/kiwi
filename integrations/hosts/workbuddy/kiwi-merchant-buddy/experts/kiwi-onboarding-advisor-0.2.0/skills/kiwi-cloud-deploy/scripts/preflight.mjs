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

// Single-attempt install budget. The merchant cloud runtime pulls roughly 240
// packages; on a slow link one tarball alone can take minutes, so a fixed ten
// minute budget turns a slow network into an apparent "dependency failure"
// (2026-11-27: npm was SIGTERMed at the budget and exited 1). The budget bounds
// only one attempt: an interrupted attempt is continued in the same session
// directory with `cloud-session-cli.mjs resume --session <dir>`, which keeps the
// locked tarball/source identity and reuses npm-cache.
const MIN_INSTALL_TIMEOUT_MS = 60_000;
const MAX_INSTALL_TIMEOUT_MS = 7_200_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 1_800_000;

export function installTimeoutMs(value = process.env.KIWI_CLOUD_INSTALL_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INSTALL_TIMEOUT_MS;
  return Math.min(MAX_INSTALL_TIMEOUT_MS, Math.max(MIN_INSTALL_TIMEOUT_MS, Math.trunc(parsed)));
}

// Prefer whatever the local cache already holds (resume is cheap) and raise
// npm's own network timers. The registry stays pinned to the public one: no
// mirror, version or source substitution.
export const NPM_INSTALL_ARGS = Object.freeze([
  'install',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--prefer-offline',
  '--fetch-retries=5',
  '--fetch-timeout=600000',
  '--fetch-retry-maxtimeout=120000',
  '--maxsockets=8',
]);

export function stagingEnvironment(directory, nodeBinary) {
  return {
    HOME: directory, TMPDIR: directory, PATH: `${dirname(nodeBinary)}:/usr/bin:/bin`,
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_CACHE: join(directory, 'npm-cache'),
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_PREFER_OFFLINE: 'true',
  };
}

// Installs the already-pinned package into an existing session directory.
// Reusing the directory (instead of recreating it) is the supported retry path:
// node_modules and npm-cache from the interrupted attempt survive and the
// locked tarball/source identity is never re-resolved.
export async function installStaged({ directory, npmBinary, nodeBinary, timeoutMs = installTimeoutMs() }) {
  if (!isAbsolute(directory) || !isAbsolute(npmBinary) || !isAbsolute(nodeBinary)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const environment = stagingEnvironment(directory, nodeBinary);
  await runIsolatedInstall({
    directory,
    timeoutMs,
    install: () => exec(npmBinary, [...NPM_INSTALL_ARGS], { cwd: directory, env: environment, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }),
  });
}

// Offline/online inspection prototype. Intentionally does not execute the
// downloaded package, enable a connector, or touch any cloud application.
// `authorized` is forwarded as executionAuthorized once the checks pass; installation
// bytes, WorkBuddy integration and the real deployment remain separate steps.
export async function preflight({name, stagingParent, npmBinary, nodeBinary, pythonBinary, authorized = false}) {
  if (!isAbsolute(stagingParent) || !isAbsolute(npmBinary) || !isAbsolute(nodeBinary) || !pythonBinary || !isAbsolute(pythonBinary)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const {lock, bytes} = await resolveLatest(name);
  const directory = await mkdtemp(join(stagingParent, 'kiwi-preflight-'));
  await chmod(directory, 0o700);
  const environment = stagingEnvironment(directory, nodeBinary);
  const project = {name:'kiwi-latest-private-preflight',version:'1.0.0',private:true,dependencies:{[name]:lock.version}};
  await writeFile(join(directory,'package.json'),JSON.stringify(project),{mode:0o600,flag:'wx'});
  const archive=join(directory,'verified-download.tgz');
  await writeFile(archive,bytes,{mode:0o600,flag:'wx'});
  const published=await verifyPublishedArtifact({lock,bytes,npmBinary,stagingDirectory:directory});
  // Check the top-level archive before letting npm parse/install it. No code
  // from the downloaded archive is executed in these inspection subprocesses.
  try {
    const script=fileURLToPath(new URL(name==='@harrylabsj/kiwi'?'./inspect_buyer_archive_cli.py':'./inspect_cloud_cli.py', import.meta.url));
    const r=await exec(pythonBinary,[script,archive,lock.version],{cwd:directory,env:environment,timeout:600_000,maxBuffer:1024*1024});
    const result=JSON.parse(r.stdout);
    if(result.version!==lock.version || (name==='@harrylabsj/kiwi' && result.name!==name) || (name==='@harrylabsj/kiwi-merchant-cloud' && result.sourceCommit!==published.sourceCommit)) throw new Error('ARCHIVE_IDENTITY_MISMATCH');
  } catch {throw new Error('ARCHIVE_INSPECTION_FAILED')}
  await installStaged({directory,npmBinary,nodeBinary});
  const verified = await auditStagedPackage({directory,npmBinary,lock,tarball:bytes,env:environment});
  if(verified.sourceCommit!==published.sourceCommit) throw new Error('SOURCE_COMMIT_MISMATCH');
  let treeInspection = null;
  if (name === '@harrylabsj/kiwi' && pythonBinary) {
    try {
      const script=fileURLToPath(new URL('./inspect_tree_cli.py',import.meta.url));
      const result=await exec(pythonBinary,[script,directory],{cwd:directory,env:environment,timeout:600_000,maxBuffer:1024*1024});
      treeInspection=JSON.parse(result.stdout);
      if (!Number.isInteger(treeInspection.packages) || treeInspection.packages < 1 || !Number.isInteger(treeInspection.files)) throw new Error('TREE_OUTPUT_INVALID');
    } catch { throw new Error('TREE_INSPECTION_FAILED'); }
  }
  if (name === '@harrylabsj/kiwi-merchant-cloud' && pythonBinary) {
    try {
      const script=fileURLToPath(new URL('./inspect_cloud_cli.py',import.meta.url));
      const installed=join(directory,'node_modules','@harrylabsj','kiwi-merchant-cloud');
      const result=await exec(pythonBinary,[script,archive,lock.version,installed],{cwd:directory,env:environment,timeout:600_000,maxBuffer:1024*1024});
      treeInspection=JSON.parse(result.stdout);
      if (treeInspection.version !== lock.version || treeInspection.sourceCommit !== verified.sourceCommit || !Number.isInteger(treeInspection.files) || treeInspection.files < 1 || treeInspection.installed?.files !== treeInspection.files) throw new Error('CLOUD_OUTPUT_INVALID');
    } catch { throw new Error('CLOUD_INSPECTION_FAILED'); }
  }
  return {directory,lock,sourceCommit:verified.sourceCommit,treeInspection,executionAuthorized:authorized === true};
}
