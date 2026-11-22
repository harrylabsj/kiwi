// Run against an extracted expert ZIP in an isolated HOME. No network required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(process.argv[2]);
const runtime = name => pathToFileURL(resolve(root, 'runtime', name));
const core = name => import(runtime('buyer/node_modules/@harrylabsj/kiwi/dist/' + name));
const protocolVersion = '2025-06-18';
const baseline = JSON.parse(readFileSync(runtime('mcp-tools-0.12.12.json')));
const { startProductionMcpServer } = await import(runtime('mcp-production-server.mjs'));
const { A2ANegotiator } = await core('buyer-core/a2a-negotiator.js');
const { KiwiBuyerService } = await core('buyer-core/service.js');
const { TaskApprovalStore } = await core('buyer-core/store.js');
const { buildKiwiTools } = await core('mcp/tools.js');
const item = {sku:'LAMP',query:'desk lamp',quantity:{value:1,unit:'piece'}};
const intent = {intent_id:'audit',intent_type:'inquiry',items:[item]};
const frame = (method, params, id) => JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n';

await test('P1-4 / P2-1 · cold package entry, multi-item and missing quantity', {timeout:15000}, async () => {
  const [name, config] = Object.entries(JSON.parse(readFileSync(resolve(root,'.mcp.json'))).mcpServers)[0];
  const start = performance.now();
  const child = spawn(config.command,config.args,{cwd:root,stdio:['pipe','pipe','inherit']});
  const closed = new Promise(resolve => child.on('close',resolve));
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let id = 0;
  async function request(method,params) {
    child.stdin.write(frame(method,params,++id));
    const {value} = await lines.next();
    const reply = JSON.parse(value);
    assert.equal(reply.id,id);
    return reply.result;
  }
  try {
    const hello = await request('initialize',{protocolVersion,capabilities:{}});
    assert.equal(hello.serverInfo.name,name);
    child.stdin.write(frame('notifications/initialized',{}));
    const {tools} = await request('tools/list',{});
    assert.equal(tools.length,13);
    assert.ok(tools.find(t=>t.name==='kiwi_negotiate').inputSchema.properties.candidate_id);
    const rfq = {name:'kiwi_request_quotes',arguments:{intent,merchant_ids:[],idempotency_key:'cold-rfq'}};
    let result = await request('tools/call',rfq);
    if (result.structuredContent?.code === 'PREPARATION_IN_PROGRESS') {
      assert.equal(result.structuredContent.requestSent,false);
      const read = await request('tools/call',{name:'kiwi_get_task',arguments:{task_id:'absent'}});
      assert.match(read.content[0].text,/task_not_found/);
      result = await request('tools/call',rfq);
    }
    assert.deepEqual(result.structuredContent,{code:'clarification_needed',reason:'merchant_required'});
    console.log('Cold first RFQ handled on one connection (ms)',Math.round(performance.now()-start));
    for (const [items,reason] of [[[item,{...item,sku:'LAMP-B'}],'single_item_required'],[[{query:'desk lamp'}],'quantity_required']]) {
      const result = await request('tools/call',{name:'kiwi_request_quotes',arguments:{
        intent:{...intent,items}, merchant_ids:['synthetic'],idempotency_key:'same-unused-key',
      }});
      assert.deepEqual(result.structuredContent,{code:'clarification_needed',reason});
    }
  } finally { child.stdin.end(); assert.equal(await closed,0); }
});

async function negotiation({currency='CNY',count=1,budget,target,merchants=['A'],selected,reason,expectMoney}) {
  const wire = [];
  const policy = {policy_id:'policy',version:'1.0',principal:'buyer:test',expires_at:'2099-01-01T00:00:00Z',
    actions:{discover:{mode:'auto'},inquiry_rfq:{mode:'auto'},compare_offers:{mode:'auto'},counter_offer:{mode:'auto'},accept_nonbinding:{mode:'ask'},handoff:{mode:'ask'},payment:{mode:'never'}}};
  const store = new TaskApprovalStore({dbPath:':memory:'});
  const quantity = {value:count,unit:'piece'};
  const term = {sku:item.sku,quantity,unit_price:{currency,amount_minor:18000}};
  const negotiator = new A2ANegotiator();
  negotiator.clientFor = async () => ({client:{}});
  negotiator.recovery = {
    hasCounterClaim:()=>false,
    validatedQuote:()=>({reply:{payload:{type:'offer',terms:{items:[term]}}}}),
    exchange:async operation=>{
      wire.push({merchant:operation.merchantId,money:operation.build().payload.proposed_terms.items[0].unit_price});
      throw new Error('end of local capture');
    },
  };
  const service = new KiwiBuyerService({store,principal:'buyer:test',buyerAgentId:'buyer:test',sessionId:'audit',delegationPolicy:policy,negotiator,
    quoteFetcher:{requestQuotes:async()=>merchants.map(merchant=>({
      merchant_id:merchant,status:'succeeded',terms:{currency,items:[{sku:item.sku,quantity_value:count,quantity_unit:'piece',unit_price_minor:18000}],total_price_minor:18000*count},
      provenance:{source:'a2a',a2a_endpoint:'https://merchant.invalid/a2a',negotiation_id:'neg-'+merchant,offer_id:'offer-'+merchant,merchant_reply_id:'reply-'+merchant,sku:item.sku},
    }))}});
  try {
    const {task} = await service.requestQuotes({intent:{...intent,items:[{...item,quantity}],constraints:budget?{budget}:{}},merchant_ids:merchants});
    const args = {task_id:task.task_id,action:'counter_offer',summary:'Please offer a discount'};
    if(selected) args.candidate_id = task.candidates.find(c=>c.merchant_id===selected)?.candidate_id ?? 'candidate-from-another-task';
    if(target) args.target_unit_price = target;
    const result = await buildKiwiTools(service,'legacy13',{targetedNegotiation:true}).find(tool=>tool.name==='kiwi_negotiate').handle(args);
    if(reason) { assert.equal(result.isError,true); assert.match(result.content[0].text,reason); }
    if(expectMoney) assert.deepEqual(wire,[{merchant:selected??merchants[0],money:expectMoney}]);
    else assert.deepEqual(wire,[]);
  } finally {store.close();}
}
await test('P1-1 · selected candidate B, both list orders, missing or foreign candidate',async()=>{
  for(const merchants of [['A','B'],['B','A']]) {
    await negotiation({merchants,selected:'B',expectMoney:{currency:'CNY',amount_minor:16200}});
    await negotiation({merchants,reason:/clarification_needed/});
    await negotiation({merchants,selected:'Z',reason:/invalid_params/});
  }
});
await test('P1-2 · budget is a ceiling, discounted offer, quantity and explicit authorization',async()=>{
  for(const count of [1,2]) await negotiation({count,budget:{currency:'CNY',amount_minor:count*24000},expectMoney:{currency:'CNY',amount_minor:16200}});
  await negotiation({budget:{currency:'CNY',amount_minor:9000},reason:/预算/});
  await negotiation({target:{currency:'CNY',amount_minor:15000},expectMoney:{currency:'CNY',amount_minor:15000}});
});
await test('P1-3 · USD and JPY preserved, conflicting currency blocked',async()=>{
  for(const currency of ['USD','JPY']) {
    const target = {currency,amount_minor:15000};
    await negotiation({currency,target,expectMoney:target});
  }
  await negotiation({currency:'USD',target:{currency:'CNY',amount_minor:15000},reason:/币种/});
  await negotiation({target:{amount_minor:15000},reason:/invalid_params/});
});

async function connection({failHandshake=false,timeout=2000}={}) {
  const input = new PassThrough(), frames=[], requests=[], statuses=[];
  const output = new Writable({highWaterMark:16384,write(bytes,encoding,callback){
    frames.push(JSON.parse(bytes)); setImmediate(callback);
  }});
  let end, reply;
  const done = new Promise(resolve=>{end=resolve});
  const server = startProductionMcpServer({input,output,baseline,toolTimeoutMs:timeout,
    onStatus:state=>statuses.push(state), prepare:async()=>({}), activate:async (_,options)=>{
      if(failHandshake) throw new Error('BACKEND_HANDSHAKE_TIMEOUT');
      reply=options.onMessage;
      return {toolCount:13,protocolVersion,done,stop:end,send:async msg=>{requests.push(msg)}};
    }});
  async function waitFor(get) {
    const deadline=performance.now()+3000;
    while (performance.now()<deadline) {const value=get();if(value)return value;await tick();}
    throw new Error('Fixture timed out');
  }
  const send=(method,params,id)=>input.write(frame(method,params,id));
  send('initialize',{protocolVersion},1);send('notifications/initialized',{});
  await waitFor(()=>server.status===(failHandshake?'failed':'ready'));
  return {server,end,statuses,frames,send,
    response:id=>waitFor(()=>frames.find(f=>f.id===id)),
    async call(id,name='kiwi_search',args={query:'desk lamp'}) {
      send('tools/call',{name,arguments:args},id);
      const index=this.calls++;
      return waitFor(()=>requests.filter(r=>r.method==='tools/call')[index]);
    },
    calls:0, requests,reply:(request,result)=>reply({jsonrpc:'2.0',id:request.id,result},async()=>{}),
  };
}
await test('P1-5 / P2-4 · backend exits after dispatch, preserve unknown outcome and original failure',async()=>{
  const host=await connection();
  await host.call(2,'kiwi_request_quotes',{intent,merchant_ids:['A'],idempotency_key:'original-key'});
  host.end();
  const outcome=await host.server.done;
  assert.deepEqual(outcome,{status:'failed',code:'BACKEND_EXITED'});
  assert.deepEqual((await host.response(2)).result.structuredContent,{code:'OUTCOME_UNKNOWN',idempotency_key:'original-key'});
  assert.ok(!host.statuses.includes('STOPPED'));
  const normal=await connection();
  await normal.server.shutdown();assert.deepEqual(await normal.server.done,{status:'stopped'});
});
await test('P1-6 · slow host receives large reply and subsequent replies in order',async()=>{
  const host=await connection();
  try {
    const request=await host.call(2), text='desk lamp '.repeat(4000);
    host.reply(request,{content:[{type:'text',text}]});
    host.send('ping',{},3);host.send('ping',{},4);
    assert.deepEqual((await host.response(2)).result.content,[{type:'text',text}]);
    await host.response(4); assert.deepEqual(host.frames.map(f=>f.id),[1,2,3,4]);
    assert.equal(host.server.status,'ready');
  } finally {await host.server.shutdown();}
});
await test('P2-2 · late search response after cancel or timeout cannot affect next query',async()=>{
  for(const cancel of [true,false]) {
    const host=await connection({timeout:100});
    try {
      const old=await host.call(2);
      if(cancel) host.send('notifications/cancelled',{requestId:2});
      else assert.match((await host.response(2)).result.content[0].text,/Read timed out/);
      const next=await host.call(3);
      host.reply(old,{content:[{type:'text',text:'late'}]});
      host.reply(next,{content:[{type:'text',text:'new'}]});
      assert.equal((await host.response(3)).result.content[0].text,'new');
      assert.equal(host.frames.filter(f=>f.id===2).length,cancel?0:1);
      assert.equal(host.server.status,'ready');
    } finally {await host.server.shutdown();}
  }
});
await test('P2-3 · failed handshake is reported by list and call',async()=>{
  const host=await connection({failHandshake:true});
  try {
    host.send('tools/list',{},2);
    assert.equal((await host.response(2)).error.data.code,'TIMEOUT_BACKEND');
    host.send('tools/call',{name:'kiwi_search',arguments:{query:'desk lamp'}},3);
    assert.deepEqual((await host.response(3)).result.structuredContent,{code:'TIMEOUT_BACKEND',requestSent:false});
    assert.equal(host.requests.length,0);
  } finally {await host.server.shutdown();}
});

await test('P2-4 · packaged launcher exits nonzero after losing its own backend', {
  timeout:15000,skip:process.platform!=='linux',
}, async () => {
  const [config]=Object.values(JSON.parse(readFileSync(resolve(root,'.mcp.json'))).mcpServers);
  const child=spawn(config.command,config.args,{cwd:root,stdio:['pipe','pipe','pipe']});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  let log='';
  child.stderr.on('data',chunk=>{log+=chunk});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  try {
    child.stdin.write(frame('initialize',{protocolVersion},1));
    await lines.next();
    child.stdin.write(frame('notifications/initialized',{}));
    child.stdin.write(frame('tools/call',{name:'kiwi_get_task',arguments:{task_id:'absent'}},2));
    assert.match(JSON.parse((await lines.next()).value).result.content[0].text,/task_not_found/);
    const ids=readFileSync(`/proc/${child.pid}/task/${child.pid}/children`,'utf8').trim().split(/\s+/);
    assert.equal(ids.length,1);
    assert.match(ids[0],/^[1-9][0-9]*$/);
    process.kill(Number(ids[0]),'SIGTERM');
    assert.deepEqual(await closed,{code:1,signal:null});
    assert.match(log,/KIWI_LAUNCHER_HOLD:BACKEND_(EXITED|FAILED)/);
    assert.doesNotMatch(log,/KIWI_STATUS:STOPPED/);
  } finally {
    child.stdin.end();
    if(child.exitCode===null && child.signalCode===null) child.kill();
    await closed;
  }
});
