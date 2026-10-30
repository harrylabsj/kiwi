import {recheckTree} from './buyer-managed-prepare-draft.mjs';

// Bind the persistent format-3 pointer to the just-prepared session immediately
// before spawning the backend. This narrows the race window; same-UID mutation
// remains outside this mechanism's trust boundary.
export async function verifyPreparedTreeBinding(selected,result,options){
  if(!selected||!result||selected.sessionDirectory!==result.sessionDirectory||selected.version!==result.version||selected.integrity!==result.integrity||
    !/^[a-f0-9]{64}$/.test(selected.contentTreeSha256??'')||selected.contentTreeSha256!==result.tree?.content_tree_sha256)throw new Error('PREPARED_STATE_MISMATCH');
  await recheckTree(result,options);
}
