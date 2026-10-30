import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

const KNOWN=new Set(['kiwi_search','kiwi_request_quotes','kiwi_get_task','kiwi_negotiate','kiwi_accept_agreement','kiwi_get_agreement','kiwi_handoff','kiwi_approve','kiwi_reject','kiwi_follow_merchant','kiwi_unfollow_merchant','kiwi_list_follows','kiwi_get_follow_updates']);
const PROTOCOL='2025-06-18';
const out=(output,message)=>{const ok=output.write(JSON.stringify(message)+'\n');return ok};
const unavailable=text=>({isError:true,content:[{type:'text',text}]});
const responseError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
// Transparent MCP transport only. Business policy, scope, approval, and action
// outcomes belong to the verified Kiwi backend / calling expert. This adapter
// must not invent approval, call kiwi_approve, or block a listed business tool.
export function startProductionMcpServer({input,output,baseline,prepare,activate,onStatus=()=>{},onProtocolDiagnostic=()=>{},backendRequestTimeoutMs=30000,toolTimeoutMs=30000}){
  if(!input||!output||!Array.isArray(baseline)||baseline.length!==13||typeof prepare!=='function'||typeof activate!=='function'||backendRequestTimeoutMs<1||toolTimeoutMs<1)throw new Error('SERVER_ARGUMENT_INVALID');
  const baselineByName=new Map(baseline.map(tool=>[tool?.name,tool]));
  if(baselineByName.size!==13||[...baselineByName.keys()].some(name=>!KNOWN.has(name)))throw new Error('TOOL_BASELINE_INVALID');
  const abort=new AbortController(),reader=createInterface({input,crlfDelay:Infinity});
  let phase='preparing',hostInitialized=false,hostReady=false,hostCanElicit=false,clientProtocolVersionClass='NOT_OBSERVED',backend,stopped=false,stopping=false,preparedResult,runTask,finishTask;
  const status=code=>{try{onStatus(code)}catch{}};
  const protocolDiagnostic=state=>{try{onProtocolDiagnostic({clientProtocolVersionClass,negotiatedProtocolVersion:PROTOCOL,state})}catch{}};
  let resolveHostReady;const hostReadyPromise=new Promise(resolve=>{resolveHostReady=resolve});
  const backendRequests=new Map(),activeToolCalls=new Map(),expiredBackend=new Set(),timedOutClientIds=new Set();
  let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve});
  const emit=message=>{try{if(!out(output,message))fail('OUTPUT_BACKPRESSURE')}catch{fail('OUTPUT_WRITE_FAILED')}};
  const sendBackend=async message=>{
    if(!backend||phase!=='ready')throw new Error('BACKEND_UNAVAILABLE');
    await backend.send(message);
  };
  const answerTool=(id,result)=>{const callKey=`${typeof id}:${String(id)}`,pending=activeToolCalls.get(callKey);if(pending)clearTimeout(pending.timer);activeToolCalls.delete(callKey);emit({jsonrpc:'2.0',id,result})};
  function fail(code){
    if(stopped)return;stopped=true;phase='failed';status(code==='BACKEND_EXITED'?'BACKEND_EXITED':code==='BACKEND_FAILED'?'BACKEND_FAILED':'FAILED_RUNTIME');abort.abort();resolveHostReady(false);
    for(const pending of activeToolCalls.values()){clearTimeout(pending.timer);emit({jsonrpc:'2.0',id:pending.id,result:unavailable('Connector stopped; action was not completed.')})}activeToolCalls.clear();
    for(const [hostId,pending] of backendRequests){clearTimeout(pending.timer);void pending.send(responseError(pending.backendId,-32603,'Host request ended.'));remember(expiredBackend,hostId)}
    backendRequests.clear();void settleExit('failed',code);
  }
  function settleExit(status,code){
    if(finishTask)return finishTask;
    finishTask=(async()=>{
      abort.abort();try{backend?.stop()}catch{}try{reader.close()}catch{}output.off('error',outputError);
      await Promise.all([runTask,backend?.done].filter(Boolean).map(p=>Promise.resolve(p).catch(()=>{})));
      resolveDone({status,...(code?{code}:{})});
    })();return finishTask;
  }
  function remember(set,value){set.add(value);if(set.size>128)set.delete(set.values().next().value)}
  function finishBackendRequest(hostId,message){
    const pending=backendRequests.get(hostId);if(!pending){if(!expiredBackend.has(hostId))fail('UNMATCHED_BACKEND_RESPONSE');return}
    clearTimeout(pending.timer);backendRequests.delete(hostId);
    const forwarded={...message,id:pending.backendId};void pending.send(forwarded).catch(()=>fail('BACKEND_WRITE_FAILED'));
  }
  async function onHostLine(line){
    if(Buffer.byteLength(line)>1024*1024){fail('INPUT_TOO_LARGE');return}
    let message;try{message=JSON.parse(line)}catch{emit(responseError(null,-32700,'Invalid JSON'));return}
    if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'){emit(responseError(null,-32600,'Invalid request'));return}
    const hasId=Object.hasOwn(message,'id'),validId=typeof message.id==='string'||(typeof message.id==='number'&&Number.isSafeInteger(message.id));
    if(message.method===undefined){
      if(!hasId||!validId||Object.hasOwn(message,'result')===Object.hasOwn(message,'error')){emit(responseError(null,-32600,'Invalid response'));return}
      if(backendRequests.has(message.id)||expiredBackend.has(message.id))return finishBackendRequest(message.id,message);
      const activeKey=`${typeof message.id}:${String(message.id)}`;
      if(activeToolCalls.has(activeKey)){const pending=activeToolCalls.get(activeKey);clearTimeout(pending.timer);activeToolCalls.delete(activeKey);emit(message);return}
      if(timedOutClientIds.has(activeKey)){timedOutClientIds.delete(activeKey);return}
      // Only responses for an outstanding backend request or active tool call
      // are meaningful here. Never forward unknown IDs into the backend.
      return;
    }
    if(typeof message.method!=='string'){if(hasId)emit(responseError(validId?message.id:null,-32600,'Invalid request'));return}
    if(message.method==='initialize'){
      if(!hasId||!validId||hostInitialized){emit(responseError(validId?message.id:null,-32600,'Invalid initialize request'));return}
      const requestedVersion=message.params?.protocolVersion;
      if(typeof requestedVersion!=='string'||requestedVersion.length===0){clientProtocolVersionClass=requestedVersion===undefined?'MISSING':'INVALID';protocolDiagnostic('INVALID_INITIALIZE');emit(responseError(message.id,-32602,'Invalid initialize parameters'));return}
      clientProtocolVersionClass=requestedVersion===PROTOCOL?'EXACT_MATCH':'UNSUPPORTED_COUNTEROFFER';
      const elicitation=message.params?.capabilities?.elicitation;
      const isRecord=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
      if(isRecord(elicitation)){
        if(Object.hasOwn(elicitation,'form'))hostCanElicit=isRecord(elicitation.form);
        else if(Object.hasOwn(elicitation,'url'))hostCanElicit=false;
        else hostCanElicit=Object.keys(elicitation).length===0;
      }else hostCanElicit=false;
      hostInitialized=true;protocolDiagnostic(clientProtocolVersionClass==='EXACT_MATCH'?'MATCHED':'COUNTEROFFER_SENT');
      emit({jsonrpc:'2.0',id:message.id,result:{protocolVersion:PROTOCOL,capabilities:{tools:{}},serverInfo:{name:'kiwi-sourcing-production-launcher',version:'1.0.0'}}});return;
    }
    if(!hostInitialized){if(hasId&&validId)emit(responseError(message.id,-32002,'Initialize first'));return}
    if(message.method==='notifications/initialized'){
      if(hostInitialized&&!hostReady){hostReady=true;protocolDiagnostic('CLIENT_ACCEPTED_NEGOTIATED_VERSION');resolveHostReady(true)}
      return;
    }
    if(message.method==='notifications/cancelled'){
      const id=message.params?.requestId;
      const callKey=`${typeof id}:${String(id)}`,pending=activeToolCalls.get(callKey);
      if(pending){clearTimeout(pending.timer);activeToolCalls.delete(callKey);void sendBackend({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}}).catch(()=>{});remember(timedOutClientIds,callKey);fail('TOOL_OUTCOME_UNCERTAIN')}
      return;
    }
    if(!hasId){if(message.method==='tools/call')return;return}
    if(!validId){emit(responseError(null,-32600,'Invalid request id'));return}
    if(message.method==='ping'){emit({jsonrpc:'2.0',id:message.id,result:{}});return}
    if(message.method==='tools/list'){
      emit({jsonrpc:'2.0',id:message.id,result:{tools:structuredClone(baseline)}});return;
    }
    if(message.method==='tools/call'){
      const name=message.params?.name,args=message.params?.arguments??{};
      if(typeof name!=='string'||!KNOWN.has(name)||!args||typeof args!=='object'||Array.isArray(args)){emit(responseError(message.id,-32602,'Invalid tool request'));return}
      if(Buffer.byteLength(JSON.stringify(message))>256*1024){emit({jsonrpc:'2.0',id:message.id,result:unavailable('Tool request exceeds the supported size; action stopped.')});return}
      const callKey=`${typeof message.id}:${String(message.id)}`;if(activeToolCalls.has(callKey)){fail('DUPLICATE_REQUEST_ID');return}
      const toolTimer=setTimeout(()=>{
        remember(timedOutClientIds,callKey);
        answerTool(message.id,unavailable('Backend response timed out; outcome is unknown. Do not retry until task status is checked.'));
        fail('TOOL_OUTCOME_UNCERTAIN');
      },toolTimeoutMs);toolTimer.unref?.();activeToolCalls.set(callKey,{id:message.id,timer:toolTimer});
      if(phase==='preparing'){answerTool(message.id,unavailable('Latest verification is in progress; retry this tool shortly.'));return}
      if(phase!=='ready'){answerTool(message.id,unavailable('Latest verification failed; connector is stopped.'));return}
      try{await sendBackend(message)}catch{answerTool(message.id,unavailable('Verified backend unavailable; request stopped.'))}return;
    }
    if(message.method==='logging/setLevel'||message.method==='resources/list'||message.method==='prompts/list'){
      if(phase==='ready'){try{await sendBackend(message)}catch{emit(responseError(message.id,-32603,'Backend unavailable'))}return}
    }
    emit(responseError(message.id,-32601,'Method not supported'));
  }
  function onBackendMessage(message,sendResponse){
    if(stopped)return;
    if(message&&typeof message==='object'&&Object.hasOwn(message,'method')&&Object.hasOwn(message,'id')){
      if(message.method!=='elicitation/create'){
        void sendResponse(responseError(message.id,-32601,'Server request not supported by the verified host adapter')).catch(()=>fail('BACKEND_WRITE_FAILED'));return;
      }
      if(backendRequests.size>=16){void sendResponse(responseError(message.id,-32000,'Host request capacity exceeded')).catch(()=>fail('BACKEND_WRITE_FAILED'));return;}
      const hostId=`kiwi-backend:${randomUUID()}`,timer=setTimeout(()=>finishBackendRequest(hostId,{error:{code:-32000}}),backendRequestTimeoutMs);timer.unref?.();
      backendRequests.set(hostId,{backendId:message.id,timer,send:sendResponse});emit({...message,id:hostId});return;
    }
    emit(message);
  }
  const lineHandler=line=>{void onHostLine(line).catch(()=>fail('PROTOCOL_HANDLER_FAILED'))};
  const outputError=()=>fail('OUTPUT_STREAM_FAILED');
  reader.on('line',lineHandler);reader.once('close',()=>shutdown());input.once('error',()=>shutdown());output.once('error',outputError);
  async function run(){
    try{
      let prepared;
      try{prepared=await prepare({signal:abort.signal})}catch(error){status(error?.message==='PREPARE_TIMEOUT'?'TIMEOUT_PREPARE':'FAILED_PREPARE');throw new Error('PREPARE_FAILED')}
      if(stopped||abort.signal.aborted)return;
      preparedResult=prepared;
      const initialized=await Promise.race([hostReadyPromise,new Promise(resolve=>abort.signal.addEventListener('abort',()=>resolve(false),{once:true}))]);
      if(!initialized||stopped||abort.signal.aborted)return;
      let active;
      try{active=await activate(prepared,{signal:abort.signal,clientCapabilities:{elicitation:hostCanElicit},onMessage:onBackendMessage})}catch(error){status(error?.message==='BACKEND_HANDSHAKE_TIMEOUT'?'TIMEOUT_BACKEND':'FAILED_BACKEND');throw new Error('BACKEND_VERIFY_FAILED')}
      if(stopped||abort.signal.aborted){active?.stop?.();return}
      if(!active||typeof active.send!=='function'||!active.done||typeof active.stop!=='function'||active.toolCount!==13||active.protocolVersion!==PROTOCOL){status('FAILED_BACKEND');throw new Error('BACKEND_HANDLE_INVALID')}
      backend=active;phase='ready';status('READY');
      active.done.then(()=>{if(!stopped)fail('BACKEND_EXITED')}).catch(()=>{if(!stopped)fail('BACKEND_FAILED')});
    }catch{if(!stopped)phase='failed'}
  }
  runTask=run();
  function shutdown(){
    if(stopping)return finishTask;stopping=true;stopped=true;phase='stopped';status('STOPPED');abort.abort();resolveHostReady(false);
    for(const pending of activeToolCalls.values())clearTimeout(pending.timer);activeToolCalls.clear();
    for(const [id,p] of backendRequests){clearTimeout(p.timer);void p.send(responseError(p.backendId,-32603,'Connector stopped.'));remember(expiredBackend,id)}backendRequests.clear();
    return settleExit('stopped');
  }
  return {done,shutdown,get status(){return phase},get prepared(){return preparedResult}};
}
