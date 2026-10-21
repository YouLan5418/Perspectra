// Explicit fault injection against a real provider, kept separate from natural playtest failures.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createChatProvider, prototypeTurnCall } from '@harness-world/provider-chat'
import type { WorldJsonObject, WorldJsonValue } from '@harness-world/contracts'
import { gatewayTurnCall } from '../../desktop/host/gateway-turn-call.ts'
import { decideWithFormatRetry } from '../../desktop/host/decision-format.ts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'

const directory=resolve(process.argv[2]??'output/interaction-continuity/format-live')
mkdirSync(directory,{recursive:true})
const results:WorldJsonObject[]=[]
const provider=createChatProvider({endpoint:new URL('http://127.0.0.1:8045/v1/chat/completions'),
  model:'gemini-3.8-flash',thinkingLevel:'low',timeoutMs:60000,
  fetch:async (url,options)=>{
    const response=await fetch(url,options)
    const payload=await response.clone().json() as WorldJsonObject
    results.push({kind:'provider-usage',httpStatus:response.status,usage:payload.usage??{}})
    return response
  },
  onCall:observation=>{results.push({kind:'provider-observation',status:observation.status,durationMs:observation.durationMs})}})
const context:WorldJsonObject={character:{characterId:'character:probe',name:'测试角色',locationId:'location:room'},
  scene:{locationId:'location:room',people:[{characterId:'character:probe',name:'测试角色'},{characterId:'character:player',name:'玩家'}]},
  affordances:[],observations:[],selfObservations:[]}
const take={decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:cup'},
  definitionRef:{id:'base:take',version:1},bindingId:'binding:cup-take',arguments:{}}}
const cases=[{
  name:'missing-private-recipient',request:{context:{...context,stimulus:[{content:{text:'请私下告诉我一句简短的问候，只发给玩家。'}}]},continuation:false,canPerform:false},
  invalid:{decision:'publish',scope:'private',segments:[{type:'speech',text:'人工注入的非法表达，不进入世界或历史'}]},
}, {
  name:'missing-interaction-arguments',request:{context:{...context,stimulus:[{content:{text:'你已经决定拿取面前可用的杯子，请使用当前选项提出正式操作。'}}],
    affordances:[{actionType:'interact',interactions:[{...take.parameters,argumentSchema:{type:'object',additionalProperties:false,properties:{}}}]}]},
    continuation:false,canPerform:true},
  invalid:{...take,parameters:{targetRef:take.parameters.targetRef,definitionRef:take.parameters.definitionRef,bindingId:take.parameters.bindingId}},
}] as const
for(const entry of cases) {
  const request=entry.request as PrototypeTurnRequest
  let invocations=0,repairs=0
  const started=performance.now(),signal=AbortSignal.timeout(60000)
  try {
    const output=await decideWithFormatRetry(gatewayTurnCall(request),async call=>{
      if(++invocations===1)return entry.invalid as unknown as WorldJsonValue
      return provider.decide(call,signal)
    },signal,prototypeTurnCall(request).schema,()=>++repairs===1)
    results.push({name:entry.name,injectedFault:true,firstWasModelOutput:false,providerCalls:invocations-1,
      repairs,elapsedMs:Math.round(performance.now()-started),output,worldCommits:0})
  } catch(error) {
    results.push({name:entry.name,injectedFault:true,providerCalls:invocations-1,repairs,
      elapsedMs:Math.round(performance.now()-started),failure:error instanceof Error?error.message:String(error),worldCommits:0})
  }
}
writeFileSync(join(directory,'format-probes.json'),JSON.stringify({model:'gemini-3.8-flash',thinkingLevel:'low',results},null,2)+'\n')
process.stdout.write(JSON.stringify({directory,results})+'\n')
if(results.some(row=>row.failure))process.exitCode=1
