import {createHash} from 'node:crypto';
import {fetchOfficial} from './latest-resolver.mjs';
import {resolveMetadata,verifyBytes} from './artifact.mjs';
import {checkVerifiedAudit} from './provenance-policy.mjs';
import {verifyTrustedBundle} from './sigstore-gate.mjs';

// Verify the top-level public npm artifact before invoking npm install.
// The temporary report adapts raw registry attestations to the statement
// policy parser; it is NOT an npm dependency audit and becomes trustworthy
// only after verifyTrustedBundle cryptographically verifies the same bundle.
export async function verifyPublishedArtifact({lock,bytes,npmBinary,stagingDirectory}) {
  lock=resolveMetadata(lock?.name,{name:lock?.name,version:lock?.version,dist:{integrity:lock?.integrity,tarball:lock?.tarball}});
  verifyBytes(lock,bytes);
  const url=`https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(lock.name)}@${lock.version}`;
  let payload;
  try {payload=JSON.parse((await fetchOfficial(url,2*1024*1024)).toString('utf8'))}
  catch {throw new Error('ATTESTATION_FETCH_FAILED')}
  if(!Array.isArray(payload.attestations)) throw new Error('ATTESTATION_INVALID');
  const report={invalid:[],missing:[],verified:[{name:lock.name,version:lock.version,location:`node_modules/${lock.name}`,attestationBundles:payload.attestations}]};
  const claims=checkVerifiedAudit(report,lock.name,lock.version,createHash('sha512').update(bytes).digest('hex'));
  await verifyTrustedBundle({report,name:lock.name,version:lock.version,sourceCommit:claims.sourceCommit,npmBinary,stagingDirectory});
  return claims;
}
