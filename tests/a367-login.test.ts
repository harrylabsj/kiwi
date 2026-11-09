import {Readable} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/auth/merchant-sessions.js',async imp=>({...await imp<typeof import('../src/auth/merchant-sessions.js')>(),readAdminCredentials:()=>({principal_id:'a367-fixture',merchant_id:'a367-fixture',password_hash:'synthetic-only'}),verifyAdminPassword:(pw:string)=>pw==='a367-correct'}));
import {createMerchantHttpHandler} from '../src/mcp/merchant-server.js';
const closers:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of closers.splice(0))await close();});
function fixture(adminOptions:Record<string,unknown>={}){let now=1_700_000_000_000;vi.spyOn(Date,'now').mockImplementation(()=>now);const sessions={createSession:vi.fn(()=>({sessionId:'synthetic-session'}))};const handle=createMerchantHttpHandler({service:{},admin:{adminDir:'/never-read-a367',sessions,surface:{},...adminOptions}} as never);closers.push(handle.close);return {sessions,advance:()=>{now+=300_001;},login:async(password:string,ip='192.0.2.1',xff='',next?:string)=>new Promise<{status:number;headers:Record<string,string>;body:string}>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('login fixture timeout')),2000);const fields:Record<string,string>={password};if(next!==undefined)fields.next=next;const req=Readable.from([Buffer.from(new URLSearchParams(fields).toString())]);Object.assign(req,{url:'/admin/login',method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-forwarded-for':xff},socket:{remoteAddress:ip}});let status=0;let headers:Record<string,string>={};const headerMap:Record<string,string>={};let body='';handle.handler(req as never,{headersSent:false,setHeader:(name:string,value:unknown)=>{headerMap[name.toLowerCase()]=String(value);},getHeader:(name:string)=>headerMap[name.toLowerCase()],writeHead:(code:number,h?:Record<string,string>)=>{status=code;headers={...headerMap,...(h??{})};},end:(chunk?:unknown)=>{body+=typeof chunk==='string'?chunk:(Buffer.isBuffer(chunk)?chunk.toString('utf8'):'');clearTimeout(timer);resolve({status,headers,body});}} as never);})};}
it('2-16 expiry starts a new failure window and correct password clears it',async()=>{const h=fixture();for(let n=0;n<10;n++)expect((await h.login('wrong')).status).toBe(200);expect((await h.login('wrong')).status).toBe(429);h.advance();for(let n=0;n<10;n++)expect((await h.login('wrong')).status).toBe(200);expect((await h.login('wrong')).status).toBe(429);h.advance();expect((await h.login('a367-correct')).status).toBe(303);for(let n=0;n<9;n++)expect((await h.login('wrong')).status).toBe(200);expect(h.sessions.createSession).toHaveBeenCalledTimes(1);});
it('2-16 forged XFF does not rotate a socket bucket or bypass an active block',async()=>{const h=fixture();for(let n=0;n<10;n++)expect((await h.login('wrong','192.0.2.1',`198.51.100.${n}`)).status).toBe(200);expect((await h.login('a367-correct','192.0.2.1','203.0.113.99')).status).toBe(429);expect((await h.login('wrong','192.0.2.2','203.0.113.99')).status).toBe(200);h.advance();expect((await h.login('a367-correct','192.0.2.1')).status).toBe(303);expect(h.sessions.createSession).toHaveBeenCalledTimes(1);});

it('裸登录成功默认落到 /admin/pending（独立 MCP 保持原默认）', async () => {
  const h = fixture();
  const r = await h.login('a367-correct');
  expect(r.status).toBe(303);
  expect(r.headers.location).toBe('/admin/pending');
});

it('合法 next 在成功、口令失败与限流后都保留；非法 next 回落到默认页', async () => {
  const h = fixture();
  const ok = await h.login('a367-correct', '192.0.2.11', '', '/merchant/');
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe('/merchant/');

  const failed = await h.login('wrong', '192.0.2.12', '', '/merchant/');
  expect(failed.status).toBe(200);
  expect(failed.body).toContain('name="next" value="/merchant/"');

  for (let n = 0; n < 10; n += 1) await h.login('wrong', '192.0.2.13', '', '/merchant/');
  const blocked = await h.login('wrong', '192.0.2.13', '', '/merchant/');
  expect(blocked.status).toBe(429);
  expect(blocked.body).toContain('name="next" value="/merchant/"');

  const evil = await h.login('a367-correct', '192.0.2.14', '', '//evil.example/x');
  expect(evil.status).toBe(303);
  expect(evil.headers.location).toBe('/admin/pending');
});

it('云工作台形态（admin.defaultNext=/merchant/）裸登录与失败页都落到工作台', async () => {
  const h = fixture({ defaultNext: '/merchant/' });
  const ok = await h.login('a367-correct', '192.0.2.21');
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe('/merchant/');
  const failed = await h.login('wrong', '192.0.2.22');
  expect(failed.status).toBe(200);
  expect(failed.body).toContain('name="next" value="/merchant/"');
});
