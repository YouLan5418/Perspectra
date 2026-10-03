/** Replay a saved real request with new memory; proposed actions are NOT executed. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createChatProvider } from '@harness-world/provider-chat'
import { type WorldJsonObject } from '@harness-world/contracts'
import { localPrototypeTurnCall } from '../../tests/experiments/local-prototype-turn-call.ts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'

type Ref={sourceId:string;worldSeq:number;characterId:string;worldAddress:WorldJsonObject}
type Source=Ref & {knownTick:number}
type Unit={id:string;text:string;kind:string;memoryLevel?:string;sourceRefs:Ref[];sourceRanks?:Record<string,number>}
type Index={scope:WorldJsonObject;sources:Source[];units:Unit[];vectors:number[][];links:(string|number|null)[][]}
const [traceArg,preparedArg,outputArg]=process.argv.slice(2)
if(!traceArg||!preparedArg||!outputArg)throw new Error('provide saved trace, prepared file and fresh output')
const output=resolve(outputArg)
if(existsSync(output))throw new Error('output exists')
const trace=JSON.parse(readFileSync(resolve(traceArg),'utf8')) as {id:string;actorId:string;headSeq:number;tick:number;query:string;snapshot:string;hostRequest:PrototypeTurnRequest}
const data=JSON.parse(readFileSync(resolve(preparedArg),'utf8')) as {scope:WorldJsonObject;sources:Source[]}
const original=JSON.parse(readFileSync(resolve(dirname(traceArg),'..',trace.snapshot),'utf8')) as Index
if(data.scope.characterId!==trace.actorId||JSON.stringify(data.scope.worldAddress)!==JSON.stringify(original.scope.worldAddress))throw new Error('scope mismatch')
if(Number(data.scope.asOfWorldSeq)>trace.headSeq||data.sources.some(s=>s.worldSeq>trace.headSeq||s.knownTick>trace.tick))throw new Error('future memory')
const indexed=JSON.parse(readFileSync(resolve(dirname(preparedArg),'index.json'),'utf8')) as Index
if(JSON.stringify(indexed.scope)!==JSON.stringify(data.scope))throw new Error('index scope mismatch')
const request=trace.hostRequest
const recent=new Set([...(request.context.observations as WorldJsonObject[]),...(request.context.selfObservations as WorldJsonObject[])]
 .map(o=>Number(o.sourceSeq)))
const positions=indexed.units.flatMap((u,i)=>u.sourceRefs.every(r=>recent.has(r.worldSeq))?[]:[i])
const units=positions.map(i=>indexed.units[i]!),ids=new Set(units.map(u=>u.id))
const index={...indexed,units,vectors:positions.map(i=>indexed.vectors[i]!),links:indexed.links.filter(e=>ids.has(String(e[0]))&&ids.has(String(e[1])))}
const run=spawnSync(process.env.HCW_HINDSIGHT_PYTHON||resolve('.tmp/hindsight-vector-venv/Scripts/python.exe'),
 [resolve('experiments/hindsight-core/vector_core.py')],{input:JSON.stringify({operation:'recall',scope:data.scope,index,query:trace.query,limit:8}),
 encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'},maxBuffer:64*1024*1024,timeout:120_000})
if(run.error||run.status!==0)throw new Error(run.error?.message??run.stderr.slice(-2000))
const recall=JSON.parse(run.stdout) as {results:Unit[]}
const sources=new Map(data.sources.map(s=>[s.sourceId,s]))
const memories=recall.results.map(u=>({...u,memoryId:u.id,sourceMaxSeq:Math.max(...u.sourceRefs.map(r=>r.worldSeq)),
 sourceAgeTicks:trace.tick-Math.max(...u.sourceRefs.map(r=>sources.get(r.sourceId)!.knownTick)),
 sourceAges:u.sourceRefs.map(r=>({sourceId:r.sourceId,knownTick:sources.get(r.sourceId)!.knownTick,sourceAgeTicks:trace.tick-sources.get(r.sourceId)!.knownTick})),
 note:'本角色已授权来源的非权威记忆；Episode 内证据各自独立，Observation 是可修正的主观认识。'}))
const delivered:PrototypeTurnRequest={...request,context:{...request.context,memories},
 ...(request.recallEvidence===undefined?{}:{recallEvidence:{query:trace.query,memories}})}
const call=localPrototypeTurnCall(delivered)
const apiKey=process.env.HCW_LOCAL_API_KEY?.trim()
const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT||'http://127.0.0.1:8045/v1/chat/completions'),
 model:process.env.HCW_LOCAL_MODEL||'gemini-3.7-flash',toolName:'prototype_turn',timeoutMs:90_000,maxOutputTokens:1400,
 ...(apiKey===undefined?{}:{apiKey})})
mkdirSync(dirname(output),{recursive:true})
const record={originalTraceId:trace.id,scope:data.scope,selected:recall.results,retrieval:recall,deliveredRequest:delivered,
 modelCall:call,modelResponse:null as unknown,limits:'request replay with original failing source batch only; no action execution or behavior A/B'}
writeFileSync(output,JSON.stringify(record,null,2))
record.modelResponse=await provider.decide(call,AbortSignal.timeout(90_000))
writeFileSync(output,JSON.stringify(record,null,2))
process.stdout.write(JSON.stringify({originalTraceId:trace.id,memoryCount:memories.length,levels:recall.results.map(u=>u.memoryLevel),response:record.modelResponse})+'\n')
