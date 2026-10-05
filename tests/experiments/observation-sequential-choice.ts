/** Three-step live continuations of frozen natural readings; no new cognition generation. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brandId, resolutionAuthority, RECALL_KEYWORD_TOKENIZER_ID, type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, currentLocation, type CompiledWorldManifest } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { SceneDecisionService } from '../../packages/application/src/scene-decision.ts'
import { basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const root=resolve(process.argv[2]??''),mode=process.argv[3]??'--prepare'
const input=resolve(process.argv[4]??'.tmp/observation-natural-choice-20261004-v1')
if(!process.argv[2]||!['--prepare','--run'].includes(mode))throw new Error('fresh output, --prepare/--run, optional original natural-choice directory')
const load=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as WorldJsonObject
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2))
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
const npc=brandId('character:npc','CharacterId'),player=brandId('character:player','CharacterId')
const conditions=['full','without-opposed','atom-only']
const replies=[
 {id:'fresh',text:'补充一下，我查的是今天更新的指引。上面现在仍写着隔壁小屋，不是以前存的那份。'},
 {id:'old',text:'补充一下，那个位置是我去年存下来的介绍。我今天还没有核实，想先过去碰碰运气。'},
]
const finalText='我先把要交的表整理一下。你接下来想做什么？'

async function episode(dir:string,protocol:WorldJsonObject,reply:typeof replies[number],repeat:number,condition:string,dry:boolean,
    compareInitial:(request:PrototypeTurnRequest)=>void) {
 const address=protocol.address as unknown as WorldAddress
 mkdirSync(dir)
 for(const file of ['world.sqlite','memory.sqlite'])copyFileSync(join(root,'history',file),join(dir,file))
 const store=new WorldStore(join(dir,'world.sqlite')),memory=new CognitiveMemoryService(join(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
 const leases=new WriterLeaseService(join(dir,'world.sqlite')),availability=new CharacterRuntimeAvailabilityService(join(dir,'world.sqlite'))
 const rules=createCoreRulebookRegistry({interactionPackages:[basicInteractionPackage]})
 const stored=store.readManifest(address)!,manifest=stored.manifest as CompiledWorldManifest
 const scene=new SceneDecisionService(store,availability,2)
 const prefix=Number(protocol.prefixSeq),startSeq=store.head(address).headSeq
 const full=(load(join(root,'reading-'+repeat+'.json')).delivery as WorldJsonObject).memories as WorldJsonObject[]
 const selected=full.filter(m=>condition==='full'||(m.memoryId!=='bank:10'&&(condition!=='atom-only'||m.memoryId!==protocol.target)))
 if(selected.length>3)throw new Error('reading budget')
 let callIndex=0,stage=0,transportPath:string|undefined
 const provider=dry?undefined:createChatProvider({fetch:async(req,init)=>{
   const response=await fetch(req,init)
   if(transportPath)save(transportPath,{status:response.status,body:await response.clone().text()})
   return response
 },endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
 model:String(protocol.model),timeoutMs:90000,maxOutputTokens:1600,
 ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{})})
 // Small test host: declared player inputs use existing authority, scene audiences and atomic commit.
 async function submit(action:{actionType:'speak'|'move';parameters:WorldJsonObject},tag:string) {
   const owner='sequential-player:'+tag,lease=leases.acquire(address,owner,180000)
   try {
     const head=store.head(address),history=store.readEvents(address),rulebook=rules.resolve(manifest.rulebook.rulebookId,manifest.rulebook.version,owner,address)
     const roundId=brandId(owner,'InteractionRoundId'),actionId=owner+':action'
     const authority=resolutionAuthority('player','manual_player_immediate')
     const resolution=rulebook.resolve({manifest,manifestHash:stored.manifestHash,events:history,
       characterId:player,asOfWorldSeq:head.headSeq,resolutionAuthority:authority,roundId,actionId,action})
     if(resolution.status!=='accepted')throw new Error('authored player input rejected: '+resolution.reason)
     const drafts:WorldEventDraft[]=[...resolution.events]
     if(action.actionType==='move')drafts.push(...scene.transitionForMove(address,history,player,String(action.parameters.locationId),head.headSeq))
     drafts.push({eventType:'action.resolved',eventVersion:1,data:{roundId,actionId,participantId:owner,actorId:player,
       actionType:action.actionType,sourceRole:'player',order:0,accepted:true,reason:null}})
     const beforeAudience=scene.audienceForAction(address,player,history,head.headSeq,{
       scope:resolution.observationScope?.scope??'scene_public',
       ...(resolution.observationScope?.recipientIds?{recipientIds:resolution.observationScope.recipientIds.map(id=>brandId(id,'CharacterId'))}:{})})
     const departures=new Set(scene.decideFromEvents(address,player,history,head.headSeq).observerIds)
     const arrivals=new Set(scene.decideFromEvents(address,player,[...history,...drafts],head.headSeq+drafts.length).observerIds)
     const observers=new Set([...beforeAudience.fullContentCharacterIds,...(action.actionType==='move'?[...arrivals]:[]),player])
     const speech=resolution.events.find(e=>e.eventType==='character.speak')
     const movement=resolution.events.find(e=>e.eventType==='character.moved')?.data as WorldJsonObject|undefined
     for(const observerId of observers)drafts.push({eventType:'observation.upsert',eventVersion:1,
       data:{id:actionId+':observer:'+observerId,value:{observerId,actionId,content:{actorId:player,actionType:action.actionType,status:'accepted',
         ...(speech?{speech:speech.data}:{}),
         ...(movement?{movement:{characterId:player,
           ...(observerId===player||departures.has(observerId)?{fromLocationId:movement.fromLocationId!}:{}),
           ...(observerId===player||arrivals.has(observerId)?{toLocationId:movement.toLocationId!}:{})}}:{})}}}})
     drafts.push({eventType:'world.tick-advanced',eventVersion:1,data:{tick:head.tick+1,roundId}})
     await store.commitRound({address,transactionId:brandId(owner+':commit','TransactionId'),roundId,
       expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,events:drafts,outbox:[],
       writerFencingToken:lease.fencingToken,correlationId:owner,
       authority:{actorId:player,actionId,action,status:'accepted',reason:null,resolutionAuthority:authority}})
     const events=store.readEvents(address).filter(e=>e.seq>head.headSeq)
     appendFileSync(join(dir,'player.jsonl'),JSON.stringify({stage,tag,action,events})+'\n')
     return events.filter(e=>e.eventType==='observation.upsert'&&(e.data as WorldJsonObject).value
       && ((e.data as WorldJsonObject).value as WorldJsonObject).observerId===npc).map(e=>(e.data as WorldJsonObject).value as WorldJsonObject)
   }finally{leases.release(address,owner,lease.fencingToken)}
 }
 async function alignPlayer() {
   const events=store.readEvents(address),destination=currentLocation(events,npc)
   if(destination===undefined)throw new Error('missing NPC location')
   if(currentLocation(events,player)!==destination)await submit({actionType:'move',parameters:{locationId:destination}},'align:'+stage)
 }
 const records:WorldJsonObject[]=[]
 try {
   const turn=new PrototypeCharacterTurn({address,store,memory,leases,availability,rulebooks:rules,
     projectContext:context=>({...context,memories:[],
       observations:(context.observations as WorldJsonObject[]).filter(r=>Number(r.sourceSeq)>prefix),
       selfObservations:(context.selfObservations as WorldJsonObject[]).filter(r=>Number(r.sourceSeq)>prefix)}),
     validateDecision:d=>{if(d.decision==='recall')throw new Error('fixed reading continuation disables extra recall')},
     decide:async(request,signal)=>{
       const head=store.head(address)
       const memories=stage===2?[]:selected.map(m=>({...m,sourceAgeTicks:Number(m.sourceAgeTicks)+head.tick-Number(protocol.tick)}))
       const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories}}
       if(stage===0&&!request.continuation)compareInitial(visible)
       if(JSON.stringify(visible).includes('雪青密码'))throw new Error('private canary leaked')
       const index=callIndex++,path=join(dir,'call-'+index+'.json')
       save(path,{stage,index,dry,request:visible,status:'pending',headSeq:head.headSeq,tick:head.tick})
       transportPath=join(dir,'transport-'+index+'.json')
       const start=performance.now()
       const response=dry?(request.continuation?{decision:'publish',speech:'到了，先看现场指引。'}:
         stage===1?{decision:'perform',actionType:'move',parameters:{locationId:'location:next'}}:
         {decision:'publish',speech:stage===0?'指引是今天更新的吗？':'我先看看现场。',addresseeIds:[player]}):
         await provider!.decide(localPrototypeTurnCall(visible),signal)
       save(path,{stage,index,dry,request:visible,status:'returned',headSeq:head.headSeq,tick:head.tick,
         response,durationMs:Math.round(performance.now()-start)})
       return response
     }})
   const texts=[String(protocol.initialText),reply.text,finalText]
   for(stage=0;stage<texts.length;stage++){
     await alignPlayer()
     const stimulus=await submit({actionType:'speak',parameters:{text:texts[stage]!,scope:'direct',addresseeIds:[npc]}},'speech:'+stage)
     if(stimulus.length!==1)throw new Error('player speech not authorized to NPC')
     const before=store.head(address).headSeq,firstCall=callIndex
     const result=await turn.run(npc,{stimulus,maxCalls:2,signal:AbortSignal.timeout(120000)})
     const events=store.readEvents(address).filter(e=>e.seq>before)
     const row:WorldJsonObject={stage,playerText:texts[stage]!,firstCall,calls:callIndex-firstCall,
       result:result as unknown as WorldJsonObject,events:events as unknown as WorldJsonObject[]}
     records.push(row);appendFileSync(join(dir,'stages.jsonl'),JSON.stringify(row)+'\n')
     console.log(JSON.stringify({dry,reply:reply.id,repeat,condition,stage,calls:row.calls,status:result.status}))
     if(dry&&result.status==='failed')throw new Error('mechanical preview failed')
     if(result.failure==='provider_failed')throw new Error('provider failed; stop')
     if(result.status==='failed'||result.status==='interrupted')break
   }
   memory.catchUp(address,npc,store.head(address).headSeq,'sequential-audit')
   const result={reply:reply.id,repeat,condition,stages:records.length,calls:callIndex,
     stoppedEarly:records.length!==3,head:store.head(address),initialSeq:startSeq}
   save(join(dir,'summary.json'),result)
   return result
 }finally{memory.close();availability.close();leases.close();store.close()}
}

if(mode==='--prepare'){
 if(existsSync(root))throw new Error('fresh directory required')
 if(!existsSync(join(input,'audit.json')))throw new Error('audit original first')
 mkdirSync(root,{recursive:true});mkdirSync(join(root,'history'))
 const original=load(join(input,'protocol.json'))
 const files=['protocol.json','bank.json','authorized.json','audit.json',...['world.sqlite','memory.sqlite'].map(f=>'history/'+f),
   ...[0,1].map(r=>'new-building-retrieval-'+r+'.json')]
 const frozen=Object.fromEntries(files.map(f=>[join(input,f),hash(join(input,f))]))
 for(const file of ['world.sqlite','memory.sqlite'])copyFileSync(join(input,'history',file),join(root,'history',file))
 for(const repeat of [0,1])copyFileSync(join(input,'new-building-retrieval-'+repeat+'.json'),join(root,'reading-'+repeat+'.json'))
 const protocol:WorldJsonObject={inputRoot:input,address:original.address!,model:original.model!,target:original.target!,
   tick:55,prefixSeq:68,repeats:2,conditions,replies,initialText:(original.probes as WorldJsonObject[])[0]!.text!,
   finalText,maxActivations:36,maxCharacterCalls:72,newJevCalls:0,newUtilityCalls:0,frozen,
   design:['frozen natural reading carried for first two stages; third stage no long-term reading',
     'real committed player speech, NPC actions and result-aware continuation',
     'test copy adds empty scene at existing next location; original scene topology unchanged',
     'recent/self observations after original prefix retained',
     'follow player to NPC through adjudicated move before next dialogue',
     'first context equal; subsequent context may diverge as effect of earlier actions',
     'predeclared replies independent of whether NPC asks; all conditions get same reply text',
     'invalid output stops episode, not counted as silence; no automatic retry'],
   limits:['12 short scripted-input episodes, not autonomous player or long play',
     'no fresh retrieval/JEV on later stages','no newly generated or revised Observation',
     'removal interventions remain experimental; do not elect conflict truth',
     'retained self speech is evidence of speaking, not a new belief',
     'two repeats per cell; nonblind exploratory semantic reading']}
 save(join(root,'protocol.json'),protocol)
 const setupStore=new WorldStore(join(root,'history','world.sqlite'))
 try {
   const address=protocol.address as unknown as WorldAddress,head=setupStore.head(address)
   const roundId=brandId('sequential-setup','InteractionRoundId')
   await setupStore.commitRound({address,expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,
     transactionId:brandId('sequential-setup:commit','TransactionId'),roundId,correlationId:'sequential-setup',outbox:[],
     events:[{eventType:'scene.upsert',eventVersion:1,data:{sceneId:'scene:next',value:{lifecycle:'active',locationId:'location:next',participantIds:[]}}},
       {eventType:'world.tick-advanced',eventVersion:1,data:{tick:head.tick+1,roundId}}]})
 }finally{setupStore.close()}
 await episode(join(root,'mechanical-preview'),protocol,replies[0]!,0,'without-opposed',true,()=>{})
 const unchanged=Object.entries(frozen).every(([p,h])=>hash(p)===h)
 if(!unchanged)throw new Error('original changed')
 save(join(root,'prepared.json'),{ready:true,realModelCalls:0,mechanicalPreview:true})
 console.log(JSON.stringify({ready:true,maxCharacterCalls:72,newJevCalls:0}))
}else{
 if(!existsSync(join(root,'prepared.json'))||existsSync(join(root,'episodes.jsonl')))throw new Error('prepare then run once')
 const protocol=load(join(root,'protocol.json')),frozen=protocol.frozen as WorldJsonObject
 const unchanged=()=>Object.entries(frozen).every(([p,h])=>hash(p)===h)
 if(!unchanged())throw new Error('original changed')
 let canonical:string|undefined
 const compare=(request:PrototypeTurnRequest)=>{
   const plain=JSON.stringify({...request,context:{...request.context,memories:[]}})
   if(canonical!==undefined&&canonical!==plain)throw new Error('initial nonmemory context differs')
   canonical=plain
 }
 const summaries=[]
 for(let repeat=0;repeat<2;repeat++)for(const reply of (repeat===0?replies:[...replies].reverse())){
   const ordered=[...conditions.slice(repeat),...conditions.slice(0,repeat)]
   for(const condition of ordered){
     const id=reply.id+'-'+repeat+'-'+condition
     const result=await episode(join(root,id),protocol,reply,repeat,condition,false,compare)
     if(!unchanged())throw new Error('original changed')
     appendFileSync(join(root,'episodes.jsonl'),JSON.stringify({id,...result})+'\n');summaries.push(result)
   }
 }
 save(join(root,'summary.json'),{episodes:summaries.length,calls:summaries.reduce((n,r)=>n+r.calls,0),
   originalUnchanged:unchanged(),initialNonmemoryContextIdentical:true,newJevCalls:0,newUtilityCalls:0,summaries})
}
