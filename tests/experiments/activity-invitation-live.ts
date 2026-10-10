import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorldStore } from '@harness-world/store-sqlite'
import type { WorldJsonObject } from '@harness-world/contracts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'

const root=resolve('.tmp','activity-invitation-live-'+Date.now()),model=process.env.HCW_LOCAL_MODEL??'gemini-3.8-flash'
mkdirSync(root,{recursive:true})
const runtime=await FrozenWorldPlaytestRuntime.create({packPath:resolve('examples/world-packs/multiple-activities'),dataDirectory:join(root,'data'),
  provider:'local',model,utilityEndpoint:process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8046/v1/chat/completions',timeoutMs:45_000})
const steps:unknown[]=[]
function events(){const store=new WorldStore(join(runtime.dataDirectory,'world.sqlite'));try{return store.readEvents(runtime.address)}finally{store.close()}}
async function act(operation:string,parameters:WorldJsonObject={}){
  const activity=(await runtime.state()).activities!.find(value=>value.activityKey==='invite')!,started=Date.now()
  const state=await runtime.activityAction({activityKey:'invite',activityId:operation==='start'?null:String(activity.id),revision:operation==='start'?0:Number(activity.revision),operation,parameters,requestId:randomUUID()})
  steps.push({operation,elapsedMs:Date.now()-started,error:state.error,notice:state.notice,activity:state.activity,lastProviderCall:state.debug?.lastProviderCall})
  process.stdout.write('invite:'+operation+' '+(state.error?'failed':'committed')+'\n')
  assert.equal(state.error,false,state.notice);return state
}
try{
  const before=events().length
  let state=await act('start',{npcIds:['character:friend']})
  for(let attempt=0;attempt<2&&(state.activity!.game as WorldJsonObject).phase==='invited';attempt++)state=await act('retry')
  const game=state.activity!.game as WorldJsonObject
  assert(['date','declined'].includes(String(game.phase)),'角色必须通过回应操作接受或拒绝，单纯对白不作为完成验收')
  assert.deepEqual(state.activity!.participants,['character:player','character:friend'])
  const submitted=events().slice(before)
  const response=submitted.find(event=>event.eventType==='activity.updated'&&(event.data as WorldJsonObject).operation==='respond')!
  assert(response,'需要正式回应事件')
  assert.equal((response.data as WorldJsonObject).actorId,'character:friend')
  assert(!submitted.some(event=>event.eventType==='character.moved'),'接受邀请不能自动移动')
  const bystander=submitted.filter(event=>event.eventType==='observation.upsert'&&((event.data as WorldJsonObject).value as WorldJsonObject).observerId==='character:companion')
  for(const observation of bystander){
    const content=((observation.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject
    assert.equal((content.resultMetadata as WorldJsonObject|undefined)?.activity,undefined,'旁观者不能拿到活动元数据')
    assert.equal(content.activity,undefined,'旁观者不能拿到活动状态')
  }
  if(game.phase==='date'){
    const saved=structuredClone(game)
    await act('suspend');state=await act('resume')
    assert.deepEqual(state.activity!.game,saved)
    await act('finish')
  }
  writeFileSync(join(root,'report.json'),JSON.stringify({status:'passed',model,result:game.phase,steps,bystanderObservations:bystander.length,transcript:(await runtime.state()).transcript},null,2)+'\n')
  process.stdout.write('Report: '+join(root,'report.json')+'\n')
}catch(error){
  writeFileSync(join(root,'report.json'),JSON.stringify({status:'failed',model,reason:error instanceof Error?error.message:String(error),steps,transcript:(await runtime.state()).transcript},null,2)+'\n')
  process.stdout.write('Report: '+join(root,'report.json')+'\n');throw error
}finally{await runtime.close()}
