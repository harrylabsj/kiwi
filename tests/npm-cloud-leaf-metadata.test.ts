import {execFileSync} from "node:child_process";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {beforeAll,afterAll,it,expect} from "vitest";
import {assertBundledEdges} from "../scripts/lib/npm-bundled-edges.mjs";
let home:string,authority:string,leaf:string;
beforeAll(()=>{
 home=mkdtempSync(path.join(tmpdir(),"leaf-edge-test-"));authority=path.join(home,"authority");leaf=path.join(home,"leaf");
 execFileSync("git",["clone","--no-hardlinks",process.cwd(),authority],{stdio:"pipe"});mkdirSync(path.join(leaf,"node_modules"),{recursive:true});
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
