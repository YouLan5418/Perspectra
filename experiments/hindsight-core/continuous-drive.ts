import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { brandId, worldAddressKey, resolutionAuthority, RECALL_KEYWORD_TOKENIZER_ID,
  type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, type CompiledWorldManifest } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { CharacterViewBuilder } from '@harness-world/store-sqlite'
import { WorldStore, WriterLeaseService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider, type ChatCall } from '@harness-world/provider-chat'
import { characterVisibleItems } from '../../packages/application/src/character-visible-items.ts'
import { FrozenWorldPlaytestRuntime } from '../../tests/experiments/playtest-frozen-runtime.ts'
import { localPrototypeTurnCall } from '../../tests/experiments/local-prototype-turn-call.ts'
import { ensureRoomScenes } from './continuous-scene.ts'
import { identityEntry, restoreAliasHistory } from './alias-history.ts'
import { repeatedPlayerStimulus } from './play-warning.ts'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'

type Ref={sourceId:string;sourceHash:string;epistemicKind:string;worldSeq:number;characterId:string;worldAddress:WorldAddress}
type Source=Ref & {text:string;knownTick:number}
type Unit={id:string;text:string;kind:string;sourceRefs:Ref[];sourceFactIds?:string[];knownTickStart?:number;knownTickEnd?:number;
  sourceRanks?:Record<string,number>;semanticSimilarity?:number;score?:number}
type Prepared={scope:WorldJsonObject;sources:Source[];representations:Unit[];facts:Unit[];observations:Unit[];episodes?:Unit[];memoryGrain?:string}
type Index={scope:WorldJsonObject;sources:Source[];units:Unit[];vectors:number[][];links:(string|number|null)[][];stats:WorldJsonObject}
type Recall={results:Unit[];arms:WorldJsonObject;armResults:Record<string,{id:string;similarity:number}[]>;
  graphSeeds:string[];expansionPaths:{from:string;to:string;kind:string;entities?:string[];weight?:number}[]}
type Round={turn:number;input:string;intent:WorldJsonObject;beforeSeq:number;afterSeq:number;beforeTick:number;afterTick:number;
  traceIds:string[];notice:string;error:boolean;events:unknown[];activationCycle:unknown}
const arg=process.argv[2]
if(!arg)throw new Error('provide a fresh or resumable output root')
const root=resolve(arg),base=resolve(root,'base'),pack=resolve(root,'world-pack')
const numberArg=(name:string,fallback:number)=>{const i=process.argv.indexOf(name);return i<0?fallback:Number(process.argv[i+1])}
const grainIndex=process.argv.indexOf('--memory-grain')
const memoryGrain=grainIndex<0?'source':process.argv[grainIndex+1]
if(memoryGrain!=='source'&&memoryGrain!=='episode')throw new Error('invalid memory grain')
const separateProjections=process.argv.includes('--memory-projections')
if(separateProjections&&memoryGrain!=='episode')throw new Error('memory projections require episode grain')
const target=numberArg('--turns',120),stopAfter=Math.min(target,numberArg('--stop-after',target))
if(!Number.isInteger(target)||target<100||target>300||!Number.isInteger(stopAfter)||stopAfter<1)throw new Error('invalid turn count')
mkdirSync(base,{recursive:true});mkdirSync(resolve(root,'traces'),{recursive:true})
const python=process.env.HCW_HINDSIGHT_PYTHON||resolve('.tmp/hindsight-vector-venv/Scripts/python.exe')
const model=process.env.HCW_LOCAL_MODEL?.trim()||'gemini-3.7-flash'
const endpoint=process.env.HCW_LOCAL_ENDPOINT?.trim()||'http://127.0.0.1:8045/v1/chat/completions'
const apiKey=process.env.HCW_LOCAL_API_KEY?.trim()
const env={...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0'}
const playerSystem='你是刚到普通驿站借宿的旅人，由你决定自己的下一步。你想安顿住处、照料随身物件，和认识的人相处，并处理你自己的日常安排。'+
  '只依据给你的可见场景、已知经历和自己的笔记行动；不知道别人的私密想法。你可以说话、私聊、移动或选择现成的交互。'+
  '不要写别人的回答或宣称别人已经行动。涉及携带、转交物品或移动时必须选对应行动，不能用发言替代。'+
  '事情结束后可以做自己的事、换地方或话题，不要反复总结已达成的共识，也不需要每件小事都请示。'+
  '不要为制造戏剧冲突、记忆考题或证明某种机制而故意编剧情；承诺、改变打算、分开办事等只在你眼前事情需要时自然发生。'+
  '选择下一步后给一个简短的 purpose（可公开的行动目的，非思维过程），journal 是仅供你下一次读取的简短个人笔记，保留尚未完成的打算和重要个人经历，不超过600字。'
const mission='根据本角色有权获知的经历，归纳多次证据支持的习惯、偏好、人物认识和事件关联。保留说话者、来源差异和不确定性。'+
  '新证据可修订旧认识，但保留历史变化；区分计划、承诺、报告与亲眼观察。不要给角色生成行为指令，不要把派生内容写成权威事实。'
const protocol={target,model,...(memoryGrain==='episode'?{memoryGrain}:{}),...(separateProjections?{memoryProjections:'separate',retrievalCleanup:'authorized-identity-template/v1',deliveryMaxItems:3,unverifiedObservations:'original evidence fallback'}:{}),mode:'core-recall-observation',checkpointEveryPlayerTurns:5,world:'ordinary generated lodge without seeded history',
  playerSystem,observationsMission:mission,playerPolicy:'only player-authorized view, recent visible transcript and own journal; no plot or action quota',
  traceMeaning:'retrieval routing and actual delivered input; not proof of model internal causality',
  roomSceneLifecycle:'experiment Host creates fresh empty Scenes for closed rooms; normal movement decides membership',
  controls:'native and keyword recalls recorded as shadow baselines; no claim of behavior A/B',time:'knownTick and source age; no inferred temporal window'}
const protocolPath=resolve(root,'protocol.json')
if(existsSync(protocolPath)&&JSON.stringify(JSON.parse(readFileSync(protocolPath,'utf8')))!==JSON.stringify(protocol))throw new Error('protocol changed; use a new root')
writeFileSync(protocolPath,JSON.stringify(protocol,null,2))
if(!existsSync(pack)){
 const run=spawnSync(python,[resolve('experiments/hindsight-core/continuous-world.py'),pack],{encoding:'utf8',env})
 if(run.status!==0)throw new Error('world preparation failed: '+run.stderr.slice(0,1000))
}
function json(path:string,value:unknown){writeFileSync(path,JSON.stringify(value,null,2))}
function append(path:string,value:unknown){writeFileSync(path,JSON.stringify(value)+'\n',{flag:'a'})}
function object(value:unknown):WorldJsonObject{
 if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('expected model object')
 return value as WorldJsonObject
}
function core(input:unknown,episodic=false):Record<string,unknown>{
 const run=spawnSync(python,[resolve('experiments/hindsight-core',episodic?'episode_core.py':'core.py')],{input:JSON.stringify(input),encoding:'utf8',
  env,maxBuffer:96*1024*1024,timeout:240_000})
 if(run.error||run.status!==0){
  append(resolve(root,'core-errors.jsonl'),{playerTurn:turnNumber,input,status:run.status,error:run.error?.message,stderr:run.stderr.slice(-6000)})
  throw new Error('core failed: '+(run.error?.message??run.stderr.slice(-1500)))
 }
 return JSON.parse(run.stdout) as Record<string,unknown>
}
const worker=spawn(python,[resolve('experiments/hindsight-core/vector-worker.py')],{env,stdio:['pipe','pipe','pipe']})
const awaiting=new Map<number,{resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void}>()
let workerId=0,workerError=''
worker.stderr.on('data',chunk=>{workerError=(workerError+String(chunk)).slice(-2500)})
createInterface({input:worker.stdout}).on('line',line=>{
 try{const result=JSON.parse(line) as {id:number;result:Record<string,unknown>;error?:string};const pending=awaiting.get(result.id)
  if(!pending)return;awaiting.delete(result.id);if(result.error)pending.reject(new Error(result.error));else pending.resolve(result.result)
 }catch(error){for(const p of awaiting.values())p.reject(error as Error);awaiting.clear()}
})
worker.on('error',error=>{for(const p of awaiting.values())p.reject(error);awaiting.clear()})
worker.on('exit',code=>{if(awaiting.size)for(const p of awaiting.values())p.reject(new Error('vector worker exited '+code+': '+workerError));awaiting.clear()})
function vector(input:unknown):Promise<Record<string,unknown>>{
 return new Promise((ready,reject)=>{const id=++workerId;awaiting.set(id,{resolve:ready,reject});worker.stdin.write(JSON.stringify({id,input})+'\n')})
}
function verify(units:Unit[],sources:Source[]):void{
 const map=new Map(sources.map(s=>[s.sourceId,s]))
 for(const u of units)for(const r of u.sourceRefs){const s=map.get(r.sourceId)
  if(s===undefined||s.sourceHash!==r.sourceHash||s.epistemicKind!==r.epistemicKind||s.worldSeq!==r.worldSeq
   ||s.characterId!==r.characterId||JSON.stringify(s.worldAddress)!==JSON.stringify(r.worldAddress))throw new Error('source mapping mismatch '+u.id)
 }
}
function timed(units:Unit[],sources:Source[]):Unit[]{
 verify(units,sources);const ticks=new Map(sources.map(s=>[s.sourceId,s.knownTick]))
 return units.map(u=>({...u,knownTickStart:Math.min(...u.sourceRefs.map(r=>ticks.get(r.sourceId)!)),
  knownTickEnd:Math.max(...u.sourceRefs.map(r=>ticks.get(r.sourceId)!))}))
}
const progressPath=resolve(root,'progress.json')
const progress: {rounds:Round[];journal:string}=existsSync(progressPath)?JSON.parse(readFileSync(progressPath,'utf8')):{rounds:[],journal:''}
const snapshots=new Map<string,{data:Prepared;index:Index;path:string}>()
let aliasHistory=new Map<string,WorldJsonObject[]>()

let address:WorldAddress,turnNumber=progress.rounds.length,callNumber=0
let roundTraces:string[]=[]
const pendingTraces=new WeakMap<PrototypeTurnRequest,{path:string;record:Record<string,unknown>}>()
function queryText(value:unknown):string {
 if(value===null||typeof value!=='object')return typeof value==='string'?value:''
 const outer=value as WorldJsonObject,owned=outer.value!==null&&typeof outer.value==='object'?outer.value as WorldJsonObject:outer
 const content=owned.content
 if(typeof content==='string')return content
 if(content===null||typeof content!=='object'||Array.isArray(content))return ''
 const c=content as WorldJsonObject,speech=c.speech as WorldJsonObject|undefined
 if(typeof speech?.text==='string'&&speech.text.trim())return speech.text
 return [c.resultDescription,c.description,c.narration,
  c.interaction===undefined?'':JSON.stringify(c.interaction),c.movement===undefined?'':JSON.stringify(c.movement)]
  .filter(v=>typeof v==='string'&&v.length>0).join(' ')
}

async function adapt(request:PrototypeTurnRequest):Promise<PrototypeTurnRequest>{
 const actor=String(object(request.context.character).characterId)
 const snapshot=snapshots.get(actor)
 if(snapshot===undefined)throw new Error('missing authorized memory snapshot for '+actor)
 const legacyQuery=typeof request.recallEvidence?.query==='string'?request.recallEvidence.query:
  [...(request.context.stimulus as unknown[]),...(request.context.observations as unknown[]).slice(-3)]
   .map(queryText).filter(Boolean).join(' ').slice(0,1600)||'当前可见场景与角色经历'
 let query=legacyQuery
 const headStore=new WorldStore(resolve(base,'world.sqlite'))
 let tick:number,headSeq:number
 try{const head=headStore.head(address);tick=head.tick;headSeq=head.headSeq}finally{headStore.close()}
 if(separateProjections){
  const history=aliasHistory.get(actor)??[]
  history.push(identityEntry(request.context as unknown as WorldJsonObject,snapshot.data.scope,headSeq))
  aliasHistory.set(actor,history)
 }
 const visibleSeqs=new Set([...(request.context.observations as WorldJsonObject[]),...(request.context.selfObservations as WorldJsonObject[])]
  .map(o=>Number(o.sourceSeq)))
 const positions=snapshot.index.units.flatMap((u,i)=>u.sourceRefs.every(r=>visibleSeqs.has(r.worldSeq))?[]:[i])
 const units=positions.map(i=>snapshot.index.units[i]!),ids=new Set(units.map(u=>u.id))
 const index:Index={...snapshot.index,units,vectors:positions.map(i=>snapshot.index.vectors[i]!),
  links:snapshot.index.links.filter(e=>ids.has(String(e[0]))&&ids.has(String(e[1])))}
 const result=separateProjections
  ? await vector({operation:'projected_recall',scope:snapshot.data.scope,index:snapshot.index,
    archive:snapshot.data,query,recentSeqs:[...visibleSeqs],request,tick})
  : await vector({operation:'recall',scope:index.scope,index,query,limit:8})
 if(separateProjections)query=String(result.query)
 const selected=result as unknown as Recall
 verify(selected.results,snapshot.data.sources)
 if(Number(index.scope.asOfWorldSeq)>headSeq)throw new Error('future memory snapshot')
 const sourceMap=new Map(snapshot.data.sources.map(s=>[s.sourceId,s]))
 const memories=separateProjections?result.delivery as WorldJsonObject[]:selected.results.map(u=>({...u,memoryId:u.id,sourceMaxSeq:Math.max(...u.sourceRefs.map(r=>r.worldSeq)),
  sourceAgeTicks:tick-Math.max(...u.sourceRefs.map(r=>sourceMap.get(r.sourceId)!.knownTick)),
  sourceAges:u.sourceRefs.map(r=>({sourceId:r.sourceId,knownTick:sourceMap.get(r.sourceId)!.knownTick,
   sourceAgeTicks:tick-sourceMap.get(r.sourceId)!.knownTick})),
  note:'本角色已授权来源的非权威记忆；归纳可能有误，转述、计划、承诺不证明已完成。'}))
 const visible:PrototypeTurnRequest={...request,context:{...request.context,memories},
  ...(request.recallEvidence===undefined?{}:{recallEvidence:{query,memories}})}
 const id=`turn-${String(turnNumber).padStart(4,'0')}-call-${String(++callNumber).padStart(3,'0')}-${actor.split(':')[1]}`
 const tracePath=resolve(root,'traces',id+'.json'),selectedIds=new Set(selected.results.map(u=>u.id))
 const viewIds=new Map<string,Set<string>>()
 if(separateProjections){
  const projection=result.projectionTrace as {retrieval:{results:{id:string;matches:{representationId:string}[]}[]}}
  for(const candidate of projection.retrieval.results)viewIds.set(candidate.id,new Set(candidate.matches.map(m=>m.representationId)))
 }
 const selectedViewIds=new Set([...viewIds.values()].flatMap(ids=>[...ids]))
 const keyword=core({operation:'recall',scope:snapshot.data.scope,query:legacyQuery,sources:snapshot.data.sources,representations:snapshot.data.representations,
  facts:snapshot.data.facts,observations:[],limit:8})
 const record={id,playerTurn:turnNumber,actorId:actor,tick,headSeq,indexedThroughSeq:index.scope.asOfWorldSeq,
  currentStimulus:request.context.stimulus,query,legacyQuery,queryOrigin:request.recallEvidence===undefined?(separateProjections?'current authorized stimulus only':'authorized stimulus and recent observations'):'character主动 recall',
  snapshot:relative(root,snapshot.path),selected:selected.results.map(u=>({...u,
   rrfContributions:Object.fromEntries(Object.entries(u.sourceRanks??{}).map(([arm,rank])=>[arm,1/(60+rank)])),
   routes:selected.expansionPaths.filter(p=>p.to===u.id||viewIds.get(u.id)?.has(p.to)),
   sources:u.sourceRefs.map(r=>sourceMap.get(r.sourceId)!)})),
  retrieval:{arms:selected.arms,armResults:selected.armResults,graphSeeds:selected.graphSeeds,
   expansionPaths:selected.expansionPaths.filter(p=>selectedIds.has(p.to)||selectedViewIds.has(p.to)),recentSourceSeqsExcluded:[...visibleSeqs]},
  hasObservation:separateProjections
   ? memories.some(u=>u.memoryLevel==='observation'):selected.results.some(u=>u.kind==='observation'),
  ...(separateProjections?{projection:result.projectionTrace}:{}),
  baselines:{nativeInitial:request.context.memories??[],nativeActiveRecall:request.recallEvidence??null,keyword},
  hostRequest:request,deliveredRequest:visible,modelCall:localPrototypeTurnCall(visible),modelResponse:null,status:'awaiting_model',
  causality:'routes explain selection, not internal reasons for final behavior'}
 json(tracePath,record);pendingTraces.set(request,{path:tracePath,record});roundTraces.push(id)
 return visible
}
function response(record:{request:PrototypeTurnRequest;visible:PrototypeTurnRequest;response:unknown}):void{
 const trace=pendingTraces.get(record.request)
 if(!trace)throw new Error('response without trace')
 Object.assign(trace.record,{modelResponse:record.response,status:'model_returned'})
 json(trace.path,trace.record)
 append(resolve(root,'trace-index.jsonl'),{id:trace.record.id,playerTurn:turnNumber,actorId:trace.record.actorId,
  tick:trace.record.tick,hasObservation:trace.record.hasObservation,response:record.response})
}
let runtime:FrozenWorldPlaytestRuntime|undefined
async function checkpoint(n:number):Promise<void>{
 const store=new WorldStore(resolve(base,'world.sqlite'))
 const memory=new CognitiveMemoryService(resolve(base,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
 try{
  const head=store.head(address),stored=store.readManifest(address)!,manifest=stored.manifest as CompiledWorldManifest
  const ticks=new Map(store.readEvents(address).map(e=>[e.seq,e.tick]))
  for(const character of manifest.characters.filter(c=>c.characterId!=='character:player')){
   const actor=character.characterId;memory.catchUp(address,actor,head.headSeq,'continuous-checkpoint')
   const db=new DatabaseSync(resolve(base,'memory.sqlite'),{readOnly:true})
   let rows:{source_id:string;source_hash:string;source_seq:number;epistemic_kind:string;text_value:string}[]
   try{rows=db.prepare('SELECT source_id,source_hash,source_seq,epistemic_kind,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id')
    .all(worldAddressKey(address)+'\u001f'+actor,head.headSeq) as typeof rows}finally{db.close()}
   const sources:Source[]=rows.map(r=>({sourceId:r.source_id,sourceHash:r.source_hash,epistemicKind:r.epistemic_kind,
    worldSeq:r.source_seq,characterId:actor,worldAddress:address,text:r.text_value,knownTick:ticks.get(r.source_seq)!}))
   const scope:WorldJsonObject={worldAddress:address,characterId:actor,asOfWorldSeq:head.headSeq}
   const actorKey=actor.split(':')[1]!,dir=resolve(root,'memories',actorKey);mkdirSync(dir,{recursive:true})
   const path=resolve(dir,'prepared.json')
   let data:Prepared=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{scope,sources:[],representations:[],facts:[],observations:[]}
   const known=new Set(data.sources.map(s=>s.sourceId)),incoming=sources.filter(s=>!known.has(s.sourceId))
   for(let offset=0;offset<incoming.length;offset+=8){
    const episodic=memoryGrain==='episode'
    const batch=incoming.slice(offset,offset+8),retained=core({operation:'retain',scope,sources:batch},episodic)
    const facts=timed(retained.facts as Unit[],sources)
    const previous=data.observations
    let grouping:Record<string,unknown>|undefined
    let integrated:Record<string,unknown>
    if(episodic){
     const prefixSources=[...data.sources,...batch],allFacts=[...data.facts,...facts]
     const input={scope,sources:prefixSources,representations:[],facts:allFacts,episodes:data.episodes??[],observations:data.observations}
     grouping=core({operation:'group',...input},true)
     const episodes=timed(grouping.episodes as Unit[],prefixSources)
     integrated=core({operation:'consolidate',...input,episodes,observationsMission:mission},true)
     data={...data,scope,memoryGrain,sources:prefixSources,episodes,facts:allFacts,
      representations:[...data.representations,...retained.representations as Unit[]],
      observations:timed(integrated.observations as Unit[],prefixSources)}
    }else{
     integrated=core({operation:'consolidate',scope,representations:[],facts,observations:data.observations,observationsMission:mission})
     data={scope,sources:[...data.sources,...batch],representations:[...data.representations,...retained.representations as Unit[]],
      facts:[...data.facts,...facts],observations:timed(integrated.observations as Unit[],sources)}
    }
    verify([...data.representations,...data.facts,...(data.episodes??[]),...data.observations],data.sources)
    json(path,data)
    append(resolve(root,'consolidation.jsonl'),{playerTurn:n,actorId:actor,headSeq:head.headSeq,sourceIds:batch.map(s=>s.sourceId),
     sourceTexts:batch,facts,...(grouping===undefined?{}:{episodes:data.episodes,groupingActions:grouping.actions,retainStats:retained.stats}),previousObservations:previous,nextObservations:data.observations,actions:integrated.actions})
   }
   data={...data,scope,sources};json(path,data)
   const index=await vector({operation:separateProjections?'projected_index':'index',...data,...(separateProjections?{aliasHistory:aliasHistory.get(actor)??[]}: {})}) as unknown as Index
   const snapshotDir=resolve(root,'snapshots','turn-'+String(n).padStart(4,'0'),actorKey);mkdirSync(snapshotDir,{recursive:true})
   json(resolve(snapshotDir,'prepared.json'),data);const indexPath=resolve(snapshotDir,'index.json');json(indexPath,index)
   snapshots.set(actor,{data,index,path:indexPath})
   process.stdout.write(JSON.stringify({checkpoint:n,actor,sources:sources.length,facts:data.facts.length,observations:data.observations.length})+'\n')
  }
 }finally{memory.close();store.close()}
}
const player=brandId('character:player','CharacterId')
const rules=createCoreRulebookRegistry({interactionPackages:[createBasicInteractionPackage()]})
const playerProvider=createChatProvider({endpoint:new URL(endpoint),model,toolName:'player_next_step',timeoutMs:90_000,
 maxOutputTokens:1400,...(apiKey===undefined?{}:{apiKey})})
async function playerNext():Promise<{input:string;intent:WorldJsonObject}>{
 const state=await runtime!.state(),store=new WorldStore(resolve(base,'world.sqlite'))
 try{
  const head=store.head(address),stored=store.readManifest(address)!,manifest=stored.manifest as CompiledWorldManifest
  const events=store.readEvents(address),view=new CharacterViewBuilder(store).rebuildAt(address,player,head.headSeq)
  const people=manifest.characters.filter(c=>state.world.currentScene?.presentNpcNames.includes(c.name)).map(c=>({characterId:c.characterId,name:c.name}))
  const afforded=rules.resolve(manifest.rulebook.rulebookId,manifest.rulebook.version,'player-visible',address)
   .affordances({manifest,events,characterId:player,manifestHash:stored.manifestHash,asOfWorldSeq:head.headSeq,
    resolutionAuthority:resolutionAuthority('player','manual_player_immediate')})
  const interactions:(WorldJsonObject & {index:number})[]=afforded.flatMap(a=>a.interactions??[]).map((o,index)=>({index,...o}))
  const destinations=afforded.find(a=>a.actionType==='move')?.destinations??[]
  const schema:WorldJsonObject={type:'object',additionalProperties:false,required:['kind','purpose','journal'],properties:{
   kind:{type:'string',enum:['speak','move',...(interactions.length?['interact']:[])]},purpose:{type:'string',maxLength:180},
   journal:{type:'string',maxLength:1200},text:{type:'string',maxLength:1000},narration:{type:'string',maxLength:500},
   scope:{type:'string',enum:['scene_public',...(people.length?['private']:[])]},
   ...(people.length?{addresseeIds:{type:'array',uniqueItems:true,items:{type:'string',enum:people.map(p=>p.characterId)}}}:{}),
   locationId:{type:'string',enum:destinations.map(d=>d.locationId)},
   ...(interactions.length?{optionIndex:{type:'integer',enum:interactions.map(o=>o.index)}}:{})}}
  const payload={character:{characterId:player,name:'旅人'},scene:state.world.currentScene,people,items:characterVisibleItems(manifest,events,player,
   [player,...people.map(p=>p.characterId)]),affordances:{destinations,interactions},
   observations:view.observations.slice(-24),selfObservations:view.selfObservations.slice(-10),
   recentTranscript:state.transcript.slice(-28),ownJournal:progress.journal,lastNotice:state.notice,
   objectNames:manifest.entities.map(e=>({entityId:e.entityId,name:e.kind}))}
  const call:ChatCall={messages:[{role:'system',content:playerSystem},{role:'user',content:JSON.stringify(payload)}],schema,
   description:'只选择玩家自己的下一步，交互通过世界裁定。'}
  const intent=object(await playerProvider.decide(call,AbortSignal.timeout(95_000)))
  json(resolve(root,'player-turn-'+String(turnNumber).padStart(4,'0')+'.json'),{call,response:intent,viewAsOfSeq:head.headSeq})
  let input:string
  if(intent.kind==='move'){
   if(!destinations.some(d=>d.locationId===intent.locationId))throw new Error('player selected unavailable destination')
   input='/move '+String(intent.locationId)
  }else if(intent.kind==='interact'){
   const option=interactions.find(o=>o.index===intent.optionIndex)
   if(!option)throw new Error('player selected unavailable interaction')
   const parameters={targetRef:option.targetRef,bindingId:option.bindingId,definitionRef:option.definitionRef,arguments:option.arguments}
   input='/act interact '+JSON.stringify(parameters)
  }else if(intent.kind==='speak'){
   const scope=intent.scope??'scene_public',addresseeIds=scope==='private'?intent.addresseeIds:[]
   if(scope==='private'&&(!Array.isArray(addresseeIds)||addresseeIds.length===0||addresseeIds.some(id=>!people.some(p=>p.characterId===id))))throw new Error('invalid private player recipients')
   if(typeof intent.text!=='string'&&typeof intent.narration!=='string')throw new Error('empty player expression')
   input='/act speak '+JSON.stringify({text:intent.text??'',scope,addresseeIds,
    ...(typeof intent.narration==='string'?{narration:intent.narration}:{})})
  }else throw new Error('unknown player action')
  return {input,intent}
 }finally{store.close()}
}
try{
 runtime=await FrozenWorldPlaytestRuntime.create({dataDirectory:base,packPath:pack,provider:'local',model,
  utilityEndpoint:endpoint,timeoutMs:90_000,...(apiKey===undefined?{}:{apiKey}),
  experimentalCharacterRequest:async request=>{
   try{return await adapt(request)}catch(error){
    append(resolve(root,'trace-errors.jsonl'),{playerTurn:turnNumber,actorId:object(request.context.character).characterId,
     stimulus:request.context.stimulus,error:error instanceof Error?error.message:'unknown error'})
    throw error
   }
  },experimentalCharacterResponse:response})
 address=runtime.address
 if(existsSync(resolve(root,'inflight.json')))throw new Error('unfinished input exists; inspect it before resuming')
 if(separateProjections&&progress.rounds.length){
  const store=new WorldStore(resolve(base,'world.sqlite'))
  try{aliasHistory=restoreAliasHistory(root,progress.rounds,address,store.head(address).headSeq)}finally{store.close()}
  process.stdout.write(JSON.stringify({restoredAliasHistory:Object.fromEntries([...aliasHistory].map(([actor,entries])=>[actor,entries.length]))})+'\n')
 }
 await checkpoint(progress.rounds.length)
 for(let n=progress.rounds.length+1;n<=stopAfter;n++){
  turnNumber=n;callNumber=0;roundTraces=[]
  await runtime.releaseForExperimentalHost()
  const sceneStore=new WorldStore(resolve(base,'world.sqlite')),sceneLeases=new WriterLeaseService(resolve(base,'world.sqlite'))
  let before:{headSeq:number;tick:number}
  try{
   const created=await ensureRoomScenes(sceneStore,sceneLeases,address,n)
   if(created!==undefined)append(resolve(root,'room-scenes.jsonl'),created)
   before=sceneStore.head(address)
  }finally{sceneLeases.close();sceneStore.close()}
  const chosen=await playerNext()
  const inflight={turn:n,...chosen,beforeSeq:Number(before.headSeq)};json(resolve(root,'inflight.json'),inflight)
  const state=await runtime.submit(chosen.input,'continuous-player-'+n)
  const store=new WorldStore(resolve(base,'world.sqlite'))
  let events:unknown[],afterTick:number,afterSeq:number
  try{const head=store.head(address);afterTick=head.tick;afterSeq=head.headSeq;
   events=store.readEvents(address).filter(e=>e.seq>Number(before.headSeq))}finally{store.close()}
  const record:Round={turn:n,...chosen,beforeSeq:Number(before.headSeq),beforeTick:Number(before.tick),afterSeq,afterTick,
   traceIds:roundTraces,notice:state.notice,error:state.error,events,activationCycle:state.debug.activationCycle}
  for(const [traceIndex,id] of roundTraces.entries()){const path=resolve(root,'traces',id+'.json'),trace=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>
   const nextId=roundTraces[traceIndex+1]
   const nextHead=nextId===undefined?afterSeq:Number((JSON.parse(readFileSync(resolve(root,'traces',nextId+'.json'),'utf8')) as {headSeq:number}).headSeq)
   trace.roundOutcome={afterSeq,afterTick,notice:state.notice,error:state.error,activationCycle:state.debug.activationCycle,
    structuredActionProposed:(trace.modelResponse as WorldJsonObject|null)?.decision==='perform',
    actionEvents:(events as {seq:number;eventType:string;data:WorldJsonObject}[]).filter(e=>e.seq>Number(trace.headSeq)&&e.seq<=nextHead&&['action.resolved','character.moved','entity.transferred','character.relation-started','character.relation-ended'].includes(e.eventType)),
    note:'events committed between this request and the next request; compare action IDs and activation results'}
   trace.responseCompletion=trace.status==='model_returned'?'decoded response captured':'no response received before activation ended'
   json(path,trace)
  }
  progress.rounds.push(record);progress.journal=typeof chosen.intent.journal==='string'?chosen.intent.journal:progress.journal
  json(progressPath,{...progress,address});append(resolve(root,'rounds.jsonl'),record)
  const repetition=repeatedPlayerStimulus(progress.rounds)
  if(repetition){
   const warning={turn:n,warning:'玩家刺激连续近似重复；请检查试玩是否停滞',...repetition}
   append(resolve(root,'play-warnings.jsonl'),warning);process.stdout.write(JSON.stringify(warning)+'\n')
  }
  // Move the temporary input aside after its world outcome is recorded; never silently replay partial turns.
  const {renameSync}=await import('node:fs');renameSync(resolve(root,'inflight.json'),resolve(root,'last-input.json'))
  process.stdout.write(JSON.stringify({turn:n,tick:afterTick,input:chosen.input,calls:roundTraces.length,error:state.error,notice:state.notice})+'\n')
  if(state.error){
   if((state.debug.activationCycle as {terminalReason?:string}|undefined)?.terminalReason==='interrupted'){
    append(resolve(root,'continuations.jsonl'),{afterPlayerTurn:n,reason:'activation interrupted; preserve committed outcome and advance to next player step without replay',notice:state.notice})
   }else throw new Error('real turn failed; inspect trace and committed events before continuation')
  }
  if(n%5===0||n===stopAfter)await checkpoint(n)
  if(n%20===0||n===stopAfter){
   const summary=spawnSync(python,[resolve('experiments/hindsight-core/trace-summary.py'),root],{encoding:'utf8',env,maxBuffer:8*1024*1024})
   if(summary.status!==0)throw new Error('trace audit failed: '+summary.stderr.slice(-2000))
   const report=JSON.parse(summary.stdout) as {windows:unknown[]}
   process.stdout.write(JSON.stringify({memoryWindows:report.windows})+'\n')
  }
 }
}finally{await runtime?.close();worker.stdin.end();worker.kill()}
process.stdout.write(JSON.stringify({completedPlayerTurns:progress.rounds.length,target,root})+'\n')
