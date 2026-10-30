import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createTransaction} from '../runtime/transaction.mjs';
import {withBuyerCacheStore} from '../runtime/buyer-cache-store-draft.mjs';
import {startBackendWithPreparedLock} from '../runtime/locked-backend-session.mjs';

function prepareStore(base){
  const store=join(base,'store');mkdirSync(store,{mode:0o700});
  const name='@harrylabsj/kiwi',version='0.12.14',session=join(store,'kiwi-preflight-abcdef'),archive=Buffer.from('fixture-artifact');mkdirSync(session,{mode:0o700});
  writeFileSync(join(session,'verified-download.tgz'),archive,{mode:0o600});
  const integrity='sha512-'+createHash('sha512').update(archive).digest('base64'),tarball=`https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-${version}.tgz`;
  createTransaction(join(session,'transaction.json'),name,{name,version,dist:{integrity,tarball}},archive);
  const packageLock=Buffer.from('fixture-package-lock');writeFileSync(join(session,'package-lock.json'),packageLock,{mode:0o600});
  const treeDigest='b'.repeat(64);const record={version,integrity,treeLockSha256:createHash('sha256').update(packageLock).digest('hex'),contentTreeSha256:treeDigest};
  return {store,session,record,prepared:{name,version,integrity,sessionDirectory:session,tree:{content_tree_sha256:treeDigest}}};
}

test('prepared pointer and tree are checked under a lock held until backend exit',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-production-lock-'),state=prepareStore(root);let resolveDone,verified=false,stopped=false;
  try{
    await withBuyerCacheStore(state.store,cache=>cache.recordPrepared(state.session,'0.12.9',state.record));
    const done=new Promise(resolve=>{resolveDone=resolve});
    const active=await startBackendWithPreparedLock({storeDirectory:state.store,prepared:state.prepared,verificationOptions:{},verifyTree:async(selected,result)=>{verified=selected.contentTreeSha256===result.tree.content_tree_sha256},backendFactory:async()=>({send:async()=>{},done,stop:()=>{stopped=true;resolveDone()}})});
    assert.equal(verified,true);assert.equal(existsSync(join(state.store,'.update-lock')),true);
    await assert.rejects(()=>withBuyerCacheStore(state.store,async()=>{}),/CACHE_BUSY/);
    active.stop();await active.done;assert.equal(stopped,true);assert.equal(existsSync(join(state.store,'.update-lock')),false);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('tree-binding failure stops before backend creation and releases lock',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-production-lock-fail-'),state=prepareStore(root);let spawned=false;
  try{
    await withBuyerCacheStore(state.store,cache=>cache.recordPrepared(state.session,'0.12.9',state.record));
    await assert.rejects(()=>startBackendWithPreparedLock({storeDirectory:state.store,prepared:{...state.prepared,tree:{content_tree_sha256:'c'.repeat(64)}},verificationOptions:{},verifyTree:async()=>{throw new Error('TREE_RECHECK_FAILED')},backendFactory:async()=>{spawned=true;return {done:Promise.resolve(),send:async()=>{},stop(){}}}}),/TREE_RECHECK_FAILED/);
    assert.equal(spawned,false);assert.equal(existsSync(join(state.store,'.update-lock')),false);
  }finally{rmSync(root,{recursive:true,force:true})}
});
