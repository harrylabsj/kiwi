import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeFiles,rootFiles,skillFiles} from './package-manifest.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),errors=[];
const check=(condition,message)=>{if(!condition)errors.push(message)};
const read=path=>readFileSync(join(root,path),'utf8');
const meta=JSON.parse(read('connector-meta.json')),mcp=JSON.parse(read('mcp.json'));
for(const path of [...rootFiles,...skillFiles,...runtimeFiles.map(file=>`runtime/${file}`)]){
  const full=join(root,path);check(existsSync(full),`missing:${path}`);if(existsSync(full))check(lstatSync(full).isFile()&&!lstatSync(full).isSymbolicLink(),`not_regular:${path}`);
}
check(meta.source==='kiwi-sourcing'&&/^\d+\.\d+\.\d+$/.test(meta.version??''),'metadata_invalid');
check(!Object.hasOwn(meta,'auth_mode'),'auth_mode_not_allowed');
const servers=Object.entries(mcp.mcpServers??{});check(servers.length===1,'server_count_invalid');
const [serverName,server]=servers[0]??[];
check(serverName==='kiwi-sourcing'&&server?.type==='stdio'&&server?.command==='node','mcp_entry_invalid');
check(server?.runtime?.type==='node'&&server.runtime.version==='22','node_runtime_invalid');
check(Number.isInteger(server?.timeout)&&server.timeout>0&&server.timeout<=30000,'startup_timeout_invalid');
check(JSON.stringify(server?.args)===JSON.stringify(['${CODEBUDDY_PLUGIN_ROOT}/runtime/production-launcher.mjs']),'launch_path_invalid');
check(!JSON.stringify(server??{}).includes('testOnly')&&!JSON.stringify(server??{}).includes('experimental'),'test_flag_in_package');
const baselineRaw=JSON.parse(read('runtime/mcp-tools-0.12.12.json')),baseline=Array.isArray(baselineRaw)?baselineRaw:baselineRaw.tools;
const expected=['kiwi_search','kiwi_request_quotes','kiwi_get_task','kiwi_negotiate','kiwi_accept_agreement','kiwi_get_agreement','kiwi_handoff','kiwi_approve','kiwi_reject','kiwi_follow_merchant','kiwi_unfollow_merchant','kiwi_list_follows','kiwi_get_follow_updates'];
check(Array.isArray(baseline)&&baseline.length===13&&JSON.stringify(baseline.map(x=>x.name))===JSON.stringify(expected),'tool_baseline_invalid');
const runtimeSet=new Set(runtimeFiles);
for(const file of runtimeFiles){
  const sourcePath=join(root,'runtime',file);if(!existsSync(sourcePath)||!file.endsWith('.mjs'))continue;
  const source=readFileSync(sourcePath,'utf8');
  for(const match of source.matchAll(/from ['\"]\.\/([^'\"]+)['\"]/g))check(runtimeSet.has(match[1]),`runtime_import_missing:${file}:${match[1]}`);
}
const included=[...rootFiles,...skillFiles,...runtimeFiles.map(file=>`runtime/${file}`)];
const content=included.map(read).join('\n');
for(const pattern of [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,/\bgh[pousr]_[A-Za-z0-9]{20,}\b/])check(!pattern.test(content),`secret_pattern:${pattern}`);
const pycache=readdirSync(join(root,'runtime')).includes('__pycache__');check(!pycache,'pycache_not_packaged');
if(errors.length){for(const e of errors)process.stderr.write(`VALIDATION_HOLD:${e}\n`);process.exitCode=1}else process.stdout.write(`VALIDATION_OK:${included.length}\n`);
