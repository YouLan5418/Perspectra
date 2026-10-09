import { afterEach, expect, it, vi } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { CharacterViewBuilder, WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { PackActivity } from '../experiments/pack-activity.ts'
import { FrozenWorldRuntimeCore } from '../experiments/playtest-frozen-runtime.ts'
import { FrontendActions, projectPlayerView } from '../../packages/frontend/src/player-view.ts'
const roots:string[]=[],runtimes:FrozenWorldRuntimeCore[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const r of runtimes.splice(0))await r.close();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true})})
async function fixture(menu=false,kitchen=false,noCooker=false){
 const root=mkdtempSync(join(tmpdir(),'official-demo-'));roots.push(root);const pack=join(root,'pack'),data=join(root,'data');cpSync(resolve('examples/world-packs/model-girls-official'),pack,{recursive:true})
 if(menu){const script=join(pack,'scripts/activity.js');writeFileSync(script,readFileSync(script,'utf8').replace('const complete=saved.prologueComplete===true','const complete=true'))}
 if(kitchen){for(const file of ['characters.json','scenes.json']){const p=join(pack,file);writeFileSync(p,readFileSync(p,'utf8').replaceAll('location:living-room','location:temporary').replaceAll('location:kitchen','location:living-room').replaceAll('location:temporary','location:kitchen'))}}
 if(noCooker){const p=join(pack,'entities.json');const e=JSON.parse(readFileSync(p,'utf8'));e.entities.find((e:{entityId:string})=>e.entityId==='entity:rice-cooker').locationId='location:workspace';writeFileSync(p,JSON.stringify(e))}
 const options={packPath:pack,dataDirectory:data,provider:'ollama' as const,model:'unused',utilityEndpoint:'http://127.0.0.1:1/api/chat',timeoutMs:1000}
 const runtime=await FrozenWorldRuntimeCore.create(options);runtimes.push(runtime)
 const events=()=>{const store=new WorldStore(join(data,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
 const activate=async()=>{const action=projectPlayerView(await runtime.state()).actions.find(a=>a.label.startsWith('开始 '))!;return runtime.perform(action.action)}
 const operation=async(label:string)=>{const action=projectPlayerView(await runtime.state()).actions.find(a=>a.label===label)!;expect(action).toBeDefined();return runtime.perform(action.action)}
 return {runtime,options,data,pack,events,activate,operation}
}
it('atomically commits the scripted player question and cursor, hides its source from role observations, and rejects stale next actions',async()=>{
 const f=await fixture();const opened=await f.activate();expect(opened.transcript.at(-1)).toMatchObject({speaker:'游戏结果',player:false});for(let i=0;i<7;i++)await f.operation('继续');
 const gateway=new FrontendActions(f.runtime),next=projectPlayerView(await f.runtime.state()).actions.find(a=>a.label==='继续')!;
 const request={requestId:'request:scripted',actionId:'action:scripted',operation:'perform' as const,payload:{optionId:next.id}};
 const first=await gateway.perform(request),again=await gateway.perform({...request,requestId:'request:again'});expect(again.history).toEqual(first.history);
 const events=f.events(),speech=events.filter(e=>e.eventType==='character.speak'&&(e.data as WorldJsonObject).characterId==='character:player');expect(speech).toHaveLength(1);
 expect(speech[0]!.data).toMatchObject({text:'……什么情况？这里不是我家吗？',scope:'scene_public'});
 const sourced=events.find(e=>e.eventType==='activity.updated'&&(e.data as WorldJsonObject).scriptedPlayerExpression)!;expect(sourced.tick).toBe(speech[0]!.tick);
 expect(((sourced.data as WorldJsonObject).scriptedPlayerExpression as WorldJsonObject).source).toMatchObject({script:'scripts/activity.js',operation:'next'});
 expect(events.filter(e=>e.eventType==='observation.upsert'&&JSON.stringify(e.data).includes('scriptedPlayerExpression'))).toHaveLength(0);
 expect(first.history.filter(h=>h.player)).toHaveLength(1);await expect(f.runtime.perform(next.action)).rejects.toThrow('失效');
 const before=events.length;await f.runtime.close();const restored=await FrozenWorldRuntimeCore.create(f.options);runtimes.push(restored);expect(f.events()).toHaveLength(before);
 expect(((await restored.state()).activity!.game as WorldJsonObject).public).toMatchObject({index:8});
})
it('does not advance the NPC cursor or publish when its transaction fails; retries the pending line once',async()=>{
 const f=await fixture();const start=await f.activate();const index=((start.activity!.game as WorldJsonObject).public as WorldJsonObject).index;
 const original=WorldStore.prototype.commitRound;const spy=vi.spyOn(WorldStore.prototype,'commitRound').mockImplementation(function(this:WorldStore,...args){if(args[0].events.some(e=>e.eventType==='character.speak'))throw new Error('publication transaction failed');return original.apply(this,args)});
 await expect(f.operation('继续')).rejects.toThrow('publication transaction failed');spy.mockRestore();
 expect(f.events().filter(e=>e.eventType==='character.speak')).toHaveLength(0);expect(((await f.runtime.state()).activity!.game as WorldJsonObject).public).toMatchObject({index});
 const state=await f.runtime.state();const retry=projectPlayerView(state).actions.find(a=>a.label==='恢复当前活动节点')!;expect(retry).toBeDefined();await f.runtime.perform(retry.action);
 expect(f.events().filter(e=>e.eventType==='character.speak')).toHaveLength(1);
})
it.each(['direct','private'] as const)('keeps %s content out of activity bystanders and delivers only the private occurrence when appropriate',async scope=>{
 const f=await fixture(true);await f.activate();await f.runtime.submit('/act speak '+JSON.stringify({text:'只有 Claude 知道的秘密：蓝色纸鹤。',scope,addresseeIds:['character:claude']}));
 const store=new WorldStore(join(f.data,'world.sqlite'));try{const head=store.head(f.runtime.address).headSeq;const gpt=new CharacterViewBuilder(store).rebuildAt(f.runtime.address,brandId('character:gpt','CharacterId'),head);expect(JSON.stringify(gpt.observations)).not.toContain('蓝色纸鹤');expect(gpt.observations.some(o=>((o.value as WorldJsonObject).content as WorldJsonObject)?.contentVisibility==='occurrence_only')).toBe(scope==='private');const claude=new CharacterViewBuilder(store).rebuildAt(f.runtime.address,brandId('character:claude','CharacterId'),head);expect(JSON.stringify(claude.observations)).toContain('蓝色纸鹤')}finally{store.close()}
})
it('cooks exactly one existing batch, cannot cook it twice, then consumes it without inventing another entity',async()=>{
 const f=await fixture(true,true);await f.activate();const before=f.events().filter(e=>e.eventType==='entity.upsert').length;
 const cook=projectPlayerView(await f.runtime.state()).actions.find(a=>a.action.parameters.definitionRef && (a.action.parameters.definitionRef as WorldJsonObject).id==='home:cook-rice')!;expect(cook).toBeDefined();await f.runtime.perform(cook.action);
 expect(currentEntityState(f.events(),'entity:rice-batch')).toMatchObject({kind:'cooked-rice',holderId:null,locationId:'location:kitchen'});
 await expect(f.runtime.perform(cook.action)).rejects.toThrow('未被规则接受');
 const eat=projectPlayerView(await f.runtime.state()).actions.find(a=>(a.action.parameters.definitionRef as WorldJsonObject)?.id==='home:eat-rice')!;expect(eat).toBeDefined();await f.runtime.perform(eat.action);
 expect(currentEntityState(f.events(),'entity:rice-batch')?.kind).toBe('empty-meal-container');await expect(f.runtime.perform(eat.action)).rejects.toThrow('未被规则接受');
 expect(f.events().filter(e=>e.eventType==='entity.upsert')).toHaveLength(before+2);
})
it('offers no cooking when the declared cooker is out of reach; leaves ingredients unchanged',async()=>{
 const f=await fixture(true,true,true);await f.activate();expect(projectPlayerView(await f.runtime.state()).actions.some(a=>(a.action.parameters.definitionRef as WorldJsonObject)?.id==='home:cook-rice')).toBe(false);expect(currentEntityState(f.events(),'entity:rice-batch')?.kind).toBe('raw-rice-kit');
})
it('checks dinner conditions at execution and returns the fixed event opening to free control',async()=>{
 const absent=await fixture(true);await absent.activate();const head=absent.events().length;await expect(absent.operation('第一顿晚餐')).rejects.toThrow('需要在厨房');expect(absent.events()).toHaveLength(head);
 const present=await fixture(true,true);await present.activate();const end=await present.operation('第一顿晚餐');expect((end.activity!.game as WorldJsonObject).active).toBe(false);expect(end.transcript.at(-1)?.text).toContain('有人愿意一起吗');expect(end.debug.providerCalls).toBe(0);expect(currentEntityState(present.events(),'entity:rice-batch')?.kind).toBe('raw-rice-kit');
})

it('offers dinner after autonomous cooking without replaying cooking or changing the meal',async()=>{
 const f=await fixture(true,true);await f.activate();
 const cook=projectPlayerView(await f.runtime.state()).actions.find(a=>(a.action.parameters.definitionRef as WorldJsonObject)?.id==='home:cook-rice')!;await f.runtime.perform(cook.action);
 const before=f.events().filter(e=>e.eventType==='entity.upsert').length;
 const end=await f.operation('第一顿晚餐');expect((end.activity!.game as WorldJsonObject).active).toBe(false);expect(end.transcript.at(-1)?.text).toContain('饭已经煮好了');
 expect(currentEntityState(f.events(),'entity:rice-batch')?.kind).toBe('cooked-rice');expect(f.events().filter(e=>e.eventType==='entity.upsert')).toHaveLength(before);
})

it('requires an authorized cake transfer before asking, and does not guess an unseen current position',async()=>{
 const f=await fixture(true,true);await f.activate();const before=f.events().length;
 await expect(f.operation('找一找草莓蛋糕')).rejects.toThrow('蛋糕就在眼前');expect(f.events()).toHaveLength(before);
 const find=(id:string)=>projectPlayerView(awaitState).actions.find(a=>(a.action.parameters.definitionRef as WorldJsonObject)?.id===id && (a.action.parameters.targetRef as WorldJsonObject)?.id==='entity:strawberry-cake')!;
 let awaitState=await f.runtime.state();await f.runtime.perform(find('base:take').action);
 awaitState=await f.runtime.state();await f.runtime.perform(find('base:drop').action);
 const move=projectPlayerView(await f.runtime.state()).actions.find(a=>a.action.actionType==='move'&&a.action.parameters.locationId==='location:living-room')!;expect(move).toBeDefined();await f.runtime.perform(move.action);
 const end=await f.operation('找一找草莓蛋糕');expect((end.activity!.game as WorldJsonObject).active).toBe(false);
 expect(end.transcript.at(-1)?.text).toBe('草莓蛋糕现在在哪里？我想确认一下。');expect(end.debug.providerCalls).toBe(0);
 expect(currentEntityState(f.events(),'entity:strawberry-cake')).toMatchObject({locationId:'location:kitchen',holderId:null});
})
it('advances only the declared game day and records the explicit follow-up without inventing a promise',async()=>{
 const f=await fixture(true);await f.activate();const end=await f.operation('推进到第二天并聊聊约定');
 expect((end.activity!.game as WorldJsonObject).public).toMatchObject({day:2,period:'上午'});expect((end.activity!.game as WorldJsonObject).active).toBe(false);
 expect(end.transcript.at(-1)?.text).toBe('新的一天了。昨天我们聊过的安排，你现在怎么看？');expect(end.debug.providerCalls).toBe(0);
 expect(f.events().filter(e=>e.eventType==='character.speak'&&(e.data as WorldJsonObject).characterId==='character:player')).toHaveLength(1);
})

it('serves committed activity views without reopening a writer during snapshot polling',async()=>{
 const f=await fixture();await f.activate();const before=await f.runtime.state();
 const spy=vi.spyOn(PackActivity.prototype,'current').mockImplementation(()=>{throw new Error('database is locked')});
 const state=await f.runtime.state();expect(state.activity).toEqual(before.activity);expect(projectPlayerView(state).activity?.phase).toBe('prologue');expect(spy).not.toHaveBeenCalled();
})

it('publishes a fixed beat with a Core-sized authorized context, and bounds oversized simulation input',async()=>{
 const f=await fixture();await f.activate();
 const original=PackActivity.prototype.simulate;let size=70000;
 vi.spyOn(PackActivity.prototype,'simulate').mockImplementation(function(this:PackActivity,request){return original.call(this,{...request,context:{...request.context,authorizedHistory:'x'.repeat(size)}})});
 const first=await f.operation('继续');expect(first.error).toBe(false);expect(f.events().filter(e=>e.eventType==='character.speak')).toHaveLength(1);expect(first.debug.providerCalls).toBe(0);
 size=2*1024*1024;const failed=await f.operation('继续');expect(failed.error).toBe(true);expect(f.events().filter(e=>e.eventType==='character.speak')).toHaveLength(1);
 size=70000;const option=projectPlayerView(failed).actions.find(a=>a.label==='恢复当前活动节点')!;await f.runtime.perform(option.action);expect(f.events().filter(e=>e.eventType==='character.speak')).toHaveLength(2);
})
