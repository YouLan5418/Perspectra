/** Insert existing sidecar cognition update between a committed inspect and native continuation.
 * All groups resume the same accepted action; no new player question or forced character choice.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { npc, playerText, priorText } from './notice-board-fixture.ts'
import { noticeBoardContext, noticeBoardResult, boardText, privateText } from './notice-board-capability.ts'
import { bringSecondBoard, openConflictingBoardWorld, secondBoardId, secondBoardText } from './notice-board-conflict-fixture.ts'
import { inscriptionReadings } from './notice-board-evidence-delivery.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const root=resolve(process.argv[2]??''),mode=process.argv[3],updates=process.argv[4]?resolve(process.argv[4]):undefined
if(!process.argv[2]||existsSync(root)||!['--prepare','--run','--delivery'].includes(mode??'')||((mode==='--run'||mode==='--delivery')&&!updates))
  throw new Error('fresh output directory + --prepare, or --run update-directory')
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2))
const load=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as WorldJsonObject
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
const secondStimulus='刚有人把窗口指示牌搬到大厅了。我手头的表还在整理，你觉得接下来往哪走？'
const conditions=mode==='--delivery'?['raw-evidence','plain-evidence','paired-evidence','updated']:['baseline','updated','raw-evidence']
mkdirSync(root,{recursive:true})
let transportPath:string|undefined
const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
  model:'gemini-3.7-flash',timeoutMs:90000,maxOutputTokens:1600,
  ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{}),
  fetch:async(input,init)=>{const response=await fetch(input,init)
    if(transportPath)save(transportPath,{status:response.status,body:await response.clone().text()})
    return response}})
const comparable=new Map<number,string>(),trials:WorldJsonObject[]=[]
function buildTurn(f:ReturnType<typeof openConflictingBoardWorld>,dir:string,tag:string,
  memories:WorldJsonObject[],seed?:number) {
  let calls=0
  const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,leases:f.leases,
    availability:f.availability,rulebooks:f.rules,executionResult:noticeBoardResult,
    projectContext:context=>{
      const c=noticeBoardContext(context)
      return {...c,memories:[],affordances:(c.affordances as WorldJsonObject[]).map(a=>a.actionType!=='interact'?a:
        {...a,interactions:(a.interactions as WorldJsonObject[]).map(i=>
          (i.targetRef as WorldJsonObject).id===secondBoardId?{...i,label:'查看窗口指示牌'}:i)})}
    },
    decide:async(request,signal)=>{
      const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories}}
      const serialized=JSON.stringify(visible)
      if(serialized.includes(privateText))throw new Error('private context leaked')
      const history=f.store.readEvents(f.address)
      for(const [target,text] of [['entity:hall-board',boardText],[secondBoardId,secondBoardText]]){
        const observed=history.some(e=>e.eventType==='observation.upsert'
          && ((e.data as WorldJsonObject).value as WorldJsonObject).epistemicKind==='direct_observation'
          && (((e.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject)?.targetId===target)
        if(!observed&&serialized.includes(text!))throw new Error('unexecuted inscription leaked')
      }
      if(seed!==undefined){
        if(!request.continuation||request.canPerform!==false||request.result?.status!=='accepted')
          throw new Error('comparison must be result-only continuation of an actual accepted inspect')
        const plain=JSON.stringify({...visible,context:{...visible.context,memories:[]}})
        if(comparable.has(seed)&&comparable.get(seed)!==plain)throw new Error('nonmemory continuation differs')
        comparable.set(seed,plain)
      }
      const index=calls++,path=join(dir,tag+'-call-'+index+'.json')
      transportPath=join(dir,tag+'-transport-'+index+'.json')
      save(path,{request:visible,status:'pending',head:f.store.head(f.address)})
      const start=performance.now(),response=await provider.decide(localPrototypeTurnCall(visible),signal)
      save(path,{request:visible,response,status:'returned',head:f.store.head(f.address),
        durationMs:Math.round(performance.now()-start)})
      return response
    }})
  return {turn,calls:()=>calls}
}
function exportWorld(f:ReturnType<typeof openConflictingBoardWorld>,dir:string) {
  save(join(dir,'sources.json'),{npc:f.sources(),player:f.sources('character:player' as typeof npc),
    bob:f.sources('character:bob' as typeof npc)})
  save(join(dir,'events.json'),f.store.readEvents(f.address))
}
if(mode==='--prepare'){
  save(join(root,'protocol.json'),{model:'gemini-3.7-flash',repeats:3,firstStimulus:playerText,secondStimulus,
    maxCharacterCalls:9,newJevCalls:0,design:['real autonomous first read and expression',
      'second autonomous inspect maxCalls=1, intentionally no expression yet',
      'native budget_exhausted means this bounded execution phase ended, not technical failure or a character pass',
      'save accepted inspect action for existing continuationOf; never replay an inspect in a comparison clone'],
    limits:['known family and researcher-authored initial local cognition from real first Source',
      'controlled staging moves second sign into reach','same short scene, not natural retrieval']})
  for(let seed=0;seed<3;seed++){
    const dir=join(root,'repeat-'+seed),f=openConflictingBoardWorld(dir)
    try{
      const priorSources=f.sources().filter(s=>s.epistemic_kind==='direct_observation')
      const ref=(s:WorldJsonObject)=>({sourceId:s.source_id!,sourceHash:s.source_hash!,worldSeq:s.source_seq!,
        epistemicKind:s.epistemic_kind!,characterId:npc,worldAddress:{...f.address}})
      const prior:WorldJsonObject={memoryId:'family:traveler-navigation:v1',memoryLevel:'observation',text:priorText,
        epistemicKind:'subjective_inference',sourceIds:priorSources.map(s=>s.source_id!),sourceRefs:priorSources.map(ref)}
      const firstStimulus=await f.submitPlayer(playerText,'first')
      const first=buildTurn(f,dir,'first',[prior])
      const firstResult=await first.turn.run(npc,{stimulus:firstStimulus,maxCalls:2,signal:AbortSignal.timeout(160000)})
      save(join(dir,'first-result.json'),firstResult)
      if(firstResult.status!=='published')throw new Error('initial scene not completed; stop, no selective retries')
      const firstSource=f.sources().find(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(boardText))
      if(!firstSource)throw new Error('no autonomous first inspection')
      const local:WorldJsonObject={memoryId:'conflict:local:v1',memoryLevel:'observation',
        text:'【主观认识，可修正】大厅公告牌上写着登记处在二楼203；我暂把它作为寻找登记处的线索，尚未到登记处核实。',
        epistemicKind:'subjective_inference',sourceIds:[firstSource.source_id!],sourceRefs:[ref(firstSource)],
        firstFormedTick:f.store.head(f.address).tick,lastRevisedTick:f.store.head(f.address).tick}
      save(join(dir,'old-local.json'),local)
      await bringSecondBoard(f)
      const stimulus=await f.submitPlayer(secondStimulus,'second'),before=f.store.head(f.address).headSeq
      const second=buildTurn(f,dir,'second',[local])
      const result=await second.turn.run(npc,{stimulus,maxCalls:1,signal:AbortSignal.timeout(110000)})
      save(join(dir,'second-result.json'),result)
      if(result.status!=='budget_exhausted'||result.performResult?.status!=='accepted')
        throw new Error('second autonomous inspect did not commit; no forced action or retry')
      const action=result.performResult.action as WorldJsonObject
      if((action.parameters as WorldJsonObject).bindingId!=='binding:'+secondBoardId+':inspect')
        throw new Error('actor did not choose the second sign; stop')
      const secondSource=f.sources().find(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(secondBoardText))
      if(!secondSource)throw new Error('actual second Source absent')
      save(join(dir,'handoff.json'),{stimulus,continuationOf:{actionId:result.performResult.operationId!,
        action,afterSeq:before},head:f.store.head(f.address) as unknown as WorldJsonObject})
      save(join(dir,'summary.json'),{repeat:seed,firstSourceId:firstSource.source_id!,
        secondSourceId:secondSource.source_id!,head:f.store.head(f.address) as unknown as WorldJsonObject})
      exportWorld(f,dir)
      trials.push({seed,firstCalls:first.calls(),secondCalls:second.calls(),secondPhaseStatus:result.status})
      save(join(root,'trials.json'),trials)
      console.log(JSON.stringify({seed,prepared:true,calls:first.calls()+second.calls(),secondPhaseStatus:result.status}))
    }finally{f.close()}
  }
  save(join(root,'summary.json'),{seeds:3,calls:trials.reduce((n,t)=>n+Number(t.firstCalls)+Number(t.secondCalls),0)})
}else{
  const input=String(load(join(updates!,'protocol.json')).inputRoot)
  const files=[join(updates!,'protocol.json'),...[0,1,2].flatMap(seed=>[
    join(updates!,'update-'+seed+'.json'),join(updates!,'archive-'+seed+'.json'),
    ...['world.sqlite','memory.sqlite','handoff.json','old-local.json'].map(p=>join(input,'repeat-'+seed,p))])]
  const frozen=Object.fromEntries(files.map(p=>[p,hash(p)]))
  save(join(root,'protocol.json'),{model:'gemini-3.7-flash',mode:mode!,inputRoot:input,updates,seeds:3,samplesPerSeed:2,conditions,
    frozen,maxCharacterCalls:3*2*conditions.length,newJevCalls:0,
    ...(mode==='--delivery'?{newUpdateCalls:0,newReadOperations:0,
      deliveryDesign:['plain separate vs plain paired; exact host descriptions, no conflict assertion or action instruction',
        'reuse frozen seeds and generated cognitions; only new continuation calls']}:{}),
    design:['same committed action and same stimulus resumed via native continuationOf',
      'all nonmemory request fields identical within each seed; recent and self observation channels retained',
      'no new player question, no forced mention of conflict, unchanged model instructions',
      'two independent model samples per seed/condition; order rotated'],
    limits:['two samples share evidence and a single generated update; not six independent histories',
      'updated replaces one old understanding with two current conflict branches; raw uses two atoms',
      'fixed cognition family, explicit delivery; no natural search or production integration',
      'update phase completed offline before cloned continuations, not a measurement of interactive wall-clock latency']})
  for(let seed=0;seed<3;seed++){
    const source=join(input,'repeat-'+seed),handoff=load(join(source,'handoff.json'))
    const row=load(join(updates!,'update-'+seed+'.json'))
    if(row.status!=='accepted')throw new Error('update rejected; no fallback or edited answer')
    const record=row.record as WorldJsonObject,archive=load(join(updates!,'archive-'+seed+'.json'))
    const variants:Record<string,WorldJsonObject[]>={baseline:archive.observations as WorldJsonObject[],
      updated:record.current as WorldJsonObject[],'raw-evidence':archive.facts as WorldJsonObject[],
      'plain-evidence':archive.facts as WorldJsonObject[],'paired-evidence':archive.facts as WorldJsonObject[]}
    for(let sample=0;sample<2;sample++){
      const offset=(seed+sample)%conditions.length,ordered=[...conditions.slice(offset),...conditions.slice(0,offset)]
      for(const condition of ordered){
        const dir=join(root,'seed-'+seed+'-sample-'+sample+'-'+condition);mkdirSync(dir)
        for(const p of ['world.sqlite','memory.sqlite'])copyFileSync(join(source,p),join(dir,p))
        const f=openConflictingBoardWorld(dir,true)
        try{
          const head=f.store.head(f.address)
          const memories=condition==='plain-evidence'||condition==='paired-evidence'
            ? inscriptionReadings(archive,head.tick,condition==='plain-evidence'?'separate':'paired')
            : variants[condition]!.map(u=>({memoryId:u.id!,memoryLevel:u.memoryLevel!,text:u.text!,
            epistemicKind:u.epistemicKind??(u.sourceRefs as WorldJsonObject[])[0]!.epistemicKind!,
            sourceIds:(u.sourceRefs as WorldJsonObject[]).map(s=>s.sourceId!),sourceRefs:u.sourceRefs!,
            sourceAgeTicks:head.tick-Number(u.knownTickEnd),
            ...(condition==='raw-evidence'?{}:{firstFormedTick:record.firstFormedTick!,
              lastRevisedTick:condition==='updated'?record.lastRevisedTick!:record.firstFormedTick!}),
            ...(condition==='updated'?{familyId:record.familyId!,hasUnresolvedConflict:record.hasUnresolvedConflict!}:{})}))
          const continuation=handoff.continuationOf as WorldJsonObject,action=continuation.action as WorldJsonObject
          const built=buildTurn(f,dir,'continuation',memories,seed)
          const result=await built.turn.run(npc,{stimulus:handoff.stimulus as WorldJsonObject[],
            continuationOf:{actionId:String(continuation.actionId),afterSeq:Number(continuation.afterSeq),
              action:{actionType:String(action.actionType),parameters:action.parameters as WorldJsonValue}},
            signal:AbortSignal.timeout(110000)})
          const trial:WorldJsonObject={seed,sample,condition,calls:built.calls(),initialHead:head as unknown as WorldJsonObject,
            result:result as unknown as WorldJsonObject}
          save(join(dir,'result.json'),trial);exportWorld(f,dir);trials.push(trial)
          save(join(root,'trials.json'),trials)
          console.log(JSON.stringify({seed,sample,condition,status:result.status,calls:built.calls()}))
          if(result.status==='failed'||result.status==='interrupted')throw new Error('continuation failed; no sampling replacement')
        }finally{f.close()}
      }
    }
  }
  if(Object.entries(frozen).some(([p,h])=>hash(p)!==h))throw new Error('frozen inputs changed')
  save(join(root,'summary.json'),{trials:trials.length,calls:trials.reduce((n,t)=>n+Number(t.calls),0),
    originalUnchanged:true,nonmemoryIdenticalWithinSeed:true,completed:true})
}
