import process from "node:process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import path from "node:path";
const o=JSON.parse(process.argv[2]);
const original=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql){const stmt=original.call(this,sql);if(sql.includes("INSERT INTO mcp_tasks")){const run=stmt.run.bind(stmt);stmt.run=(...args)=>{this.exec("PRAGMA busy_timeout=5000");fs.writeFileSync(path.join(o.dir,o.actor+".ready"),"");const deadline=Date.now()+10000;while(!fs.existsSync(path.join(o.dir,"go"))){if(Date.now()>deadline)throw new Error("barrier timeout");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return run(...args);};}return stmt;};
const {TaskApprovalStore}=await import(pathToFileURL(o.bundle).href);const s=new TaskApprovalStore({dbPath:o.dbPath});try{process.stdout.write(JSON.stringify(s.createTask(o.task)));}finally{s.close();}
