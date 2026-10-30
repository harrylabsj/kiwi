import {spawn} from 'node:child_process';
import {delimiter, dirname, isAbsolute, join} from 'node:path';
import {checkToolContract} from './tool-contract.mjs';

// Local fixture-only probe. No model, business tool calls or real merchant.
// This executes package code; callers must first verify provenance and every
// executable byte. It cannot prove future authorization semantics by itself.
export async function probeMcpSchema({nodeBinary, packageRoot, fixtureHome, baseline, locale='en', timeoutMs=15000}) {
  if (![nodeBinary,packageRoot,fixtureHome].every(isAbsolute)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  if (!['en','zh'].includes(locale)) throw new Error('LOCALE_INVALID');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('TIMEOUT_INVALID');
  const command=join(packageRoot,'dist','cli.js');
  const env={HOME:fixtureHome,TMPDIR:fixtureHome,PATH:[dirname(nodeBinary),'/usr/bin','/bin'].join(delimiter),NODE_ENV:'test',KIWI_LANG:locale};
  const lines=[
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',clientInfo:{name:'kiwi-contract-probe',version:'1.0.0'},capabilities:{}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
  ];
  const output=await new Promise((resolve,reject)=>{
    const p=spawn(nodeBinary,[command,'mcp','serve','--principal','workbuddy:local','--agent','buyer-agent:workbuddy','--a2a-timeout-ms','15000'],{env,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,done=false;
    const timer=setTimeout(()=>{p.kill();finish(new Error('MCP_PROBE_TIMEOUT'))},timeoutMs);
    function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)}
    p.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){p.kill();finish(new Error('MCP_OUTPUT_TOO_LARGE'))}else chunks.push(chunk)});
    p.stderr.resume();
    p.on('error',()=>finish(new Error('MCP_SPAWN_FAILED')));
    p.on('close',code=>code===0?finish(null,Buffer.concat(chunks).toString('utf8')):finish(new Error('MCP_PROBE_FAILED')));
    p.stdin.on('error',()=>finish(new Error('MCP_INPUT_FAILED')));
    p.stdin.end(lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
  });
  let response;let count=0;
  for(const line of output.split(/\r?\n/).filter(Boolean)){
    let item;try{item=JSON.parse(line)}catch{throw new Error('MCP_NON_JSON_STDOUT')}
    if(item.id===2){count++;response=item}
  }
  if(count!==1 || response.error || !Array.isArray(response.result?.tools)) throw new Error('MCP_TOOLS_RESPONSE_INVALID');
  checkToolContract(baseline,response.result.tools);
  return {toolCount:response.result.tools.length};
}
