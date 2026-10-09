import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect,it,vi } from 'vitest';
import { WeixinChannel } from '../src/weixin/channel.js';
import { IlinkClient } from '../src/weixin/ilink-client.js';
import * as credentials from '../src/weixin/credentials.js';
import { ensurePathsForDir } from '../src/agent/agent-db.js';
import { AgentKernel } from '../src/agent/kernel.js';
import { createFakeChatModels } from '../src/agent/fake-chat-model.js';
import { PrivateVault,EnvKeyProvider } from '../src/agent/memory/vault.js';
import { testProfile } from './helpers.js';
it('3-53 cursor-only/seen-only changes persist, unchanged polls and stop skip; restart dedup remains',async()=>{
 const d=mkdtempSync(path.join(tmpdir(),'a386-wx-'));let k:AgentKernel|undefined;let channel:WeixinChannel|undefined;
 try{
 const c=path.join(d,'credentials.json'),sync=path.join(d,'sync.json');
 credentials.saveCredentials(c,{ilink_bot_id:'fixture',bot_token:'synthetic-only',base_url:'http://127.0.0.1:1',ilink_user_id:'paired',saved_at:'2026-10-09T00:00:00Z'});
 credentials.saveSyncState(sync,{get_updates_buf:'cursor1',seen:[]});
 k=await AgentKernel.open({paths:ensurePathsForDir(path.join(d,'agent')),profile:testProfile(),...createFakeChatModels(),vault:new PrivateVault(new EnvKeyProvider('b'.repeat(64)))});
 const business=vi.spyOn(k,'handleUserText').mockResolvedValue({text:'fixture reply',quit:false});vi.spyOn(IlinkClient.prototype,'sendMessage').mockResolvedValue();
 const writes=vi.spyOn(credentials,'saveSyncState');
 const msg={account:'fixture',message_id:'m1',from_user_id:'paired',text:'fixture',context_token:''};
 for(const restart of [false,true]){
 let polls=0;let reached!:()=>void;const ready=new Promise<void>(r=>{reached=r;});
 vi.spyOn(IlinkClient.prototype,'getUpdates').mockImplementation(async(_cursor,_creds,signal)=>{
 polls++;if(polls<=3)return {messages:[],longpoll_timeout_ms:0,next_sync_buf:restart?'cursor2':'cursor1'};
 if(polls===4)return {messages:[msg],longpoll_timeout_ms:0,next_sync_buf:restart?'cursor2':'cursor1'};
 if(polls===5)return {messages:[],longpoll_timeout_ms:0,next_sync_buf:'cursor2'};
 reached();return new Promise((_resolve,reject)=>{if(signal?.aborted)reject(new Error('abort'));else signal?.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});
 });
 channel=await WeixinChannel.open({kernel:k,credentialsPath:c,syncBufPath:sync,log:()=>{},notice:()=>{},timings:{schedulerTickMs:1e8,negotiateTickMs:1e8}});
 const run=channel.run();await ready;await channel.stop();expect(await run).toBe(0);
 expect(writes).toHaveBeenCalledTimes(2);expect(business).toHaveBeenCalledTimes(1);
 const state=credentials.loadSyncState(sync);expect(state.get_updates_buf).toBe('cursor2');expect(state.seen).toHaveLength(1);
 }
 }finally{await channel?.stop();await k?.close();vi.restoreAllMocks();rmSync(d,{recursive:true,force:true});}
});
