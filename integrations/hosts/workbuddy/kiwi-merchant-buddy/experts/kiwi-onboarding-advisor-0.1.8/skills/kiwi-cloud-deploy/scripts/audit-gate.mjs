import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { checkVerifiedAudit } from './provenance-policy.mjs';
import { verifyBytes } from './artifact.mjs';
import { verifyTrustedBundle } from './sigstore-gate.mjs';

const exec = promisify(execFile);

// Preflight only: caller must create a private staging directory, install with
// scripts disabled, and separately secure installed execution bytes and archive
// paths. This does not make npm install or executing the package safe.
export async function auditStagedPackage({directory, npmBinary, lock, tarball, env}) {
  verifyBytes(lock, tarball);
  let file,packageLock;
  try {
    file=await open(`${directory}/package-lock.json`,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=await file.stat();
    if(!st.isFile() || st.size>16*1024*1024 || (st.mode&0o022) || (typeof process.getuid==='function' && st.uid!==process.getuid()))throw new Error();
    packageLock=JSON.parse(await file.readFile('utf8'));
  } catch {throw new Error('PACKAGE_LOCK_INVALID')}
  finally {await file?.close()}
  const entry = packageLock.packages?.[`node_modules/${lock.name}`];
  if (!entry || entry.version !== lock.version || entry.integrity !== lock.integrity || entry.resolved !== lock.tarball) throw new Error('INSTALLED_LOCK_MISMATCH');
  let stdout;
  try {
    ({stdout} = await exec(npmBinary, ['audit','signatures','--json','--include-attestations'], {
      cwd: directory, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    }));
  } catch { throw new Error('AUDIT_FAILED'); }
  let report;
  try { report = JSON.parse(stdout); } catch { throw new Error('AUDIT_OUTPUT_INVALID'); }
  const result=checkVerifiedAudit(report, lock.name, lock.version, createHash('sha512').update(tarball).digest('hex'));
  await verifyTrustedBundle({report,name:lock.name,version:lock.version,sourceCommit:result.sourceCommit,npmBinary,stagingDirectory:directory});
  return result;
}
