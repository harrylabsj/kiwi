import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,linkSync,rmdirSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {withBuyerCacheStore} from '../runtime/buyer-cache-store-draft.mjs';
import {createTransaction} from '../runtime/transaction.mjs';
import {verifyPreparedTreeBinding} from '../runtime/tree-binding.mjs';

const runtime=dirname(fileURLToPath(import.meta.url));
const connector=dirname(runtime);
const python=realpathSync('/opt/homebrew/bin/python3');
const treeCli=join(connector,'runtime','inspect_tree_cli.py');
const name='@harrylabsj/kiwi',version='0.12.14';
function createInstallTree(session){
  const script=`import base64,hashlib,json,sys,tarfile,os\nfrom io import BytesIO\nfrom pathlib import Path\nr=Path(sys.argv[1]);v=sys.argv[2]\npkg=json.dumps({'name':'@harrylabsj/kiwi','version':v,'bin':{}},separators=(',',':')).encode();body=b'export const syntheticFixture = true;\\n';archive=r/'verified-download.tgz'\nwith tarfile.open(archive,'w:gz') as t:\n for n,data in [('package/package.json',pkg),('package/index.js',body)]:\n  info=tarfile.TarInfo(n);info.size=len(data);info.mode=0o644;t.addfile(info,BytesIO(data))\nos.chmod(archive,0o600);raw=archive.read_bytes();digest=hashlib.sha512(raw).digest();integrity='sha512-'+base64.b64encode(digest).decode();target=r/'node_modules'/'@harrylabsj'/'kiwi';target.mkdir(parents=True);(target/'package.json').write_bytes(pkg);(target/'index.js').write_bytes(body)\nproject={'name':'kiwi-preflight-test','version':'1.0.0','private':True,'dependencies':{'@harrylabsj/kiwi':v}};(r/'package.json').write_text(json.dumps(project,separators=(',',':')))\ntarball=f'https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-{v}.tgz';lock={'name':'kiwi-preflight-test','version':'1.0.0','lockfileVersion':3,'packages':{'':{'name':'kiwi-preflight-test','version':'1.0.0'},'node_modules/@harrylabsj/kiwi':{'version':v,'integrity':integrity,'resolved':tarball}}};(r/'package-lock.json').write_text(json.dumps(lock,separators=(',',':')))\nh=digest.hex();cache=r/'npm-cache'/'_cacache'/'content-v2'/'sha512'/h[:2]/h[2:4]/h[4:];cache.parent.mkdir(parents=True);cache.write_bytes(raw)\n`;
  execFileSync(python,['-c',script,session,version],{env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
  const bytes=readFileSync(join(session,'verified-download.tgz'));
  return {bytes,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),tarball:`https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-${version}.tgz`};
}
function inspect(session){return JSON.parse(execFileSync(python,[treeCli,session],{env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',stdio:['ignore','pipe','ignore']}))}

test('Python tree inspection does not write bytecode into the pinned source tree',{timeout:10000},()=>{
  const source=readFileSync(join(connector,'runtime','candidate-check.mjs'),'utf8');
  assert.match(source,/NODE_ENV:'test',PYTHONDONTWRITEBYTECODE:'1'/);
  const base=mkdtempSync('/private/tmp/kiwi-format3-bytecode-'),session=join(base,'session');mkdirSync(session,{mode:0o700});
  try{
    createInstallTree(session);
    const result=execFileSync(python,[treeCli,session],{cwd:connector,env:{HOME:base,TMPDIR:base,PATH:'/usr/bin:/bin',NODE_ENV:'test',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',stdio:['ignore','pipe','ignore']});
    assert.equal(JSON.parse(result).packages,1);
    assert.equal(existsSync(join(connector,'runtime','__pycache__')),false);
  }finally{rmSync(base,{recursive:true,force:true})}
});

test('synthetic install emits a content tree digest, format3 binds it, and spawn gate rechecks it',{timeout:15000},async()=>{
  const base=mkdtempSync('/private/tmp/kiwi-format3-contract-'),store=join(base,'store'),session=join(store,'kiwi-preflight-ABC123');mkdirSync(store,{mode:0o700});mkdirSync(session,{mode:0o700});
  try{
    const artifact=createInstallTree(session),before=inspect(session);
    assert.equal(before.packages,1);assert.equal(before.files,2);assert.match(before.content_tree_sha256,/^[a-f0-9]{64}$/);
    const transaction=join(session,'transaction.json');createTransaction(transaction,name,{name,version,dist:{integrity:artifact.integrity,tarball:artifact.tarball}},artifact.bytes);
    const afterTransaction=inspect(session);assert.equal(afterTransaction.content_tree_sha256,before.content_tree_sha256,'transaction metadata is deliberately outside the content digest');
    const expected={version,integrity:artifact.integrity,treeLockSha256:before.lock_sha256,contentTreeSha256:before.content_tree_sha256};
    await withBuyerCacheStore(store,async state=>{
      assert.throws(()=>state.recordPrepared(session,'0.12.9',{...expected,contentTreeSha256:undefined}),/CACHE_RESULT_MISMATCH/);
      state.recordPrepared(session,'0.12.9',expected);
    });
    const selected=await withBuyerCacheStore(store,state=>state.prepared());
    const pointerPath=join(store,'prepared.json'),pointer=JSON.parse(readFileSync(pointerPath,'utf8'));
    assert.equal(pointer.format,3);assert.equal(pointer.contentTreeSha256,before.content_tree_sha256);
    const format2={...pointer,format:2};delete format2.contentTreeSha256;const legacy=JSON.stringify(format2);writeFileSync(pointerPath,legacy,{mode:0o600});
    await assert.rejects(()=>withBuyerCacheStore(store,state=>state.prepared()),/CACHE_POINTER_INVALID/);assert.equal(readFileSync(pointerPath,'utf8'),legacy);
    writeFileSync(pointerPath,JSON.stringify(pointer),{mode:0o600});
    const result={name,version,integrity:artifact.integrity,sessionDirectory:session,tree:before};
    await verifyPreparedTreeBinding(selected,result,{nodeBinary:process.execPath,pythonBinary:python});
    writeFileSync(join(session,'node_modules','@harrylabsj','kiwi','index.js'),'export const syntheticFixture = fake;\n',{mode:0o644});
    await assert.rejects(()=>verifyPreparedTreeBinding(selected,result,{nodeBinary:process.execPath,pythonBinary:python}),/TREE_RECHECK_FAILED/);
  }finally{rmSync(base,{recursive:true,force:true})}
});

test('root allowlist rejects an unknown top-level file before digest acceptance',{timeout:10000},()=>{
  const base=mkdtempSync('/private/tmp/kiwi-format3-root-contract-'),session=join(base,'session');mkdirSync(session,{mode:0o700});
  try{
    createInstallTree(session);writeFileSync(join(session,'.npmrc'),'synthetic-only',{mode:0o600,flag:'wx'});
    const result=spawnSync(python,[treeCli,session],{env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);assert.match(result.stderr,/TREE_INSPECTION_HOLD: ROOT_ENTRY_UNEXPECTED/);
  }finally{rmSync(base,{recursive:true,force:true})}
});

test('package, empty-directory and mode changes alter the content digest; hard links are rejected',{timeout:15000},()=>{
  const base=mkdtempSync('/private/tmp/kiwi-format3-digest-negative-'),session=join(base,'session');mkdirSync(session,{mode:0o700});
  try{
    createInstallTree(session);const first=inspect(session).content_tree_sha256;
    mkdirSync(join(session,'node_modules','@harrylabsj','kiwi','empty'));assert.notEqual(inspect(session).content_tree_sha256,first);
    rmdirSync(join(session,'node_modules','@harrylabsj','kiwi','empty'));chmodSync(join(session,'node_modules'),0o700);assert.notEqual(inspect(session).content_tree_sha256,first);chmodSync(join(session,'node_modules'),0o755);
    linkSync(join(session,'node_modules','@harrylabsj','kiwi','index.js'),join(base,'file-alias'));
    const hardlink=spawnSync(python,[treeCli,session],{env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:10000});
    assert.equal(hardlink.status,1);assert.match(hardlink.stderr,/TREE_INSPECTION_HOLD: INSTALLED_HARDLINK/);
  }finally{rmSync(base,{recursive:true,force:true})}
});
