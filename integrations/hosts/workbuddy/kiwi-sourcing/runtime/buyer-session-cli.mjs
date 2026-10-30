import {isAbsolute} from 'node:path';
import {stageBuyerCandidate} from './candidate-check.mjs';
import {inspectBuyerSession,inspectLatestBuyerCache,prepareLatestBuyer,verifyLatestBuyerSession} from './buyer-session.mjs';
import {prepareManagedBuyer} from './buyer-managed-prepare-draft.mjs';
import {setResolverAbortSignal} from './latest-resolver.mjs';

// Inspection only. Never starts a connector or authorizes a purchase.
function parse(argv){
 const [action,...args]=argv;if(!['stage','inspect','inspect-latest','verify','prepare','prepare-managed'].includes(action)||args.length%2)throw new Error('ARGUMENT_INVALID');
 const values={};const keys=['--parent','--session','--node','--npm','--python','--baseline-en','--baseline-zh','--previous','--store','--floor'];
 for(let i=0;i<args.length;i+=2){if(!keys.includes(args[i])||Object.hasOwn(values,args[i]))throw new Error('ARGUMENT_INVALID');values[args[i]]=args[i+1]}
 for(const k of ['--node','--npm','--python','--baseline-en','--baseline-zh',action==='stage'?'--parent':action==='prepare-managed'?'--store':'--session'])if(!isAbsolute(values[k]??''))throw new Error('ABSOLUTE_PATH_REQUIRED');
 if(action!=='prepare-managed'&&(values['--store']!==undefined||values['--floor']!==undefined))throw new Error('ARGUMENT_INVALID');
 if(action==='prepare-managed'&&(!values['--floor']||values['--parent']!==undefined||values['--session']!==undefined||values['--previous']!==undefined))throw new Error('ARGUMENT_INVALID');
 if(action==='stage'&&(values['--session']!==undefined||!values['--previous']))throw new Error('ARGUMENT_INVALID');
 if(action==='prepare'&&(!isAbsolute(values['--parent']??'')||values['--previous']!==undefined))throw new Error('ARGUMENT_INVALID');
 if((action==='inspect'||action==='inspect-latest'||action==='verify')&&(values['--parent']!==undefined||values['--previous']!==undefined))throw new Error('ARGUMENT_INVALID');
 return {action,values};
}
let interrupted=false;const cancelController=new AbortController();const onSignal=()=>{interrupted=true;cancelController.abort();setResolverAbortSignal(cancelController.signal)};setResolverAbortSignal(cancelController.signal);process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
try{
 if(interrupted)throw new Error('PREPARE_CANCELLED');
 const {action,values:v}=parse(process.argv.slice(2));const common={npmBinary:v['--npm'],nodeBinary:v['--node'],pythonBinary:v['--python'],baselineFile:v['--baseline-en'],baselineZhFile:v['--baseline-zh'],signal:cancelController.signal};
 const result=action==='prepare-managed'?await prepareManagedBuyer({...common,storeDirectory:v['--store'],floorVersion:v['--floor']}):action==='stage'?await stageBuyerCandidate({...common,stagingParent:v['--parent'],previousVersion:v['--previous']}):action==='prepare'?await prepareLatestBuyer({...common,stagingParent:v['--parent'],sessionDirectory:v['--session']}):await (action==='verify'?verifyLatestBuyerSession:action==='inspect-latest'?inspectLatestBuyerCache:inspectBuyerSession)({...common,sessionDirectory:v['--session']});
 if(interrupted)throw new Error('PREPARE_CANCELLED');
 if(result.executionAuthorized!==false||result.authorizationProven!==false)throw new Error('RESULT_INVALID');
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){const code=typeof error?.message==='string'&&/^[A-Z_]{3,80}$/.test(error.message)?error.message:'BUYER_INSPECTION_FAILED';process.stderr.write(`HOLD: ${code}\n`);process.exitCode=1}
finally{process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal)}
