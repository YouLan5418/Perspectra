/** Delayed Observation ablation. Authored history; real Core utility and Character Turns. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { brandId, hashWorldJson, worldAddressKey, RECALL_KEYWORD_TOKENIZER_ID,
  type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../fixtures/frozen-interaction-world.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { coreRunner, hindsightPython } from './hindsight-python.ts'

const root=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(root))throw new Error('provide a fresh output directory')
mkdirSync(root,{recursive:true})
const bankMode=process.argv[3]==='--bank-from'
const bankFixture=bankMode?JSON.parse(readFileSync(resolve('experiments/activity-memory/observation-bank-fixture.json'),'utf8')) as WorldJsonObject:undefined
const jevJudge=process.argv[3]==='--jev-judge-from'||bankMode
const facetJudge=process.argv[3]==='--facet-judge-from'||jevJudge
const facetMatch=process.argv[3]==='--facet-match-from'||facetJudge
const applicability=process.argv[3]==='--applicability-from'||facetMatch
const sourceRoot=(applicability||process.argv[3]==='--delivery-intervention-from')&&process.argv[4]?resolve(process.argv[4]):undefined
if(process.argv[3]&&!sourceRoot)throw new Error('unknown option')
const repeats=3,formationTick=15,probeTick=55,model='gemini-3.7-flash'
const npc=brandId('character:npc','CharacterId'),base=frozenInteractionWorld()
const address:WorldAddress={...base.manifest.address,worldId:brandId('world:observation-choice','WorldId')}
const characters=base.manifest.characters.map(c=>({...c,name:c.characterId===npc?'小芷':c.characterId==='character:player'?'旅人':'陆舟',
 portrayal:c.characterId===npc?{summary:'同行的人。留意周围情况，自行决定是否表达以及尝试什么行动。',speakingStyle:'自然、具体，避免长篇分析。'}:null}))
const manifest={...base.manifest,address,characters,
 locations:[{locationId:'location:room',name:'前室'},{locationId:'location:next',name:'隔壁小屋'}],
 metadata:{title:'Observation 延迟选择对照',description:'controlled authored-history experiment'}}
const manifestHash=hashWorldJson('compiled-world-manifest',manifest)
const genesisEvents=base.genesisEvents.map(e=>e.eventType==='world.manifest-locked'
 ?{...e,data:{...e.data as WorldJsonObject,manifestHash}}:e.eventType==='character.created'
 ?{...e,data:{...e.data as WorldJsonObject,name:characters.find(c=>c.characterId===(e.data as WorldJsonObject).characterId)?.name??'旅人'}}:e)
genesisEvents.push({eventType:'location.upsert',eventVersion:1,data:{locationId:'location:next',name:'隔壁小屋'}})
const history=new Map<number,string>([
 [2,'小芷亲眼看见：在第一次去的展馆，旅人依据一张旧导览图带大家走向北门，到了门口才发现入口已迁到南侧。大家返回大厅查看当日指示后找到了入口。'],
 [6,'小芷亲眼看见：在陌生旅馆，旅人照旧宣传册把行李登记处指在二楼。大家到二楼没找到登记处，问过值班员后才知道现在在一楼。'],
 [10,'小芷亲眼看见：第一次到新码头时，旅人参考旧线路图把等候地点指向东边。大家走过去看到该处已关闭，后来根据现场标牌改去了西侧。'],
 [13,'小芷亲眼看见：回到常去的商店时，旅人直接指出收银台的位置，大家按他的指引顺利找到了收银台。'],
])
if(bankFixture){
 for(const entry of (bankFixture.entries as WorldJsonObject[]).slice(1))history.set(Number(entry.tick),String(entry.evidence))
 writeFileSync(join(root,'bank-fixture.json'),JSON.stringify(bankFixture,null,2))
}
const fillers=['窗台上的光线慢慢移到墙边。','小芷看见有人把窗帘整理平整。','桌上的便签换了一张，内容是今天的天气。','陆舟翻过杂志的一页，放回了原处。']
const probes: {id:string;kind:string;text:string;actorId?:string}[]=[
 {id:'new-task',kind:'similar',text:'这是我们第一次来这里。登记表在隔壁小屋，我来带路，我们先过去吧。'},
 {id:'new-stop',kind:'similar',text:'第一次到这儿也没什么复杂的，隔壁就是等候点，我看过介绍了。我们走吧。'},
 {id:'familiar-control',kind:'control',text:'这是我们经常来的地方，隔壁小屋的老位置没有变。我来带路，我们过去吧。'},
 ...(applicability?[
  {id:'same-person-unrelated',kind:'negative-control',text:'桌上的杂志我看完了，里面那篇花园随笔挺有意思。你平时喜欢读什么？'},
  {id:'other-person-navigation',kind:'subject-control',actorId:'character:bob',text:'这是我们第一次来这里。登记表在隔壁小屋，我来带路，我们先过去吧。'},
 ]:[]),
]
if([...history.values(),...probes.map(p=>p.text)].some(text=>text.includes('\uFFFD')))throw new Error('invalid Unicode in authored input')
writeFileSync(join(root,'protocol.json'),JSON.stringify({...(bankMode?{bankMode:true,behaviorRoute:'trigger/20/repeat0',bankFixture,bankMatrix:'nested 5/10/20; all vs trigger<=7; three shuffled draws each'}:{}),model,repeats,formationTick,probeTick,history:[...history],probes,
 applicabilityJudge:jevJudge?'typesafe/jev-1.13':facetJudge?model:null,
 historyMode:'55 committed authored-history ticks, not 55 live model turns',
 deliveryMode:bankMode?'multi-candidate batch applicability; behavior uses trigger/20/repeat0':facetJudge?'subject and model applicability admission':facetMatch?'natural subject and facet retrieval':applicability?'natural retrieval with applicability projection':sourceRoot?'explicit intervention, not natural retrieval':'natural',
 ...(applicability?{projectionDesign:bankMode?'model-derived facets; score on complete 20 bank; nested 5/10/20 questions; all vs subject/E5/BM25 RRF top7; independent JEV batch; unchanged delivery':jevJudge?'frozen facets; deterministic subject gate; JEV typed applicability choice; probabilities diagnostic; original numeric gates diagnostic only':facetJudge?'frozen facets; deterministic subject gate; Gemini assesses relevance with quoted stimulus; original numeric gates diagnostic only':facetMatch?'frozen facets reused; subject required; contexts/exceptions scored separately with original numeric gates; one candidate; unchanged ordinary recall and delivery':'one target search window replaced; same encoder, queries, admission, entities and delivery; projection generation sees no probes',comparison:'frozen original index recalled on every same request before experimental route'}:{}),
 reusedArchiveFrom:sourceRoot??null,
 design:'natural recall audited first; only target Observation removed in ablation; all other delivered memories and context fixed',
 conditions:['with-observation','without-observation-a','without-observation-b'],
 controls:['no memory reminder in stimulus','neutral portrayal','recent observations removed in this cold comparison',
 'no rubric sent to model','three independent copies per repetition','one initial autonomous choice; further recall disabled equally'],
 limitation:'small exploratory repeated sample, nonblind qualitative reading; no significance or generalization claim'},null,2))
const historyDir=join(root,'history');mkdirSync(historyDir)
let store=new WorldStore(join(historyDir,'world.sqlite'))
let memory=new CognitiveMemoryService(join(historyDir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
const core=coreRunner({HCW_LOCAL_MODEL:model,HCW_HINDSIGHT_UTILITY_TRACE:join(root,'utility-calls.jsonl')})
let built:WorldJsonObject|undefined
function facetWorker(input:WorldJsonObject,signal:AbortSignal):Promise<WorldJsonObject>{
 return new Promise((resolveResult,reject)=>{
  const child=execFile(hindsightPython(),[resolve(bankMode?'experiments/activity-memory/observation_bank.py':'experiments/activity-memory/observation-facet-match.py')],{
   signal,timeout:bankMode?360000:120000,maxBuffer:32*1024*1024,windowsHide:true,encoding:'utf8',
   env:{...process.env,HCW_LOCAL_MODEL:model,HCW_JEV_APPLICABILITY_TRACE:join(root,'jev-applicability-calls.jsonl'),HCW_HINDSIGHT_UTILITY_TRACE:join(root,'facet-utility-calls.jsonl'),PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0'}},(error,stdout)=>{
    if(error){reject(new Error('facet retrieval failed',{cause:error}));return}
    try{resolveResult(JSON.parse(stdout) as WorldJsonObject)}catch(cause){reject(new Error('facet retrieval returned invalid JSON',{cause}))}
   })
  child.stdin!.on('error',()=>{});child.stdin!.end(JSON.stringify(input))
 })
}
function authorized():WorldJsonObject {
 const head=store.head(address);memory.catchUp(address,npc,head.headSeq,'observation-choice')
 const ticks=new Map(store.readEvents(address).map(e=>[e.seq,e.tick]))
 const db=new DatabaseSync(join(historyDir,'memory.sqlite'),{readOnly:true})
 try{
  type Row={source_id:string;source_hash:string;epistemic_kind:string;source_seq:number;text_value:string}
  const rows=db.prepare('SELECT source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id')
   .all(worldAddressKey(address)+'\u001f'+npc,head.headSeq) as Row[]
  return {scope:{worldAddress:{...address},characterId:npc,asOfWorldSeq:head.headSeq},sources:rows.map(r=>({sourceId:r.source_id,
   sourceHash:r.source_hash,epistemicKind:r.epistemic_kind,worldSeq:r.source_seq,characterId:npc,worldAddress:{...address},
   text:r.text_value,knownTick:ticks.get(r.source_seq)!}))}
 }finally{db.close()}
}
try{
 store.activateBranch({address,manifest,manifestHash,genesisEvents,genesisHash:hashWorldJson('world-genesis-plan',genesisEvents),
  transactionId:brandId('transaction:observation-genesis','TransactionId'),roundId:brandId('round:observation-genesis','InteractionRoundId'),correlationId:'observation-genesis'})
 for(let tick=1;tick<=probeTick;tick++){
  const head=store.head(address),text=history.get(tick)??fillers[(tick-1)%fillers.length]!
  const events:WorldEventDraft[]=[{eventType:'observation.upsert',eventVersion:1,
   data:{id:'observation:authored:'+tick,value:{observerId:npc,content:text,epistemicKind:'direct_observation'}}}]
  if(tick===4)events.push({eventType:'observation.upsert',eventVersion:1,data:{id:'observation:private',
   value:{observerId:'character:bob',content:'只有陆舟知道：雪青密码。',epistemicKind:'direct_observation'}}})
  await store.commitRound({address,expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:tick,
   transactionId:brandId('transaction:observation-history:'+tick,'TransactionId'),
   roundId:brandId('round:observation-history:'+tick,'InteractionRoundId'),events,outbox:[],correlationId:'observation-history'})
  if(tick===formationTick){
   const input:WorldJsonObject={operation:'build',...authorized(),tick,aliasHistory:[]}
   if(JSON.stringify(input).includes('雪青密码'))throw new Error('unauthorized source')
   writeFileSync(join(root,'build-input.json'),JSON.stringify(input))
   built=sourceRoot?JSON.parse(readFileSync(join(sourceRoot,'build.json'),'utf8')) as WorldJsonObject:await core(input,AbortSignal.timeout(600000))
   if(JSON.stringify((built!.archive as WorldJsonObject).sources)!==JSON.stringify(input.sources))throw new Error('reused archive source prefix changed')
   writeFileSync(join(root,'build.json'),JSON.stringify(built,null,2))
   console.log(JSON.stringify({formedAt:tick,observations:((built.archive as WorldJsonObject).observations as WorldJsonObject[]).map(o=>({id:o.id,text:o.text}))}))
  }
 }
 const current=authorized();writeFileSync(join(root,'authorized-at-probe.json'),JSON.stringify(current))
 const old=(built!.archive as WorldJsonObject).sources as WorldJsonObject[]
 if(JSON.stringify(old)!==JSON.stringify((current.sources as WorldJsonObject[]).filter(s=>Number(s.knownTick)<=formationTick)))throw new Error('authorized prefix changed')
}finally{memory.close();store.close()}
let archive=built!.archive as WorldJsonObject,index=built!.index as WorldJsonObject
const observations=archive.observations as WorldJsonObject[]
// Chosen before any behavioral outputs: broad understanding backed by at least three experiences.
const target=observations.filter(o=>(o.sourceRefs as WorldJsonObject[]).length>=3&&/路线|指路|陌生|旧.*图|旧.*资料/.test(String(o.text)))
 .sort((a,b)=>(b.supportingAtomIds as string[]).length-(a.supportingAtomIds as string[]).length||String(a.id).localeCompare(String(b.id)))[0]
writeFileSync(join(root,'target.json'),JSON.stringify(target??null,null,2))
if(!target){writeFileSync(join(root,'blocked.json'),JSON.stringify({stage:'formation',reason:'no multi-experience target Observation formed'}));console.log('No target formed; no behavioral calls made.');process.exitCode=0}
else{
 const targetId=String(target.id)
 let searchIndex=index
 let facetProjection:WorldJsonObject|undefined,preparedFacet:WorldJsonObject|undefined
 if(facetMatch){
  facetProjection=JSON.parse(readFileSync(join(sourceRoot!,'applicability.json'),'utf8')) as WorldJsonObject
  const preparation:WorldJsonObject={operation:'prepare',archive,index,projection:facetProjection,targetObservation:targetId,judge:facetJudge,judgeBackend:jevJudge?'jev':'gemini',...(bankMode?{fixture:bankFixture!,authorized:JSON.parse(readFileSync(join(root,'authorized-at-probe.json'),'utf8')) as WorldJsonObject}:{})}
  writeFileSync(join(root,'facet-input.json'),JSON.stringify(preparation,null,2))
  preparedFacet=await facetWorker(preparation,AbortSignal.timeout(bankMode?360000:180000))
  if(bankMode){archive=preparedFacet.archive as WorldJsonObject;index=preparedFacet.index as WorldJsonObject;writeFileSync(join(root,'bank-build.json'),JSON.stringify({archive,index},null,2))}
  writeFileSync(join(root,'facet-projection.json'),JSON.stringify(preparedFacet,null,2))
  writeFileSync(join(root,'applicability.json'),JSON.stringify(facetProjection,null,2))
 }else if(applicability){
  const frozenRequest=JSON.parse(readFileSync(join(sourceRoot!,'new-task-preview-request.json'),'utf8')) as PrototypeTurnRequest
  if((frozenRequest.context.character as WorldJsonObject).characterId!==npc)throw new Error('identity context belongs to another role')
  const people=((frozenRequest.context.scene as WorldJsonObject).people??[]) as WorldJsonObject[]
  const allowedPeople=people.filter(p=>typeof p.characterId==='string'&&typeof p.name==='string').map(p=>({characterId:p.characterId,name:p.name}))
  const projectionInput={build:built!,targetObservation:targetId,allowedPeople}
  writeFileSync(join(root,'projection-input.json'),JSON.stringify(projectionInput,null,2))
  const child=spawnSync(hindsightPython(),[resolve('experiments/activity-memory/observation-applicability.py')],{
   input:JSON.stringify(projectionInput),encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,windowsHide:true,
   env:{...process.env,HCW_LOCAL_MODEL:model,HCW_HINDSIGHT_UTILITY_TRACE:join(root,'projection-utility-calls.jsonl'),PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0'}})
  if(child.error||child.status!==0){writeFileSync(join(root,'projection-failure.json'),JSON.stringify({status:child.status,stderr:child.stderr,error:child.error?.message}));throw new Error('applicability projection failed')}
  const projected=JSON.parse(child.stdout) as WorldJsonObject
  writeFileSync(join(root,'applicability.json'),JSON.stringify(projected,null,2))
  searchIndex=projected.index as WorldJsonObject
 }
 const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
  model,timeoutMs:90000,...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{})})
 const hash=()=>createHash('sha256').update(readFileSync(join(historyDir,'world.sqlite'))).digest('hex'),frozen=hash()
 const results:unknown[]=[],eligible:string[]=[],rejected:string[]=[],canonical=new Map<string,string>(),comparisons:WorldJsonObject[]=[]
 for(const probe of probes){
  let selection:WorldJsonObject|undefined
  // Capture an actual turn request without calling the model or committing a proposal.
  const preview=join(root,probe.id+'-preview');mkdirSync(preview)
  for(const f of ['world.sqlite','memory.sqlite'])copyFileSync(join(historyDir,f),join(preview,f))
  store=new WorldStore(join(preview,'world.sqlite'));memory=new CognitiveMemoryService(join(preview,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
  const leases=new WriterLeaseService(join(preview,'world.sqlite')),availability=new CharacterRuntimeAvailabilityService(join(preview,'world.sqlite'))
  const actorId=probe.actorId??'character:player'
  const stimulus=[{observerId:npc,content:{actorId,actionType:'speak',speech:{characterId:actorId,text:probe.text}}}]
  const cold=(context:WorldJsonObject)=>({...context,observations:[],selfObservations:[],memories:[]})
  try{
   const turn=new PrototypeCharacterTurn({address,store,memory,leases,availability,rulebooks:createCoreRulebookRegistry({interactionPackages:[basicInteractionPackage]}),
    projectContext:cold,decide:async(request,signal)=>{
     writeFileSync(join(root,probe.id+'-preview-request.json'),JSON.stringify(request))
     if(applicability){
      const baseline=await core({operation:'recall',archive,index,request:{...request},tick:probeTick,observations:true},signal)
      writeFileSync(join(root,probe.id+'-baseline-recall.json'),JSON.stringify(baseline,null,2))
     }
     selection=facetMatch
      ?await facetWorker({operation:'recall',archive,index,projection:facetProjection!,prepared:preparedFacet!,targetObservation:targetId,request:{...request},tick:probeTick,observations:true,judge:facetJudge,judgeBackend:jevJudge?'jev':'gemini'},signal)
      :await core({operation:'recall',archive,index:searchIndex,request:{...request},tick:probeTick,observations:true},signal)
     return {decision:'abstain'}
    }})
   const previewResult=await turn.run(npc,{stimulus,maxCalls:1,signal:AbortSignal.timeout(bankMode?360000:180000)})
   writeFileSync(join(root,probe.id+'-preview-result.json'),JSON.stringify(previewResult,null,2))
  }finally{memory.close();availability.close();leases.close();store.close()}
  if(!selection)throw new Error('retrieval preview failed; inspect saved preview result')
  writeFileSync(join(root,probe.id+'-recall.json'),JSON.stringify(selection,null,2))
  let delivered=(selection?.delivery??[]) as WorldJsonObject[]
  if(sourceRoot&&!applicability){
   const request=JSON.parse(readFileSync(join(root,probe.id+'-preview-request.json'),'utf8')) as WorldJsonObject
   const input={archive,request,tick:probeTick,targetObservation:targetId}
   const child=spawnSync(hindsightPython(),[resolve('experiments/activity-memory/observation-choice-delivery.py')],{
    input:JSON.stringify(input),encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,
    env:{...process.env,PYTHONIOENCODING:'utf-8'}})
   if(child.error||child.status!==0)throw new Error('explicit delivery intervention failed')
   const forced=JSON.parse(child.stdout) as WorldJsonObject
   writeFileSync(join(root,probe.id+'-intervention.json'),JSON.stringify(forced,null,2))
   delivered=[...delivered.filter(m=>m.memoryId!==targetId),...forced.memories as WorldJsonObject[]]
   if(delivered.length>3||JSON.stringify(delivered).length>4500)throw new Error('intervention exceeds delivery budget')
  }
  if(applicability){
   const baseline=JSON.parse(readFileSync(join(root,probe.id+'-baseline-recall.json'),'utf8')) as WorldJsonObject
   if(JSON.stringify(baseline.query)!==JSON.stringify(selection?.query))throw new Error('query changed between indices')
   comparisons.push({probe:probe.id,actorId,baselineTargetDelivered:(baseline.delivery as WorldJsonObject[]).some(m=>m.memoryId===targetId),
    projectedTargetDelivered:delivered.some(m=>m.memoryId===targetId),baselineDelivery:baseline.delivery!,projectedDelivery:delivered})
   writeFileSync(join(root,'retrieval-comparison.json'),JSON.stringify(comparisons,null,2))
  }
  if(!delivered.some(m=>m.memoryId===targetId)){
   rejected.push(probe.id);console.log(JSON.stringify({probe:probe.id,stage:'retrieval',targetDelivered:false}));continue
  }
  eligible.push(probe.id)
  for(let repetition=0;repetition<repeats;repetition++){
   const modes=['with-observation','without-observation-a','without-observation-b']
   const shift=repetition%modes.length,ordered=[...modes.slice(shift),...modes.slice(0,shift)]
   for(const mode of ordered){
    const dir=join(root,probe.id+'-'+repetition+'-'+mode);mkdirSync(dir)
    for(const f of ['world.sqlite','memory.sqlite'])copyFileSync(join(historyDir,f),join(dir,f))
    store=new WorldStore(join(dir,'world.sqlite'));memory=new CognitiveMemoryService(join(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
    const leases=new WriterLeaseService(join(dir,'world.sqlite')),availability=new CharacterRuntimeAvailabilityService(join(dir,'world.sqlite')),before=store.head(address).headSeq
    let count=0
    try{
     const turn=new PrototypeCharacterTurn({address,store,memory,leases,availability,rulebooks:createCoreRulebookRegistry({interactionPackages:[basicInteractionPackage]}),projectContext:cold,
      validateDecision:decision=>{if(decision.decision==='recall')throw new Error('initial-choice experiment disallows further recall')},
      decide:async(request,signal)=>{
       const memories=mode==='with-observation'?delivered:delivered.filter(m=>m.memoryId!==targetId)
       const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories}}
       const comparable=JSON.stringify({...visible,context:{...visible.context,memories:[]}})
       if(canonical.has(probe.id)&&canonical.get(probe.id)!==comparable)throw new Error('nonmemory context changed')
       canonical.set(probe.id,comparable)
       if(JSON.stringify(visible).includes('雪青密码'))throw new Error('private context leaked')
       const record:Record<string,unknown>={mode,repetition,probe:probe.id,request:visible,status:'pending'}
       const path=join(dir,'call-'+(++count)+'.json');writeFileSync(path,JSON.stringify(record,null,2))
       const response=await provider.decide(localPrototypeTurnCall(visible),signal)
       record.response=response;record.status='returned';writeFileSync(path,JSON.stringify(record,null,2));return response
      }})
     const result=await turn.run(npc,{stimulus,maxCalls:1,signal:AbortSignal.timeout(120000)})
     const events=store.readEvents(address).filter(e=>e.seq>before)
     const row={probe:probe.id,kind:probe.kind,repetition,mode,result,calls:count,events,targetObservation:targetId,
      originalWorldUnchanged:hash()===frozen}
     if(!row.originalWorldUnchanged)throw new Error('original history changed')
     writeFileSync(join(dir,'result.json'),JSON.stringify(row,null,2));appendFileSync(join(root,'trials.jsonl'),JSON.stringify(row)+'\n');results.push(row)
     console.log(JSON.stringify({probe:probe.id,repetition,mode,status:result.status,calls:count}))
    }finally{memory.close();availability.close();leases.close();store.close()}
   }
  }
 }
 writeFileSync(join(root,'summary.json'),JSON.stringify({model,formationTick,probeTick,elapsedTicks:probeTick-formationTick,
  deliveryMode:bankMode?'multi-candidate batch applicability; behavior uses trigger/20/repeat0':facetJudge?'subject and model applicability admission':facetMatch?'natural subject and facet retrieval':applicability?'natural retrieval with applicability projection':sourceRoot?'explicit intervention':'natural',targetObservation:targetId,eligible,rejected,trials:results.length,originalWorldUnchanged:hash()===frozen,
  conclusion:'behavioral effect requires qualitative reading; no trial if target not naturally delivered'},null,2))
}
