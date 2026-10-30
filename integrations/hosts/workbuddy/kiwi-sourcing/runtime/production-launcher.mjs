import {accessSync,constants,lstatSync,realpathSync,readFileSync,readdirSync} from 'node:fs';
import {delimiter,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPreparation} from './stage-runner.mjs';
import {ensureBuyerCacheDirectory,withBuyerCacheStore as withCacheLock} from './buyer-cache-store-draft.mjs';
import {startVerifiedBackend} from './backend-client.mjs';
import {startBackendWithPreparedLock} from './locked-backend-session.mjs';
import {startProductionMcpServer} from './mcp-production-server.mjs';
import {selectEnvironment} from './environment-policy.mjs';

function findExecutable(name){
  const directories=[dirname(process.execPath),...(process.env.PATH??'').split(delimiter)];
  for(const directory of directories){if(!isAbsolute(directory))continue;try{const file=realpathSync(join(directory,name));accessSync(file,constants.X_OK);if(lstatSync(file).isFile())return file}catch{}}
  throw new Error('RUNTIME_DEPENDENCY_MISSING');
}
function assertPrivateDataDirectory(path){
  if(typeof path!=='string'||!isAbsolute(path)||realpathSync(path)!==path)throw new Error('PLUGIN_DATA_UNAVAILABLE');
  const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o777)!==0o700||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw new Error('PLUGIN_DATA_INVALID');
}
function supportedRuntime(){
  if(!['darwin','linux'].includes(process.platform))throw new Error('PLATFORM_UNSUPPORTED');
  const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<19))throw new Error('NODE_VERSION_UNSUPPORTED');
  if(process.versions.electron&&process.env.ELECTRON_RUN_AS_NODE!=='1')throw new Error('NODE_RUNTIME_UNVERIFIED');
}
function publicCode(error){
  const message=typeof error?.message==='string'?error.message:'';
  const exact=new Set(['PLATFORM_UNSUPPORTED','NODE_VERSION_UNSUPPORTED','NODE_RUNTIME_UNVERIFIED','PLUGIN_DATA_UNAVAILABLE','PLUGIN_DATA_INVALID','RUNTIME_DEPENDENCY_MISSING','PREPARE_TIMEOUT','PREPARE_CANCELLED','PREPARE_TERMINATION_UNCONFIRMED','PREPARE_OUTPUT_INVALID','PREPARE_START_FAILED','BACKEND_PATH_INVALID','BACKEND_PROTOCOL_MISMATCH','BACKEND_TOOL_LIST_INVALID','TREE_RECHECK_FAILED','PREPARED_STATE_MISMATCH','CACHE_BUSY','CACHE_POINTER_INVALID','CACHE_DIRECTORY_INVALID','CACHE_LEGACY_STATE_REQUIRES_REVIEW','PACKAGE_INVALID','VERSION_DOWNGRADE','LATEST_METADATA_UNAVAILABLE','AUDIT_FAILED','SIGNATURE_VERIFIER_UNAVAILABLE','SIGNER_POLICY_VERIFICATION_FAILED','ISOLATED_INSTALL_FAILED','TREE_INSPECTION_FAILED','MCP_PROBE_FAILED','MCP_PROBE_TIMEOUT','TOOL_SET_MISMATCH']);
  if(exact.has(message))return message;
  const detail=/^PREPARE_FAILED:(CACHE_BUSY|CACHE_STATE_INVALID|REGISTRY_UNAVAILABLE|INSTALL_FAILED|PROVENANCE_FAILED|TREE_CHECK_FAILED|TOOL_CHECK_FAILED|VERSION_REJECTED)$/.exec(message);
  return detail?message:'LAUNCH_HOLD';
}

async function main(){
  if(process.argv.length!==2)throw new Error('ARGUMENT_INVALID');
  supportedRuntime();
  const pluginData=process.env.CODEBUDDY_PLUGIN_DATA;assertPrivateDataDirectory(pluginData);
  const packageRoot=dirname(fileURLToPath(import.meta.url)),store=join(pluginData,'kiwi-sourcing-latest');
  const nodeBinary=process.execPath,npmBinary=findExecutable('npm'),pythonBinary=findExecutable('python3');
  const baselineRaw=JSON.parse(readFileSync(join(packageRoot,'mcp-tools-0.12.12.json'),'utf8'));
  const baseline=Array.isArray(baselineRaw)?baselineRaw:baselineRaw.tools;
  if(!Array.isArray(baseline)||baseline.length!==13)throw new Error('TOOL_BASELINE_INVALID');
  const cliPath=join(packageRoot,'buyer-session-cli.mjs');
  async function rejectUnanchoredCache(){
    ensureBuyerCacheDirectory(store);
    await withCacheLock(store,state=>{
      if(state.prepared())return;
      if(readdirSync(store).some(name=>name!=='.update-lock'))throw new Error('CACHE_STATE_INVALID');
    });
  }
  const controller=new AbortController();let server;
  const shutdown=()=>{controller.abort();server?.shutdown()};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  try{
    server=startProductionMcpServer({input:process.stdin,output:process.stdout,baseline,
      // Fixed status records use stderr only; stdout remains newline-delimited MCP JSON-RPC.
      onStatus:code=>{if(['PREPARING','READY','FAILED_PREPARE','FAILED_BACKEND','TIMEOUT_PREPARE','TIMEOUT_BACKEND','FAILED_RUNTIME','BACKEND_EXITED','BACKEND_FAILED','STOPPED'].includes(code))process.stderr.write(`KIWI_STATUS:${code}\n`)},
      onProtocolDiagnostic:event=>{
        const versions=new Set(['EXACT_MATCH','UNSUPPORTED_COUNTEROFFER','MISSING','INVALID']);
        const states=new Set(['MATCHED','COUNTEROFFER_SENT','CLIENT_ACCEPTED_NEGOTIATED_VERSION','INVALID_INITIALIZE']);
        if(versions.has(event?.clientProtocolVersionClass)&&states.has(event?.state)&&event?.negotiatedProtocolVersion==='2025-06-18'){
          process.stderr.write(`KIWI_PROTOCOL:${event.clientProtocolVersionClass}:2025-06-18:${event.state}\n`);
        }
      },
      prepare:async({signal})=>{
        process.stderr.write('KIWI_STATUS:PREPARING\n');
        await rejectUnanchoredCache();
        const args=['prepare-managed','--store',store,'--floor','0.12.9','--node',nodeBinary,'--npm',npmBinary,'--python',pythonBinary,
          '--baseline-en',join(packageRoot,'mcp-tools-0.12.12.json'),'--baseline-zh',join(packageRoot,'mcp-tools-0.12.12-zh.json')];
        const result=await runPreparation({nodeBinary,cliPath,args,env:selectEnvironment(process.env,'prepare'),signal:AbortSignal.any([signal,controller.signal]),onProgress:({elapsedMs})=>process.stderr.write(`KIWI_PROGRESS:PREPARE:${Math.floor(elapsedMs/1000)}\n`)});
        const selected=await withCacheLock(store,state=>state.prepared());
        if(!selected||selected.sessionDirectory!==result.sessionDirectory||selected.version!==result.version||selected.integrity!==result.integrity||selected.contentTreeSha256!==result.tree?.content_tree_sha256)throw new Error('PREPARED_STATE_MISMATCH');
        if(signal.aborted||controller.signal.aborted)throw new Error('PREPARE_CANCELLED');
        return result;
      },
      activate:async(prepared,{signal,clientCapabilities,onMessage})=>{
        return startBackendWithPreparedLock({storeDirectory:store,prepared,verificationOptions:{nodeBinary,pythonBinary},signal:AbortSignal.any([signal,controller.signal]),backendFactory:()=>startVerifiedBackend({nodeBinary,sessionDirectory:prepared.sessionDirectory,baseline,clientCapabilities,onMessage,timeoutMs:15000,sourceRoot:packageRoot,environment:process.env,signal})});
      },
    });
    await server.done;
  }finally{process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);server?.shutdown()}
}

main().catch(error=>{const code=publicCode(error);process.stderr.write(`KIWI_STATUS:${code==='PREPARE_TIMEOUT'?'TIMEOUT_PREPARE':'FAILED_STARTUP'}\nKIWI_LAUNCHER_HOLD:${code}\n`);process.exitCode=1});
