import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {withBuyerCacheStore} from '../runtime/buyer-cache-store-draft.mjs';
import {createTransaction} from '../runtime/transaction.mjs';

function staged(root,name,version,content){
  const directory=join(root,name);mkdirSync(directory,{mode:0o700});const bytes=Buffer.from(content);writeFileSync(join(directory,'verified-download.tgz'),bytes,{mode:0o600});
  const packageName='@harrylabsj/kiwi',integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
  createTransaction(join(directory,'transaction.json'),packageName,{name:packageName,version,dist:{integrity,tarball:`https://registry.npmjs.org/@harrylabsj/kiwi/-/kiwi-${version}.tgz`}},bytes);
  const packageLock=Buffer.from(`fixture-lock-${version}`);writeFileSync(join(directory,'package-lock.json'),packageLock,{mode:0o600});
  return {directory,version,integrity,treeLockSha256:createHash('sha256').update(packageLock).digest('hex'),contentTreeSha256:createHash('sha256').update(`tree-${content}`).digest('hex')};
}

test('format3 pointer binds content digest and rejects missing/format2 state',async()=>{
  const root=mkdtempSync('/private/tmp/kiwi-cache-format3-');
  try{
    const current=staged(root,'kiwi-preflight-aaaaaa','0.12.14','synthetic-bytes');
    await withBuyerCacheStore(root,async store=>{
      store.recordPrepared(current.directory,'0.12.9',current);
      assert.deepEqual(store.prepared().contentTreeSha256,current.contentTreeSha256);
    });
    const pointer=JSON.parse(readFileSync(join(root,'prepared.json'),'utf8'));
    assert.equal(pointer.format,3);assert.equal(pointer.contentTreeSha256,current.contentTreeSha256);
    const format2={...pointer,format:2};delete format2.contentTreeSha256;writeFileSync(join(root,'prepared.json'),JSON.stringify(format2),{mode:0o600});
    await assert.rejects(()=>withBuyerCacheStore(root,async store=>store.prepared()),/CACHE_POINTER_INVALID/);
    writeFileSync(join(root,'prepared.json'),JSON.stringify(pointer),{mode:0o600});
    await assert.rejects(()=>withBuyerCacheStore(root,async store=>store.recordPrepared(current.directory,'0.12.9',{...current,contentTreeSha256:'bad'})),/CACHE_RESULT_MISMATCH/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
