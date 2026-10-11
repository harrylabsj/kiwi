import {beforeEach,expect,it,vi} from "vitest";
import {finalizeEnvelope,computeEnvelopeDigest} from "../src/negotiation/domain/envelope.js";
import {contentDigest} from "../src/negotiation/jcs.js";
import {negotiateWithAgent} from "../src/a2a/negotiate.js";
const state=vi.hoisted(()=>({mode:"ok",sent:[] as string[],terms:{} as Record<string,unknown>}));
vi.mock("../src/discovery/index.js",()=>({AgentDiscovery:class{async resolveViaCatalog(){return [{candidate:{catalog_agent_id:"local",discovery:{agent_card_url:"https://local.invalid/card"}},profile:{identity:{}}}];}}}));
vi.mock("../src/counterparty/index.js",()=>({selectChannelCandidate:()=>({url:"https://local.invalid/a2a"}),A2ADirectChannel:class{async open(){return{close:async()=>{},send:async({envelope:e}:{envelope:{action:string;message_id:string;negotiation_id:string;capability:string;payload:{offer_id?:string}}})=>{
 state.sent.push(e.action);
 if(e.action==="accept_nonbinding")return {task:{artifacts:[{parts:[{kind:"data",data:{agreement:{type:"accepted_nonbinding_agreement",agreement_id:"agr_probe",negotiation_id:e.negotiation_id,accepted_offer_id:e.payload.offer_id,agreed_terms:state.terms,terms_digest:contentDigest(state.terms),accepted_by:["buyer","merchant"],created_at:"2026-10-11T00:00:00Z",binding_effect:"nonbinding",creates_order:false,reserves_inventory:false,authorizes_payment:false}}}]}]}};
 const cond=e.action==="counter_offer";
 const raw=finalizeEnvelope({capability:e.capability,protocol_version:"1.0",negotiation_id:e.negotiation_id,exchange_id:"ex_reply",message_id:cond?"msg_cond":"msg_offer",in_reply_to:e.message_id,actor:"merchant",action:cond?"conditional_offer":"offer",created_at:"2026-10-11T00:00:00Z",payload:cond?{type:"conditional_offer",offer_id:"off_cond",responding_to_offer_id:e.payload.offer_id,base_terms:state.terms,conditions:[]}:{type:"offer",offer_id:"off_initial",terms:{items:[{sku:"s",quantity:{value:1,unit:"piece"},unit_price:{currency:"CNY",amount_minor:100}}]}}});
 if(!cond){if(state.mode==="digest")raw.digest="sha256:"+"0".repeat(64);if(state.mode==="neg")raw.negotiation_id="neg_other";if(state.mode==="reply")raw.in_reply_to="msg_other";if(state.mode==="actor")raw.actor="buyer";if(state.mode==="version")Object.assign(raw,{protocol_version:"9.0"});if(state.mode!=="digest")raw.digest=computeEnvelopeDigest(raw);}
 return {task:{status:{message:{parts:[{kind:"data",data:{knp_envelope:raw}}]}}}};
 }};}}}));
const item=(minor=100)=>({sku:"s",quantity:{value:1,unit:"piece"},unit_price:{currency:"CNY",amount_minor:minor}});
beforeEach(()=>{state.mode="ok";state.sent=[];state.terms={items:[item()]};});
const run=()=>negotiateWithAgent({catalog:"https://local.invalid",sku:"s",quantity:1,dealPriceMinor:100,maxPriceMinor:100});
it.each([{}, {items:[]},{items:[item(),item(101)]},{items:[{...item(),sku:"other"}]},{items:[{...item(),quantity:{value:2,unit:"piece"}}]},{items:[{...item(),quantity:{value:1,unit:"kg"}}]}])("P1 refuses unsupported or mismatched agreed terms %j before nonbinding accept",async terms=>{state.terms=terms;expect((await run()).ok).toBe(false);expect(state.sent).not.toContain("accept_nonbinding");});
it.each(["digest","neg","reply","actor","version"])("P4 rejects raw %s before any counterproposal",async mode=>{state.mode=mode;expect((await run()).ok).toBe(false);expect(state.sent).toEqual(["rfq"]);});
it("P1/P4 legitimate one-item exact request keeps nonbinding result",async()=>{const result=await run();expect(result.ok).toBe(true);expect(state.sent).toEqual(["rfq","counter_offer","accept_nonbinding"]);expect(result.agreement?.creates_order).toBe(false);});
