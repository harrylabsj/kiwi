import { setTimeout } from "node:timers";
import process from "node:process";
import {createServer} from 'node:http';
import fs from 'node:fs';
import {createMerchantConnectionService} from '../../dist/cloud/connect-service.js';
import {loadOrCreateA2aSigningIdentity,toJwsSigningIdentity} from '../../dist/a2a/signing-key.js';
import {createEnrollmentChallengeResponder} from '../../dist/cloud/binding/enrollment-challenge.js';
import {withEnrollmentStoreLock} from '../../dist/cloud/binding/store-lock.js';
const [mode,dir,catalogPort,runtimePort]=process.argv.slice(2);
let server;
if(mode==='challenge'){
 const raw=loadOrCreateA2aSigningIdentity(dir,'https://runtime.test');server=createServer(createEnrollmentChallengeResponder({dataDir:dir,signingIdentity:toJwsSigningIdentity(raw)}));server.listen(0,'127.0.0.1',()=>process.send({ready:true,port:server.address().port,pid:process.pid}));
}else{
 const shim=(input,init)=>globalThis.fetch(String(input).replace('https://catalog.test',`http://127.0.0.1:${catalogPort}`).replace('https://runtime.test',`http://127.0.0.1:${runtimePort}`),init);
 const service=createMerchantConnectionService({dataDir:dir,catalogUrl:'https://catalog.test',publicOrigin:'https://runtime.test',fetchImpl:shim,beforePublish:async()=>{withEnrollmentStoreLock(dir,()=>{const f=dir+'/merchant-enrollments.json',s=JSON.parse(fs.readFileSync(f));s.consumed.push('callback-'+process.pid);fs.writeFileSync(f,JSON.stringify(s));});process.send({callback:true});await new Promise(r=>setTimeout(r,250));}});
 process.send({ready:true,pid:process.pid});process.on('message',async message=>{if(message==='go'){try{process.send({result:await service.reconcile()});}catch(e){process.send({error:e.code??e.message});}}});
}
process.on('message',message=>{if(message==='stop'){if(server){server.closeAllConnections();server.close(()=>process.exit(0));}else process.exit(0);}});
setTimeout(()=>process.exit(124),10000).unref();
