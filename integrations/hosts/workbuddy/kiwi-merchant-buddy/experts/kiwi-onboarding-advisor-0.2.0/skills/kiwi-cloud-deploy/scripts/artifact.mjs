import { createHash, timingSafeEqual } from 'node:crypto';

// This is a byte-integrity primitive, not a provenance or compatibility gate.
const allowed = new Set(['@harrylabsj/kiwi', '@harrylabsj/kiwi-merchant-cloud']);
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function resolveMetadata(name, metadata) {
  if (!allowed.has(name) || !metadata || metadata.name !== name || !stable.test(metadata.version ?? '')) throw new Error('METADATA_INVALID');
  const integrity = metadata.dist?.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('INTEGRITY_INVALID');
  let url;
  try { url = new URL(metadata.dist?.tarball); } catch { throw new Error('REGISTRY_URL_INVALID'); }
  const baseName = name.split('/')[1];
  const expectedPath = `/@harrylabsj/${baseName}/-/${baseName}-${metadata.version}.tgz`;
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) throw new Error('REGISTRY_URL_INVALID');
  return Object.freeze({ name, version: metadata.version, integrity, tarball: url.href });
}

export function verifyBytes(lock, bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('BUFFER_REQUIRED');
  const expected = Buffer.from(lock.integrity.slice(7), 'base64');
  const actual = createHash('sha512').update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('INTEGRITY_MISMATCH');
  return true;
}
