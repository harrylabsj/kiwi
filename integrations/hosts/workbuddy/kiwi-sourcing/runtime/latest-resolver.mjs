import { get } from 'node:https';
import { resolveMetadata, verifyBytes } from './artifact.mjs';

const packages = new Set(['@harrylabsj/kiwi', '@harrylabsj/kiwi-merchant-cloud']);
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_TARBALL = 128 * 1024 * 1024;
let processAbortSignal;
export function setResolverAbortSignal(signal){processAbortSignal=signal}
// In-process provenance token: never serialized and not a same-user security boundary.
const officialLatestLocks=new WeakMap(),officialResolutions=new WeakMap();
const MAX_RESOLUTION_AGE_NS=60n*1000000000n;
export function consumeOfficialLatestResolution(value){
 if(!value||typeof value!=='object')return false;const expiry=officialResolutions.get(value);officialResolutions.delete(value);
 return typeof expiry==='bigint'&&process.hrtime.bigint()<=expiry;
}

// This module downloads bytes only. It never installs, unpacks, or executes code.
// SRI provides integrity, not proof of trusted publisher or compatibility.
export function fetchOfficial(url, maxBytes, timeoutMs = 20_000) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.username || parsed.password || parsed.port) throw new Error('REGISTRY_URL_INVALID');
  const signal=processAbortSignal;
  return new Promise((resolve, reject) => {
    let done = false;
    let timer;
    let req;
    const abort=()=>{req?.destroy();finish(new Error('REGISTRY_CANCELLED'))};
    const finish = (err, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',abort); err ? reject(err) : resolve(value); };
    if(signal?.aborted){finish(new Error('REGISTRY_CANCELLED'));return}
    req = get(parsed, {headers:{accept:'application/json, application/octet-stream'}}, res => {
      if (res.statusCode !== 200) { res.resume(); finish(new Error('REGISTRY_HTTP_ERROR')); return; }
      const pieces = []; let count = 0;
      res.on('data', chunk => { count += chunk.length; if (count > maxBytes) { req.destroy(); finish(new Error('DOWNLOAD_TOO_LARGE')); } else pieces.push(chunk); });
      res.on('end', () => finish(null, Buffer.concat(pieces)));
      res.on('aborted', () => finish(new Error('DOWNLOAD_ABORTED')));
      res.on('error', err => finish(err));
    });
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    timer = setTimeout(() => { req.destroy(); finish(new Error('REGISTRY_TIMEOUT')); }, timeoutMs);
    req.on('error', err => finish(err));
  });
}

export async function resolveLatestMetadata(name, fetchBytes = fetchOfficial) {
  if (!packages.has(name)) throw new Error('PACKAGE_INVALID');
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  let metadata;
  try { metadata = JSON.parse((await fetchBytes(metadataUrl, MAX_METADATA)).toString('utf8')); }
  catch { throw new Error('LATEST_METADATA_UNAVAILABLE'); }
  const lock=resolveMetadata(name, metadata);
  if(fetchBytes===fetchOfficial)officialLatestLocks.set(lock,process.hrtime.bigint()+MAX_RESOLUTION_AGE_NS);
  return lock;
}

export async function downloadLockedArtifact(lock, fetchBytes=fetchOfficial) {
  const checked=resolveMetadata(lock?.name,{name:lock?.name,version:lock?.version,dist:{integrity:lock?.integrity,tarball:lock?.tarball}});
  const expiry=officialLatestLocks.get(lock);if(expiry!==undefined){officialLatestLocks.delete(lock);if(process.hrtime.bigint()>expiry)throw new Error('LATEST_RESOLUTION_EXPIRED')}
  const bytes = await fetchBytes(checked.tarball, MAX_TARBALL);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TARBALL) throw new Error('DOWNLOAD_TOO_LARGE');
  verifyBytes(checked, bytes);
  const result=Object.freeze({lock:checked,bytes});
  if(typeof expiry==='bigint'&&fetchBytes===fetchOfficial){if(process.hrtime.bigint()>expiry)throw new Error('LATEST_RESOLUTION_EXPIRED');officialResolutions.set(result,expiry)}
  return result;
}

export async function resolveLatest(name, fetchBytes = fetchOfficial) {
  const lock = await resolveLatestMetadata(name,fetchBytes);
  return downloadLockedArtifact(lock,fetchBytes);
}
