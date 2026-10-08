import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { afterEach, expect, it } from "vitest";
import type { StoredTask } from "../src/buyer-core/store.js";
const sourceRoot=process.env.A359_BASELINE_SOURCE ?? path.resolve("src");
const { TaskApprovalStore }=await import(path.join(sourceRoot,"buyer-core/store.ts"));
import type { WorkbenchRetentionStore as RetentionStore } from "../src/privacy/workbench-retention.js";
const { WorkbenchRetentionStore, recommendedRetentionPolicy }=await import(path.join(sourceRoot,"privacy/workbench-retention.ts"));
const T = "2026-10-08T00:00:00.000Z";
const dirs: string[] = [];
function temp() { const d=mkdtempSync(path.join(tmpdir(),"a359-cas-")); dirs.push(d); return d; }
afterEach(()=> { for(const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); });
function task(id="t1", key="k1"): StoredTask { return {task_id:id, task_kind:"quotes", status:"pending", idempotency_key:key, created_at:T, updated_at:T, resumable:true,payload:JSON.stringify({steps:[]})}; }
it("3-7 stale full payload cannot overwrite another connection at the same clock",()=> {
 const file=path.join(temp(),"tasks.sqlite"); const a=new TaskApprovalStore({dbPath:file,now:()=>T}); const b=new TaskApprovalStore({dbPath:file,now:()=>T});
 try { a.createTask(task()); const old=a.getTask("t1")!; const winner=b.updateTask("t1",{status:"succeeded",payload:'{"steps":["B"]}'},b.getTask("t1")!);
 expect(()=>a.updateTask("t1",{payload:'{"steps":["A"]}'},old)).toThrow(/changed/); expect(a.getTask("t1")).toEqual(winner);
 expect(()=>a.updateTask("t1",{payload:"{}"})).toThrow(/snapshot/);
 expect(a.updateTask("t1",{resumable:false}).resumable).toBe(false);
 expect(()=>a.createTask(task("t1","different-key"))).toThrow();
 } finally { a.close();b.close(); }
});
it("3-7 scalar compatibility uses SQL CAS even when a writer changes state after read",()=> {
 const file=path.join(temp(),"tasks.sqlite");const a=new TaskApprovalStore({dbPath:file,now:()=>T});const b=new TaskApprovalStore({dbPath:file,now:()=>T});
 try {a.createTask(task());const get=a.getTask.bind(a);let intercepted=false;
 a.getTask=(id: string)=> {const row=get(id);if(!intercepted){intercepted=true;b.updateTask(id,{status:"succeeded"});}return row;};
 expect(()=>a.updateTask("t1",{resumable:false})).toThrow(/changed/);expect(b.getTask("t1")?.status).toBe("succeeded");expect(b.getTask("t1")?.resumable).toBe(true);
 } finally {a.close();b.close();}
});
it("3-7 two child processes racing the actual insert return the same authoritative task",async()=> {
 const dir=temp(); const dbPath=path.join(dir,"tasks.sqlite");new TaskApprovalStore({dbPath}).close();
 const bundle=path.join(dir,"store.mjs");buildSync({entryPoints:[path.join(sourceRoot,"buyer-core/store.ts")],outfile:bundle,bundle:true,platform:"node",format:"esm"});
 const fixture=path.resolve("tests/fixtures/a359-task-create-child.mjs");
 const children=["a","b"].map(actor=> {const child=spawn(process.execPath,[fixture,JSON.stringify({dir,dbPath,bundle,actor,task:task(actor,"shared")})],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",d=>out+=d);child.stderr.on("data",d=>err+=d);return {child,done:new Promise<{code:number|null,out:string,err:string}>(resolve=>child.on("close",code=>resolve({code,out,err})))};});
 try {const deadline=Date.now()+10000;while(!["a","b"].every(a=>existsSync(path.join(dir,a+".ready")))){if(Date.now()>deadline)throw new Error("insert barrier timeout");await new Promise(r=>setTimeout(r,10));}
 writeFileSync(path.join(dir,"go"),"");const results=await Promise.all(children.map(c=>c.done));for(const r of results)expect(r.code,r.err).toBe(0);
 const values=results.map(r=>JSON.parse(r.out));expect(values.filter(r=>r.created)).toHaveLength(1);expect(new Set(values.map(r=>r.task.task_id)).size).toBe(1);
 const verify=new DatabaseSync(dbPath);expect(verify.prepare("SELECT COUNT(*) n FROM mcp_tasks").get()?.n).toBe(1);verify.close();
 }finally {for(const c of children)if(c.child.exitCode===null)c.child.kill("SIGTERM");}
});
function privacy(db: DatabaseSync, now:()=>string=()=>T) { const s=new WorkbenchRetentionStore({db,now});s.configurePolicy(recommendedRetentionPolicy({processor:"test",basis:"test",reviewAt:"2027-01-01T00:00:00Z"}));return s; }
function processing(s:RetentionStore){const r=s.receiveBuyerDeletionRequest({merchantId:"m",buyerPrincipalId:"b"});s.transition(r.requestId,"IDENTITY_CHECK");s.transition(r.requestId,"SCOPED");s.transition(r.requestId,"PROCESSING");for(const nodeId of ["runtime-primary","negotiation-ledger","buyer-preferences","runtime-cache","controlled-backup"])s.recordDeletionTask({requestId:r.requestId,nodeId,status:"completed",receiptRef:nodeId});return r.requestId;}
it("3-44 competing connection cannot finish between original state read and transition write",()=> {
 const file=path.join(temp(),"privacy.sqlite"),aDb=new DatabaseSync(file),bDb=new DatabaseSync(file);let armed=false,blocked=false,id="";
 const b=privacy(bDb);const a=privacy(aDb,()=>{if(armed){armed=false;try{b.transition(id,"COMPLETED");}catch(e){blocked=/locked|busy/.test(String(e));}}return T;});
 try{id=processing(a);armed=true;expect(a.transition(id,"RESTRICTED").status).toBe("RESTRICTED");expect(blocked).toBe(true);expect(()=>b.transition(id,"COMPLETED")).toThrow(/cannot transition/);
 }finally{aDb.close();bDb.close();}
});
it("3-44 nested failure preserves caller writes and ownership; caller rollback reverts successful transition",()=> {
 const db=new DatabaseSync(":memory:"),s=privacy(db),id=processing(s);db.exec("CREATE TABLE scratch(value TEXT); BEGIN; INSERT INTO scratch VALUES ('caller')");
 try {db.prepare("UPDATE workbench_privacy_deletion_tasks SET status='pending' WHERE request_id=?").run(id);
 expect(()=>s.transition(id,"COMPLETED")).toThrow(/controlled nodes/);expect(db.isTransaction).toBe(true);expect(db.prepare("SELECT value FROM scratch").get()?.value).toBe("caller");
 expect(s.transition(id,"RESTRICTED").status).toBe("RESTRICTED");expect(db.isTransaction).toBe(true);db.exec("ROLLBACK");expect(db.prepare("SELECT COUNT(*) n FROM scratch").get()?.n).toBe(0);expect(db.prepare("SELECT status FROM workbench_privacy_requests WHERE request_id=?").get(id)?.status).toBe("PROCESSING");
 }finally{if(db.isTransaction)db.exec("ROLLBACK");db.close();}
});

it("3-7 production quote call carries persisted context; stale completion neither overwrites nor resends",async()=> {
 const {buildBuyerService}=await import(path.join(sourceRoot,"buyer-core/build-service.ts"));
 const service=buildBuyerService({dbPath:":memory:",principal:"company:cas",buyerAgentId:"buyer:cas",sessionId:"cas",policy:{policy_id:"p-cas",version:"1.0",principal:"company:cas",expires_at:"2099-12-31T23:59:59Z",actions:{discover:{mode:"auto"},inquiry_rfq:{mode:"auto"},compare_offers:{mode:"auto"},counter_offer:{mode:"auto"},accept_nonbinding:{mode:"auto"},handoff:{mode:"ask"},payment:{mode:"never"}}}});
 const internals=service as unknown as {store: InstanceType<typeof TaskApprovalStore>;quoteFetcher: {requestQuotes: (...args: unknown[])=>Promise<never[]>}};
 let calls=0,taskId="";
 internals.quoteFetcher={requestQuotes:async(_intent,_merchants,context)=>{calls++; const c=context as {taskId:string;createdAt:string;intentBindingDigest:string};const stored=internals.store.getTask(c.taskId)!;expect({taskId:c.taskId,createdAt:c.createdAt}).toEqual({taskId:stored.task_id,createdAt:stored.created_at});expect(c.intentBindingDigest).toMatch(/^sha256:/);taskId=c.taskId;internals.store.updateTask(c.taskId,{status:"succeeded"});return [];}};
 const input={intent:{intent_id:"int-cas",intent_type:"purchase",items:[{query:"cup",quantity:{value:1,unit:"个"}}]},merchant_ids:["m"],idempotency_key:"cas-quotes"};
 try {await expect(service.requestQuotes(input)).rejects.toThrow(/changed/);expect(internals.store.getTask(taskId)?.status).toBe("succeeded");const retry=await service.requestQuotes(input);expect(retry.created).toBe(false);expect(calls).toBe(1);}
 finally{internals.store.close();}
});
