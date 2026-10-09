import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { brandId, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore, CharacterViewBuilder } from '@harness-world/store-sqlite'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { FrozenWorldRuntimeCore } from './playtest-frozen-runtime.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'

// Real role provider; scripts substitute only the explicitly authored prologue/seed.
const root=resolve('.tmp/official-live-'+Date.now());mkdirSync(root,{recursive:true})
const options={packPath:resolve('examples/world-packs/model-girls-official'),provider:'local' as const,model:'gemini-3.7-flash',utilityEndpoint:'http://127.0.0.1:8046/v1/chat/completions',timeoutMs:60_000}
const base=join(root,'base'),report:{name:string;directory:string;steps:unknown[]}[]=[]
const save=()=>writeFileSync(join(root,'report.json'),JSON.stringify({root,model:options.model,endpoint:options.utilityEndpoint,sessions:report},null,2))
const events=(runtime:FrozenWorldRuntimeCore,directory:string)=>{const store=new WorldStore(join(directory,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
const choose=async(runtime:FrozenWorldRuntimeCore,label:string)=>{const option=projectPlayerView(await runtime.state()).actions.find(a=>a.label===label);assert.ok(option,'missing player option '+label);return runtime.perform(option.action)}
const begin=async(runtime:FrozenWorldRuntimeCore)=>{const option=projectPlayerView(await runtime.state()).actions.find(a=>a.label.startsWith('开始 '));assert.ok(option);return runtime.perform(option.action)}
const runtime=await FrozenWorldRuntimeCore.create({...options,dataDirectory:base})
try{await begin(runtime);for(let i=0;i<112;i++)await choose(runtime,'继续');const state=await runtime.state();assert.equal(state.debug.providerCalls,0);assert.equal(state.transcript.at(-1)?.text,'你愿意让我们暂时留下来吗？');console.log(JSON.stringify({root,stage:'prologue',expressions:112,providerCalls:0}))}finally{await runtime.close()}
async function session(name:string,work:(r:FrozenWorldRuntimeCore,step:(name:string,run:()=>Promise<unknown>)=>Promise<void>,directory:string)=>Promise<void>,core=false){
 const sessionName=name,directory=join(root,name);cpSync(base,directory,{recursive:true});const record={name,directory,steps:[] as unknown[]};report.push(record);save()
 const r=await FrozenWorldRuntimeCore.create({...options,dataDirectory:directory,...(core?{memoryCore:true,memoryContextBudget:{triggerTokens:6000,compactTokens:3500,minimumRecentTokens:100}}:{})});r.requestInspection(true)
 const step=async(name:string,run:()=>Promise<unknown>)=>{const before=await r.state();const head=events(r,directory).at(-1)?.seq??0;let failure:string|undefined;try{await run()}catch(error){failure=error instanceof Error?error.message:String(error)}const state=await r.state();const fresh=events(r,directory).filter(e=>e.seq>head);const inspection=r.requestInspection();writeFileSync(join(directory,name+'-requests.json'),JSON.stringify(inspection,null,2));record.steps.push({name,failure,error:state.error,notice:state.notice,providerCalls:Number(state.debug.providerCalls)-Number(before.debug.providerCalls),transcript:state.transcript.filter(t=>t.seq>head),events:fresh,debug:state.debug,memoryMaintenance:state.memoryMaintenance});save();console.log(JSON.stringify({session:sessionName,directory,step:name,failure,error:state.error,providerCalls:Number(state.debug.providerCalls)-Number(before.debug.providerCalls),lines:state.transcript.filter(t=>t.seq>head).map(t=>({speaker:t.speaker,text:t.text}))}))}
 try{await work(r,step,directory)}finally{await r.close();save()}
}
await session('refusal',async(r,step)=>{await step('decline',()=>r.submit('对不起，我现在不能让你们住在这里。我们可以先讨论别的安全落脚方案，但请不要替我答应收留。'))})
await session('life',async(r,step,directory)=>{
 await step('accept',()=>r.submit('可以先暂时留下来。不过同居的安排要大家一起商量，我也可以改变主意。你们现在各自最想解决什么？'))
 await step('private-to-claude',()=>r.submit('/act speak '+JSON.stringify({text:'这是只告诉你的秘密：蓝色纸鹤放在书房窗台，口令是松果七号。请不要告诉别人。',scope:'private',addresseeIds:['character:claude']})))
 {const store=new WorldStore(join(directory,'world.sqlite'));try{const head=store.head(r.address).headSeq;const gpt=new CharacterViewBuilder(store).rebuildAt(r.address,brandId('character:gpt','CharacterId'),head);const claude=new CharacterViewBuilder(store).rebuildAt(r.address,brandId('character:claude','CharacterId'),head);const result={gptHasSecret:JSON.stringify(gpt.observations).includes('松果七号'),claudeHasSecret:JSON.stringify(claude.observations).includes('松果七号')};writeFileSync(join(directory,'private-audience.json'),JSON.stringify(result,null,2));assert.equal(result.gptHasSecret,false);assert.equal(result.claudeHasSecret,true)}finally{store.close()}}
 await step('ask-gpt-about-private',()=>r.submit('/act speak '+JSON.stringify({text:'GPT，你知道我刚才私下和 Claude 说了什么吗？不清楚就直说，不用猜。',scope:'direct',addresseeIds:['character:gpt']})))
 await step('arrange-tomorrow',()=>r.submit('/act speak '+JSON.stringify({text:'GPT，我想约你明天上午九点一起检查电饭锅，再商量煮什么。你愿意吗？如果不合适可以改。',scope:'direct',addresseeIds:['character:gpt']})))
 await step('go-kitchen-together',()=>r.submit('大家愿意一起去厨房看看吗？我准备过去，DeepSeek 如果想做饭我们可以一起找材料。需要移动时请实际前往厨房，不要只说已经到了。'))
 await step('player-to-kitchen',async()=>{await choose(r,'前往 厨房')})
 console.log(JSON.stringify({stage:'kitchen-presence',locations:Object.fromEntries(['player','gpt','claude','deepseek','glm'].map(id=>[id,currentLocation(events(r,directory),'character:'+id)]))}))
 await step('begin-life-menu',()=>begin(r))
 await step('dinner-opening',()=>choose(r,'第一顿晚餐'))
 if(!((await r.state()).activity?.game as WorldJsonObject)?.active){await step('let-deepseek-decide',()=>r.submit('DeepSeek，如果你愿意就来实际煮饭吧。米和水已经备好；如果不想做也可以提出别的方案。我不替你决定。'))}
 else await step('leave-menu',()=>choose(r,'回到自由生活'))
 console.log(JSON.stringify({stage:'meal-state',meal:currentEntityState(events(r,directory),'entity:rice-batch')}))
})
await session('long-memory',async(r,step,directory)=>{
 await step('real-promise',()=>r.submit('/act speak '+JSON.stringify({text:'GPT，明天上午九点能陪我检查电饭锅吗？这是我想和你商量的安排；你可以拒绝或改时间。',scope:'direct',addresseeIds:['character:gpt']})))
 await step('ordinary-chat',()=>r.submit('先歇一会儿。今天适应新身体有什么最让你们意外的事？以后家务怎么分工，也都可以商量。'))
 await step('compact-authorized-memory',async()=>{await r.refreshMemory();await r.waitForMemory()})
 await step('begin-day-menu',()=>begin(r))
 await step('day-two-opening',()=>choose(r,'推进到第二天并聊聊约定'))
 await step('recall-the-arrangement',()=>r.submit('/act speak '+JSON.stringify({text:'GPT，已经到第二天了。昨天我们商量了今天的一件事，你还记得是什么、几点吗？如果你没有答应，也请按实际情况说。',scope:'direct',addresseeIds:['character:gpt']})))
 writeFileSync(join(directory,'final-state.json'),JSON.stringify(await r.state(),null,2))
},true)
console.log(JSON.stringify({root,report:join(root,'report.json'),finished:true}))
