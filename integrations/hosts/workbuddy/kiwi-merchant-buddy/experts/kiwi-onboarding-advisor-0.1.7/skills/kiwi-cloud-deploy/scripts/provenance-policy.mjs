import {X509Certificate} from 'node:crypto';

// Evaluates claims from a *fresh, successfully verified* npm audit output.
// This function does not itself verify a signature. Never accept caller-provided
// or persisted output as runtime trust evidence without verifying it first.
const NAMES = new Set(['@harrylabsj/kiwi', '@harrylabsj/kiwi-merchant-cloud']);
const TYPE = 'https://slsa.dev/provenance/v1';

export function checkVerifiedAudit(report, name, version, sha512hex) {
  if (!NAMES.has(name) || !/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{128}$/.test(sha512hex)) throw new Error('INPUT_INVALID');
  if (!Array.isArray(report.verified) || !Array.isArray(report.invalid) || !Array.isArray(report.missing) || report.invalid.length || report.missing.length) throw new Error('AUDIT_NOT_CLEAN');
  const entries = report.verified.filter(e => e.name === name && e.version === version && e.location === `node_modules/${name}`);
  if (entries.length !== 1) throw new Error('TARGET_NOT_VERIFIED');
  const bundles = entries[0].attestationBundles?.filter(b => b.predicateType === TYPE) ?? [];
  if (bundles.length !== 1) throw new Error('PROVENANCE_MISSING');
  let cert;
  try {
    const encoded=bundles[0].bundle.verificationMaterial.certificate.rawBytes;
    if(typeof encoded !== 'string' || encoded.length > 65536) throw new Error('invalid certificate');
    cert=new X509Certificate(Buffer.from(encoded,'base64'));
  } catch { throw new Error('SIGNER_CERTIFICATE_INVALID'); }
  // npm's sigstore verification establishes the certificate chain/signature;
  // enforce the *actual certificate* identity independently of self-asserted
  // statement fields. Exact single SAN rejects alternate workflows/refs.
  const signer='URI:https://github.com/harrylabsj/kiwi/.github/workflows/portfolio-release.yml@refs/heads/main';
  if(cert.subjectAltName !== signer) throw new Error('SIGNER_IDENTITY_MISMATCH');
  let statement;
  try { statement = JSON.parse(Buffer.from(bundles[0].bundle.dsseEnvelope.payload, 'base64').toString('utf8')); }
  catch { throw new Error('PROVENANCE_INVALID'); }
  const subjectName = `pkg:npm/%40harrylabsj/${name.split('/')[1]}@${version}`;
  if (!Array.isArray(statement.subject) || !statement.subject.some(s => s.name === subjectName && s.digest?.sha512 === sha512hex)) throw new Error('SUBJECT_MISMATCH');
  const def = statement.predicate?.buildDefinition;
  const wf = def?.externalParameters?.workflow;
  const gh = def?.internalParameters?.github;
  if (wf?.repository !== 'https://github.com/harrylabsj/kiwi' || wf?.path !== '.github/workflows/portfolio-release.yml' || wf?.ref !== 'refs/heads/main' || gh?.repository_id !== '1322298114' || gh?.repository_owner_id !== '144880725') throw new Error('SOURCE_MISMATCH');
  const deps = def?.resolvedDependencies;
  const dep = Array.isArray(deps) && deps.find(d => d.uri === 'git+https://github.com/harrylabsj/kiwi@refs/heads/main');
  if (!/^[a-f0-9]{40}$/.test(dep?.digest?.gitCommit ?? '')) throw new Error('COMMIT_MISSING');
  return { name, version, sourceCommit: dep.digest.gitCommit };
}
