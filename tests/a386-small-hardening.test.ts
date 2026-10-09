import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { BuyerTaskStore } from '../src/agent/buyer/task-store.js';
import { migrateMemorySchema } from '../src/agent/memory/schema.js';
import { MemoryStore } from '../src/agent/memory/store.js';
import { PrivateVault, EnvKeyProvider } from '../src/agent/memory/vault.js';
import { buildBuyerTools } from '../src/agent/buyer/buyer-tools.js';
import { FakeCommerceConnector } from '../src/agent/connector/fake-connector.js';
import { TRACKING_RULE_TYPES } from '../src/agent/buyer/types.js';
import { ensurePathsForDir } from '../src/agent/agent-db.js';
import { openMainSessionManager, AgentSessionError } from '../src/agent/session.js';
import { AgentKernel } from '../src/agent/kernel.js';
import { createFakeChatModels } from '../src/agent/fake-chat-model.js';
import { createInMemoryDailyBudgetStore } from '../src/merchant/ai-runtime/gate.js';
import { SqliteDailyBudgetStore } from '../src/merchant/ai-runtime/sqlite-budget-store.js';
import { testBuyerProfile } from './helpers.js';
const dirs: string[]=[];
function dir(){const d=mkdtempSync(path.join(tmpdir(),'a386-'));dirs.push(d);return d;}
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
it('3-25 invalid direct rule input is typed validation and leaves zero rule/event rows',()=>{
 const db=new DatabaseSync(':memory:');try{
 migrateMemorySchema(db);const m=new MemoryStore({db,vault:new PrivateVault(new EnvKeyProvider('a'.repeat(64)))});
 m.ensurePrincipal({principal_id:'p',owner_id:'o',role:'buyer'});m.bindPrincipal('p');
 const s=new BuyerTaskStore({db,principalId:'p'});const t=s.createTask({goal_text:'fixture',intent:{},idempotency_key:'task'});
 for(const rule_type of ['bad',null,{},'price_below ']){
 expect(()=>s.addTrackingRule({task_id:t.task_id,rule_type:rule_type as never,condition:{},interval_seconds:60,idempotency_key:'bad'})).toThrowError(expect.objectContaining({code:'validation'}));}
 expect(db.prepare('select count(*) n from tracking_rules').get()).toMatchObject({n:0});
 expect(s.taskEvents(t.task_id).filter(e=>e.type==='buyer_rule_v1_added')).toHaveLength(0);
 for(const rule_type of TRACKING_RULE_TYPES) expect(s.addTrackingRule({task_id:t.task_id,rule_type,condition:{},interval_seconds:60,idempotency_key:rule_type}).rule_type).toBe(rule_type);
 }finally{db.close();}
});
for(const method of ['appendMessage','_persist','_rewriteFile'])it(`3-27 missing upstream ${method} fails closed with session error before disk writes`,()=>{
 const p=ensurePathsForDir(dir());const fake={appendMessage(){return 'x';},_persist(){},_rewriteFile(){},getSessionFile(){return p.mainSession;}};
 delete (fake as Record<string,unknown>)[method];vi.spyOn(SessionManager,'create').mockReturnValue(fake as unknown as SessionManager);
 expect(()=>openMainSessionManager(p,p.dir)).toThrowError(AgentSessionError);expect(existsSync(p.mainSession)).toBe(false);
});
it('3-27 actual upstream preserves 0600 and strips thinking',()=>{
 const p=ensurePathsForDir(dir());const {manager}=openMainSessionManager(p,p.dir);
 manager.appendMessage({role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_THOUGHT'},{type:'text',text:'public'}],api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
 expect(readFileSync(p.mainSession,'utf8')).not.toContain('PRIVATE_THOUGHT');expect(readFileSync(p.mainSession,'utf8')).toContain('public');expect(statSync(p.mainSession).mode&0o777).toBe(0o600);
});
it('3-29 invalid clock is explicit configuration failure before opening DB',async()=>{
 const p=ensurePathsForDir(dir());const models=createFakeChatModels();let k:AgentKernel|undefined;
 try{await expect(AgentKernel.open({paths:p,profile:testBuyerProfile(),...models,now:()=> 'not-a-date'}).then(x=>{k=x;return x;})).rejects.toThrow(/clock.*configuration|configuration.*clock/i);expect(existsSync(p.db)).toBe(false);}finally{await k?.close();}
});
for(const kind of ['memory','sqlite'])it(`3-35 ${kind} unknown, duplicate and first-settlement budget contract`,async()=>{
 const s=kind==='memory'?createInMemoryDailyBudgetStore():new SqliteDailyBudgetStore(path.join(dir(),'budget.db'));
 try{
 await expect(Promise.resolve().then(()=>s.settleTokens('day','unknown',100,1))).rejects.toMatchObject({code:'unknown_lease'});expect(await Promise.resolve(s.tryReserveTokens('day','probe-'+Math.random(),0,100)).then(x=>x.usedAfter)).toBe(0);
 expect(await s.tryReserveTokens('day','l',10,100)).toEqual({ok:true,usedAfter:10});
 expect(await s.tryReserveTokens('day','l',10,100)).toEqual({ok:true,usedAfter:10});
 await expect(Promise.resolve().then(()=>s.tryReserveTokens('day','l',11,100))).rejects.toMatchObject({code:'replay_conflict'});
 await s.settleTokens('day','l',999,7);await s.settleTokens('day','l',10,50);expect(await Promise.resolve(s.tryReserveTokens('day','probe-'+Math.random(),0,100)).then(x=>x.usedAfter)).toBe(7);
 await expect(Promise.resolve().then(()=>s.tryReserveTokens('day','l',10,100))).rejects.toMatchObject({code:'replay_conflict'});
 await s.releaseReservation('day','l');expect(await Promise.resolve(s.tryReserveTokens('day','probe-'+Math.random(),0,100)).then(x=>x.usedAfter)).toBe(7);
 }finally{if(s instanceof SqliteDailyBudgetStore)s.close();}
});

it('3-29 clock failing during open closes the acquired SQLite handle',async()=>{
 const p=ensurePathsForDir(dir());let n=0;const closed=vi.spyOn(DatabaseSync.prototype,'close');
 await expect(AgentKernel.open({paths:p,profile:testBuyerProfile(),...createFakeChatModels(),now:()=>++n===1?'2026-10-09T08:00:00+08:00':'invalid'})).rejects.toThrow(/clock.*configuration/);
 expect(closed).toHaveBeenCalledTimes(1);
});

it('3-25 tool direct invalid enum returns validation before any claim or rule event',async()=>{
 const db=new DatabaseSync(':memory:');try{migrateMemorySchema(db);const m=new MemoryStore({db,vault:new PrivateVault(new EnvKeyProvider('a'.repeat(64)))});m.ensurePrincipal({principal_id:'p',owner_id:'o',role:'buyer'});m.bindPrincipal('p');const store=new BuyerTaskStore({db,principalId:'p'});const task=store.createTask({goal_text:'fixture',intent:{},idempotency_key:'create'});const tool=buildBuyerTools({store,connector:new FakeCommerceConnector(),profile:testBuyerProfile(),now:()=>new Date().toISOString()}).find(t=>t.name==='add_tracking_rule')!;const before=store.taskEvents(task.task_id).length;const result=await tool.execute('call-invalid',{task_id:task.task_id,rule_type:'bad',condition:{},interval_seconds:60});expect(JSON.stringify(result)).toContain('validation');expect(store.taskEvents(task.task_id)).toHaveLength(before);expect(db.prepare('select count(*) n from tracking_rules').get()).toMatchObject({n:0});}finally{db.close();}
});
