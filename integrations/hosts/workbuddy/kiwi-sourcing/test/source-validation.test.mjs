import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {resolveMetadata,verifyBytes} from '../runtime/artifact.mjs';
import {checkVerifiedAudit} from '../runtime/provenance-policy.mjs';

const testRoot=dirname(fileURLToPath(import.meta.url));
const packageRoot=dirname(testRoot);
const name='@harrylabsj/kiwi',version='0.12.12';
const bytes=readFileSync(join(testRoot,'fixtures/provenance/harrylabsj-kiwi-0.12.12.tgz'));
const digest=createHash('sha512').update(bytes).digest('hex');
const sri='sha512-'+Buffer.from(digest,'hex').toString('base64');
const metadata={name,version,dist:{integrity:sri,tarball:`https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-${version}.tgz`}};
const lock=resolveMetadata(name,metadata);
const audit=JSON.parse(readFileSync(join(testRoot,'fixtures/provenance/audit-signatures-locked.json'),'utf8'));

test('offline published artifact SRI binds the exact fixture bytes and metadata',()=>{
  assert.equal(verifyBytes(lock,bytes),true);
  assert.throws(()=>verifyBytes(lock,Buffer.concat([bytes,Buffer.from('tamper')])),/INTEGRITY_MISMATCH/);
  assert.throws(()=>resolveMetadata(name,{...metadata,version:'latest'}),/METADATA_INVALID/);
  assert.throws(()=>resolveMetadata(name,{...metadata,dist:{...metadata.dist,tarball:'https://evil.invalid/package.tgz'}}),/REGISTRY_URL_INVALID/);
});

test('locked provenance policy binds the fixture artifact and rejects source or signer drift',()=>{
  const policy=checkVerifiedAudit(audit,name,version,digest);
  assert.equal(policy.name,name);assert.equal(policy.version,version);assert.equal(policy.sourceCommit,'f8fe73e2c61b03c0b5e3f2dd0a163763b6e927c6');
  assert.throws(()=>checkVerifiedAudit(audit,name,version,'0'.repeat(128)),/SUBJECT_MISMATCH/);
  const rogue=structuredClone(audit),entry=rogue.verified.find(x=>x.name===name&&x.location===`node_modules/${name}`);
  const bundle=entry.attestationBundles.find(x=>x.predicateType==='https://slsa.dev/provenance/v1');
  const statement=JSON.parse(Buffer.from(bundle.bundle.dsseEnvelope.payload,'base64').toString('utf8'));
  statement.predicate.buildDefinition.externalParameters.workflow.repository='https://github.com/untrusted/example';
  bundle.bundle.dsseEnvelope.payload=Buffer.from(JSON.stringify(statement)).toString('base64');
  assert.throws(()=>checkVerifiedAudit(rogue,name,version,digest),/SOURCE_MISMATCH/);
  const wrongSigner=structuredClone(audit),target=wrongSigner.verified.find(x=>x.name===name&&x.location===`node_modules/${name}`),targetBundle=target.attestationBundles.find(x=>x.predicateType==='https://slsa.dev/provenance/v1'),other=wrongSigner.verified.find(x=>x.name==='zod'&&x.version==='4.6.7');
  targetBundle.bundle.verificationMaterial.certificate=other.attestationBundles.find(x=>x.predicateType==='https://slsa.dev/provenance/v1').bundle.verificationMaterial.certificate;
  assert.throws(()=>checkVerifiedAudit(wrongSigner,name,version,digest),/SIGNER_IDENTITY_MISMATCH/);
});

test('production entry is wired to the full preflight/prepare path and has no test-only bypass',()=>{
  const entry=readFileSync(join(packageRoot,'runtime/production-launcher.mjs'),'utf8');
  const cli=readFileSync(join(packageRoot,'runtime/buyer-session-cli.mjs'),'utf8');
  const published=readFileSync(join(packageRoot,'runtime/published-provenance.mjs'),'utf8');
  const auditGate=readFileSync(join(packageRoot,'runtime/audit-gate.mjs'),'utf8');
  assert.match(entry,/runPreparation/);assert.match(entry,/prepare-managed/);assert.match(cli,/prepareManagedBuyer/);
  assert.match(published,/verifyTrustedBundle/);assert.match(auditGate,/verifyTrustedBundle/);
  assert.doesNotMatch(entry,/testOnly|experimental-local-only|KIWI_LAUNCHER_EXPERIMENTAL/);
});

test('production entry fails before preparation when the host data root is absent',()=>{
  const entry=join(packageRoot,'runtime/production-launcher.mjs');
  const result=spawnSync(process.execPath,[entry],{env:{HOME:'/private/tmp',PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'KIWI_STATUS:FAILED_STARTUP\nKIWI_LAUNCHER_HOLD:PLUGIN_DATA_UNAVAILABLE\n');
});
