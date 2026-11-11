import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expertDataDirectory } from '../../kiwi-procurement-expert/runtime/expert-data.mjs';
test('private data persists per OS home and distinct homes stay separate',()=>{const root=mkdtempSync(join(tmpdir(),'kiwi-expert-test-'));try{const a=join(root,'a'),b=join(root,'b');mkdirSync(a,{mode:0o700});mkdirSync(b,{mode:0o700});const first=expertDataDirectory(a);assert.equal(first,expertDataDirectory(a));assert.notEqual(first,expertDataDirectory(b));assert.equal(statSync(first).mode&0o777,0o700)}finally{rmSync(root,{recursive:true,force:true})}});
test('rejects symlink or nonprivate data directory',()=>{const root=mkdtempSync(join(tmpdir(),'kiwi-expert-test-'));try{const h=join(root,'home'),target=join(root,'target');mkdirSync(h,{mode:0o700});mkdirSync(target,{mode:0o700});symlinkSync(target,join(h,'.kiwi-workbuddy-buyer-v1'));assert.throws(()=>expertDataDirectory(h));rmSync(join(h,'.kiwi-workbuddy-buyer-v1'));mkdirSync(join(h,'.kiwi-workbuddy-buyer-v1'));chmodSync(join(h,'.kiwi-workbuddy-buyer-v1'),0o755);assert.throws(()=>expertDataDirectory(h))}finally{rmSync(root,{recursive:true,force:true})}});
