/** Live semantic capability experiment. Fixed authorized prior; no retrieval/consolidation changes. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type WorldJsonObject } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { npc, playerText, priorText, openCapabilityWorld } from './notice-board-fixture.ts'
import { noticeBoardContext, noticeBoardResult, boardText, privateText, inspectId } from './notice-board-capability.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const root=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(root))throw new Error('provide a fresh output directory')
mkdirSync(root,{recursive:true})
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2))
const original=resolve('.tmp/observation-natural-choice-20261004-v1/new-building-retrieval-0.json')
const hash=()=>createHash('sha256').update(readFileSync(original)).digest('hex')
const frozenHash=hash()
const originalReading=JSON.parse(readFileSync(original,'utf8')) as WorldJsonObject
const originalMemories=(originalReading.delivery as WorldJsonObject).memories as WorldJsonObject[]
const prior=originalMemories.find(m=>m.memoryId==='family:traveler-navigation:revision:20:1')!
if(prior.text!==priorText)throw new Error('prior text differs from original')
const secondText='我先把要交的表整理一下。你觉得接下来往哪里走？'
save(join(root,'protocol.json'),{model:'gemini-3.7-flash',repeats:3,playerText,secondText,maximumCalls:12,
  original,frozenHash,priorText,newJevCalls:0,newObservationCalls:0,
  design:['fresh controlled world with a trusted inspect package and fixed authoritative board binding',
    'prior text reused verbatim; new controlled authorized history and new source references',
    'prior explicitly delivered; this tests execution, not natural retrieval or unique Observation causality',
    'two predeclared player inputs, maxCalls 2 per activation; no inspect instruction or automatic retry',
    'inspect evidence actor-only; subsequent speech remains reported_speech'],
  limits:['read-only fixed compiled world config, not mutable board storage',
    'trusted installed code, not a sandbox for untrusted creator JavaScript',
    'no staff query, no automatic Observation revision, no UI/Activity integration']})
const summaries:WorldJsonObject[]=[]
let canonical:string|undefined
for(let repeat=0;repeat<3;repeat++){
  const dir=join(root,'repeat-'+repeat),f=openCapabilityWorld(dir)
  let callIndex=0,transportPath:string|undefined
  const requests:PrototypeTurnRequest[]=[]
  const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
    model:'gemini-3.7-flash',timeoutMs:90000,maxOutputTokens:1600,
    ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{}),
    fetch:async(input,init)=>{
      const response=await fetch(input,init)
      if(transportPath)save(transportPath,{status:response.status,body:await response.clone().text()})
      return response
    }})
  try {
    const before=f.store.head(f.address).headSeq
    const supports=f.sources().filter(s=>s.epistemic_kind==='direct_observation')
    if(supports.length!==4)throw new Error('controlled prior sources differ')
    const memory:WorldJsonObject={memoryId:prior.memoryId!,memoryLevel:'observation',text:priorText,
      epistemicKind:'subjective_inference',sourceIds:supports.map(s=>s.source_id!),
      sources:supports.map(s=>({sourceId:s.source_id!,sourceHash:s.source_hash!,worldSeq:s.source_seq!,
        epistemicKind:s.epistemic_kind!,CharacterId:npc,WorldAddress:{...f.address}})),
      experimentalOrigin:'reused recognition body, researcher-authored authorized supporting history'}
    save(join(dir,'prior.json'),memory)
    let stage=0
    const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,leases:f.leases,
      availability:f.availability,rulebooks:f.rules,projectContext:noticeBoardContext,executionResult:noticeBoardResult,
      decide:async(request,signal)=>{
        const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories:[memory]}}
        const serialized=JSON.stringify(visible)
        if(serialized.includes(privateText))throw new Error('private text leaked')
        const committedReads=f.store.readEvents(f.address).filter(e=>e.eventType==='observation.upsert'
          && ((e.data as WorldJsonObject).value as WorldJsonObject).epistemicKind==='direct_observation'
          && typeof (((e.data as WorldJsonObject).value as WorldJsonObject).content)==='object')
        if(committedReads.length===0&&serialized.includes(boardText))throw new Error('unexecuted board content leaked')
        if(callIndex===0){
          if(canonical!==undefined&&canonical!==serialized)throw new Error('initial context changed between repeats')
          canonical=serialized
        }
        requests.push(visible)
        const index=callIndex++,path=join(dir,'call-'+index+'.json')
        transportPath=join(dir,'transport-'+index+'.json')
        save(path,{stage,index,request:visible,status:'pending',head:f.store.head(f.address)})
        const start=performance.now(),response=await provider.decide(localPrototypeTurnCall(visible),signal)
        save(path,{stage,index,request:visible,response,status:'returned',
          durationMs:Math.round(performance.now()-start),head:f.store.head(f.address)})
        return response
      }})
    const stages:WorldJsonObject[]=[]
    for(stage=0;stage<2;stage++){
      const stimulus=await f.submitPlayer(stage===0?playerText:secondText,'stage-'+stage)
      if(stimulus.length!==1)throw new Error('NPC stimulus not singly authorized')
      const firstCall=callIndex,beforeStage=f.store.head(f.address).headSeq
      const result=await turn.run(npc,{stimulus,maxCalls:2,signal:AbortSignal.timeout(160000)})
      const record:WorldJsonObject={stage,firstCall,calls:callIndex-firstCall,result:result as unknown as WorldJsonObject,
        events:f.store.readEvents(f.address).filter(e=>e.seq>beforeStage) as unknown as WorldJsonObject[]}
      stages.push(record);save(join(dir,'stages.json'),stages)
      console.log(JSON.stringify({repeat,stage,status:result.status,calls:record.calls,perform:result.performResult?.status??null}))
      if(result.failure==='provider_failed')throw new Error('provider failed; bounded experiment stopped')
      if(result.status==='failed'||result.status==='interrupted')break
    }
    const events=f.store.readEvents(f.address),sources=f.sources(),playerSources=f.sources('character:player' as typeof npc),
      bobSources=f.sources('character:bob' as typeof npc)
    const namespace=[f.address.tenantId,f.address.worldId,f.address.branchId,npc].join('\x1f')
    for(const s of sources){
      const e=events.find(e=>e.seq===s.source_seq)
      if(!e||s.source_id!=='event:'+e.seq||s.source_hash!==e.eventHash||s.namespace_key!==namespace
        || ((e.data as WorldJsonObject).value as WorldJsonObject).observerId!==npc)throw new Error('Source provenance mismatch')
      const content=((e.data as WorldJsonObject).value as WorldJsonObject).content
      if(content!==null&&typeof content==='object'&&!Array.isArray(content)&&(content as WorldJsonObject).speech!==undefined
        && s.epistemic_kind!=='reported_speech')throw new Error('speech promoted')
    }
    const reads=events.filter(e=>e.eventType==='observation.upsert'
      && (((e.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject)?.capabilityId===inspectId)
    for(const e of reads){
      const value=(e.data as WorldJsonObject).value as WorldJsonObject,content=value.content as WorldJsonObject
      const source=sources.find(s=>s.source_seq===e.seq),action=events.find(a=>a.eventType==='action.resolved'
        && (a.data as WorldJsonObject).actionId===value.actionId)
      if(!source||source.epistemic_kind!=='direct_observation'||content.observedText!==boardText
        ||value.observerId!==npc||!action||!(action.data as WorldJsonObject).accepted||action.tick!==e.tick)throw new Error('read/action/source mismatch')
      if([...playerSources,...bobSources].some(s=>s.source_seq===e.seq))throw new Error('read evidence escaped actor')
      if(!requests.some(r=>r.continuation&&JSON.stringify(r.result).includes(String(value.actionId))
        &&JSON.stringify(r.result).includes(boardText)))throw new Error('no actual result-aware continuation')
    }
    const record:WorldJsonObject={repeat,calls:callIndex,stages:stages.length,reads:reads.length,
      closedLoop:reads.length>0,sourceRows:sources.length,head:f.store.head(f.address) as unknown as WorldJsonObject,
      eventsAfterGenesis:events.filter(e=>e.seq>before).length}
    save(join(dir,'events.json'),events);save(join(dir,'sources.json'),{npc:sources,player:playerSources,bob:bobSources})
    save(join(dir,'summary.json'),record);summaries.push(record)
  }finally{f.close()}
}
if(hash()!==frozenHash)throw new Error('original retrieval artifact changed')
save(join(root,'summary.json'),{trials:summaries.length,closedLoops:summaries.filter(s=>s.closedLoop).length,
  calls:summaries.reduce((n,s)=>n+Number(s.calls),0),reads:summaries.reduce((n,s)=>n+Number(s.reads),0),
  firstContextsIdentical:true,originalUnchanged:true,newJevCalls:0,newObservationCalls:0,summaries})
console.log(JSON.stringify({completed:true,summaries}))
