import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, afterEach, expect, it } from "vitest";
import { assertNoState, createCompiledAppProof, createVendorCodeProof, inventory, sourceContract } from "../scripts/lib/npm-shipping.mjs";
const candidate=process.cwd();let home:string,root:string,stage:string,tar:string;
const undo:Array<()=>void>=[];
const git=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["pipe","pipe","pipe"]}).trim();
function commit(files:string[]) {git(root,"add","--",...files);git(root,"-c","user.name=A413 Synthetic Producer","-c","user.email=fixture@example.invalid","commit","-m","finite mechanism fixture");}
function change(file:string,bytes:Buffer|string){const old=readFileSync(file);writeFileSync(file,bytes);undo.push(()=>writeFileSync(file,old));}
function rows(){return inventory(stage).filter(r=>r.path.startsWith("app/negotiation/state/")||r.path.includes("/credentials/"));}
beforeAll(()=>{
 home=mkdtempSync(path.join(tmpdir(),"a413-code-proof-"));root=path.join(home,"root");stage=path.join(root,"build/cloud-artifact");
 git(candidate,"clone","--no-hardlinks",candidate,root);
 for(const name of ["scripts/lib/npm-shipping.mjs","scripts/lib/npm-shipping.d.mts","scripts/build-npm-shipping.mjs"])cpSync(path.join(candidate,name),path.join(root,name));
 const dependencies=path.join(candidate,"node_modules");mkdirSync(path.join(root,"node_modules"));
 for(const name of readdirSync(dependencies))symlinkSync(path.join(dependencies,name),path.join(root,"node_modules",name));
 const pkg=JSON.parse(readFileSync(path.join(root,"package.json"),"utf8"));pkg.scripts.verify="npm run build && node scripts/a413-fixture-check.mjs";writeFileSync(path.join(root,"package.json"),JSON.stringify(pkg,null,2)+"\n");
 writeFileSync(path.join(root,"scripts/a413-fixture-check.mjs"),"import assert from 'node:assert/strict';import fs from 'node:fs';import {createNegotiationPhase,isTerminalPhase} from '../dist/negotiation/state/phase.js';assert.equal(createNegotiationPhase('a413').negotiation_id,'a413');assert.equal(isTerminalPhase('AGREEMENT_REACHED'),true);for(const ext of ['js','js.map','d.ts'])assert.ok(fs.statSync('dist/negotiation/state/phase.'+ext).isFile());console.log('finite actual tsc + state/file assertions');\n");
 commit(["scripts/lib/npm-shipping.mjs","scripts/lib/npm-shipping.d.mts","scripts/build-npm-shipping.mjs","package.json","scripts/a413-fixture-check.mjs"]);
 writeFileSync(path.join(root,"build-inputs/release0124-source.json"),JSON.stringify(sourceContract(root),null,2)+"\n");commit(["build-inputs/release0124-source.json"]);
 const producer=execFileSync(process.execPath,[path.join(root,"scripts/verify-npm-shipping-source.mjs")],{cwd:root,encoding:"utf8",timeout:120000});
 mkdirSync(stage,{recursive:true});cpSync(path.join(root,"dist"),path.join(stage,"app"),{recursive:true});cpSync(path.join(root,"build-inputs/release0124-stage/package-lock.json"),path.join(stage,"package-lock.json"));
 mkdirSync(path.join(stage,"node_modules/@anthropic-ai"),{recursive:true});cpSync(path.join(dependencies,"@anthropic-ai/sdk"),path.join(stage,"node_modules/@anthropic-ai/sdk"),{recursive:true});
 const locked=JSON.parse(readFileSync(path.join(root,"build-inputs/release0124-stage/package-lock.json"),"utf8")).packages["node_modules/@anthropic-ai/sdk"];
 const digest=Buffer.from(locked.integrity.slice(7),"base64").toString("hex");const cache=execFileSync("npm",["config","get","cache"],{cwd:root,encoding:"utf8"}).trim();tar=path.join(cache,"_cacache/content-v2/sha512",digest.slice(0,2),digest.slice(2,4),digest.slice(4));
 if(process.env.A413_EVIDENCE_DIR){mkdirSync(process.env.A413_EVIDENCE_DIR,{recursive:true});writeFileSync(path.join(process.env.A413_EVIDENCE_DIR,"finite-producer.json"),JSON.stringify({fixtureRoot:root,commit:git(root,"rev-parse","HEAD"),command:["node","scripts/verify-npm-shipping-source.mjs"],scope:"actual tsc + finite real module/file assertions, not production fullverify",actualExit:0,stdout:producer},null,2));cpSync(path.join(root,"build/npm-shipping-build-receipt.json"),path.join(process.env.A413_EVIDENCE_DIR,"finite-mode-receipt.json"));cpSync(path.join(root,"scripts/a413-fixture-check.mjs"),path.join(process.env.A413_EVIDENCE_DIR,"finite-verify.mjs"));}
},120000);
afterEach(()=>{for(const fn of undo.splice(0).reverse())fn();});afterAll(()=>rmSync(home,{recursive:true,force:true}));
function proofs(){return {artifactRoot:stage,compiledApp:createCompiledAppProof(root,stage),vendorCode:createVendorCodeProof(root,stage,tar)};}
it("admits three actual compiled state files and 54 official SDK credential code files only with separate strong proofs",()=>{
 const input=rows();expect(input).toHaveLength(57);expect(()=>assertNoState(input)).toThrow();expect(()=>assertNoState(input,proofs())).not.toThrow();
 const receipt=JSON.parse(readFileSync(path.join(root,"build/npm-shipping-build-receipt.json"),"utf8"));expect(receipt.dist.every((r:{mode?:number})=>Number.isInteger(r.mode))).toBe(true);
});
it("rejects JSON-forged proofs, cross-type proofs and a different artifact root",()=>{
 const p=proofs();expect(()=>assertNoState(rows(),{...p,compiledApp:JSON.parse(JSON.stringify(p.compiledApp))})).toThrow("SHIPPING_CODE_PROOF_INVALID");
 expect(()=>assertNoState(rows(),{...p,compiledApp:p.vendorCode as unknown as typeof p.compiledApp})).toThrow("SHIPPING_CODE_PROOF_INVALID");
 expect(()=>assertNoState(rows(),{...p,vendorCode:p.compiledApp as unknown as typeof p.vendorCode})).toThrow("SHIPPING_CODE_PROOF_INVALID");
 expect(()=>assertNoState(rows(),{...p,artifactRoot:root})).toThrow("SHIPPING_CODE_PROOF_INVALID");
});
it.each(["app/negotiation/state/.env","app/negotiation/state/private.sqlite","app/negotiation/state/private.key","app/negotiation/state/extra.js","node_modules/@anthropic-ai/sdk/lib/credentials/.env","node_modules/@anthropic-ai/sdk/lib/credentials/extra.js"])("does not exempt unknown file %s",relative=>{
 const p=proofs(),file=path.join(stage,relative);writeFileSync(file,"SYNTHETIC_UNKNOWN");undo.push(()=>rmSync(file));expect(()=>assertNoState(rows(),p)).toThrow("SHIPPING_STATE_OR_CREDENTIAL_FILE");
});
it.each(["app/negotiation/state/phase.js","node_modules/@anthropic-ai/sdk/lib/credentials/credential-chain.js"])("rejects changed bytes and mode for %s",relative=>{
 const p=proofs(),file=path.join(stage,relative),old=readFileSync(file);change(file,Buffer.concat([old,Buffer.from("\nmutation")]));expect(()=>assertNoState(rows(),p)).toThrow();writeFileSync(file,old);
 const mode=statSync(file).mode;chmodSync(file,0o600);undo.push(()=>chmodSync(file,mode));expect(()=>assertNoState(rows(),p)).toThrow();
});
it.each(["build/npm-shipping-build-receipt.json","build/npm-shipping-fullverify.log","src/negotiation/state/phase.ts"])("rejects changed root evidence %s",relative=>{
 const p=proofs(),file=path.join(root,relative);change(file,Buffer.concat([readFileSync(file),Buffer.from("\nchanged")]));expect(()=>assertNoState(rows(),p)).toThrow();
});
it("rejects absent mode or wrong source commit in the genuinely producer-created receipt",()=>{
 const file=path.join(root,"build/npm-shipping-build-receipt.json"),old=readFileSync(file);let value=JSON.parse(old.toString());delete value.dist[0].mode;change(file,JSON.stringify(value));expect(()=>createCompiledAppProof(root,stage)).toThrow();writeFileSync(file,old);
 value=JSON.parse(old.toString());value.source.source_commit="0".repeat(40);writeFileSync(file,JSON.stringify(value));expect(()=>createCompiledAppProof(root,stage)).toThrow();
});
it("rejects wrong official tar SRI, version, stage lock and tar changed after proof",()=>{
 const p=proofs(),bad=path.join(home,"bad.tgz");writeFileSync(bad,Buffer.concat([readFileSync(tar),Buffer.from("wrong")]));expect(()=>createVendorCodeProof(root,stage,bad)).toThrow("SHIPPING_VENDOR_SRI_MISMATCH");
 const file=path.join(stage,"node_modules/@anthropic-ai/sdk/package.json"),old=readFileSync(file),pkg=JSON.parse(old.toString());pkg.version="0.0.0";change(file,JSON.stringify(pkg));expect(()=>createVendorCodeProof(root,stage,tar)).toThrow("SHIPPING_VENDOR_VERSION_CHANGED");expect(()=>assertNoState(rows(),p)).toThrow();writeFileSync(file,old);
 const lock=path.join(stage,"package-lock.json");change(lock,"{}\n");expect(()=>createVendorCodeProof(root,stage,tar)).toThrow("SHIPPING_VENDOR_STAGE_LOCK_CHANGED");
});

it("rejects official tar changed after its proof without changing the shared cached tar",()=>{
 const ownTar=path.join(home,"official-copy.tgz");cpSync(tar,ownTar);const vendorCode=createVendorCodeProof(root,stage,ownTar),compiledApp=createCompiledAppProof(root,stage);
 writeFileSync(ownTar,Buffer.concat([readFileSync(ownTar),Buffer.from("changed")]));expect(()=>assertNoState(rows(),{artifactRoot:stage,vendorCode,compiledApp})).toThrow("SHIPPING_VENDOR_PROOF_CHANGED");
});
