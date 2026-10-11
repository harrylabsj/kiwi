import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {generateKeyPairSync,sign,type KeyObject} from "node:crypto";
import {JwsError,verifyCompactJws} from "../src/trust/identity/jws.js";
import {verifyBindingClaims} from "../src/trust/binding/verify.js";
import {InboundPipeline} from "../src/a2a/server/pipeline.js";
import {TaskRegistry} from "../src/a2a/server/task-registry.js";
import {LedgerStore} from "../src/negotiation/ledger/store.js";
import {IdempotencyStore} from "../src/negotiation/idempotency/store.js";
import {finalizeEnvelope,validateWireEnvelope} from "../src/negotiation/domain/envelope.js";
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const now=()=>"2026-10-11T00:00:00.000Z";
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),"a422-core-"));dirs.push(dir);const ledger=new LedgerStore({dir,now}),idem=new IdempotencyStore({dir,now});let effects=0;const pipe=new InboundPipeline({ledger,idempotency:idem,tasks:new TaskRegistry(),now,logError:()=>{},handler:{name:"synthetic",handle:async()=>{effects++;return {kind:"declined",reasonCode:"not_supported"};}}});return {dir,ledger,idem,pipe,effects:()=>effects};}
function envelope(payload:{type:"clarification_response";[key:string]:unknown}={type:"clarification_response",answer:"public"}){return finalizeEnvelope({capability:"com.harrylabsj.kiwi.shopping.negotiation",protocol_version:"1.0",negotiation_id:"neg_probe",exchange_id:"ex_probe",message_id:"msg_probe",in_reply_to:"msg_prior",actor:"buyer",action:"clarification_response",created_at:now(),payload});}
function send(x:ReturnType<typeof fixture>,e:ReturnType<typeof envelope>){return x.pipe.sendMessage({message:{role:"user",messageId:e.message_id,parts:[{kind:"data",data:{knp_envelope:e}}]}},{senderIdentity:"peer",identityVerified:true});}
it("P2 deterministic reserved wire refuses before handler and no new unknown claim",async()=>{const x=fixture(),e=validateWireEnvelope(envelope({type:"clarification_response",answer:{reasoning:"SYNTHETIC"}}));await expect(send(x,e)).rejects.toThrow();expect(x.effects()).toBe(0);expect(x.idem.readInFlight("peer",e.message_id)).toBeNull();expect(x.ledger.events(e.negotiation_id)).toEqual([]);await expect(send(x,e)).rejects.toThrow();expect(x.effects()).toBe(0);});
it("P2 existing unknown remains blocking; public safe extensions still process once",async()=>{const x=fixture(),e=envelope();x.idem.markInFlight({sender_identity:"peer",message_id:e.message_id,digest:e.digest});await expect(send(x,e)).rejects.toThrow();expect(x.effects()).toBe(0);expect(x.idem.readInFlight("peer",e.message_id)).not.toBeNull();const y=fixture(),safe=envelope({type:"clarification_response",answer:{public_extension:true}});await send(y,safe);await send(y,safe);expect(y.effects()).toBe(1);});
function compact(alg:string,privateKey:KeyObject){const h=Buffer.from(JSON.stringify({alg,kid:"issuer"})).toString("base64url"),p=Buffer.from('{}').toString("base64url");const input=Buffer.from(h+'.'+p);const sig=alg==="EdDSA"?sign(null,input,privateKey):sign("sha256",input,{key:privateKey,dsaEncoding:"ieee-p1363"});return h+'.'+p+'.'+sig.toString("base64url");}
it("P3 KeyObject alg mismatch is structured and binding verifier refuses without native throw",()=>{const key=generateKeyPairSync("ed25519"),valid=compact("EdDSA",key.privateKey);expect(verifyCompactJws(valid,key.publicKey).alg).toBe("EdDSA");const parts=valid.split('.');parts[0]=Buffer.from(JSON.stringify({alg:"ES256",kid:"issuer"})).toString("base64url");const bad=parts.join('.');expect(()=>verifyCompactJws(bad,key.publicKey)).toThrow(JwsError);expect(()=>verifyBindingClaims(bad,{trust:{resolveIssuerKey:()=>key.publicKey},now:()=>new Date(now())})).not.toThrow();expect(verifyBindingClaims(bad,{trust:{resolveIssuerKey:()=>key.publicKey},now:()=>new Date(now())}).ok).toBe(false);});
it("P3 ES256 permits actual P256 but rejects P384 KeyObject even with real valid crypto signature",()=>{const good=generateKeyPairSync("ec",{namedCurve:"prime256v1"});expect(verifyCompactJws(compact("ES256",good.privateKey),good.publicKey).alg).toBe("ES256");const wrong=generateKeyPairSync("ec",{namedCurve:"secp384r1"});expect(()=>verifyCompactJws(compact("ES256",wrong.privateKey),wrong.publicKey)).toThrow(JwsError);});

it.each(["P384", "RSA"])("P3 unsupported %s JWK is refused without adding another JWS algorithm", family => {
  const pair = family === "P384" ? generateKeyPairSync("ec", { namedCurve: "secp384r1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = pair.publicKey.export({ format: "jwk" });
  expect(() => verifyCompactJws(compact("ES256", pair.privateKey), key)).toThrow(JwsError);
});
