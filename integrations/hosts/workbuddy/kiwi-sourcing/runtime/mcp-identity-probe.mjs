import {spawn} from 'node:child_process';
import {createHmac,randomBytes} from 'node:crypto';
import {chmodSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {delimiter,dirname,isAbsolute,join} from 'node:path';

// Behavioral capability probe for the installed Kiwi runtime. A version string
// or schema alone cannot prove that the runtime understands per-client identity.
// This creates two synthetic owned tasks and requires the installed runtime to
// read exactly the matching one and reject the foreign one. No network, model,
// merchant, or real user data is involved.
const PRINCIPAL='probe:principal';
const AGENT='probe:agent';
const CLIENT_ID='probe-client';
const SESSION='probe-session';
const EXPECTED_TASK='probe-owner-task';
const FOREIGN_TASK='probe-foreign-task';
const HEX64=/^[0-9a-f]{64}$/;

function owner(token,clientId){
  return createHmac('sha256',token).update(`${PRINCIPAL}\0${AGENT}\0${clientId}\0${SESSION}`).digest('hex');
}
function taskRow(taskId,ownerHash){
  const now='2026-11-01T00:00:00.000Z',expires='2099-12-31T23:59:59.000Z';
  return {
    task_id:taskId,task_kind:'request_quotes',status:'succeeded',idempotency_key:`idem-${taskId}`,
    intent_id:'probe-intent',delegation_policy_id:'probe-policy',created_at:now,updated_at:now,
    expires_at:expires,resumable:1,owner_hash:ownerHash,
    payload:JSON.stringify({task_id:taskId,task_kind:'request_quotes',status:'succeeded',idempotency_key:`idem-${taskId}`,intent_id:'probe-intent',delegation_policy_id:'probe-policy',created_at:now,updated_at:now,expires_at:expires,resumable:true,candidates:[],intent:{intent_id:'probe-intent',intent_type:'inquiry',items:[]}}),
  };
}

function parseCall(message){
  if(message?.error)return null;
  const result=message?.result;
  if(!result||result.isError)return null;
  const text=result.content?.find?.(part=>part?.type==='text')?.text;
  if(typeof text!=='string')return null;
  try{const value=JSON.parse(text);return value?.task?.task_id??value?.task_id??null}catch{return null}
}

export async function probeMcpIdentity({nodeBinary,packageRoot,fixtureHome,timeoutMs=15000}){
  if(![nodeBinary,packageRoot,fixtureHome].every(isAbsolute))throw new Error('ABSOLUTE_PATH_REQUIRED');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw new Error('TIMEOUT_INVALID');
  const command=join(packageRoot,'dist','cli.js');
  // Dynamic import: merely loading the connector must not emit Node's
  // experimental SQLite warning on unrelated startup paths.
  const {DatabaseSync}=await import('node:sqlite');
  const dir=join(fixtureHome,`identity-${randomBytes(8).toString('hex')}`);
  const dbPath=join(dir,'buyer.sqlite'),tokenFile=join(dir,'session.token');
  const token=randomBytes(32).toString('hex'),foreignToken=randomBytes(32).toString('hex');
  if(!HEX64.test(token)||!HEX64.test(foreignToken))throw new Error('PROBE_TOKEN_INVALID');
  try{
    mkdirSync(dir,{mode:0o700});
    chmodSync(dir,0o700);
    writeFileSync(tokenFile,token,{mode:0o600});
    const db=new DatabaseSync(dbPath);
    try{
      db.exec(`CREATE TABLE IF NOT EXISTS mcp_tasks (
        task_id TEXT PRIMARY KEY, task_kind TEXT NOT NULL, status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, intent_id TEXT, delegation_policy_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
        resumable INTEGER NOT NULL DEFAULT 0, owner_hash TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL
      )`);
      const insert=db.prepare(`INSERT INTO mcp_tasks
        (task_id,task_kind,status,idempotency_key,intent_id,delegation_policy_id,created_at,updated_at,expires_at,resumable,owner_hash,payload)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const expected=taskRow(EXPECTED_TASK,owner(token,CLIENT_ID));
      const foreign=taskRow(FOREIGN_TASK,owner(foreignToken,CLIENT_ID));
      for(const row of [expected,foreign])insert.run(row.task_id,row.task_kind,row.status,row.idempotency_key,row.intent_id,row.delegation_policy_id,row.created_at,row.updated_at,row.expires_at,row.resumable,row.owner_hash,row.payload);
    }finally{db.close()}
    const env={
      HOME:dir,TMPDIR:dir,PATH:[dirname(nodeBinary),'/usr/bin','/bin'].join(delimiter),
      NODE_ENV:'test',KIWI_CLIENT_ID:CLIENT_ID,KIWI_SESSION_TOKEN_FILE:tokenFile,KIWI_SESSION:SESSION,
    };
    const lines=[
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',clientInfo:{name:'kiwi-identity-probe',version:'1.0.0'},capabilities:{}}},
      {jsonrpc:'2.0',method:'notifications/initialized'},
      {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'kiwi_get_task',arguments:{task_id:EXPECTED_TASK}}},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'kiwi_get_task',arguments:{task_id:FOREIGN_TASK}}},
    ];
    const output=await new Promise((resolve,reject)=>{
      const p=spawn(nodeBinary,[command,'mcp','serve','--db',dbPath,'--principal',PRINCIPAL,'--agent',AGENT,'--session',SESSION,'--a2a-timeout-ms','5000'],{env,stdio:['pipe','pipe','pipe']});
      const chunks=[];let size=0,done=false;
      const timer=setTimeout(()=>{p.kill('SIGTERM');finish(new Error('MCP_IDENTITY_TIMEOUT'))},timeoutMs);
      function finish(error,value){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)}
      p.stdout.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){p.kill('SIGTERM');finish(new Error('MCP_IDENTITY_OUTPUT_TOO_LARGE'))}else chunks.push(chunk)});
      p.stderr.resume();
      p.on('error',()=>finish(new Error('MCP_IDENTITY_SPAWN_FAILED')));
      p.on('close',code=>code===0?finish(null,Buffer.concat(chunks).toString('utf8')):finish(new Error('MCP_IDENTITY_FAILED')));
      p.stdin.on('error',()=>finish(new Error('MCP_IDENTITY_INPUT_FAILED')));
      p.stdin.end(lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
    });
    const responses=new Map();
    for(const line of output.split(/\r?\n/).filter(Boolean)){
      let item;try{item=JSON.parse(line)}catch{throw new Error('MCP_IDENTITY_NON_JSON')}
      if(item.id===2||item.id===3)responses.set(item.id,item);
    }
    if(responses.size!==2)throw new Error('MCP_IDENTITY_RESPONSE_MISSING');
    if(parseCall(responses.get(2))!==EXPECTED_TASK)throw new Error('MCP_IDENTITY_MISSING');
    if(parseCall(responses.get(3))!==null)throw new Error('MCP_IDENTITY_FOREIGN_READABLE');
    return {identity:'supported',probeTasks:2};
  }finally{try{rmSync(dir,{recursive:true,force:true})}catch{void 0}}
}
