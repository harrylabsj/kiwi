import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveMetadata, verifyBytes } from './artifact.mjs';

// Local version lock only: provenance, archive safety, permissions and business
// authorization are independent mandatory gates. Never use this alone to deploy.
function version(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('VERSION_INVALID');
  return value.split('.').map(BigInt);
}

export function ensureNoDowngrade(current, previous) {
  const a = version(current); const b = version(previous);
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) throw new Error('VERSION_DOWNGRADE');
    if (a[i] > b[i]) return;
  }
}

export function createTransaction(path, name, metadata, bytes, previousVersion) {
  const lock = resolveMetadata(name, metadata);
  if (previousVersion) ensureNoDowngrade(lock.version, previousVersion);
  verifyBytes(lock, bytes);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify({format:1, ...lock})}\n`, 'utf8'); }
  finally { closeSync(fd); }
  return lock;
}

export function resumeTransaction(path, bytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 4096) throw new Error('LOCK_INVALID');
    raw = readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
  const record = JSON.parse(raw);
  if (record.format !== 1 || Object.keys(record).sort().join(',') !== 'format,integrity,name,tarball,version') throw new Error('LOCK_INVALID');
  const lock = resolveMetadata(record.name, {name:record.name, version:record.version, dist:{integrity:record.integrity, tarball:record.tarball}});
  verifyBytes(lock, bytes);
  return lock;
}
