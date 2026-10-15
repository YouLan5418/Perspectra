import { createServer } from 'node:http'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { currentEntityState, currentLocation } from '@harness-world/kernel'
import { WorldStore } from '@harness-world/store-sqlite'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import { recentExecutionContext } from '../../packages/application/src/recent-execution-context.ts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { goalProgressPacks, goalProgressScenarios } from './goal-progress-content.ts'
import { estimateContextTokens } from './playtest-memory-core.ts'
import { playSettings } from '../../desktop/play-settings.ts'

const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
const array=(v:unknown):unknown[]=>Array.isArray(v)?v:[]
const model='gemini-3.8-flash',endpoint='http://127.0.0.1:8045/v1/chat/completions'
const actor='character:friend'
const command=(type:string,parameters:unknown)=>'/act '+type+' '+JSON.stringify(parameters)
const inspection={decision:'perform',actionType:'interact',parameters:{targetRef:{kind:'entity',id:'entity:west-shelf'},bindingId:'binding:west-shelf-inspect',definitionRef:{id:'experiment:inspect-shelf',version:1},arguments:{}}}
const move=(locationId:string)=>({decision:'perform',actionType:'move',parameters:{locationId}})
const settings=playSettings({maximumNpcCalls:8,maximumCallsPerCharacter:2,maximumWaves:3,reactionDeadlineSeconds:180,
 autonomyOpportunities:1,autonomyNpcCalls:8,autonomyReactionWaves:2,autonomyReactionCalls:6,autonomyDeadlineSeconds:180,publicationCharacters:900})

function snapshot(runtime:FrozenWorldPlaytestRuntime) {
 const store=new WorldStore(join(runtime.dataDirectory,'world.sqlite'))
 try {
  const head=store.head(runtime.address),events=store.readEvents(runtime.address)
  return {head,events,location:currentLocation(events,actor),document:currentEntityState(events,'entity:brass-key'),integrity:store.verifyBranchIntegrity(runtime.address)}
 } finally {store.close()}
}

async function main() {
 const directory=resolve(process.argv[2]??'output/goal-progress/manual-run');mkdirSync(directory,{recursive:true})
 goalProgressPacks(join(directory,'packs'))
 const rawRequests=new Map<string,PrototypeTurnRequest>()
 ;(globalThis as unknown as {captureGoalRequest:(request:PrototypeTurnRequest)=>void}).captureGoalRequest=request=>rawRequests.set(String(object(request.context.character).characterId),structuredClone(request))
 let phase:'setup'|'capture'|'live'='setup',round=0,setupDecision:unknown,captured:PrototypeTurnRequest|undefined
 let calls:Record<string,unknown>[]=[]
 const server=createServer((request,response)=>{
  if(request.method!=='POST'){response.writeHead(404);response.end();return}
  let body='';request.on('data',chunk=>{body+=String(chunk)})
  request.on('end',()=>{void(async()=>{
   const start=performance.now(),wire=object(JSON.parse(body)),messages=array(wire.messages)
   const input=object(JSON.parse(String(object(messages.findLast(m=>object(m).role==='user')).content))),id=String(object(object(input.context).character).characterId)
   if(phase!=='live') {
    let decision:unknown={decision:'abstain'}
    if(id===actor&&input.continuation!==true&&setupDecision){decision=setupDecision;setupDecision=undefined}
    if(phase==='capture'&&id===actor&&!captured)captured=structuredClone(rawRequests.get(id)!)
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)}}]}));return
   }
   const call:Record<string,unknown>={round,actor:id,input,hostRequest:rawRequests.get(id),schema:object(object(object(array(wire.tools)[0]).function).parameters),
    generation:Object.fromEntries(['temperature','max_tokens','reasoning_effort'].map(k=>[k,wire[k]])),
    formatRepair:messages.some(m=>String(object(m).content).startsWith('上一次返回不符合本次工具 JSON schema。'))}
   calls.push(call)
   const cancel=new AbortController();response.on('close',()=>{if(!response.writableEnded)cancel.abort()})
   try {
    const upstream=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body,signal:cancel.signal})
    call.httpStatus=upstream.status;const text=await upstream.text(),returned=object(JSON.parse(text))
    call.usage=returned.usage
    const message=object(object(array(returned.choices)[0]).message)
    try{call.proposal=JSON.parse(String(object(object(array(message.tool_calls)[0]).function).arguments??message.content))}catch{call.invalidJson=true}
    if(!response.destroyed){response.writeHead(upstream.status,{'content-type':'application/json'});response.end(text)}
   }catch(error){call.failure=error instanceof Error?error.name:String(error);if(!response.destroyed){response.writeHead(502);response.end('{}')}}
   finally{call.elapsedMs=Math.round(performance.now()-start)}
  })()})
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
 const port=(server.address() as {port:number}).port
 const create=(packPath:string,dataDirectory:string,enabled=false)=>FrozenWorldPlaytestRuntime.create({packPath,dataDirectory,provider:'local',model,
  utilityEndpoint:`http://127.0.0.1:${port}/v1/chat/completions`,thinkingLevel:'low',preset:{maxOutputTokens:32768},timeoutMs:60000,
  playSettings:settings,recentExecutionEvidence:enabled,continueAfterPublish:false,beforeActionExpression:false})
 const frozen:Record<string,{request:PrototypeTurnRequest;packPath:string;dataDirectory:string;initial:ReturnType<typeof snapshot>}>= {}
 try {
  for(const scenario of goalProgressScenarios) {
   phase='setup';captured=undefined
   const packPath=join(directory,'packs',scenario),dataDirectory=join(directory,'prepared',scenario)
   const runtime=await create(packPath,dataDirectory)
   try {
    const preparation=scenario==='bounded-search'?[inspection]:scenario==='arrival-only'?[move('location:front-room'),move('location:back-room')]:[move('location:front-room')]
    for(const decision of preparation){setupDecision=decision;await runtime.submit(command('speak',{text:'作者建立该时刻之前的有限执行前史。',scope:'self',addresseeIds:[]}))}
    if(setupDecision!==undefined)throw new Error('Preparation action did not execute')
    phase='capture';await runtime.submit(command('speak',{text:scenario==='rest'?'先歇一会儿吧，今天午饭想吃什么？':'玩家整理自己的记录。',scope:scenario==='rest'?'scene_public':'self',addresseeIds:[]}))
    if(!captured)throw new Error('Missing frozen authorized request')
    frozen[scenario]={request:captured,packPath,dataDirectory,initial:snapshot(runtime)}
   } finally {await runtime.close()}
  }
  writeFileSync(join(directory,'frozen.json'),JSON.stringify(frozen,null,2)+'\n')
  const replays:Record<string,unknown>[]=[]
  const saveReplay=()=>writeFileSync(join(directory,'replay.json'),JSON.stringify({model,thinking:'low',executedActions:0,repeats:3,results:replays},null,2)+'\n')
  for(const [index,scenario] of goalProgressScenarios.entries())for(let repetition=1;repetition<=3;repetition++) {
   for(const mode of (index+repetition)%2?['A','B']:['B','A']) {
    const original=frozen[scenario]!.request,request=mode==='B'?{...original,context:recentExecutionContext(original.context)}:original
    const call=localPrototypeTurnCall(request),validate=new Ajv({strict:false}).compile(prototypeTurnCall(request).schema)
    const row:Record<string,unknown>={scenario,repetition,mode,input:JSON.parse(call.messages.at(-1)!.content),hostRequest:request,schema:call.schema,
     estimatedEvidenceTokens:estimateContextTokens(JSON.stringify((request.context.recentExecutionEvidence??{})))}
    replays.push(row);const start=performance.now()
    try {
     const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(60000),body:JSON.stringify({model,messages:call.messages,
      stream:false,temperature:0.7,max_tokens:32768,reasoning_effort:'low',tools:[{type:'function',function:{name:'submit_actions',description:call.description,parameters:call.schema}}],tool_choice:{type:'function',function:{name:'submit_actions'}}})})
     row.httpStatus=response.status;if(!response.ok)throw new Error('HTTP '+response.status)
     const returned=object(await response.json()),message=object(object(array(returned.choices)[0]).message)
     row.usage=returned.usage;row.proposal=JSON.parse(String(object(object(array(message.tool_calls)[0]).function).arguments??message.content))
     row.valid=validate(row.proposal);if(!row.valid)row.validationErrors=validate.errors
    }catch(error){row.failure=error instanceof Error?error.name+': '+error.message:String(error)}
    row.elapsedMs=Math.round(performance.now()-start);saveReplay()
    console.log(JSON.stringify({phase:'replay',scenario,repetition,mode,decision:object(row.proposal).decision,valid:row.valid,elapsedMs:row.elapsedMs,failure:row.failure}))
   }
  }
  const summaries:Record<string,unknown>[]=[]
  for(let repetition=1;repetition<=2;repetition++)for(const scenario of goalProgressScenarios)for(const mode of repetition%2?['A','B']:['B','A']) {
   phase='live';round=0;calls=[]
   const trial=join(directory,`${mode}-${scenario}-${repetition}`),dataDirectory=join(trial,'world');mkdirSync(trial,{recursive:true})
   cpSync(frozen[scenario]!.dataDirectory,dataDirectory,{recursive:true})
   const runtime=await create(frozen[scenario]!.packPath,dataDirectory,mode==='B'),rounds:Record<string,unknown>[]=[]
   const persist=()=>writeFileSync(join(trial,'record.json'),JSON.stringify({meta:{scenario,repetition,mode,model,thinking:'low',settings,recentExecutionEvidence:mode==='B',beforeActionExpression:false,continueAfterPublish:false},initial:frozen[scenario]!.initial,rounds,calls},null,2)+'\n')
   try {
    for(round=1;round<=4;round++) {
     const playerInput=command('speak',{text:scenario==='rest'&&round===1?'先歇一会儿吧，今天午饭想吃什么？':'我在前室安静记录今天的安排。',scope:scenario==='rest'&&round===1?'scene_public':'self',addresseeIds:[]})
     const before=snapshot(runtime),from=calls.length,start=performance.now(),state=await runtime.submit(playerInput),after=snapshot(runtime)
     rounds.push({round,playerInput,elapsedMs:Math.round(performance.now()-start),callRange:[from,calls.length],error:state.error,notice:state.notice,debug:state.debug,
      events:after.events.filter(e=>e.seq>before.head.headSeq),location:after.location,document:after.document,integrity:after.integrity,playerTranscript:state.transcript})
     persist();console.log(JSON.stringify({phase:'live',scenario,repetition,mode,round,calls:calls.length-from,error:state.error,location:after.location,holder:after.document?.holderId}))
    }
    const summary={scenario,repetition,mode,calls:calls.length,elapsedMs:rounds.reduce((sum,r)=>sum+Number(r.elapsedMs),0),
     knownTotalTokens:calls.reduce((sum,c)=>sum+Number(object(c.usage).total_tokens??0),0),callsWithUsage:calls.filter(c=>c.usage).length,
     errorRounds:rounds.filter(r=>r.error).map(r=>r.round),final:snapshot(runtime)}
    summaries.push(summary);writeFileSync(join(trial,'summary.json'),JSON.stringify(summary,null,2)+'\n')
    writeFileSync(join(directory,'summary.json'),JSON.stringify(summaries,null,2)+'\n')
   } finally {await runtime.close()}
  }
  console.log(JSON.stringify({directory,completed:summaries.length,replayCalls:replays.length}))
 }finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
