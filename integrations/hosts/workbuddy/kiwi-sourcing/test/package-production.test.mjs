import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)),connector=dirname(here);
const packager=join(connector,'scripts/package-production.mjs');

test('offline package contains the complete allowlisted runtime and verifies every payload hash',{timeout:15000},()=>{
  const root=mkdtempSync('/private/tmp/kiwi-production-package-'),output=join(root,'kiwi.zip');
  try{
    execFileSync(process.execPath,[packager,'--output',output],{stdio:'pipe'});
const inspect=`import sys,zipfile,json,hashlib,stat\np=sys.argv[1]\nwith zipfile.ZipFile(p) as z:\n n={i.filename for i in z.infolist() if not i.is_dir()};m=json.loads(z.read('PACKAGE-SHA256.json'))\n assert 'runtime/production-launcher.mjs' in n and 'runtime/backend-client.mjs' in n and 'runtime/mcp-tools-0.12.12.json' in n\n assert 'runtime/launcher-draft.mjs' not in n and not any(x.startswith('test/') or '/node_modules/' in x or '__pycache__' in x for x in n)\n rows={x['path']:x for x in m['files']}\n assert set(rows)==n-{'PACKAGE-SHA256.json'}\n for name,row in rows.items():\n  data=z.read(name);assert len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256']\n for i in z.infolist():\n  assert not i.filename.startswith('/') and '..' not in i.filename.split('/')\n  assert stat.S_IFMT(i.external_attr>>16)!=stat.S_IFLNK\n`;
    execFileSync('/opt/homebrew/bin/python3',['-c',inspect,output],{stdio:'pipe'});
    const before=readFileSync(output);
    assert.throws(()=>execFileSync(process.execPath,[packager,'--output',output],{stdio:'pipe'}),error=>error.status===1);
    assert.deepEqual(readFileSync(output),before,'existing package must not be overwritten');
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('packaged entry and launcher dependencies are present in the explicit manifest',()=>{
  const manifest=readFileSync(join(connector,'scripts/package-manifest.mjs'),'utf8');
  for(const file of ['production-launcher.mjs','mcp-production-server.mjs','backend-client.mjs','tree-binding.mjs','stage-runner.mjs','preflight.mjs','published-provenance.mjs','sigstore-gate.mjs','inspect_tree_cli.py','installed_tree.py','mcp-tools-0.12.12.json'])assert.ok(manifest.includes(file));
  assert.equal(existsSync(join(connector,'runtime','__pycache__')),false);
});
