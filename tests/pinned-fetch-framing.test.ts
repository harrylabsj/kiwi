import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createHash} from 'node:crypto';
import {type AddressInfo} from 'node:net';
import {it,expect} from 'vitest';
import {A2AClient} from '../src/a2a/client/client.js';
import {requestViaAddress} from '../src/merchant-gateway/pinned-fetch.js';

async function fixture(check:(req:IncomingMessage,body:Buffer,res:ServerResponse)=>void){
 const server=createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',(b:Buffer)=>chunks.push(b));req.on('end',()=>check(req,Buffer.concat(chunks),res));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`);
 return{url,close:()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());})};
}
it('default A2A transport supplies exact UTF8 length to a strict nonchunked JSON peer without changing signed bytes',async()=>{
 let captured:Buffer|undefined;let signed:Buffer|undefined;let framing:Record<string,unknown>|undefined;
 const x=await fixture((req,body,res)=>{captured=body;framing={length:req.headers['content-length'],transfer:req.headers['transfer-encoding'],host:req.headers.host,bytes:body.length};console.log('actual default framing',JSON.stringify(framing));res.setHeader('content-type','application/json');if(req.headers['content-length']===undefined){res.statusCode=411;res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Content-Length required'}}));return;}const rpc=JSON.parse(body.toString()) as {id:string};res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{task:{id:'task-framing',contextId:'ctx',status:{state:'working'}}}}));});
 try{const client=new A2AClient({url:x.url.href,signer:{keyid:'synthetic-framing-key',sign(input){signed=input.body;return {'content-digest':createHash('sha256').update(input.body).digest('hex')};}}});await expect(client.getTask('任务🍵')).resolves.toMatchObject({id:'task-framing'});expect(captured).toEqual(signed);expect(framing?.length).toBe(String(captured!.length));expect(framing?.transfer).toBeUndefined();expect(framing?.host).toBe(x.url.host);expect(captured!.toString()).toContain('任务🍵');}finally{await x.close();}
});
it.each(['','plain ASCII','茶🍵'])('finite body %j uses its UTF8 byte length and no transfer encoding',async body=>{
 let actual:Buffer|undefined;let length:string|undefined;let transfer:string|undefined;const x=await fixture((req,b,res)=>{actual=b;length=req.headers['content-length'];transfer=req.headers['transfer-encoding'];res.end('ok');});
 try{expect((await requestViaAddress(x.url,'127.0.0.1',{method:'POST',body})).status).toBe(200);expect(actual).toEqual(Buffer.from(body,'utf8'));expect(length).toBe(String(Buffer.byteLength(body,'utf8')));expect(transfer).toBeUndefined();}finally{await x.close();}
});
