import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { currentEntityState } from '@harness-world/kernel'
import { playSettings } from '../../desktop/play-settings.ts'
import { FrozenWorldRuntimeCore } from './playtest-frozen-runtime.ts'
import { projectPlayerView } from '../../packages/frontend/src/player-view.ts'
const root=resolve(process.argv[2]!),directory=join(root,'cake-'+Date.now());mkdirSync(directory,{recursive:true});cpSync(join(root,'life'),directory,{recursive:true})
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
 await step('begin-conditional-activity',async()=>{const a=projectPlayerView(await r.state()).actions.find(a=>a.label.startsWith('开始 '));assert.ok(a);return r.perform(a.action)})
 await step('take-cake-in-kitchen',()=>option('base:take','entity:strawberry-cake'))
 await step('carry-cake-to-study',()=>move('location:workspace'))
 await step('drop-cake-out-of-gpt-view',()=>option('base:drop','entity:strawberry-cake'))
 await step('return-to-kitchen',()=>move('location:kitchen'))
 await step('conditional-cake-opening',async()=>{const a=projectPlayerView(await r.state()).actions.find(a=>a.label==='找一找草莓蛋糕');assert.ok(a);return r.perform(a.action)})
 await step('gpt-distinguishes-seen-from-guessed',()=>tell('character:gpt','GPT，你有亲眼看到我后来把草莓蛋糕放下吗？你现在能确认它在哪吗？没看到也可以直说。'))
 writeFileSync(join(directory,'final-state.json'),JSON.stringify(await r.state(),null,2));save();console.log(JSON.stringify({directory,cake:currentEntityState(events(),'entity:strawberry-cake')}))
}finally{await r.close()}
