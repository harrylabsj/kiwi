import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it,vi } from 'vitest';
import { AgentKernel } from '../src/agent/kernel.js';
import { ensurePathsForDir } from '../src/agent/agent-db.js';
import { createFakeChatModels } from '../src/agent/fake-chat-model.js';
import { FakeCommerceConnector } from '../src/agent/connector/fake-connector.js';
import { PrivateVault,EnvKeyProvider } from '../src/agent/memory/vault.js';
import { HandoffEventStore,createHandoffCandidate } from '../src/handoff/index.js';
import type { LedgerEvent } from '../src/negotiation/ledger/event.js';
import { testBuyerProfile } from './helpers.js';
it('3-28 order, duplicate-created first display/last lifecycle, missing keys, unrelated kind, negotiation and read isolation',async()=>{
 const d=mkdtempSync(path.join(tmpdir(),'a386-summary-'));const kernels:AgentKernel[]=[];
 try{
 const open=async(connector:boolean)=>{const k=await AgentKernel.open({paths:ensurePathsForDir(path.join(d,String(kernels.length))),profile:testBuyerProfile(),...createFakeChatModels(),...(connector?{connector:new FakeCommerceConnector()}:{}),vault:new PrivateVault(new EnvKeyProvider('e'.repeat(64)))});kernels.push(k);return k;};
 const off=await open(false);expect(off.handoffSummary).toEqual({enabled:false});
 const k=await open(true);const ledger=new HandoffEventStore({dir:path.join(d,'seed')});
 const candidate=createHandoffCandidate({agreement_id:'a',negotiation_id:'neg1',agreed_terms:{items:[{sku:'s',quantity:{value:1,unit:'piece'}}]},buyer_identity_ref:'p',merchant_identity_ref:'m',destination:{type:'external_checkout_url',ref:'https://merchant.example/one'},display_summary:{merchant:'FIRST',summary:'FIRST'},policy_version:'v1',expires_at:'2026-10-10T00:00:00Z'});
 const seed=ledger.appendCandidateEvent({kind:'handoff_candidate_created',candidate,identity:{sender_identity:'p',counterparty_identity:'m',actor:'buyer'},capability:{capability:'com.harrylabsj.kiwi.shopping.negotiation',protocol_version:'1.0'}});
 const event=(kind:LedgerEvent['event_kind'],id:string|undefined,extra:Partial<LedgerEvent>={}):LedgerEvent=>{const result={...seed,event_kind:kind,...extra};if(id===undefined)delete result.handoff_candidate_id;else result.handoff_candidate_id=id;return result;};
 const chain1=[event('handoff_candidate_created','same'),event('handoff_delivered',undefined,{handoff_id:'h2'}),event('handoff_candidate_ready','same'),event('message_sent','ghost',{outcome:{kind:'ok',result:{}}}),event('handoff_candidate_created','same',{outcome:{kind:'ok',result:{candidate:{...candidate,display_summary:{merchant:'SECOND',summary:'SECOND'}}}}}),event('handoff_delivered','same',{handoff_id:'h1'}),event('handoff_launched','same',{handoff_id:'h1'}),event('message_sent',undefined,{outcome:{kind:'ok',result:{}}})];
 const chain2=[event('handoff_candidate_created','same',{negotiation_id:'neg2',outcome:{kind:'ok',result:{candidate:{...candidate,display_summary:{merchant:'OTHER_NEG',summary:'OTHER_NEG'}}}}})];
 vi.spyOn(HandoffEventStore.prototype,'listNegotiations').mockReturnValue(['neg1','neg2']);vi.spyOn(HandoffEventStore.prototype,'events').mockImplementation(id=>id==='neg1'?chain1:chain2);
 const first=k.handoffSummary;if(!first.enabled)throw new Error('expected enabled');
 expect(first.candidates.map(x=>[x.candidate_id,x.negotiation_id,x.lifecycle,x.display_summary.merchant])).toEqual([['same','neg1','PROPOSED','FIRST'],['ghost','neg1','UNKNOWN','?'],['same','neg2','PROPOSED','OTHER_NEG']]);
 expect(first.handoffs).toEqual([{handoff_id:'h2',delivery:'DELIVERED'},{handoff_id:'h1',delivery:'LAUNCHED'}]);
 chain1.push(event('handoff_candidate_ready','same'));const second=k.handoffSummary;if(!second.enabled)throw new Error('expected enabled');expect(second.candidates[0]?.lifecycle).toBe('READY');expect(second.candidates[2]?.lifecycle).toBe('PROPOSED');expect(first.candidates[0]?.lifecycle).toBe('PROPOSED');
 }finally{vi.restoreAllMocks();for(const k of kernels)await k.close();rmSync(d,{recursive:true,force:true});}
});
