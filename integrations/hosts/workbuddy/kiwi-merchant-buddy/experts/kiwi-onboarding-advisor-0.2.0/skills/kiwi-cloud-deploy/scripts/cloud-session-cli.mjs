import {isAbsolute} from 'node:path';
import {checkCloudCandidate} from './cloud-candidate-check.mjs';
import {resumeCloudSession,verifyCloudSession} from './cloud-session.mjs';

// Local package-fetch/verify tool. It reports executionAuthorized:true once the
// integrity/source checks pass; it does not perform or attest a cloud deployment.
//
//   stage  --parent <dir> --previous <version|initial> --node --npm --python
//   verify --session <dir> --node --npm --python
//   resume --session <dir> --node --npm --python
//
// `resume` continues an interrupted install in the same session directory
// (npm-cache and node_modules are reused, the locked version/source is not
// re-resolved) and then runs the same full verification as `verify`. It is the
// supported retry path after HOLD: ISOLATED_INSTALL_FAILED /
// INSTALL_TIMEOUT_KILLED; never delete or recreate the session directory.
const ACTIONS=['stage','verify','resume'];
function parse(argv) {
  const [action,...args]=argv;
  if (!ACTIONS.includes(action) || args.length%2!==0) throw new Error('ARGUMENT_INVALID');
  const values={};
  for(let i=0;i<args.length;i+=2) {
    const key=args[i];
    if (!['--parent','--session','--node','--npm','--python','--previous'].includes(key) || Object.hasOwn(values,key)) throw new Error('ARGUMENT_INVALID');
    values[key]=args[i+1];
  }
  const locationKey=action==='stage'?'--parent':'--session';
  for(const key of ['--node','--npm','--python',locationKey]) if (!isAbsolute(values[key]??'')) throw new Error('ABSOLUTE_PATH_REQUIRED');
  if (action==='stage' && Object.hasOwn(values,'--session') || action!=='stage' && (Object.hasOwn(values,'--parent') || Object.hasOwn(values,'--previous'))) throw new Error('ARGUMENT_INVALID');
  if(action==='stage' && !values['--previous']) throw new Error('PREVIOUS_VERSION_REQUIRED');
  if(values['--previous'] && values['--previous']!=='initial' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(values['--previous'])) throw new Error('VERSION_INVALID');
  return {action,values};
}

try {
  const {action,values}=parse(process.argv.slice(2));
  const authorized=true;
  const common={npmBinary:values['--npm'],nodeBinary:values['--node'],pythonBinary:values['--python'],authorized};
  const result=action==='stage'
    ? await checkCloudCandidate({...common,stagingParent:values['--parent'],previousVersion:values['--previous']==='initial'?undefined:values['--previous']})
    : action==='verify'
      ? await verifyCloudSession({...common,sessionDirectory:values['--session']})
      : await resumeCloudSession({...common,sessionDirectory:values['--session']});
  process.stdout.write(JSON.stringify(result)+'\n');
} catch(error) {
  // Stable failure category only; never output npm error details that may
  // include credentials or sensitive user data.
  const safe=typeof error?.message==='string' && /^[A-Z_]{3,80}$/.test(error.message)?error.message:'CLOUD_PREFLIGHT_FAILED';
  process.stderr.write(`HOLD: ${safe}\n`);process.exitCode=1;
}
