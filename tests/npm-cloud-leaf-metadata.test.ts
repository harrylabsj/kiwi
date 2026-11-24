import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {createRequire} from "node:module";
import {beforeAll,afterAll,it,expect} from "vitest";
// The frozen 0.12.32 checkpoint stays in published history. Exercise the helper
// with that checkout's matching guard/contract so a version bump does not need
// to pin a pre-rebase commit. Check that the production helper and guard logic
// still match the fixture; this is not a release proof for the current source.
const VERIFIED_SOURCE = "8ce4e0e2531d63bfd7bdd6afd8e2157e309ff00d";
const VERIFIED_CONTRACT_SHA = "8e49bb10d0cfa160620ce2a09680004ecf0404474386b80365eaa79c438505bc";
const VERIFIED_GUARD_CLOSURE = {
  "scripts/lib/npm-bundled-edges.mjs": "23ffad0d820443ac3cb608a693dca0ce35a865f6e5efca38c32291dc88cd48fe",
  "scripts/lib/npm-shipping.mjs": "236a075d447cf1f40d6f97530f03892659135686cdedd227aff5ba4c916e8ffb",
  "scripts/check-install-toolchain.mjs": "ccb86a2707cb23f385f6428eb8c3f28df9ad0c0fe59b584e2b29ffe4eafd9c69",
  "build-inputs/release0124-npm12-payload.json": "ae7810234dbf422fba678c4c0956d31b82563131286c4adca6c2810cb435058a"
};
const digest = (file:string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function assertVerifiedSourceIdentity(root:string){
 expect(execFileSync("git",["--no-replace-objects","-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim()).toBe(VERIFIED_SOURCE);
 expect(digest(path.join(root,"build-inputs/release0124-source.json"))).toBe(VERIFIED_CONTRACT_SHA);
 for(const [file,sha] of Object.entries(VERIFIED_GUARD_CLOSURE))expect(digest(path.join(root,file))).toBe(sha);
}
let home:string,authority:string,leaf:string;
let assertBundledEdges: typeof import("../scripts/lib/npm-bundled-edges.mjs").assertBundledEdges;
beforeAll(()=>{
 home=mkdtempSync(path.join(tmpdir(),"leaf-edge-test-"));authority=path.join(home,"authority");leaf=path.join(home,"leaf");
 execFileSync("git",["clone","--no-hardlinks",process.cwd(),authority],{stdio:"pipe"});
 execFileSync("git",["--no-replace-objects","-C",authority,"checkout","--detach",VERIFIED_SOURCE],{stdio:"pipe"});
 assertVerifiedSourceIdentity(authority);
 const helper = "scripts/lib/npm-bundled-edges.mjs";
 expect(digest(path.join(process.cwd(),helper))).toBe(VERIFIED_GUARD_CLOSURE[helper]);
 const guard = "scripts/lib/npm-shipping.mjs";
 const withoutRelease = (root:string) => readFileSync(path.join(root,guard), "utf8")
   .replace(/^export const VERSION = "\d+\.\d+\.\d+";$/m, "export const VERSION = <release>;");
 expect(withoutRelease(process.cwd())).toBe(withoutRelease(authority));
 ({assertBundledEdges} = createRequire(import.meta.url)(path.join(authority,helper)));
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
 expect(builder).not.toContain('  "overrides",');expect(builder).not.toContain('pkg.bundledDependencies');expect(builder).toContain('package-lock.json');expect(cold).toContain('overrides: json(path.join(root, "package.json")).overrides');expect(cold).toContain('SHIPPING_CLOUD_CALLER_OVERRIDE_FORBIDDEN');expect(cold).toContain('SHIPPING_CLOUD_PACKAGE_MUST_NOT_BUNDLE_NODE_MODULES');expect(cold).toContain('assertInstalledLockedVersions(root, installed)');expect(strict).not.toContain('assertBundledEdges');expect(strict).toContain('package-lock.json');
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
