import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchOfficial,setResolverAbortSignal} from '../runtime/latest-resolver.mjs';

test('an already cancelled prepare aborts registry fetch before opening a request',async()=>{
  const controller=new AbortController();controller.abort();setResolverAbortSignal(controller.signal);
  try{await assert.rejects(()=>fetchOfficial('https://registry.npmjs.org/@harrylabsj%2fkiwi/latest',1024),/REGISTRY_CANCELLED/)}
  finally{setResolverAbortSignal(undefined)}
});
