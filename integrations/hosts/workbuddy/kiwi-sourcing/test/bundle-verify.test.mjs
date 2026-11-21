import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isHostMetadata,verifyFiles} from '../../kiwi-procurement-expert/runtime/bundle-verify.mjs';

function digest(content){return createHash('sha256').update(content).digest('hex')}

test('host metadata does not block a verified bundle and expected files must all be seen',()=>{
  const root=mkdtempSync('/private/tmp/kiwi-bundle-verify-');
  try{
    mkdirSync(join(root,'nested'),{mode:0o700});
    writeFileSync(join(root,'runtime.mjs'),'export{};');
    writeFileSync(join(root,'nested','data.json'),'{}');
    writeFileSync(join(root,'.DS_Store'),'finder');
    writeFileSync(join(root,'._runtime.mjs'),'appledouble');
    writeFileSync(join(root,'Thumbs.db'),'windows');
    writeFileSync(join(root,'nested','.missing.mjs.icloud'),'placeholder');
    const manifest=new Map([
      ['runtime.mjs',digest('export{};')],
      ['nested/data.json',digest('{}')],
    ]);
    verifyFiles(root,manifest);
    assert.equal(manifest.size,0);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('an unknown non-metadata file still fails closed',()=>{
  const root=mkdtempSync('/private/tmp/kiwi-bundle-verify-');
  try{
    writeFileSync(join(root,'runtime.mjs'),'export{};');
    writeFileSync(join(root,'injected.mjs'),'evil');
    assert.throws(()=>verifyFiles(root,new Map([['runtime.mjs',digest('export{};')]])),/BUNDLED_RUNTIME_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('a changed expected file fails closed',()=>{
  const root=mkdtempSync('/private/tmp/kiwi-bundle-verify-');
  try{
    writeFileSync(join(root,'runtime.mjs'),'export{};');
    assert.throws(()=>verifyFiles(root,new Map([['runtime.mjs',digest('different')]])),/BUNDLED_RUNTIME_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('metadata detection covers the documented host files only',()=>{
  for(const name of ['.DS_Store','Thumbs.db','desktop.ini','._resource','placeholder.mjs.icloud'])assert.equal(isHostMetadata(name),true,name);
  for(const name of ['runtime.mjs','.env','notes.txt','.icloud'])assert.equal(isHostMetadata(name),false,name);
});
