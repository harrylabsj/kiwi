import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findCompatibleNpm} from '../runtime/npm-discovery.mjs';
test('skips npm 10 and selects npm 12 from PATH; rejects absence',()=>{
 const root=mkdtempSync(join(tmpdir(),'kiwi-npm-'));try{const a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b);writeFileSync(join(a,'npm'),'#!/bin/sh\necho 10.9.7\n',{mode:0o700});writeFileSync(join(b,'npm'),'#!/bin/sh\necho 12.2.0\n',{mode:0o700});mkdirSync(join(b,'node_modules','sigstore'),{recursive:true});writeFileSync(join(b,'node_modules','sigstore','index.js'),'exports.verify = function() {}');assert.equal(findCompatibleNpm({path:`${a}:${b}`,home:root,nodePath:join(root,'node')}),realpathSync(join(b,'npm')));writeFileSync(join(a,'npm'),'#!/bin/sh\necho 12.0.2\n',{mode:0o700});assert.equal(findCompatibleNpm({path:`${a}:${b}`,home:root,nodePath:join(root,'node')}),realpathSync(join(b,'npm')));assert.throws(()=>findCompatibleNpm({path:a,home:root,nodePath:join(root,'node')}),/NPM_12_UNAVAILABLE/)}finally{rmSync(root,{recursive:true,force:true})}
});
