import {realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute,join} from 'node:path';

function derUtf8(value) {
  const raw=Buffer.from(value,'utf8');
  if(raw.length>127) throw new Error('CERTIFICATE_POLICY_INVALID');
  return Buffer.concat([Buffer.from([0x0c,raw.length]),raw]);
}

// Cryptographic verification with the same npm installation that ran audit.
// npm-internal sigstore availability is not a supported WorkBuddy contract:
// missing/incompatible versions fail closed. Call only in a private staging
// directory after checkVerifiedAudit has bound the statement to package bytes.
export async function verifyTrustedBundle({report,name,version,sourceCommit,npmBinary,stagingDirectory}) {
  if(!isAbsolute(npmBinary) || !isAbsolute(stagingDirectory) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('CERTIFICATE_POLICY_INVALID');
  const matches=report.verified.filter(e=>e.name===name && e.version===version && e.location===`node_modules/${name}`);
  const bundles=matches[0]?.attestationBundles?.filter(x=>x.predicateType==='https://slsa.dev/provenance/v1') ?? [];
  if(matches.length!==1 || bundles.length!==1) throw new Error('PROVENANCE_MISSING');
  let sigstore;
  try { sigstore=createRequire(realpathSync(npmBinary))('sigstore'); }
  catch { throw new Error('SIGNATURE_VERIFIER_UNAVAILABLE'); }
  if(typeof sigstore.verify!=='function') throw new Error('SIGNATURE_VERIFIER_UNAVAILABLE');
  try {
    await sigstore.verify(bundles[0].bundle,{
      certificateIdentityURI:'^https://github\\.com/harrylabsj/kiwi/\\.github/workflows/portfolio-release\\.yml@refs/heads/main$',
      certificateIssuer:'https://token.actions.githubusercontent.com',
      certificateOIDs:{
        '1.3.6.1.4.1.57264.1.13':derUtf8(sourceCommit),
        '1.3.6.1.4.1.57264.1.15':derUtf8('1322298114'),
        '1.3.6.1.4.1.57264.1.17':derUtf8('144880725'),
      },
      tufCachePath:join(stagingDirectory,'sigstore-tuf'),
    });
  } catch { throw new Error('SIGNER_POLICY_VERIFICATION_FAILED'); }
  return true;
}
