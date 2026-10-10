import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { assertForeignCheckouts, assertSource, sourceContract } from "../scripts/lib/npm-shipping.mjs";
const base = process.cwd(), names = ["shopping-cli", "kiwi-catalog", "hermes-plugin-kiwi"];
let home: string, root: string;
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const commit = (dir: string) => { git(dir,"add","."); git(dir,"-c","user.name=Synthetic Consumer Test","-c","user.email=synthetic@example.invalid","commit","-m","synthetic reviewed source"); };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
afterAll(() => rmSync(home,{recursive:true,force:true}));
beforeAll(() => {
  home=mkdtempSync(path.join(tmpdir(),"shipping-consumer-")); root=path.join(home,"root");
  git(base,"clone","--no-hardlinks",base,root);
  const lock=JSON.parse(readFileSync(path.join(root,"portfolio.lock.json"),"utf8"));
  const products=JSON.parse(readFileSync(path.join(root,"portfolio-products.json"),"utf8"));
  for (const name of names) {
    const dir=path.join(home,name);mkdirSync(dir);git(dir,"init");
    writeFileSync(path.join(dir,".gitignore"),".env\n.venv/\n");
    writeFileSync(path.join(dir,"tracked.txt"),"reviewed exact blob\n");
    if(name==="hermes-plugin-kiwi")writeFileSync(path.join(dir,"plugin.json"),JSON.stringify({version:products.products.find((p:{id:string})=>p.id===name).version}));
    else {
      const relative=name==="shopping-cli"?"shopping_cli/contracts":"kiwi_catalog/contracts";
      mkdirSync(path.join(dir,relative),{recursive:true});
      writeFileSync(path.join(dir,relative,"kiwi-contracts.lock.json"),JSON.stringify({source_commit:lock.contract_source_commit,bundle_sha256:lock.contract_bundle_sha256}));
    }
    commit(dir);const sha=git(dir,"rev-parse","HEAD");
    if(name==="hermes-plugin-kiwi")products.products.find((p:{id:string})=>p.id===name).source_commit=sha;
    else lock.repositories[name].commit=sha;
  }
  writeFileSync(path.join(root,"portfolio.lock.json"),JSON.stringify(lock,null,2)+"\n");
  writeFileSync(path.join(root,"portfolio-products.json"),JSON.stringify(products,null,2)+"\n");
  commit(root);
  writeFileSync(path.join(root,"build-inputs/release0124-source.json"),JSON.stringify(sourceContract(root),null,2)+"\n");commit(root);
  for(const name of names)renameSync(path.join(home,name),path.join(root,name));
},20000);
function change(file: string, value: string) {
  const old=readFileSync(file);writeFileSync(file,value);cleanups.push(()=>writeFileSync(file,old));
}
it("accepts exact clean three Git roots and excludes only their paths from root source",()=>{
  expect(assertForeignCheckouts(root)).toEqual(names);expect(()=>assertSource(root)).not.toThrow();
  const contract=sourceContract(root) as {files:Array<{path:string}>};
  expect(contract.files.some(row=>names.some(n=>row.path===n||row.path.startsWith(n+"/")))).toBe(false);
});
it("accepts optional missing roots and quality's shopping-only composition",()=>{
  for(const name of names.slice(1)){renameSync(path.join(root,name),path.join(home,name));cleanups.push(()=>renameSync(path.join(home,name),path.join(root,name)));}
  expect(assertForeignCheckouts(root)).toEqual(["shopping-cli"]);expect(()=>assertSource(root)).not.toThrow();
  renameSync(path.join(root,"shopping-cli"),path.join(home,"shopping-cli"));cleanups.push(()=>renameSync(path.join(home,"shopping-cli"),path.join(root,"shopping-cli")));
  expect(assertForeignCheckouts(root)).toEqual([]);expect(()=>assertSource(root)).not.toThrow();
});
it("refuses a wrong foreign HEAD",()=>{
  const dir=path.join(root,"shopping-cli"), head=git(dir,"rev-parse","HEAD");writeFileSync(path.join(dir,"extra.txt"),"extra");commit(dir);
  cleanups.push(()=>git(dir,"reset","--hard",head));expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_HEAD_CHANGED");
});
it("refuses tracked byte drift even with assume-unchanged",()=>{
  const dir=path.join(root,"shopping-cli"), file=path.join(dir,"tracked.txt");git(dir,"update-index","--assume-unchanged","tracked.txt");
  cleanups.push(()=>git(dir,"update-index","--no-assume-unchanged","tracked.txt"));change(file,"tampered");
  expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_TRACKED_CHANGED");
});
it("refuses tracked mode drift",()=>{
  const file=path.join(root,"shopping-cli/tracked.txt");chmodSync(file,0o755);cleanups.push(()=>chmodSync(file,0o644));
  expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_TRACKED_CHANGED");
});
it.each([".env","unknown.sqlite",".venv/private.sqlite"])("refuses foreign untracked or ignored state %s",name=>{
  const file=path.join(root,"shopping-cli",name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,"SYNTHETIC_ONLY");
  cleanups.push(()=>rmSync(name.startsWith(".venv/")?path.join(root,"shopping-cli/.venv"):file,{recursive:true,force:true}));
  expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_DIRTY");
});
it("refuses even an empty ignored generated directory",()=>{
  const dir=path.join(root,"shopping-cli/.venv");mkdirSync(dir);cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_DIRTY");
});
it("refuses unreviewed root pin metadata",()=>{
  change(path.join(root,"portfolio.lock.json"),"{}\n");expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_AUTHORITY_CHANGED");
});
it("refuses symlink and a same-name directory without its own Git root",()=>{
  const dir=path.join(root,"shopping-cli"),saved=path.join(home,"saved");renameSync(dir,saved);
  cleanups.push(()=>{rmSync(dir,{recursive:true,force:true});renameSync(saved,dir);});
  symlinkSync(saved,dir,"dir");expect(()=>assertForeignCheckouts(root)).toThrow("SHIPPING_FOREIGN_ROOT_INVALID");
  rmSync(dir);mkdirSync(dir);expect(()=>assertForeignCheckouts(root)).toThrow();
});
it.each(["unknown-repo","shopping-cli-suffix"])("rejects root foreign directory not precisely named %s",name=>{
  const dir=path.join(root,name);cpSync(path.join(root,"shopping-cli"),dir,{recursive:true});cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  expect(()=>assertSource(root)).toThrow();
});

function isolatedTree() {
  const isolated=mkdtempSync(path.join(home,"isolated-"));cpSync(root,isolated,{recursive:true});
  cleanups.push(()=>rmSync(isolated,{recursive:true,force:true}));return isolated;
}
it("ignores foreign Git replacement objects and rejects nominal-pin substituted bytes without deleting refs",()=>{
  const copy=isolatedTree(), dir=path.join(copy,"shopping-cli"), pin=git(dir,"rev-parse","HEAD");
  writeFileSync(path.join(dir,"tracked.txt"),"REPLACED_SYNTHETIC_BLOB");commit(dir);const replacement=git(dir,"rev-parse","HEAD");
  git(dir,"replace",pin,replacement);git(dir,"reset","--hard",pin);
  expect(git(dir,"rev-parse","HEAD")).toBe(pin);expect(git(dir,"status","--porcelain")).toBe("");
  expect(()=>assertForeignCheckouts(copy)).toThrow("SHIPPING_FOREIGN_TRACKED_CHANGED");
  expect(git(dir,"replace","-l")).toContain(pin);
});
it("root replace cannot forge a new contract/tree under the reviewed nominal source commit",()=>{
  const copy=isolatedTree(), pin=git(copy,"rev-parse","HEAD");
  writeFileSync(path.join(copy,"README.md"),"SYNTHETIC_ROOT_REPLACEMENT");
  git(copy,"add","--","README.md");git(copy,"-c","user.name=Synthetic Consumer Test","-c","user.email=synthetic@example.invalid","commit","-m","synthetic root bytes");
  writeFileSync(path.join(copy,"build-inputs/release0124-source.json"),JSON.stringify(sourceContract(copy),null,2)+"\n");
  git(copy,"add","--","build-inputs/release0124-source.json");git(copy,"-c","user.name=Synthetic Consumer Test","-c","user.email=synthetic@example.invalid","commit","-m","synthetic replacement contract");
  const replacement=git(copy,"rev-parse","HEAD");git(copy,"replace",pin,replacement);git(copy,"reset","--hard",pin);
  expect(git(copy,"rev-parse","HEAD")).toBe(pin);expect(git(copy,"status","--porcelain").split("\n").every(row=>row.startsWith("?? "))).toBe(true);
  expect(()=>assertSource(copy)).toThrow("SHIPPING_UNCOMMITTED_CONTRACT");expect(git(copy,"replace","-l")).toContain(pin);
});
it.each(["root","foreign"])("rejects %s legacy graft graphs without removing local metadata",target=>{
  const copy=isolatedTree(), dir=target==="root"?copy:path.join(copy,"shopping-cli"), pin=git(dir,"rev-parse","HEAD");
  const file=path.join(dir,".git/info/grafts");writeFileSync(file,pin+"\n");
  expect(git(dir,"rev-list","--count","HEAD")).toBe("1");
  expect(()=>assertSource(copy)).toThrow("SHIPPING_GIT_GRAFTS_NOT_ALLOWED");expect(readFileSync(file,"utf8")).toBe(pin+"\n");
});
