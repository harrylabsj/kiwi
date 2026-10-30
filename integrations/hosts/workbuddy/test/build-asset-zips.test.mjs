import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here=resolve(fileURLToPath(new URL('..',import.meta.url)));
const repo=resolve(here,'../../..');
const script=join(here,'build-asset-zips.mjs');
const run=out=>spawnSync(process.execPath,[script,'--out-dir',out],{cwd:repo,encoding:'utf8'});

test('builds separate asset ZIPs and an inspectable status report',()=>{
  const temp=mkdtempSync(join(tmpdir(),'kiwi-workbuddy-assets-test-'));
  try{
    const out=join(temp,'packages');const result=run(out);
    assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    const report=JSON.parse(readFileSync(join(out,'BUILD-REPORT.json'),'utf8'));
    assert.ok(report.status_counts.built>0);
    assert.ok(report.status_counts.candidate>0);
    assert.ok(report.status_counts.hold>0);
    const names=readdirSync(out);
    const zips=names.filter(name=>name.endsWith('.zip'));
    assert.equal(zips.length,report.status_counts.built+report.status_counts.candidate);
    assert.ok(names.includes('BUILD-REPORT.json'));
    assert.ok(!names.some(name=>name==='all-assets.zip'));
  }finally{rmSync(temp,{recursive:true,force:true});}
});

test('refuses an existing output directory without overwriting it',()=>{
  const temp=mkdtempSync(join(tmpdir(),'kiwi-workbuddy-assets-existing-'));
  try{
    const out=join(temp,'packages');mkdirSync(out);writeFileSync(join(out,'keep.txt'),'preserve');
    const result=run(out);
    assert.notEqual(result.status,0);
    assert.deepEqual(readdirSync(out),['keep.txt']);
    assert.equal(readFileSync(join(out,'keep.txt'),'utf8'),'preserve');
  }finally{rmSync(temp,{recursive:true,force:true});}
});

test('rejects an output directory inside the repository before creating it',()=>{
  const out=join(repo,'.workbuddy-asset-zips-path-boundary-test');
  assert.equal(existsSync(out),false);
  const result=run(out);
  assert.notEqual(result.status,0);
  assert.equal(existsSync(out),false);
});

test('rejects an external-looking output path whose parent symlink resolves into the repository',()=>{
  const temp=mkdtempSync(join(tmpdir(),'kiwi-workbuddy-assets-symlink-'));
  const target=join(repo,'.workbuddy-asset-zips-symlink-boundary-test');
  try{
    assert.equal(existsSync(target),false);
    symlinkSync(repo,join(temp,'repo-link'));
    const result=run(join(temp,'repo-link','new-output'));
    assert.notEqual(result.status,0);
    assert.equal(existsSync(target),false);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
