import {withBuyerCacheStore} from './buyer-cache-store-draft.mjs';
import {verifyPreparedTreeBinding} from './tree-binding.mjs';

// Hold the cache update lock from the final pointer/tree check through the
// complete backend lifetime. This serializes other launcher instances but
// does not prevent a same-UID process from mutating files.
export async function startBackendWithPreparedLock({storeDirectory,prepared,verificationOptions,backendFactory,signal,verifyTree=verifyPreparedTreeBinding}){
  if(typeof storeDirectory!=='string'||!prepared||typeof backendFactory!=='function'||typeof verifyTree!=='function')throw new Error('LOCKED_BACKEND_ARGUMENT_INVALID');
  let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
  const lifetime=withBuyerCacheStore(storeDirectory,async state=>{
    let backend;
    try{
      const selected=state.prepared();
      await verifyTree(selected,prepared,verificationOptions);
      if(signal?.aborted)throw new Error('PREPARE_CANCELLED');
      backend=await backendFactory();
      if(!backend||typeof backend.send!=='function'||typeof backend.stop!=='function'||!backend.done)throw new Error('BACKEND_HANDLE_INVALID');
      resolveReady(backend);
      await backend.done;
    }catch(error){try{backend?.stop()}catch{}rejectReady(error);throw error}
  });
  lifetime.catch(rejectReady);
  const backend=await ready;
  return {...backend,done:lifetime};
}
