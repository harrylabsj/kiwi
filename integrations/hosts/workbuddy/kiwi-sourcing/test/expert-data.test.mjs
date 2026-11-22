import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, statSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expertDataDirectory, procurementDataDirectory } from '../../kiwi-procurement-expert/runtime/expert-data.mjs';
import { makeTempDirectory } from './fixtures/temp-directory.mjs';
test('private data persists per OS home and distinct homes stay separate',()=>{const root=mkdtempSync(join(tmpdir(),'kiwi-expert-test-'));try{const a=join(root,'a'),b=join(root,'b');mkdirSync(a,{mode:0o700});mkdirSync(b,{mode:0o700});const first=expertDataDirectory(a);assert.equal(first,expertDataDirectory(a));assert.notEqual(first,expertDataDirectory(b));assert.equal(statSync(first).mode&0o777,0o700)}finally{rmSync(root,{recursive:true,force:true})}});
test('rejects symlink or nonprivate data directory',()=>{const root=mkdtempSync(join(tmpdir(),'kiwi-expert-test-'));try{const h=join(root,'home'),target=join(root,'target');mkdirSync(h,{mode:0o700});mkdirSync(target,{mode:0o700});symlinkSync(target,join(h,'.kiwi-workbuddy-buyer-v1'));assert.throws(()=>expertDataDirectory(h));rmSync(join(h,'.kiwi-workbuddy-buyer-v1'));mkdirSync(join(h,'.kiwi-workbuddy-buyer-v1'));chmodSync(join(h,'.kiwi-workbuddy-buyer-v1'),0o755);assert.throws(()=>expertDataDirectory(h))}finally{rmSync(root,{recursive:true,force:true})}});

test('embedded startup keeps known failure codes on stderr and never exposes local paths', () => {
  const root = makeTempDirectory('kiwi-embedded-startup-');
  try {
    const sources = new URL('../runtime/', import.meta.url);
    const expert = new URL('../../kiwi-procurement-expert/runtime/', import.meta.url);
    for (const name of ['bundle-verify.mjs', 'embedded-expert-launcher.mjs', 'expert-data.mjs']) {
      copyFileSync(new URL(name, expert), join(root, name));
    }
    for (const name of ['backend-client.mjs', 'instance-store.mjs', 'mcp-production-server.mjs',
      'prepare-error-codes.mjs', 'tool-contract.mjs', 'environment-policy.mjs']) {
      copyFileSync(new URL(name, sources), join(root, name));
    }
    const run = (code, detail) => {
      const result = spawnSync(process.execPath, [join(root, 'embedded-expert-launcher.mjs')], {
        env: {HOME: root, KIWI_QUOTE_HISTORY_DELEGATION: 'true'},
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const prefix = detail ? `KIWI_BASELINE_DIAGNOSTIC:${detail}\n` : '';
      assert.equal(result.stderr, prefix + `KIWI_STATUS:FAILED_STARTUP\nKIWI_LAUNCHER_HOLD:${code}\n`);
    };
    const instance = join(expertDataDirectory(root), 'kiwi-instance-v1');
    mkdirSync(instance, {mode: 0o700});
    chmodSync(instance, 0o755);
    run('INSTANCE_DATA_NOT_PRIVATE');
    rmSync(instance, {recursive: true});
    writeFileSync(join(root, 'mcp-tools-0.12.12.json'), JSON.stringify(Array(13).fill({name: 'damaged'})));
    run('TOOL_BASELINE_INVALID','UNKNOWN_TOOL');
    const baseline = JSON.parse(readFileSync(new URL('mcp-tools-0.12.12.json', sources),'utf8'));
    writeFileSync(join(root,'mcp-tools-0.12.12.json'),JSON.stringify(baseline.filter(t=>t.name!=='kiwi_search')));
    run('TOOL_BASELINE_INVALID','MISSING_TOOL:kiwi_search');
    writeFileSync(join(root,'mcp-tools-0.12.12.json'),'{');
    run('TOOL_BASELINE_INVALID','INVALID_JSON');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('procurement preserves existing state and supports a private host directory', () => {
  const root = makeTempDirectory('kiwi-procurement-data-');
  try {
    const home = join(root, 'home'), host = join(root, 'host'), otherHome = join(root, 'other-home');
    for (const dir of [home, host, otherHome]) mkdirSync(dir, {mode:0o700});
    const legacy = expertDataDirectory(home);
    assert.equal(procurementDataDirectory(home,host),legacy);
    chmodSync(otherHome,0o500);
    const selected = procurementDataDirectory(otherHome,host);
    chmodSync(otherHome,0o700);
    assert.equal(selected,join(host,'.kiwi-workbuddy-buyer-v1'));
    assert.equal(procurementDataDirectory(otherHome,host),selected);
    chmodSync(selected,0o777);
    assert.throws(()=>procurementDataDirectory(otherHome,host),/EXPERT_DATA_UNAVAILABLE/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
