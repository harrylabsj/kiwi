import {execFileSync} from "node:child_process";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync,readlinkSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {beforeAll,afterAll,afterEach,it,expect} from "vitest";
import {aggregate,assertOfficialNpmPayload} from "../scripts/lib/npm-shipping.mjs";
let home:string,tool:string;
const payload=JSON.parse(readFileSync("build-inputs/release0124-npm12-payload.json","utf8"));
const names=["arborist","cssesc","installed-package-contents","node-gyp","node-which","nopt","pacote","qrcode-terminal","semver"];
const restore:Array<()=>void>=[];
const link=(name:string)=>path.join(tool,"node_modules/.bin",name);
function change(file:string,bytes:string|Buffer){const old=readFileSync(file);writeFileSync(file,bytes);restore.push(()=>writeFileSync(file,old));}
function changeLink(name:string,target:string){const file=link(name),old=readlinkSync(file);rmSync(file);symlinkSync(target,file);restore.push(()=>{rmSync(file,{force:true});symlinkSync(old,file);});}
beforeAll(()=>{
 home=mkdtempSync(path.join(tmpdir(),"npm-binlinks-"));tool=path.join(home,"npm");
 const cli=realpathSync(execFileSync("which",["npm"],{encoding:"utf8"}).trim());
 cpSync(path.resolve(path.dirname(cli),".."),tool,{recursive:true,verbatimSymlinks:true});
});
afterEach(()=>{for(const fn of restore.splice(0).reverse())fn();});
afterAll(()=>rmSync(home,{recursive:true,force:true}));
it("normal global npm has exactly nine validated nonpayload links and the original 1942 code digest",()=>{
 const result=assertOfficialNpmPayload(tool,payload);
 expect(result.canonical_file_count).toBe(1942);expect(result.npm_code_sha256).toBe(aggregate(payload.files));
 expect(result.nonpayload.filter(r=>r.classification==="normal-npm-bin-link").map(r=>path.basename(r.path))).toEqual(names);
});
it("missing one generated link rejects while a canonical layout without all nine remains valid",()=>{
 const old=readlinkSync(link("arborist"));rmSync(link("arborist"));restore.push(()=>symlinkSync(old,link("arborist")));
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("BIN_LINK_INVALID");
 const dir=path.join(tool,"node_modules/.bin"),moved=path.join(home,"saved-bin");renameSync(dir,moved);restore.push(()=>renameSync(moved,dir));
 expect(assertOfficialNpmPayload(tool,payload).npm_code_sha256).toBe(aggregate(payload.files));
});
it("wrong known target, noncanonical alias and outside target are refused",()=>{
 changeLink("semver","../cssesc/bin/cssesc");expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("BIN_LINK_INVALID");
 changeLink("semver","../semver/bin/../bin/semver.js");expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("BIN_LINK_INVALID");
 changeLink("semver","../../../../outside");expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("SYMLINK_ESCAPE");
});
it("an arbitrary command name or a regular file in a known command slot cannot be exempted",()=>{
 const extra=link("npm-arbitrary-alias");symlinkSync("../semver/bin/semver.js",extra);restore.push(()=>rmSync(extra,{force:true}));
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("PAYLOAD_CHANGED");rmSync(extra);
 const file=link("semver"),old=readlinkSync(file);rmSync(file);writeFileSync(file,"not a link");restore.push(()=>{rmSync(file);symlinkSync(old,file);});
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("BIN_LINK_INVALID");
});
it("published target bytes and package bin mapping still require exact official bytes",()=>{
 const target=path.join(tool,"node_modules/semver/bin/semver.js"),originalTarget=readFileSync(target);change(target,Buffer.concat([originalTarget,Buffer.from("\nchanged")]));
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("PAYLOAD_CHANGED");writeFileSync(target,originalTarget);
 const file=path.join(tool,"node_modules/semver/package.json"),pkg=JSON.parse(readFileSync(file,"utf8"));pkg.bin.semver="../cssesc/bin/cssesc";change(file,JSON.stringify(pkg));
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("PAYLOAD_CHANGED");
});
it("unknown pycache and extra JavaScript remain hard failures",()=>{
 const dir=path.join(tool,"node_modules/node-gyp/gyp/pylib/gyp/__pycache__");mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,"unknown.pyc"),"synthetic");restore.push(()=>rmSync(dir,{recursive:true,force:true}));
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("PAYLOAD_CHANGED");rmSync(dir,{recursive:true});
 const extra=path.join(tool,"unknown-extra.js");writeFileSync(extra,"synthetic");restore.push(()=>rmSync(extra));expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("PAYLOAD_CHANGED");
});
it("a symlinked bin parent directory cannot authenticate generated links",()=>{
 const dir=path.join(tool,"node_modules/.bin"),moved=path.join(home,"linked-bin");renameSync(dir,moved);symlinkSync(moved,dir);restore.push(()=>{rmSync(dir);renameSync(moved,dir);});
 expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("SYMLINK_ESCAPE");
});
it("the original strict Corepack locator remains independent of generated links",()=>{
 const file=path.join(tool,".corepack"),hex=Buffer.from(payload.integrity.slice(7),"base64").toString("hex");
 const good={locator:{name:"npm",reference:"12.0.2"},bin:{npm:"./bin/npm-cli.js",npx:"./bin/npx-cli.js"},hash:"sha512."+hex};
 writeFileSync(file,JSON.stringify(good));restore.push(()=>rmSync(file,{force:true}));
 expect(assertOfficialNpmPayload(tool,payload).nonpayload.filter(r=>r.classification==="matching-corepack-locator")).toHaveLength(1);
 writeFileSync(file,JSON.stringify({...good,locator:{name:"npm",reference:"12.0.1"}}));expect(()=>assertOfficialNpmPayload(tool,payload)).toThrow("LOCATOR_INVALID");
});
