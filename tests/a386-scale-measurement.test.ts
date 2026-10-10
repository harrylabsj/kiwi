import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { mkdtempSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect,it,vi } from 'vitest';
import { MemoryStore } from '../src/agent/memory/store.js';
import { migrateMemorySchema } from '../src/agent/memory/schema.js';
import { PrivateVault,EnvKeyProvider } from '../src/agent/memory/vault.js';
import { AgentKernel } from '../src/agent/kernel.js';
import { ensurePathsForDir } from '../src/agent/agent-db.js';
import { createFakeChatModels } from '../src/agent/fake-chat-model.js';
import { FakeCommerceConnector } from '../src/agent/connector/fake-connector.js';
import { HandoffEventStore,createHandoffCandidate } from '../src/handoff/index.js';
import type { LedgerEvent } from '../src/negotiation/ledger/event.js';
import { testBuyerProfile } from './helpers.js';
const observations:unknown[]=[];
it('3-26 actual retrieve linear scan, selective namespace and deterministic sorted output',()=>{
 for(const n of [100,1000,10000]){
 const db=new DatabaseSync(':memory:');try{
 migrateMemorySchema(db);const store=new MemoryStore({db,vault:new PrivateVault(new EnvKeyProvider('c'.repeat(64))),now:()=> '2026-10-09T00:00:00Z'});
 store.ensurePrincipal({principal_id:'p',owner_id:'o',role:'buyer'});store.bindPrincipal('p');
 const insert=db.prepare("INSERT INTO memory_items(memory_id,principal_id,namespace,key,value_json,scope_json,source_kind,confidence,sensitivity,status,created_at,updated_at) VALUES (?,?,?,?,?,'{}','explicit',1,'normal','active',?,?)");
 db.exec('BEGIN');for(let i=0;i<n;i++)insert.run('m'+String(i).padStart(6,'0'),'p',i%100===0?'preference':'episode','key'+i,JSON.stringify({fixture:'same'}),'2026-10-09T00:00:00Z','2026-10-09T00:00:00Z');db.exec('COMMIT');
 const ns=['preference'] as const;const query={session_id:'main',purpose:'rank' as const,namespaces:[...ns],limit:8};
 const timings=[];let ids:string[]=[];
 for(let j=0;j<4;j++){const t=performance.now();ids=store.retrieve(query).map(x=>x.memory_id);timings.push(performance.now()-t);}
 const expected=Array.from({length:Math.ceil(n/100)},(_,i)=>'m'+String(i*100).padStart(6,'0')).sort((a,b)=>a.localeCompare(b)).slice(0,8);expect(ids).toEqual(expected);
 const plan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM memory_items WHERE principal_id = ? AND status IN ('active','needs_review')").all('p');
 observations.push({id:'3-26',n,eligible:Math.ceil(n/100),returned:ids.length,ms:timings,selectedIDs:ids,scanRows:n,queryPlan:plan});
 }finally{db.close();}}
});
it('3-28 real kernel summary projection scale and filter visits; ledger I/O excluded explicitly',async()=>{
 const d=mkdtempSync(path.join(tmpdir(),'a386-perf-'));let k:AgentKernel|undefined;
 try{
 k=await AgentKernel.open({paths:ensurePathsForDir(d),profile:testBuyerProfile(),...createFakeChatModels(),connector:new FakeCommerceConnector(),vault:new PrivateVault(new EnvKeyProvider('d'.repeat(64)))});
 const ledger=new HandoffEventStore({dir:d});const c=createHandoffCandidate({agreement_id:'a',negotiation_id:'perf-neg',agreed_terms:{items:[{sku:'s',quantity:{value:1,unit:'piece'}}]},buyer_identity_ref:'p',merchant_identity_ref:'m',destination:{type:'external_checkout_url',ref:'https://merchant.example/checkout'},display_summary:{merchant:'fixture',summary:'fixture'},policy_version:'v1',expires_at:'2026-10-10T00:00:00Z'});
 const seed=ledger.appendCandidateEvent({kind:'handoff_candidate_created',candidate:c,identity:{sender_identity:'p',counterparty_identity:'m',actor:'buyer'},capability:{capability:'com.harrylabsj.kiwi.shopping.negotiation',protocol_version:'1.0'}});
 vi.spyOn(HandoffEventStore.prototype,'listNegotiations').mockReturnValue(['perf-neg']);
 for(const count of [25,250,2500]){
 const events:LedgerEvent[]=[];
 for(let i=0;i<count;i++)for(const kind of ['handoff_candidate_created','handoff_candidate_ready','handoff_delivered'] as const)events.push({...seed,event_kind:kind,handoff_candidate_id:'candidate'+i,...(kind==='handoff_delivered'?{handoff_id:'handoff'+i}:{}),outcome:kind==='handoff_candidate_created'?{kind:'ok',result:{candidate:c}}:{kind:'ok',result:{}}});
 vi.spyOn(HandoffEventStore.prototype,'events').mockReturnValue(events);
 let visits=0;const original=Array.prototype.filter;
 const spy=vi.spyOn(Array.prototype,'filter').mockImplementation(function<T>(this:T[],predicate:(value:T,index:number,array:T[])=>unknown,thisArg?:unknown){return original.call(this,(v:T,i:number,a:T[])=>{if((v as unknown as {negotiation_id?:string})?.negotiation_id==='perf-neg')visits++;return predicate.call(thisArg,v,i,a);});});
 const t=performance.now();const summary=k.handoffSummary;const elapsed=performance.now()-t;spy.mockRestore();
 expect(summary.enabled).toBe(true);if(!summary.enabled)throw new Error('expected enabled');expect(summary.candidates.map(x=>x.candidate_id)).toEqual(Array.from({length:count},(_,i)=>'candidate'+i));expect(summary.candidates.every(x=>x.lifecycle==='READY')).toBe(true);expect(summary.handoffs).toHaveLength(count);
 const uninstrumentedMs=[];for(let run=0;run<3;run++){const start=performance.now();const repeated=k.handoffSummary;uninstrumentedMs.push(performance.now()-start);expect(repeated).toEqual(summary);}
 observations.push({uninstrumentedMs,id:'3-28',events:events.length,candidates:count,handoffs:count,ms:elapsed,filterPredicateVisits:visits,scope:'real getter + real resolved event format; synthetic expanded events via read seam; no disk I/O benchmark'});
 }
 }finally{vi.restoreAllMocks();await k?.close();rmSync(d,{recursive:true,force:true});}
 const output=path.resolve(process.env.A386_SCALE_OUTPUT ?? '../raw/scale-measurement.json');
 mkdirSync(path.dirname(output),{recursive:true});
 writeFileSync(output,JSON.stringify(observations,null,2)+'\n');
 for(const o of observations as Array<{id:string;events?:number;filterPredicateVisits?:number}>)if(o.id==='3-28')expect(o.filterPredicateVisits).toBeLessThanOrEqual(o.events! * 3);
});
