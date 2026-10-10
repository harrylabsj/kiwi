import {it,expect,vi,afterEach} from 'vitest';
import {redactPrivateFloor} from '../src/agent/negotiation-chat.js';
import {createStrategyEngine} from '../src/operator/strategy.js';
import {compileDirectiveHints} from '../src/operator/runner.js';
import {buildModel} from '../src/runtime/model.js';
import {MerchantWorkbenchService} from '../src/merchant/workbench-service.js';
import {runFanoutBuyer,DEMO_SCENARIOS} from '../src/demo/demo-runner.js';
import {testProfile} from './helpers.js';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('3-24 equivalent decimal private floor tokens are masked, distinct values and regex-like text remain intact',()=>{const p=testProfile({merchant_policy:{min_unit_price_private:80.5} as never});expect(redactPrivateFloor('80.50 080.500 8.05e1',p)).toBe('[私密阈值] [私密阈值] [私密阈值]');expect(redactPrivateFloor('180.50 80x5 80.55',p)).toBe('180.50 80x5 80.55');});
it('3-49 percentage amounts are refused instead of applied as absolute money',()=>{for(const [text,ctx] of [['预算提高10%',{role:'buyer',buyer_max_total_price:100}],['底价降低10％',{role:'merchant',merchant_min_unit_price:100}]] as const){const p=createStrategyEngine().compile(text,ctx);expect(p.kind).toBe('forbidden');expect(p.summary).toMatch(/百分比|明确金额/);}});
it('3-49 persisted legacy percentage directives cannot become numeric budget/floor hints',()=>{expect(compileDirectiveHints([{kind:'tighten',directive:'预算提高10%'},{kind:'relax',directive:'底价降低10％'}] as never)).toEqual({});});
it('3-49 absolute amounts still obey confirmation classification',()=>{expect(createStrategyEngine().compile('预算提高到150',{role:'buyer',buyer_max_total_price:100}).kind).toBe('relax');expect(createStrategyEngine().compile('预算降到80',{role:'buyer',buyer_max_total_price:100}).kind).toBe('tighten');});
it('3-51 incomplete unknown provider rejects at model resolution',()=>{expect(()=>buildModel({...testProfile(),model:{provider:'custom-a359',model:'local'}} as never)).toThrow(/provider|api|base/i);});
it('3-51 complete custom provider, standard provider and fake remain supported',()=>{const m=buildModel({...testProfile(),model:{provider:'custom-a359',model:'local',api:'openai-completions',base_url:'http://127.0.0.1:1/v1'}} as never);expect(m.baseUrl).toBe('http://127.0.0.1:1/v1');expect(buildModel({...testProfile(),model:{provider:'openai',model:'x'}} as never).baseUrl).toContain('openai.com');expect(buildModel(testProfile({model:{provider:'fake',model:'fake'}} as never))).toBeDefined();});
function workbench(products: Record<string, unknown>[]){return new MerchantWorkbenchService({profile:testProfile(),merchantClient:{},approvals:{},mode:()=> 'supervised',now:()=>new Date().toISOString(),dataSource:{getProducts:async()=>products}} as never);}
it('3-36 unknown product price fails explicitly instead of being advertised as free',async()=>{await expect(workbench([{sku:'missing',title:'unknown'}]).listPublicProducts()).rejects.toMatchObject({kind:'unavailable'});});
it('3-36 explicitly zero and real priced products remain valid',async()=>{const res=await workbench([{sku:'free',price_minor:0},{sku:'paid',price_minor:100}]).listPublicProducts();expect(res.items.map(p=>p.price)).toEqual([0,100]);});
it('3-54 fanout progress uses the supplied log sink and never console stdout',async()=>{const log=vi.fn();const stdout=vi.spyOn(console,'log').mockImplementation(()=>{});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('A359 fixture stop before network')));const call=runFanoutBuyer;await expect(call(DEMO_SCENARIOS.a!,'http://fixture.invalid',log)).rejects.toThrow('fixture stop');expect(log).toHaveBeenCalledWith('发现',expect.any(String));expect(stdout).not.toHaveBeenCalled();});
