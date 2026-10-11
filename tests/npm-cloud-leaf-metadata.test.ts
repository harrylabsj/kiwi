import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {beforeAll,afterAll,it,expect} from "vitest";
import {assertBundledEdges} from "../scripts/lib/npm-bundled-edges.mjs";
// Linux run 38095216057 verified this immutable npm source/build/cold closure.
const VERIFIED_SOURCE = "65c3e8a0885f94baa1f6f40ae3f4f5e5b975a59c";
const VERIFIED_CONTRACT_SHA = "90641e610c93313803c2b35e44a9a75330d4cb05bb7d492ff608ec586871dcb7";
const VERIFIED_GUARD_CLOSURE = {
  "scripts/lib/npm-shipping.mjs": "39f6335164f789758f77d769f50ce44739898d9c9c64d7db774a24b9bd6290bb",
  "scripts/check-install-toolchain.mjs": "9d3708cea56d4b83b718930a0b6769b17561a73779855a02559090eaa8eb1419",
  "build-inputs/release0124-npm12-payload.json": "d05e06706d48b2a8407dd6401b264fb70e2261cf229325ad2f895595a474a6a6"
};
const digest = (file:string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function assertVerifiedSourceIdentity(root:string){
 expect(execFileSync("git",["--no-replace-objects","-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(VERIFIED_SOURCE);
 expect(digest(path.join(root,"build-inputs/release0124-source.json"))).toBe(VERIFIED_CONTRACT_SHA);
 for(const [file,sha] of Object.entries(VERIFIED_GUARD_CLOSURE))expect(digest(path.join(root,file))).toBe(sha);
}
let home:string,authority:string,leaf:string;
beforeAll(()=>{
 home=mkdtempSync(path.join(tmpdir(),"leaf-edge-test-"));authority=path.join(home,"authority");leaf=path.join(home,"leaf");
 execFileSync("git",["clone","--no-hardlinks",process.cwd(),authority],{stdio:"pipe"});
 execFileSync("git",["--no-replace-objects","-C",authority,"checkout","--detach",VERIFIED_SOURCE],{stdio:"pipe"});
 assertVerifiedSourceIdentity(authority);
 // Invoke the current imported d8 helper (includes realpath alias support), not the cloned helper.
 expect(digest(path.join(process.cwd(),"scripts/lib/npm-bundled-edges.mjs"))).toBe("80a7c385987f2eba05e8a6a51948dab9bc21009f8bd8bc4e3c679f7d1496de0d");
 mkdirSync(path.join(leaf,"node_modules"),{recursive:true});
 cpSync(path.join(process.cwd(),"node_modules/yaml"),path.join(leaf,"node_modules/alias-yaml"),{recursive:true});
 writeFileSync(path.join(leaf,"package.json"),JSON.stringify({name:"synthetic-leaf",version:"1.0.0",dependencies:{"alias-yaml":"npm:yaml@2.9.1"},bundleDependencies:["alias-yaml"],bundledDependencies:["alias-yaml"]}));
});afterAll(()=>rmSync(home,{recursive:true,force:true}));
it("normal trusted npm Arborist accepts an actual npm alias edge",async()=>{expect((await assertBundledEdges(authority,leaf)).bundled_nodes).toBe(1);});
it("rejects leaf override and incomplete bundle metadata",async()=>{
 const file=path.join(leaf,"package.json"),original=readFileSync(file),pkg=JSON.parse(original.toString());
 try{writeFileSync(file,JSON.stringify({...pkg,overrides:{yaml:"2.9.1"}}));await expect(assertBundledEdges(authority,leaf)).rejects.toThrow("SHIPPING_LEAF_OVERRIDES_FORBIDDEN");writeFileSync(file,JSON.stringify({...pkg,bundleDependencies:[]}));await expect(assertBundledEdges(authority,leaf)).rejects.toThrow("SHIPPING_COMPLETE_BUNDLE_REQUIRED");}finally{writeFileSync(file,original);}
});
it("physical alias version drift fails normal semver rather than a caller-provided verdict",async()=>{
 const file=path.join(leaf,"node_modules/alias-yaml/package.json"),original=readFileSync(file),pkg=JSON.parse(original.toString());
 try{pkg.version="0.0.0";writeFileSync(file,JSON.stringify(pkg));await expect(assertBundledEdges(authority,leaf)).rejects.toThrow("SHIPPING_BUNDLED_EDGE_INVALID");}finally{writeFileSync(file,original);}
});
it("publisher and cold consumer preserve root/stage protections while leaf/cloud caller lack unusable override",()=>{
 const builder=readFileSync("scripts/build-cloud-package.mjs","utf8"),cold=readFileSync("scripts/verify-npm-shipping-installed.mjs","utf8"),strict=readFileSync("scripts/verify-cloud-package-candidate.mjs","utf8");
 expect(builder).not.toContain('  "overrides",');expect(builder).toContain('pkg.bundledDependencies = pkg.bundleDependencies');expect(cold).toContain('subdir === "root" ? { overrides:');expect(cold).toContain('SHIPPING_CLOUD_CALLER_OVERRIDE_FORBIDDEN');expect(cold).toContain('assertInstalledLockedVersions(root, installed)');expect(strict).toContain('await assertBundledEdges(root, dir)');
});

it("explicit filesystem alias root preserves normal valid alias edges",async()=>{
 const alias=path.join(home,"valid-root-alias");symlinkSync(leaf,alias,"dir");
 expect((await assertBundledEdges(authority,alias)).bundled_nodes).toBe(1);
});
it("explicit filesystem alias root rejects actual physical version drift",async()=>{
 const alias=path.join(home,"invalid-root-alias");symlinkSync(leaf,alias,"dir");
 const file=path.join(leaf,"node_modules/alias-yaml/package.json"),original=readFileSync(file),pkg=JSON.parse(original.toString());
 try{pkg.version="0.0.0";writeFileSync(file,JSON.stringify(pkg));await expect(assertBundledEdges(authority,alias)).rejects.toMatchObject({message:"SHIPPING_BUNDLED_EDGE_INVALID",invalid:expect.arrayContaining([expect.objectContaining({name:"alias-yaml",spec:"npm:yaml@2.9.1",error:"INVALID"})])});}finally{writeFileSync(file,original);}
});

it("fixed source authority still refuses a tracked source change before bundle inspection",async()=>{
 const file=path.join(authority,"README.md"),original=readFileSync(file);
 try{writeFileSync(file,Buffer.concat([original,Buffer.from("\nfixture drift\n")]));await expect(assertBundledEdges(authority,leaf)).rejects.toThrow("SHIPPING_SOURCE_DIRTY");}finally{writeFileSync(file,original);}
});

it("authority fixture rejects a different source identity even when it is a clean source checkout",()=>{
 execFileSync("git",["--no-replace-objects","-C",authority,"checkout","--detach","ac0e7c5406b29fbc2fa941e434b59d2d1ae0801c"],{stdio:"pipe"});
 try{expect(()=>assertVerifiedSourceIdentity(authority)).toThrow();}finally{execFileSync("git",["--no-replace-objects","-C",authority,"checkout","--detach",VERIFIED_SOURCE],{stdio:"pipe"});assertVerifiedSourceIdentity(authority);}
});
