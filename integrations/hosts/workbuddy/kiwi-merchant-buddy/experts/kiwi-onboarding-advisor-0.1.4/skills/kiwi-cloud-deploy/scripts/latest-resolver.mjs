import { get } from 'node:https';
import { resolveMetadata, verifyBytes } from './artifact.mjs';

const packages = new Set(['@harrylabsj/kiwi', '@harrylabsj/kiwi-merchant-cloud']);
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_TARBALL = 128 * 1024 * 1024;
export const METADATA_TIMEOUT_MS = 20_000;
export const TARBALL_TIMEOUT_MS = 120_000;

// This module downloads bytes only. It never installs, unpacks, or executes code.
// SRI provides integrity, not proof of trusted publisher or compatibility.
export function fetchOfficial(url, maxBytes, timeoutMs = METADATA_TIMEOUT_MS, httpsGet = get) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.username || parsed.password || parsed.port) throw new Error('REGISTRY_URL_INVALID');
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const req = httpsGet(parsed, {headers:{accept:'application/json, application/octet-stream'}}, res => {
      if (res.statusCode !== 200) { res.resume(); finish(new Error('REGISTRY_HTTP_ERROR')); return; }
      const pieces = []; let count = 0;
      res.on('data', chunk => { count += chunk.length; if (count > maxBytes) { req.destroy(); finish(new Error('DOWNLOAD_TOO_LARGE')); } else pieces.push(chunk); });
      res.on('end', () => finish(null, Buffer.concat(pieces)));
      res.on('aborted', () => finish(new Error('DOWNLOAD_ABORTED')));
      res.on('error', err => finish(err));
    });
    timer = setTimeout(() => { req.destroy(); finish(new Error('REGISTRY_TIMEOUT')); }, timeoutMs);
    req.on('error', err => finish(err));
  });
}

export async function resolveLatest(name, fetchBytes = fetchOfficial) {
  if (!packages.has(name)) throw new Error('PACKAGE_INVALID');
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  let metadata;
  try { metadata = JSON.parse((await fetchBytes(metadataUrl, MAX_METADATA, METADATA_TIMEOUT_MS)).toString('utf8')); }
  catch { throw new Error('LATEST_METADATA_UNAVAILABLE'); }
  const lock = resolveMetadata(name, metadata);
  const bytes = await fetchBytes(lock.tarball, MAX_TARBALL, TARBALL_TIMEOUT_MS);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TARBALL) throw new Error('DOWNLOAD_TOO_LARGE');
  verifyBytes(lock, bytes);
  return {lock, bytes};
}
