import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brandId, hashWorldJson, worldAddressKey, RECALL_KEYWORD_TOKENIZER_ID,
  type WorldAddress, type WorldEventDraft, type WorldJsonObject } from '@harness-world/contracts'
import { createCoreRulebookRegistry, type CompiledWorldSpec } from '@harness-world/kernel'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService, CharacterViewBuilder } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { localPrototypeTurnCall } from '../../tests/experiments/local-prototype-turn-call.ts'
import { frozenInteractionWorld, basicInteractionPackage } from '../../tests/fixtures/frozen-interaction-world.ts'
import { behaviorCases, roundContent, type BehaviorCase } from './behavior-cases.ts'

type Ref={sourceId:string;sourceHash:string;epistemicKind:string;worldSeq:number;characterId:string;worldAddress:WorldAddress}
type Source=Ref & {text:string;knownTick:number}
type Unit={id:string;text:string;kind:string;sourceRefs:Ref[];entities?:string[];sourceFactIds?:string[];
  knownTickStart?:number;knownTickEnd?:number}
type Prepared={scope:WorldJsonObject;sources:Source[];representations:Unit[];facts:Unit[];observations:Unit[];
  processed:number;checkpoints:WorldJsonObject[]}
type Index={scope:WorldJsonObject;sources:Source[];units:Unit[];vectors:number[][];links:(string|number|null)[][];stats:WorldJsonObject}
type Recall={results:Unit[];arms:WorldJsonObject}
type SourceRow={source_id:string;source_seq:number;source_hash:string;epistemic_kind:string;text_value:string}
const rootArg=process.argv[2]
if(!rootArg) throw new Error('provide a fresh or resumable experiment output directory')
const root=resolve(rootArg)
mkdirSync(root,{recursive:true})
const caseIndex=process.argv.indexOf('--case')
const selectedCases=caseIndex<0?behaviorCases:behaviorCases.filter(c=>c.id===process.argv[caseIndex+1])
if(selectedCases.length===0) throw new Error('unknown case')
const repeatsIndex=process.argv.indexOf('--repeats')
const repeats=repeatsIndex<0?3:Number(process.argv[repeatsIndex+1])
if(!Number.isInteger(repeats)||repeats<1||repeats>5) throw new Error('invalid repeats')
const model=process.env.HCW_LOCAL_MODEL?.trim()||'gemini-3.7-flash'
const endpoint=process.env.HCW_LOCAL_ENDPOINT?.trim()||'http://127.0.0.1:8045/v1/chat/completions'
const apiKey=process.env.HCW_LOCAL_API_KEY?.trim()
const python=process.env.HCW_HINDSIGHT_PYTHON||resolve('.tmp/hindsight-vector-venv/Scripts/python.exe')
const npc=brandId('character:npc','CharacterId')
const emptyControl=process.argv.includes('--empty-memory-control')
const modes=emptyControl?(['no-long-memory'] as const):(['existing','keyword-core','core-recall','core-recall-observation'] as const)
type Mode=typeof modes[number]
const protocol={model,repeats,modes,cases:behaviorCases,history:'authored observations committed one round per tick; not 72 live model turns',
  controls:['same stage snapshot and current stimulus','no rubric or expected behavior in model request',
    'same character portrayal and affordances','rotate mode order','exact character namespace and evidence mapping'],
  assessment:'manual behavior labels; string markers are diagnostics only'}
const protocolPath=resolve(root,'protocol.json')
if(existsSync(protocolPath) && JSON.stringify(JSON.parse(readFileSync(protocolPath,'utf8')))!==JSON.stringify(protocol)) {
  throw new Error('protocol changed; use a new experiment directory')
}
writeFileSync(protocolPath,JSON.stringify(protocol,null,2))
const mission='根据这个角色有权获知的经历，归纳有多次证据支持的习惯、偏好、人物认识和事件关联；保留具体经历、说话者和不确定性。'+
  '新证据可以修订旧判断，区分历史状态与当前状态。人物名字相似不代表同一人。不要生成角色应该执行的行为指令，也不要把转述或计划写成已完成事实。'
function core(file:string,input:WorldJsonObject):WorldJsonObject {
  const run=spawnSync(python,[resolve('experiments/hindsight-core',file)],{input:JSON.stringify(input),
    encoding:'utf8',maxBuffer:64*1024*1024,timeout:240_000,
    env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0'}})
  if(run.error||run.status!==0) throw new Error(file+': '+(run.error?.message??run.stderr.slice(0,1800)))
  return JSON.parse(run.stdout) as WorldJsonObject
}
function verify(units:Unit[],sources:Source[]):void {
  const map=new Map(sources.map(s=>[s.sourceId,s]))
  for(const u of units) for(const ref of u.sourceRefs) {
    const s=map.get(ref.sourceId)
    if(s===undefined||s.sourceHash!==ref.sourceHash||s.epistemicKind!==ref.epistemicKind
      ||s.worldSeq!==ref.worldSeq||s.characterId!==ref.characterId
      ||JSON.stringify(s.worldAddress)!==JSON.stringify(ref.worldAddress)) throw new Error('unauthorized source reference '+u.id)
  }
}
function withTicks(units:Unit[],sources:Source[]):Unit[] {
  verify(units,sources)
  const ticks=new Map(sources.map(s=>[s.sourceId,s.knownTick]))
  return units.map(u=>({...u,knownTickStart:Math.min(...u.sourceRefs.map(r=>ticks.get(r.sourceId)!)),
    knownTickEnd:Math.max(...u.sourceRefs.map(r=>ticks.get(r.sourceId)!))}))
}
function fixture(test:BehaviorCase):CompiledWorldSpec {
  const base=frozenInteractionWorld()
  const characters=base.manifest.characters.map(c=>({...c,name:c.characterId===npc?'小芷':c.characterId==='character:bob'?'陆舟':'旅人',
    portrayal:c.characterId===npc?{summary:'同行的人，留意周围情况，自己决定是否说话和行动。',speakingStyle:'自然、具体，不长篇解释。'}:null}))
  characters.push(...['alice','zhou'].map((id,i)=>({...characters[2]!,characterId:brandId('character:'+id,'CharacterId'),
    name:i===0?'陆洲':'陆州'})))
  const address={...base.manifest.address,worldId:brandId('world:memory-behavior:'+test.id,'WorldId')}
  const scenes=base.manifest.scenes.map(s=>({...s,participantIds:characters.map(c=>c.characterId)}))
  const manifest={...base.manifest,address,characters,scenes,metadata:{title:test.id,description:'controlled memory experiment'},
    locations:[{locationId:'location:room',name:'前室'},{locationId:'location:next',name:'隔壁小屋'}]}
  const manifestHash=hashWorldJson('compiled-world-manifest',manifest)
  const genesisEvents:WorldEventDraft[]=base.genesisEvents.map(e=>e.eventType==='world.branch-activated'
    ? {...e,data:{...e.data as WorldJsonObject,manifestHash}}:e.eventType==='scene.upsert'
      ? {...e,data:{...e.data as WorldJsonObject,value:{lifecycle:'active',locationId:'location:room',participantIds:characters.map(c=>c.characterId)}}}:e)
  genesisEvents.push({eventType:'location.upsert',eventVersion:1,data:{locationId:'location:next',name:'隔壁小屋'}})
  for(const c of characters.slice(3)) genesisEvents.push({eventType:'character.created',eventVersion:1,
    data:{...c,lifecycleState:'active'}})
  return {manifest,manifestHash,genesisEvents,genesisHash:hashWorldJson('world-genesis-plan',genesisEvents)}
}
function observation(id:string,observer:string,content:WorldJsonObject):WorldEventDraft {
  return {eventType:'observation.upsert',eventVersion:1,data:{id,value:{observerId:observer,content}}}
}
async function histories(test:BehaviorCase):Promise<void> {
  const dir=resolve(root,test.id,'history')
  mkdirSync(dir,{recursive:true})
  const world=fixture(test)
  let store=new WorldStore(resolve(dir,'world.sqlite'))
  try {
    if(store.readManifest(world.manifest.address)===undefined) store.activateBranch({...world,address:world.manifest.address,
      transactionId:brandId('transaction:behavior-genesis:'+test.id,'TransactionId'),
      roundId:brandId('round:behavior-genesis:'+test.id,'InteractionRoundId'),correlationId:'behavior-genesis'})
    for(let tick=store.head(world.manifest.address).tick+1;tick<=test.ticks;tick++) {
      const head=store.head(world.manifest.address)
      await store.commitRound({address:world.manifest.address,expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:tick,
        transactionId:brandId('transaction:history:'+test.id+':'+tick,'TransactionId'),
        roundId:brandId('round:history:'+test.id+':'+tick,'InteractionRoundId'),
        events:[observation('observation:history:'+tick,npc,roundContent(test,tick)),
          ...(tick===4?[observation('observation:other-private','character:alice',{actorId:'character:player',
            actionType:'speak',speech:{characterId:'character:player',text:'只告诉陆洲：霜叶钥在暗处。'}})]:[])],
        outbox:[],correlationId:'behavior-history'})
      if(test.stages.includes(tick)) {
        const stageDir=resolve(root,test.id,'stage-'+tick,'base')
        mkdirSync(stageDir,{recursive:true})
        const memory=new CognitiveMemoryService(resolve(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
        try {memory.catchUp(world.manifest.address,npc,store.head(world.manifest.address).headSeq,'behavior-catchup')}
        finally {memory.close()}
        const view=new CharacterViewBuilder(store).rebuildAt(world.manifest.address,npc,store.head(world.manifest.address).headSeq)
        if(JSON.stringify(view).includes('霜叶钥')) throw new Error('private source crossed CharacterView')
        store.close()
        for(const f of ['world.sqlite','memory.sqlite']) copyFileSync(resolve(dir,f),resolve(stageDir,f))
        store=new WorldStore(resolve(dir,'world.sqlite'))
      }
    }
  } finally {store.close()}
}
function exported(test:BehaviorCase,stage:number):{scope:WorldJsonObject;sources:Source[]} {
  const dir=resolve(root,test.id,'stage-'+stage,'base')
  const store=new WorldStore(resolve(dir,'world.sqlite'))
  try {
    const address=fixture(test).manifest.address
    const head=store.head(address)
    const ticks=new Map(store.readEvents(address).map(e=>[e.seq,e.tick]))
    const db=new DatabaseSync(resolve(dir,'memory.sqlite'),{readOnly:true})
    let rows:SourceRow[]
    try {rows=db.prepare('SELECT source_id,source_seq,source_hash,epistemic_kind,text_value FROM cognitive_memory_v2_sources '+
      'WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id')
      .all(worldAddressKey(address)+'\u001f'+npc,head.headSeq) as SourceRow[]}
    finally {db.close()}
    const sources=rows.map(r=>({sourceId:r.source_id,sourceHash:r.source_hash,epistemicKind:r.epistemic_kind,
      worldSeq:r.source_seq,characterId:npc,worldAddress:address,text:r.text_value,knownTick:ticks.get(r.source_seq)!}))
    if(sources.some(s=>s.text.includes('霜叶钥')||s.knownTick>stage)) throw new Error('source snapshot leaked')
    return {scope:{worldAddress:address,characterId:npc,asOfWorldSeq:head.headSeq},sources}
  } finally {store.close()}
}
function prepare(test:BehaviorCase,stage:number):void {
  const dir=resolve(root,test.id,'stage-'+stage),path=resolve(dir,'prepared.json')
  const input=exported(test,stage)
  let data:Prepared
  if(existsSync(path)) data=JSON.parse(readFileSync(path,'utf8')) as Prepared
  else {
    const priorStage=test.stages.filter(t=>t<stage).at(-1)
    const prior=priorStage===undefined?undefined:JSON.parse(readFileSync(resolve(root,test.id,'stage-'+priorStage,'prepared.json'),'utf8')) as Prepared
    data={...input,representations:prior?.representations??[],facts:prior?.facts??[],observations:prior?.observations??[],
      processed:prior?.processed??0,checkpoints:prior?.checkpoints??[]}
  }
  if(JSON.stringify(data.scope)!==JSON.stringify(input.scope)) throw new Error('prepared scope changed')
  for(let offset=data.processed;offset<input.sources.length;offset+=12) {
    const incoming=input.sources.slice(offset,offset+12)
    const retained=core('core.py',{operation:'retain',scope:input.scope,sources:incoming})
    const facts=withTicks(retained.facts as unknown as Unit[],input.sources)
    const consolidated=core('core.py',{operation:'consolidate',scope:input.scope,representations:[],facts,
      observations:data.observations,observationsMission:mission})
    data={...data,representations:[...data.representations,...retained.representations as unknown as Unit[]],
      facts:[...data.facts,...facts],observations:withTicks(consolidated.observations as unknown as Unit[],input.sources),
      processed:offset+incoming.length,checkpoints:[...data.checkpoints,{processed:offset+incoming.length,
        facts:facts.length,observations:(consolidated.observations as unknown as Unit[]).length,actions:consolidated.actions!}]}
    writeFileSync(path,JSON.stringify(data,null,2))
    process.stdout.write(JSON.stringify({prepare:test.id,stage,processed:data.processed,observations:data.observations.length})+'\n')
  }
  const indexPath=resolve(dir,'index.json')
  if(!existsSync(indexPath)) {
    const indexed=core('vector_core.py',{operation:'index',...data})
    writeFileSync(indexPath,JSON.stringify(indexed))
    process.stdout.write(JSON.stringify({indexed:test.id,stage,stats:indexed.stats})+'\n')
  }
}
function plainIndex(index:Index):Index {
  const positions=index.units.flatMap((u,i)=>u.kind==='observation'?[]:[i])
  const units=positions.map(i=>index.units[i]!)
  const ids=new Set(units.map(u=>u.id))
  return {...index,units,vectors:positions.map(i=>index.vectors[i]!),links:index.links.filter(e=>ids.has(String(e[0]))&&ids.has(String(e[1])))}
}
const provider=createChatProvider({endpoint:new URL(endpoint),model,toolName:'character_decision',timeoutMs:90_000,
  ...(apiKey===undefined?{}:{apiKey})})
const trialsPath=resolve(root,'trials.jsonl')
const completed=new Set(existsSync(trialsPath)?readFileSync(trialsPath,'utf8').trim().split('\n').filter(Boolean)
  .map(line=>(JSON.parse(line) as {id:string}).id):[])
for(const test of selectedCases) {
  await histories(test)
  for(const stage of test.stages) {
    if(!emptyControl) prepare(test,stage)
    if(process.argv.includes('--prepare-only')) continue
    const stageDir=resolve(root,test.id,'stage-'+stage)
    const data=emptyControl?{...exported(test,stage),representations:[],facts:[],observations:[],processed:0,checkpoints:[]}:
      JSON.parse(readFileSync(resolve(stageDir,'prepared.json'),'utf8')) as Prepared
    const indexed:Index=emptyControl?{...data,units:[],vectors:[],links:[],stats:{}}:
      JSON.parse(readFileSync(resolve(stageDir,'index.json'),'utf8')) as Index
    const plain=plainIndex(indexed)
    const recalls=new Map<string,Recall>()
    function recall(mode:Mode,query:string,disableArms:string[]=[]):Recall {
      const key=JSON.stringify([mode,query,disableArms])
      const old=recalls.get(key)
      if(old!==undefined) return old
      const answer=(mode==='keyword-core'?core('core.py',{operation:'recall',scope:data.scope,query,
        representations:data.representations,facts:data.facts,observations:[],limit:8}):
        core('vector_core.py',{operation:'recall',scope:data.scope,query,index:mode==='core-recall-observation'?indexed:plain,
          limit:8,disableArms})) as unknown as Recall
      verify(answer.results,data.sources)
      recalls.set(key,answer)
      return answer
    }
    if(!emptyControl && test.temporalProbe!==undefined) {
      const {query,start,end}=test.temporalProbe
      const temporal=core('vector_core.py',{operation:'recall',scope:data.scope,query,index:indexed,tickWindow:{start,end},limit:8})
      const noTemporal=core('vector_core.py',{operation:'recall',scope:data.scope,query,index:indexed,tickWindow:{start,end},
        limit:8,disableArms:['temporal']})
      writeFileSync(resolve(stageDir,'temporal-probe.json'),JSON.stringify({protocol:test.temporalProbe,temporal,noTemporal},null,2))
    }
    for(const [probeIndex,probe] of test.probes.entries()) {
      if(!emptyControl) {
        const ablations={keyword:recall('keyword-core',probe.stimulus),full:recall('core-recall',probe.stimulus),
          observations:recall('core-recall-observation',probe.stimulus),
          withoutSemantic:recall('core-recall',probe.stimulus,['semantic']),
          withoutGraph:recall('core-recall',probe.stimulus,['graph'])}
        writeFileSync(resolve(stageDir,probe.id+'-retrieval.json'),JSON.stringify(ablations,null,2))
      }
      for(let repeat=0;repeat<repeats;repeat++) {
        const shift=(probeIndex+repeat)%modes.length
        const ordered=[...modes.slice(shift),...modes.slice(0,shift)]
        for(const mode of ordered) {
          const id=[test.id,stage,probe.id,repeat,mode].join(':')
          if(completed.has(id)) continue
          const dir=resolve(stageDir,'trials',probe.id+'-'+repeat+'-'+mode)
          if(existsSync(dir)) throw new Error('unfinished trial exists: '+id+'; preserve it and use a new directory')
          mkdirSync(dir,{recursive:true})
          for(const f of ['world.sqlite','memory.sqlite']) copyFileSync(resolve(stageDir,'base',f),resolve(dir,f))
          const worldPath=resolve(dir,'world.sqlite')
          const store=new WorldStore(worldPath),leases=new WriterLeaseService(worldPath)
          const availability=new CharacterRuntimeAvailabilityService(worldPath)
          const memory=new CognitiveMemoryService(resolve(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
          const address=data.scope.worldAddress as WorldAddress
          const head=store.head(address)
          const requests:PrototypeTurnRequest[]=[],decisions:unknown[]=[],selections:Recall[]=[]
          try {
            await store.commitRound({address,expectedHeadSeq:head.headSeq,expectedTick:head.tick,nextTick:head.tick+1,
              transactionId:brandId('transaction:stimulus:'+id,'TransactionId'),roundId:brandId('round:stimulus:'+id,'InteractionRoundId'),
              events:[observation('observation:current-stimulus',npc,{actorId:'character:player',actionType:'speak',
                speech:{characterId:'character:player',text:probe.stimulus}})],outbox:[],correlationId:'behavior-stimulus'})
            const before=store.head(address).headSeq
            const turn=new PrototypeCharacterTurn({address,store,memory,leases,availability,
              rulebooks:createCoreRulebookRegistry({interactionPackages:[basicInteractionPackage]}),
              decide:async(request,signal)=>{
                const query=typeof request.recallEvidence?.query==='string'?request.recallEvidence.query:probe.stimulus
                let visible=request
                if(mode==='no-long-memory') {
                  visible={...request,context:{...request.context,memories:[]},
                    ...(request.recallEvidence===undefined?{}:{recallEvidence:{query,memories:[]}})}
                } else if(mode!=='existing') {
                  const selected=recall(mode,query)
                  selections.push(selected)
                  const currentTick=store.head(address).tick
                  const sourceTicks=new Map(data.sources.map(s=>[s.sourceId,s.knownTick]))
                  const memories=selected.results.map(u=>({...u,memoryId:u.id,
                    sourceMaxSeq:Math.max(...u.sourceRefs.map(r=>r.worldSeq)),
                    sourceAgeTicks:currentTick-Math.max(...u.sourceRefs.map(r=>sourceTicks.get(r.sourceId)!)),
                    sourceAges:u.sourceRefs.map(r=>({sourceId:r.sourceId,sourceAgeTicks:currentTick-sourceTicks.get(r.sourceId)!})),
                    note:'来自本角色已授权来源的非权威记忆；归纳可能有误，转述和计划不证明事实已发生。'}))
                  visible={...request,context:{...request.context,memories},
                    ...(request.recallEvidence===undefined?{}:{recallEvidence:{query,memories}})}
                }
                if(JSON.stringify(visible).includes('霜叶钥')) throw new Error('private information reached NPC request')
                requests.push(visible)
                const answer=await provider.decide(localPrototypeTurnCall(visible),signal)
                decisions.push(answer)
                return answer
              }})
            const result=await turn.run(npc,{maxCalls:3,stimulus:[{actorId:'character:player',sourceText:probe.stimulus}]})
            const events=store.readEvents(address).filter(e=>e.seq>before)
            const report={id,case:test.id,stage,probe:probe.id,mode,repeat,result,decisions,
              memoryCounts:requests.map(r=>Array.isArray(r.context.memories)?r.context.memories.length:0),
              privateLeak:JSON.stringify(requests).includes('霜叶钥'),
              authorityEvents:events.filter(e=>['character.moved','entity.transferred','character.relation-started','character.relation-ended'].includes(e.eventType)),
              publications:events.filter(e=>e.eventType==='observation.upsert').map(e=>e.data)}
            writeFileSync(resolve(dir,'turn.json'),JSON.stringify({report,requests,selections},null,2))
            writeFileSync(trialsPath,JSON.stringify(report)+'\n',{flag:'a'})
            completed.add(id)
            process.stdout.write(JSON.stringify({trial:id,status:result.status,decisions})+'\n')
          } finally {memory.close();availability.close();leases.close();store.close()}
        }
      }
    }
  }
}
process.stdout.write(JSON.stringify({completed:completed.size,root})+'\n')
