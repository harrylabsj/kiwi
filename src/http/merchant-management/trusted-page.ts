/** Top-level, no-third-party-script pages for WebAuthn registration and action confirmation. */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function createTrustedWorkbenchPageHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://trusted-page.internal");
    const nonce = randomBytes(18).toString("base64url");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
      res.end();
      return;
    }
    if (url.pathname === "/merchant/trusted/register") {
      writePage(res, nonce, renderRegistrationPage(nonce));
      return;
    }
    if (url.pathname === "/merchant/trusted/confirm") {
      writePage(res, nonce, renderConfirmationPage(nonce, url.searchParams.get("ref") ?? ""));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("not found");
  };
}

function writePage(res: ServerResponse, nonce: string, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; " +
      "form-action 'self'; frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  });
  res.end(html);
}

function shell(nonce: string, title: string, body: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px;color:#17231c}button,input{font:inherit;padding:10px;margin:6px 0}button{background:#176b42;color:white;border:0;border-radius:8px}pre{white-space:pre-wrap;background:#f2f6f3;padding:16px;border-radius:8px}.warn{color:#8a3b12}</style></head>
<body>${body}<pre id="status">等待操作</pre><script nonce="${nonce}">'use strict';
if(window.top!==window.self){document.body.textContent='必须在顶层页面打开';throw new Error('embedded');}
const status=document.getElementById('status');const show=(v)=>status.textContent=typeof v==='string'?v:JSON.stringify(v,null,2);
const b64=(s)=>{const p=s.replace(/-/g,'+').replace(/_/g,'/');const raw=atob(p+'='.repeat((4-p.length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0));};
const enc=(v)=>{const a=new Uint8Array(v);let s='';for(const b of a)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
const session=async()=>{const r=await fetch('/merchant/api/session',{credentials:'same-origin'});if(!r.ok)throw new Error('请先在此设备重新登录');return r.json();};
const post=async(path,value,csrf,extra={})=>{const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf,...extra},body:JSON.stringify(value)});const j=await r.json();if(!r.ok)throw new Error(j.detail||j.message||'请求失败');return j;};
${script}</script></body></html>`;
}

function renderRegistrationPage(nonce: string): string {
  return shell(
    nonce,
    "绑定可信确认设备",
    `<h1>绑定可信确认设备</h1><p class="warn">只应在商家确认的独立设备/浏览器 profile 打开。管理登录本身不足以授权新增认证器。</p>
<label>一次性登记码<br><input id="code" autocomplete="one-time-code"></label><br><button id="go">绑定本设备</button>`,
    `document.getElementById('go').onclick=async()=>{try{const s=await session();const code=document.getElementById('code').value;
const begun=await post('/merchant/api/v1/webauthn/registrations/options',{},s.csrf_token,{'x-registration-authorization':code});
const o=begun.options;o.challenge=b64(o.challenge);o.user.id=b64(o.user.id);o.excludeCredentials=(o.excludeCredentials||[]).map(c=>({...c,id:b64(c.id)}));
const c=await navigator.credentials.create({publicKey:o});if(!c)throw new Error('认证器未返回结果');
const r={id:c.id,rawId:enc(c.rawId),type:c.type,authenticatorAttachment:c.authenticatorAttachment||undefined,clientExtensionResults:c.getClientExtensionResults(),response:{clientDataJSON:enc(c.response.clientDataJSON),attestationObject:enc(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]}};
show(await post('/merchant/api/v1/webauthn/registrations/'+encodeURIComponent(begun.registration_id)+'/verify',r,s.csrf_token,{'x-registration-authorization':code}));}catch(e){show(String(e.message||e));}};`,
  );
}

function renderConfirmationPage(nonce: string, requestRef: string): string {
  return shell(
    nonce,
    "可信动作确认",
    `<h1>可信动作确认</h1><p class="warn">请核对服务器冻结的商家、对象、数量、金额、影响范围和决定。request_ref 不是批准能力。</p>
<pre id="snapshot">正在读取服务器快照…</pre><button id="go" disabled>使用本设备确认</button>`,
    `const ref=${JSON.stringify(requestRef)};let projection;const load=async()=>{const s=await session();const r=await fetch('/merchant/api/v1/confirmations/by-ref/'+encodeURIComponent(ref),{credentials:'same-origin'});if(!r.ok)throw new Error('确认请求不存在、已消费或不属于当前主体');projection=await r.json();document.getElementById('snapshot').textContent=JSON.stringify(projection.snapshot,null,2);document.getElementById('go').disabled=false;return s;};
let sessionData;load().then(s=>sessionData=s).catch(e=>show(String(e.message||e)));
document.getElementById('go').onclick=async()=>{try{const o=await post('/merchant/api/v1/confirmations/'+encodeURIComponent(projection.confirmation_id)+'/assertion-options',{},sessionData.csrf_token);const p={challenge:b64(o.challenge),rpId:o.rp_id,userVerification:'required',allowCredentials:o.allow_credentials.map(c=>({type:'public-key',id:b64(c.id)}))};const c=await navigator.credentials.get({publicKey:p});if(!c)throw new Error('认证器未返回结果');const a={credential_id:c.id,client_data_json:enc(c.response.clientDataJSON),authenticator_data:enc(c.response.authenticatorData),signature:enc(c.response.signature)};show(await post('/merchant/api/v1/approvals/'+encodeURIComponent(projection.candidate_id)+'/decisions',{confirmation_id:projection.confirmation_id,decision:projection.decision,expected_version:projection.expected_version,assertion:a},sessionData.csrf_token));document.getElementById('go').disabled=true;}catch(e){show(String(e.message||e));}};`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
