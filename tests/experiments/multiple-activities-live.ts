import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import type { PlaytestState } from './playtest-server.ts'

const root=resolve('.tmp','multiple-activities-live-'+Date.now()),pack=join(root,'pack'),data=join(root,'data')
mkdirSync(root,{recursive:true});cpSync(resolve('examples/world-packs/multiple-activities'),pack,{recursive:true})
const guessFile=join(pack,'scripts/activities/guess.js')
writeFileSync(guessFile,readFileSync(guessFile,'utf8').replace('const answer = 1 + Math.floor(Math.random() * 100);','const answer = 73;'))
const transport:{status:number|null;elapsedMs:number;failure?:string;message?:unknown}[]=[]
const originalFetch=globalThis.fetch
globalThis.fetch=async(input,init)=>{
  const started=Date.now()
  try{
    const response=await originalFetch(input,init)
    const payload=response.ok?await response.clone().json() as {choices?:{message?:unknown}[]}:null
    transport.push({status:response.status,elapsedMs:Date.now()-started,...(payload?{message:payload.choices?.[0]?.message}:{})})
    return response
  }catch(error){
    transport.push({status:null,elapsedMs:Date.now()-started,failure:error instanceof Error?error.name:'unknown'})
    throw error
  }
}
const runtime=await FrozenWorldPlaytestRuntime.create({packPath:pack,dataDirectory:data,provider:'local',
  model:process.env.HCW_LOCAL_MODEL??'gemini-3.8-flash',utilityEndpoint:process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8046/v1/chat/completions',timeoutMs:45_000})
const steps:{label:string;elapsedMs:number;error:boolean;notice:string;activities:unknown;lastProviderCall:unknown}[]=[]
async function act(key:string,operation:string,parameters:WorldJsonObject={}):Promise<PlaytestState>{
  const activity=(await runtime.state()).activities!.find(value=>value.activityKey===key)!,started=Date.now()
  const state=await runtime.activityAction({activityKey:key,activityId:operation==='start'?null:String(activity.id),revision:operation==='start'?0:Number(activity.revision),operation,parameters,requestId:randomUUID()})
  steps.push({label:key+':'+operation,elapsedMs:Date.now()-started,error:state.error,notice:state.notice,activities:state.activities,lastProviderCall:state.debug?.lastProviderCall})
  process.stdout.write(key+':'+operation+' '+(state.error?'failed':'committed')+'\n')
  assert.equal(state.error,false,state.notice);return state
}
function events(){const store=new WorldStore(join(runtime.dataDirectory,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
try{
  await act('guess','start')
  let state=await act('guess','guess',{value:20})
  for(let attempt=0;attempt<2&&(state.activity!.game as WorldJsonObject).turn==='character:companion';attempt++)state=await act('guess','retry')
  const saved=structuredClone(state.activity!.game as WorldJsonObject),id=state.activity!.id
  state=await act('guess','suspend')
  assert.equal(state.availableActions?.some(action=>action.actionType==='move'),true)
  await act('weekend','start')
  state=await act('weekend','vote',{choice:'在家休息'})
  for(let attempt=0;attempt<2&&(state.activity!.game as WorldJsonObject).active;attempt++)state=await act('weekend','retry')
  if((state.activity!.game as WorldJsonObject).active)await act('weekend','suspend')
  state=await act('guess','resume')
  assert.equal(state.activity!.id,id)
  const resume=events().findLast(event=>event.eventType==='activity.updated'&&(event.data as WorldJsonObject).operation==='resume')!
  const restored=((resume.data as WorldJsonObject).state as WorldJsonObject).game as WorldJsonObject
  assert.deepEqual(restored.public,saved.public);assert.equal(restored.turn,saved.turn)
  const npcOperations=events().filter(event=>event.eventType==='activity.updated'&&(event.data as WorldJsonObject).actorId==='character:companion')
  for(const key of ['guess','weekend'])assert(npcOperations.some(event=>(event.data as WorldJsonObject).activityKey===key),'需要两场活动都有真实角色操作，弃权样本不作为完成验收：'+key)
  const final=await runtime.state()
  writeFileSync(join(root,'report.json'),JSON.stringify({status:'passed',model:process.env.HCW_LOCAL_MODEL??'gemini-3.8-flash',transport,steps,npcOperations:npcOperations.map(event=>({key:(event.data as WorldJsonObject).activityKey,operation:(event.data as WorldJsonObject).operation})),transcript:final.transcript},null,2)+'\n')
  process.stdout.write('Report: '+join(root,'report.json')+'\n')
}catch(error){
  writeFileSync(join(root,'report.json'),JSON.stringify({status:'failed',model:process.env.HCW_LOCAL_MODEL??'gemini-3.8-flash',reason:error instanceof Error?error.message:String(error),transport,steps,transcript:(await runtime.state()).transcript},null,2)+'\n')
  process.stdout.write('Report: '+join(root,'report.json')+'\n')
  throw error
}finally{await runtime.close();globalThis.fetch=originalFetch}
