import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpSync,existsSync,linkSync,mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeFiles,rootFiles,skillFiles} from './package-manifest.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--output'||!args[1]||!resolve(args[1]).endsWith('.zip')){process.stderr.write('PACKAGE_HOLD:ARGUMENT_INVALID\n');process.exit(1)}
const output=resolve(args[1]);
if(existsSync(output)){process.stderr.write('PACKAGE_HOLD:OUTPUT_EXISTS\n');process.exit(1)}
try{
  execFileSync(process.execPath,[join(root,'scripts','validate.mjs')],{stdio:'ignore'});
  const staging=mkdtempSync(join(dirname(output),'.kiwi-package-')),zipStage=mkdtempSync(join(dirname(output),'.kiwi-zip-'));
  try{
    for(const file of rootFiles){const target=join(staging,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});cpSync(join(root,file),target,{errorOnExist:true,force:false})}
    for(const file of skillFiles){const target=join(staging,file);mkdirSync(dirname(target),{recursive:true,mode:0o700});cpSync(join(root,file),target,{errorOnExist:true,force:false})}
    for(const file of runtimeFiles){const target=join(staging,'runtime',file);mkdirSync(dirname(target),{recursive:true,mode:0o700});cpSync(join(root,'runtime',file),target,{errorOnExist:true,force:false})}
    const files=[];
    function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(entry.isFile()){const rel=relative(staging,path).split(sep).join('/');files.push({path:rel,bytes:statSync(path).size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})}else throw new Error('PACKAGE_ENTRY_INVALID')}}
    walk(staging);files.sort((a,b)=>a.path.localeCompare(b.path));
    writeFileSync(join(staging,'PACKAGE-SHA256.json'),JSON.stringify({format:1,version:JSON.parse(readFileSync(join(root,'connector-meta.json'),'utf8')).version,files},null,2)+'\n',{mode:0o600,flag:'wx'});
    const temporaryZip=join(zipStage,'artifact.zip');
    execFileSync('zip',['-q','-X','-r',temporaryZip,...rootFiles,'skills','runtime','PACKAGE-SHA256.json'],{cwd:staging,stdio:'ignore'});
    linkSync(temporaryZip,output);unlinkSync(temporaryZip);
  }finally{rmSync(staging,{recursive:true,force:true});rmSync(zipStage,{recursive:true,force:true})}
  process.stdout.write('PACKAGE_CREATED\n');
}catch{process.stderr.write('PACKAGE_HOLD:BUILD_FAILED\n');process.exit(1)}
