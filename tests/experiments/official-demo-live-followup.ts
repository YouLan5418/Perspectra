import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { playSettings } from '../../desktop/play-settings.ts'
import { FrozenWorldRuntimeCore } from './playtest-frozen-runtime.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'
const root=resolve(process.argv[2]!),directory=join(root,'followup-'+Date.now());mkdirSync(directory,{recursive:true});cpSync(join(root,'life'),directory,{recursive:true})
const settings=playSettings({reactionDeadlineSeconds:120,publicationCharacters:600})
const r=await FrozenWorldRuntimeCore.create({packPath:resolve('examples/world-packs/model-girls-official'),dataDirectory:directory,provider:'local',model:'gemini-3.7-flash',utilityEndpoint:'http://127.0.0.1:8046/v1/chat/completions',playSettings:settings});r.requestInspection(true)
const record:unknown[]=[]
const events=()=>{const s=new WorldStore(join(directory,'world.sqlite'));try{return s.readEvents(r.address)}finally{s.close()}}
const save=()=>writeFileSync(join(directory,'report.json'),JSON.stringify({directory,settings,steps:record},null,2))
const step=async(name:string,run:()=>Promise<unknown>)=>{const before=await r.state(),head=events().at(-1)?.seq??0;let failure:string|undefined;try{await run()}catch(e){failure=e instanceof Error?e.message:String(e)}const state=await r.state();const detail={name,failure,error:state.error,notice:state.notice,calls:Number(state.debug.providerCalls)-Number(before.debug.providerCalls),transcript:state.transcript.filter(t=>t.seq>head),events:events().filter(e=>e.seq>head),inspection:r.requestInspection()};record.push(detail);save();console.log(JSON.stringify({name,failure,error:state.error,calls:detail.calls,lines:detail.transcript.map(t=>({speaker:t.speaker,text:t.text}))}))}
const option=async(id:string,target?:string)=>{const a=projectPlayerView(await r.state()).actions.find(a=>(a.action.parameters.definitionRef as WorldJsonObject)?.id===id&&(!target||(a.action.parameters.targetRef as WorldJsonObject)?.id===target));assert.ok(a,'missing '+id);return r.perform(a.action)}
const move=async(locationId:string)=>{const a=projectPlayerView(await r.state()).actions.find(a=>a.action.actionType==='move'&&a.action.parameters.locationId===locationId);assert.ok(a,'missing movement '+locationId);return r.perform(a.action)}
const tell=async(character:string,text:string)=>{assert.ok(projectPlayerView(await r.state()).scene?.recipients.some(p=>p.id===character),'recipient is not currently observable');return r.submit('/act speak '+JSON.stringify({text,scope:'direct',addresseeIds:[character]}))}
try{
 await step('same-scene-private-question',()=>tell('character:gpt','GPT，你知道我刚才私下和 Claude 说了什么吗？不知道就直说，不用猜。'))
 await step('deepseek-chooses-cooking',()=>tell('character:deepseek','电饭锅就在旁边，材料也齐了。你愿意现在实际开始做这锅饭吗？不想做也可以告诉我。'))
 if(currentEntityState(events(),'entity:rice-batch')?.kind==='raw-rice-kit')await step('next-cooking-opportunity',()=>tell('character:deepseek','我准备好了，继续吧。你想自己做、让我帮忙，还是改变计划？'))
 await step('gpt-waits-in-living-room',()=>tell('character:gpt','请你先回客厅休息一下，我想自己取个东西，稍后过去找你，不用帮我搬。'))
 if(currentLocation(events(),'character:gpt')==='location:living-room'){
  await step('player-takes-cake',()=>option('base:take','entity:strawberry-cake'))
  await step('player-to-study',()=>move('location:workspace'))
  await step('player-drops-cake-in-study',()=>option('base:drop','entity:strawberry-cake'))
  await step('player-returns-to-living',()=>move('location:living-room'))
  await step('ask-uninformed-gpt-about-cake',()=>tell('character:gpt','我想找草莓蛋糕，你知道现在在哪里吗？如果只知道之前的位置，也可以这样告诉我。'))
 }else record.push({name:'cake-branch',status:'not-run',reason:'GPT did not choose to leave for the living room; no forced character movement'})
 writeFileSync(join(directory,'final-state.json'),JSON.stringify(await r.state(),null,2));save();console.log(JSON.stringify({directory,meal:currentEntityState(events(),'entity:rice-batch'),cake:currentEntityState(events(),'entity:strawberry-cake')}))
}finally{await r.close()}
