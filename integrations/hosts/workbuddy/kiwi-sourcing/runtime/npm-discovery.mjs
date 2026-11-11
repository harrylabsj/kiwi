import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// npm 10 does not provide the attestation evidence required by audit-gate.
export function findCompatibleNpm({path=process.env.PATH??'',home=homedir(),nodePath=process.execPath}={}) {
 const dirs=[...path.split(delimiter),join(home,'.local','bin'),join(nodePath,'..')];
 const seen=new Set();
 for(const dir of dirs){
  if(!isAbsolute(dir))continue;
  try{
   const file=realpathSync(join(dir,'npm'));if(seen.has(file))continue;seen.add(file);
   accessSync(file,constants.X_OK);if(!lstatSync(file).isFile())continue;
   const version=execFileSync(file,['--version'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
   if(/^12\.\d+\.\d+(?:[-+].*)?$/.test(version) && typeof createRequire(file)('sigstore')?.verify==='function')return file;
  }catch{continue}
 }
 throw new Error('NPM_12_UNAVAILABLE');
}
