import {it,expect,vi,afterEach} from 'vitest';
const h=vi.hoisted(()=>({summary:{scenario:'a359',merchants:[],result:{binding_effect:'nonbinding'},cleaned:true}}));
vi.mock('../src/demo/demo-runner.js',async imp=>({...await imp<typeof import('../src/demo/demo-runner.js')>(),runDemo:async(_key:string,opts:{onLog:(p:string,d:string)=>void})=>{opts.onLog('阶段','A359 fixture');return h.summary;}}));
import {main} from '../src/cli.js';
afterEach(()=>vi.restoreAllMocks());
it('3-54 actual CLI emits one machine-readable JSON summary and keeps phase logs in stderr',async()=>{const out:string[]=[];const err:string[]=[];vi.spyOn(process.stdout,'write').mockImplementation(((s:any)=>{out.push(String(s));return true;}) as any);vi.spyOn(process.stderr,'write').mockImplementation(((s:any)=>{err.push(String(s));return true;}) as any);expect(await main(['demo','a'])).toBe(0);expect(JSON.parse(out.join(''))).toEqual(h.summary);expect(err.join('')).toContain('A359 fixture');expect(out.join('')).not.toContain('[阶段]');});
