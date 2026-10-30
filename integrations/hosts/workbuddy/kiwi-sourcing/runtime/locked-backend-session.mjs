import {withBuyerCacheStore} from './buyer-cache-store-draft.mjs';
import {verifyPreparedTreeBinding} from './tree-binding.mjs';

// Serialize selection, final tree verification, and backend startup only.
// Updates create a new session and atomically replace prepared.json, so each
// live backend keeps using its selected session path. This addresses
// cooperating connector instances, not a malicious same-UID process.
export async function startBackendWithPreparedLock({storeDirectory,prepared,verificationOptions,backendFactory,signal,deadlineEpochMs=Date.now()+600_000,verifyTree=verifyPreparedTreeBinding}){
  if(typeof storeDirectory!=='string'||!prepared||typeof backendFactory!=='function'||typeof verifyTree!=='function')throw new Error('LOCKED_BACKEND_ARGUMENT_INVALID');
  return withBuyerCacheStore(storeDirectory,async state=>{
    let backend;
    try{
      const selected=state.prepared();
      if(!selected||selected.sessionDirectory!==prepared.sessionDirectory||selected.version!==prepared.version||selected.integrity!==prepared.integrity||selected.treeLockSha256!==prepared.tree?.lock_sha256||selected.contentTreeSha256!==prepared.tree?.content_tree_sha256)throw new Error('PREPARED_STATE_MISMATCH');
      await verifyTree(selected,prepared,{...verificationOptions,signal,deadlineEpochMs});
      if(signal?.aborted)throw new Error('PREPARE_CANCELLED');
      if(Date.now()>=deadlineEpochMs)throw new Error('PREPARE_TIMEOUT');
      backend=await backendFactory(selected);
      if(!backend||typeof backend.send!=='function'||typeof backend.stop!=='function'||!backend.done)throw new Error('BACKEND_HANDLE_INVALID');
      return backend;
    }catch(error){try{backend?.stop()}catch{void 0;}throw error}
  },{waitForLock:true,signal,deadlineEpochMs});
}
