import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const o=JSON.parse(process.argv[2]);
const original=fs.unlinkSync.bind(fs);
const log=(event)=>fs.appendFileSync(o.events,JSON.stringify({actor:o.actor,event})+'\n');
function wait(file){const end=Date.now()+5000;while(!fs.existsSync(file)){if(Date.now()>end)throw Error('child barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
let intercept=true;
fs.unlinkSync=(p)=>{if(intercept&&String(p)===o.lock&&o.pause){intercept=false;log('before-unlink');wait(o.release);}return original(p);};
// A synthetic ESRCH observation, only signal 0. No real PID is signalled.
process.kill=(_pid,signal)=>{if(signal!==0)throw Error('non-probe signal forbidden');throw Object.assign(new Error('synthetic dead PID'),{code:'ESRCH'});};
syncBuiltinESMExports();
const mod=await import(o.bundle);let release;
try{release=mod.__a367Acquire(o.dir);log('owned');if(o.mode==='release')release();else wait(o.finish);log('done');}
catch(e){log('blocked');}
finally{if(release)release();}
