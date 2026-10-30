#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,'../../..');
const manifest=JSON.parse(readFileSync(join(here,'release-bundle-manifest.json'),'utf8'));
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out-dir'||!isAbsolute(args[1])){
  process.stderr.write('Usage: node integrations/hosts/workbuddy/build-asset-zips.mjs --out-dir /absolute/path/new-directory\n');process.exit(2);
}
const outDir=resolve(args[1]);
assert(!existsSync(outDir),'Output directory already exists; choose a new path');
assert(!outDir.startsWith(`${repo}${sep}`),'Output directory must be outside the repository');
function assertRealPathOutsideRepository(path){
  const canonical=realpathSync(path);const canonicalRepo=realpathSync(repo);
  assert(canonical!==canonicalRepo&&!canonical.startsWith(`${canonicalRepo}${sep}`),'Output directory resolves inside the repository');
}
let nearestParent=dirname(outDir);
while(!existsSync(nearestParent)){
  const next=dirname(nearestParent);assert.notEqual(next,nearestParent,'No existing output parent found');nearestParent=next;
}
assertRealPathOutsideRepository(nearestParent);
mkdirSync(dirname(outDir),{recursive:true});
assertRealPathOutsideRepository(dirname(outDir));
mkdirSync(outDir,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function assetRoot(asset){
  const p=resolve(here,asset.source);assert(p.startsWith(`${here}${sep}`),`Asset source escapes directory: ${asset.source}`);
  assert(realpathSync(p).startsWith(`${realpathSync(here)}${sep}`),`Asset source resolves outside directory: ${asset.source}`);return p;
}
function safeRef(base,ref){
  const rel=ref.replace(/^\.\//,'');assert(rel&&!rel.startsWith('/')&&!rel.split('/').includes('..'),`Invalid referenced path: ${ref}`);
  const p=resolve(base,rel);assert(p.startsWith(`${base}${sep}`),`Reference escapes source: ${ref}`);return {rel,p};
}
function collectAllowed(dir,root,allow,out){
  for(const ent of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const full=join(dir,ent.name);if(ent.isSymbolicLink())throw new Error(`Symlink blocked: ${full}`);
    if(ent.isDirectory()){
      if(allow.has(ent.name))collectAllowed(full,root,allow,out);
    }else if(ent.isFile())out.add(relative(root,full).split(sep).join('/'));
  }
}
function shaFile(p){const data=readFileSync(p);return {bytes:data.length,sha256:hash(data)};}
function expertSnapshot(asset,staging,output){
  const root=assetRoot(asset);const manifestRel='.codebuddy-plugin/plugin.json';
  const plugin=JSON.parse(readFileSync(join(root,manifestRel),'utf8'));
  assert.equal(plugin.version,asset.platform_version,`Expert ${asset.id}: local version does not match historical platform version`);
  assert.equal(plugin.expertType,asset.kind==='expert-team'?'team':'agent');
  assert(Array.isArray(plugin.agents)&&plugin.agents.length>0,'Expert must reference agent definitions');
  const files=new Set([manifestRel,'README.md']);
  for(const listName of ['agents','skills'])for(const ref of plugin[listName]??[]){
    const {rel,p}=safeRef(root,ref);
    if(listName==='agents'){assert(lstatSync(p).isFile(),`Missing expert agent file: ${ref}`);files.add(rel);}
    else{
      assert(lstatSync(p).isDirectory(),`Missing expert skill directory: ${ref}`);
      const found=new Set();collectAllowed(p,root,new Set(['references','scripts','templates','package']),found);
      assert(found.has(`${rel}/SKILL.md`),`Missing referenced SKILL.md: ${ref}`);for(const f of found)files.add(f);
    }
  }
  assert(typeof plugin.avatar==='string','Expert must reference avatar');
  const avatar=safeRef(root,plugin.avatar);assert(lstatSync(avatar.p).isFile(),`Missing avatar ${plugin.avatar}`);files.add(avatar.rel);
  for(const extra of ['setting.json','settings.json'])if(existsSync(join(root,extra)))files.add(extra);
  const name=plugin.name;assert(/^[a-z0-9-]+$/.test(name),'Invalid expert package root name');
  // Use an isolated staging copy, keeping the package's required single root directory.
  const rootDir=join(staging,name);mkdirSync(rootDir,{recursive:true});
  for(const rel of [...files].sort()){
    const src=join(root,rel),dest=join(rootDir,rel);assert(lstatSync(src).isFile()&&!lstatSync(src).isSymbolicLink());
    mkdirSync(dirname(dest),{recursive:true});copyFileSync(src,dest);
  }
  const names=[...files].map(f=>`${name}/${f}`).sort();
  zipStage(staging,name,output,names);
  return {format:'WorkBuddy expert/team basic package structure',local_version:plugin.version,root:name,files:names.map(p=>({path:p,...shaFile(join(staging,p))}))};
}
function zipStage(staging,root,output,expected){
  const temp=join(dirname(output),`.${process.pid}-${Math.random().toString(16).slice(2)}.zip`);
  execFileSync('zip',['-q','-X','-r',temp,root],{cwd:staging,stdio:'ignore'});
  const actual=execFileSync('unzip',['-Z1',temp],{encoding:'utf8'}).trim().split('\n').filter(x=>x&&!x.endsWith('/')).sort();
  assert.deepEqual(actual,expected.sort(),`ZIP entries differ from declared package files for ${root}`);
  execFileSync('unzip',['-t',temp],{stdio:'ignore'});copyFileSync(temp,output);rmSync(temp);
}
function parseSkill(asset,staging,output){
  const root=assetRoot(asset),skillPath=join(root,'SKILL.md');
  const text=readFileSync(skillPath,'utf8');const fm=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(fm,`Skill ${asset.id} missing YAML frontmatter`);
  const field=key=>fm[1].match(new RegExp(`^${key}:\\s*["']?([^\\r\\n"']+)`, 'm'))?.[1]?.trim();
  for(const required of ['name','display_name','display_name_en','description','description_zh','description_en','version','author'])assert(field(required),`Skill ${asset.id} missing ${required}`);
  assert.equal(field('version'),asset.platform_version,`Skill ${asset.id}: local version does not match historical platform version`);
  assert(/^[a-z0-9-]+$/.test(field('name')),'Invalid skill package root name');
  const files=new Set();collectAllowed(root,root,new Set(['references','scripts','templates','package']),files);files.add('SKILL.md');
  const names=[...files].sort();
  const rootName=field('name');const copyRoot=join(staging,rootName);mkdirSync(copyRoot,{recursive:true});
  for(const rel of names){const src=join(root,rel);assert(lstatSync(src).isFile()&&!lstatSync(src).isSymbolicLink());const dest=join(copyRoot,rel);mkdirSync(dirname(dest),{recursive:true});copyFileSync(src,dest);}
  const archiveNames=names.map(f=>`${rootName}/${f}`).sort();zipStage(staging,rootName,output,archiveNames);
  return {format:'WorkBuddy Skill basic structure (SKILL.md + optional references/scripts/templates)',local_version:field('version'),root:rootName,files:archiveNames.map(p=>({path:p,...shaFile(join(staging,p))}))};
}
function runExistingBuilder(asset,output){
  if(asset.bundle_mode==='candidate-connector'){
    const connectorRoot=assetRoot(asset);
    const meta=JSON.parse(readFileSync(join(connectorRoot,'connector-meta.json'),'utf8'));
    assert.equal(meta.version,asset.platform_version,`HOLD: local connector source is ${meta.version}, platform review candidate is ${asset.platform_version}`);
    const packageScript=join(connectorRoot,'scripts','package-production.mjs');
    execFileSync(process.execPath,[packageScript,'--output',output],{cwd:repo,stdio:'inherit'});
    execFileSync('unzip',['-t',output],{stdio:'ignore'});
    return {format:'Existing production connector packager package-production.mjs; candidate only',local_version:meta.version,files:null};
  }
  const command=asset.builder==='package-gateway-connector.mjs'
    ? [join(here,asset.builder),'--out',output]
    : asset.builder==='package.mjs'
      ? [join(here,asset.builder),'--out',output]
      : null;
  assert(command,`Unknown builder ${asset.builder}`);execFileSync(process.execPath,command,{cwd:repo,stdio:'inherit'});
  execFileSync('unzip',['-t',output],{stdio:'ignore'});
  return {format:`Existing project packager ${asset.builder}`,local_version:asset.source_version,files:null};
}
function writeSidecar(asset,outFile,check){
  const zipInfo=shaFile(outFile);
  const record={schema:'kiwi.workbuddy.asset-package-record.v1',asset:{kind:asset.kind,id:asset.id,name:asset.name,platform_version:asset.platform_version,observed_state:asset.observed_state},source:{path:asset.source,version:check.local_version,revision:manifest.snapshot.source_revision,mapping:asset.mapping},package:{path:outFile,bytes:zipInfo.bytes,sha256:zipInfo.sha256,format_check:check.format,files:check.files},limits:['Platform state is copied from the dated observations in the manifest; this builder does not query WorkBuddy.','Local ZIP structure checks do not prove upload acceptance, exact published bytes, or runtime behavior.']};
  writeFileSync(`${outFile}.manifest.json`,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
}

const statuses=[];
  for(const asset of manifest.assets){
  const version=asset.source_version?.startsWith('read ')?asset.platform_version:(asset.source_version??asset.platform_version??'unknown');
  const base=asset.id??asset.source.split('/').at(-1);
  const zip=join(outDir,`${base}-v${version}.zip`);
  try{
    if(asset.bundle_mode==='hold'){
      statuses.push({id:asset.id,kind:asset.kind,name:asset.name,status:'HOLD',reason:asset.reason});continue;
    }
    let check;
    if(asset.bundle_mode==='candidate-package'||asset.bundle_mode==='native-package'||asset.bundle_mode==='candidate-connector'){
      check=runExistingBuilder(asset,zip);
      if(asset.bundle_mode==='candidate-package')check.format=`${check.format}; candidate only; no publication state implied`;
    }else{
      const stage=mkdtempSync(join(outDir,`.stage-${asset.id}-`));
      try{
        if(asset.kind==='expert'||asset.kind==='expert-team')check=expertSnapshot(asset,stage,zip);
        else if(asset.kind==='skill')check=parseSkill(asset,stage,zip);
        else throw new Error(`No platform package adapter for ${asset.kind}`);
      }finally{rmSync(stage,{recursive:true,force:true});}
      statuses.push({id:asset.id,kind:asset.kind,name:asset.name,status:asset.bundle_mode==='candidate-source'?'CANDIDATE_PACKAGE_BUILT':'LOCAL_PACKAGE_BUILT',platform_state:asset.observed_state,version:asset.platform_version,format:check.format});
    }
    writeSidecar(asset,zip,check);
    if(asset.bundle_mode==='native-package')statuses.push({id:asset.id,kind:asset.kind,name:asset.name,status:'LOCAL_PACKAGE_BUILT',platform_state:asset.observed_state,version:asset.source_version,format:check.format});
    if(['candidate-package','candidate-connector'].includes(asset.bundle_mode))statuses.push({id:asset.id,kind:asset.kind,name:asset.name,status:'CANDIDATE_PACKAGE_BUILT',platform_state:asset.observed_state,version:check.local_version,format:check.format});
  }catch(error){
    if(existsSync(zip))rmSync(zip,{force:true});
    if(existsSync(`${zip}.manifest.json`))rmSync(`${zip}.manifest.json`,{force:true});
    statuses.push({id:asset.id,kind:asset.kind,name:asset.name,status:'HOLD',reason:String(error?.message??error)});
  }
}
const report={schema:'kiwi.workbuddy.asset-build-report.v1',source_revision:manifest.snapshot.source_revision,platform_snapshot:manifest.snapshot.platform_inventory_date,current_observation_date:manifest.snapshot.current_observation_date,current_observation_source:manifest.snapshot.current_observation_source,current_observations:manifest.snapshot.current_observations,generated_at_utc:new Date().toISOString(),status_counts:{built:statuses.filter(x=>x.status==='LOCAL_PACKAGE_BUILT').length,candidate:statuses.filter(x=>x.status==='CANDIDATE_PACKAGE_BUILT').length,hold:statuses.filter(x=>x.status==='HOLD').length},assets:statuses,held_items:manifest.held_items,global_limits:['No platform actions were performed.','Successful local packaging is not proof of current platform status or exact uploaded bytes.','Candidates and source snapshots must not be described as approved or published.']};
writeFileSync(join(outDir,'BUILD-REPORT.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
process.stdout.write(`BUILD_REPORT ${join(outDir,'BUILD-REPORT.json')}\nBUILT ${report.status_counts.built}\nCANDIDATE ${report.status_counts.candidate}\nHOLD ${report.status_counts.hold}\n`);
