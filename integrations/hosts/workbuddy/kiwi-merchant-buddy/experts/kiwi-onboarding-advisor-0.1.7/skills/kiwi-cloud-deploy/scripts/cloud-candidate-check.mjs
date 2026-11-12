import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {preflight} from './preflight.mjs';
import {createTransaction,resumeTransaction} from './transaction.mjs';

// Local prepublication check. Does not publish, deploy, touch merchant data or
// attest to platform/user authorization. Fixture data is not a real receipt.
export async function checkCloudCandidate({stagingParent,npmBinary,nodeBinary,pythonBinary,previousVersion}) {
  if (!pythonBinary) throw new Error('REQUIRED_GATE_MISSING');
  const checked=await preflight({name:'@harrylabsj/kiwi-merchant-cloud',stagingParent,npmBinary,nodeBinary,pythonBinary});
  if (!checked.treeInspection || checked.executionAuthorized !== false) throw new Error('PREFLIGHT_INVALID');
  const bytes=await readFile(join(checked.directory,'verified-download.tgz'));
  const {lock}=checked;
  const metadata={name:lock.name,version:lock.version,dist:{integrity:lock.integrity,tarball:lock.tarball}};
  const path=join(checked.directory,'transaction.json');
  createTransaction(path,lock.name,metadata,bytes,previousVersion);
  const resumed=resumeTransaction(path,bytes);
  if(resumed.version!==lock.version || resumed.integrity!==lock.integrity) throw new Error('TRANSACTION_DRIFT');
  return {name:lock.name,version:lock.version,sourceCommit:checked.sourceCommit,tree:checked.treeInspection,transactionLocked:true,sessionDirectory:checked.directory,executionAuthorized:false};
}
