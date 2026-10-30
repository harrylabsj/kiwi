// Candidate least-privilege environment. Preparation never receives business
// credentials; the product receives only the explicit documented Kiwi inputs.
const base=['HOME','TMPDIR','PATH','LANG','LC_ALL','LC_CTYPE','TZ'];
const buyer=['KIWI_A2A_SIGNING_KEY_DIR','KIWI_BUYER_AGENT','KIWI_CATALOG_SESSION','KIWI_DELEGATION_POLICY','KIWI_MCP_DB','KIWI_PRINCIPAL','KIWI_RFQ_ENABLED','KIWI_RFQ_PRICE_UNIT','KIWI_RFQ_RELEASE','KIWI_SESSION','SHOPPING_BUYER_BOOTSTRAP_TOKEN'];
export function selectEnvironment(env,role){
 if(!env||typeof env!=='object'||!['prepare','backend'].includes(role))throw new Error('ENVIRONMENT_POLICY_INVALID');
 const result={};for(const key of role==='backend'?[...base,...buyer]:base)if(typeof env[key]==='string')result[key]=env[key];
 if(env.ELECTRON_RUN_AS_NODE==='1')result.ELECTRON_RUN_AS_NODE='1';
 return result;
}
