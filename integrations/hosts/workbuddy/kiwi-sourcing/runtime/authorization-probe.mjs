import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Test-only, in-memory and fake merchants; never invokes a real merchant or a
// WorkBuddy user approval. Execute only after independent package provenance,
// archive, dependency and installed-byte verification. This probe is necessary
// but not sufficient evidence that arbitrary future versions are safe.
export async function runAuthorizationProbe(packageRoot) {
  const load = rel => import(pathToFileURL(join(resolve(packageRoot), 'dist', rel)).href);
  const [{KiwiBuyerService},{TaskApprovalStore},{buildKiwiTools}] = await Promise.all([
    load('buyer-core/service.js'),load('buyer-core/store.js'),load('mcp/tools.js'),
  ]);
  const ts='2026-08-15T10:00:00+08:00';
  const policy={policy_id:'dp-test-001',version:'1.0',principal:'company:acme-test',created_at:ts,expires_at:'2099-12-31T23:59:59+08:00',actions:{discover:{mode:'auto'},inquiry_rfq:{mode:'auto'},compare_offers:{mode:'auto'},counter_offer:{mode:'auto'},accept_nonbinding:{mode:'ask'},handoff:{mode:'ask'},payment:{mode:'never'}},limits:{max_rounds:2,allowed_currencies:['CNY']}};
  const intent={intent_id:'intent-test-0001',intent_type:'purchase',items:[{query:'USB-C 扩展坞',sku:'dock-1',quantity:{value:2,unit:'台'}}],constraints:{budget:{currency:'CNY',amount_minor:100000},currency:'CNY',delivery_location:'杭州',deadline:'2026-08-30T18:00:00+08:00'},context_projection:{disclosure_boundary:'commerce_required',projected_fields:['items','constraints']}};
  const merchant={merchant_id:'merchant-001',name:'商家甲',verified:true,category:'it',region:'杭州',capabilities:['com.harrylabsj.kiwi.shopping.negotiation']};
  const index={async search(){return [merchant]},async resolveById(id){return id===merchant.merchant_id?merchant:undefined}};
  const quotes={async requestQuotes(_intent,merchants){return merchants.map(m=>({merchant_id:m.merchant_id,status:'succeeded',terms:{currency:'CNY',items:[{sku:'dock-1',quantity_value:2,quantity_unit:'台',unit_price_minor:12900}],total_price_minor:25800},provenance:{merchant_reply_id:'reply-test',negotiation_id:'neg-test',offer_id:'offer-test',source:'a2a'}}))}};
  async function setup() {
    const store=new TaskApprovalStore({dbPath:':memory:'});
    const service=new KiwiBuyerService({store,principal:'company:acme-test',buyerAgentId:'buyer-agent:test',sessionId:'session-test-1',delegationPolicy:policy,merchantIndex:index,quoteFetcher:quotes});
    const tools=buildKiwiTools(service); const call=(name,args)=>{const tool=tools.find(t=>t.name===name);assert.ok(tool,`missing ${name}`);return tool.handle(args)};
    const created=await service.requestQuotes({intent,idempotency_key:'rfq-test',merchant_ids:['merchant-001']});
    const winner=created.task.candidates.find(c=>c.status==='succeeded');assert.ok(winner);
    return {store,call,taskId:String(created.task.task_id),candidateId:String(winner.candidate_id)};
  }
  function body(result){return JSON.parse(result.content?.[0]?.text??'{}')}
  const first=await setup();
  try {
    const action={task_id:first.taskId,candidate_id:first.candidateId};
    const request=await first.call('kiwi_accept_agreement',action);
    assert.equal(request.isError,undefined);const id=body(request).approval_required?.approval_id;assert.equal(typeof id,'string');
    const approved=await first.call('kiwi_approve',{approval_id:id,note:'synthetic local approval'});assert.equal(body(approved).status,'approved');
    const result=await first.call('kiwi_accept_agreement',{...action,approval_id:id});assert.equal(body(result).agreement?.binding_effect,'nonbinding');
    const repeat=await first.call('kiwi_approve',{approval_id:id});assert.equal(repeat.isError,true);
  } finally {first.store.close();}
  const second=await setup();
  try {
    const action={task_id:second.taskId,candidate_id:second.candidateId};
    const request=await second.call('kiwi_accept_agreement',action);const id=body(request).approval_required?.approval_id;assert.equal(typeof id,'string');
    const rejected=await second.call('kiwi_reject',{approval_id:id,reason:'synthetic local rejection'});assert.equal(body(rejected).status,'denied');
    const result=await second.call('kiwi_accept_agreement',{...action,approval_id:id});assert.equal(result.isError,true);assert.match(result.content?.[0]?.text??'',/authorization_denied/);
  } finally {second.store.close();}
  const third=await setup();
  let hostEvidenceRequired;
  try {
    const action={task_id:third.taskId,candidate_id:third.candidateId};
    const request=await third.call('kiwi_accept_agreement',action);
    const id=body(request).approval_required?.approval_id;assert.equal(typeof id,'string');
    // Adversarial local call: no note, host identity, or user evidence. The
    // fact that an ASK record exists must not itself prove human consent.
    const bare=await third.call('kiwi_approve',{approval_id:id});
    hostEvidenceRequired=bare.isError===true;
  } finally {third.store.close();}
  return {approvalRequired:true,explicitApprovalWorks:true,repeatApprovalDenied:true,rejectionWins:true,nonbinding:true,hostEvidenceRequired};
}
