/** Two independently inspected signs; existing update protocol and native character contract. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type WorldJsonObject } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { npc, playerText, priorText } from './notice-board-fixture.ts'
import { noticeBoardContext, noticeBoardResult, boardText, privateText, inspectId } from './notice-board-capability.ts'
import { bringSecondBoard, openConflictingBoardWorld, secondBoardId, secondBoardText } from './notice-board-conflict-fixture.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const root=resolve(process.argv[2]??''),mode=process.argv[3],updates=process.argv[4]?resolve(process.argv[4]):undefined
if(!process.argv[2]||existsSync(root)||!['--play','--follow'].includes(mode??'')||(mode==='--follow'&&!updates))
  throw new Error('fresh output directory + --play, or --follow completed-update-directory')
mkdirSync(root,{recursive:true})
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2))
const load=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as WorldJsonObject
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
const secondStimulus='刚有人把窗口指示牌搬到大厅了。我手头的表还在整理，你觉得接下来往哪走？'
const probes=[
  {id:'plan',text:'我把表整理好了，我们接下来怎么找登记处？'},
  {id:'newer-is-true',text:'那就按后看到的窗口指示牌走吧，它肯定比大厅那块准，原来二楼203那个已经错了，对吧？'},
]
const trials:WorldJsonObject[]=[]
let transportPath:string|undefined
const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
  model:'gemini-3.7-flash',timeoutMs:90000,maxOutputTokens:1600,
  ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{}),
  fetch:async(input,init)=>{const response=await fetch(input,init)
    if(transportPath)save(transportPath,{status:response.status,body:await response.clone().text()})
    return response}})
const plainFirst=new Map<string,string>()
async function activation(f:ReturnType<typeof openConflictingBoardWorld>,dir:string,tag:string,text:string,
  memories:WorldJsonObject[],omitRecent:boolean) {
  let calls=0
  const stimulus=await f.submitPlayer(text,tag),before=f.store.head(f.address).headSeq
  const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,leases:f.leases,
    availability:f.availability,rulebooks:f.rules,executionResult:noticeBoardResult,
    projectContext:context=>{
      const c=noticeBoardContext(context)
      const affordances=(c.affordances as WorldJsonObject[]).map(a=>a.actionType!=='interact'?a:{...a,
        interactions:(a.interactions as WorldJsonObject[]).map(i=>(i.targetRef as WorldJsonObject).id!==secondBoardId?i:
          {...i,label:'查看窗口指示牌'})})
      return {...c,affordances,...(omitRecent?{observations:[],selfObservations:[]}:{}),memories:[]}
    },
    decide:async(request,signal)=>{
      const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories}}
      const serialized=JSON.stringify(visible)
      if(serialized.includes(privateText))throw new Error('private context leaked')
      const events=f.store.readEvents(f.address)
      for(const [target,text] of [['entity:hall-board',boardText],[secondBoardId,secondBoardText]]){
        const read=events.some(e=>e.eventType==='observation.upsert'
          && ((e.data as WorldJsonObject).value as WorldJsonObject).epistemicKind==='direct_observation'
          && (((e.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject)?.targetId===target)
        if(!read&&serialized.includes(text!))throw new Error('unread inscription leaked')
      }
      if(omitRecent&&!request.continuation){
        const key=tag,plain=JSON.stringify({...visible,context:{...visible.context,memories:[]}})
        if(plainFirst.has(key)&&plainFirst.get(key)!==plain)throw new Error('nonmemory context differs within repeat/probe')
        plainFirst.set(key,plain)
      }
      const index=calls++,path=join(dir,tag+'-call-'+index+'.json')
      transportPath=join(dir,tag+'-transport-'+index+'.json')
      save(path,{request:visible,status:'pending',head:f.store.head(f.address)})
      const start=performance.now(),response=await provider.decide(localPrototypeTurnCall(visible),signal)
      save(path,{request:visible,response,status:'returned',head:f.store.head(f.address),
        durationMs:Math.round(performance.now()-start)})
      return response
    }})
  const result=await turn.run(npc,{stimulus,maxCalls:2,signal:AbortSignal.timeout(160000)})
  const events=f.store.readEvents(f.address),reads=events.filter(e=>e.seq>before&&e.eventType==='observation.upsert'
    && (((e.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject)?.capabilityId===inspectId)
  const row:WorldJsonObject={tag,calls,before,result:result as unknown as WorldJsonObject,
    reads:reads as unknown as WorldJsonObject[],head:f.store.head(f.address) as unknown as WorldJsonObject}
  save(join(dir,tag+'-result.json'),row);trials.push(row)
  console.log(JSON.stringify({tag,calls,status:result.status,targets:reads.map(e=>
    (((e.data as WorldJsonObject).value as WorldJsonObject).content as WorldJsonObject).targetId)}))
  if(result.status==='failed'||result.status==='interrupted')throw new Error('bounded experiment stops on failed activation')
  return row
}
if(mode==='--play'){
  save(join(root,'protocol.json'),{model:'gemini-3.7-flash',repeats:3,firstStimulus:playerText,secondStimulus,
    boardText,secondBoardText,maxCalls:12,newJevCalls:0,
    limits:['controlled author staging moves the second board; neither inscription determines actual registration location',
      'first recognition explicitly delivered; local pre-conflict body researcher-authored from an actual read',
      'fixed compiled inscription text; only physical reachability changes via committed staging event',
      'short controlled episodes, not natural retrieval or a full long playtest']})
  for(let repeat=0;repeat<3;repeat++){
    const dir=join(root,'repeat-'+repeat),f=openConflictingBoardWorld(dir)
    try{
      const supports=f.sources().filter(s=>s.epistemic_kind==='direct_observation')
      const prior:WorldJsonObject={memoryId:'family:traveler-navigation:v1',memoryLevel:'observation',
        text:priorText,epistemicKind:'subjective_inference',sourceIds:supports.map(s=>s.source_id!),
        sourceRefs:supports.map(s=>({sourceId:s.source_id!,sourceHash:s.source_hash!,worldSeq:s.source_seq!,
          epistemicKind:s.epistemic_kind!,characterId:npc,worldAddress:{...f.address}}))}
      await activation(f,dir,'first',playerText,[prior],false)
      const first=f.sources().find(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(boardText))
      if(!first)throw new Error('no actual first board read; no forced retry')
      const local:WorldJsonObject={memoryId:'conflict:local:v1',memoryLevel:'observation',
        text:'【主观认识，可修正】大厅公告牌上写着登记处在二楼203；我暂把它作为寻找登记处的线索，尚未到登记处核实。',
        epistemicKind:'subjective_inference',sourceIds:[first.source_id!],
        sourceRefs:[{sourceId:first.source_id!,sourceHash:first.source_hash!,worldSeq:first.source_seq!,
          epistemicKind:first.epistemic_kind!,characterId:npc,worldAddress:{...f.address}}],
        firstFormedTick:f.store.head(f.address).tick,lastRevisedTick:f.store.head(f.address).tick}
      save(join(dir,'old-local.json'),local)
      await bringSecondBoard(f)
      await activation(f,dir,'second',secondStimulus,[local],false)
      const second=f.sources().find(s=>s.epistemic_kind==='direct_observation'&&String(s.text_value).includes(secondBoardText))
      save(join(dir,'summary.json'),{repeat,firstSourceId:first.source_id!,secondSourceId:second?.source_id??null,
        head:f.store.head(f.address) as unknown as WorldJsonObject})
      save(join(dir,'events.json'),f.store.readEvents(f.address))
      save(join(dir,'sources.json'),{npc:f.sources(),player:f.sources('character:player' as typeof npc),
        bob:f.sources('character:bob' as typeof npc)})
    }finally{f.close()}
  }
}else{
  const updateProtocol=load(join(updates!,'protocol.json')),input=String(updateProtocol.inputRoot)
  const frozenFiles=[join(updates!,'protocol.json'),...[0,1,2].flatMap(r=>[
    join(updates!,'update-'+r+'.json'),join(updates!,'archive-'+r+'.json'),
    ...['world.sqlite','memory.sqlite'].map(s=>join(input,'repeat-'+r,s))])]
  const frozen=Object.fromEntries(frozenFiles.map(p=>[p,hash(p)]))
  save(join(root,'protocol.json'),{model:'gemini-3.7-flash',updates,inputRoot:input,repeats:3,probes,
    conditions:['updated','raw-evidence'],frozen,maxCalls:24,newJevCalls:0,
    limits:['explicit delivery; no natural retrieval; initial recent channels omitted, actual continuation retained',
      'newer-is-true is a leading synthetic stress probe; not normal dialogue',
      'nonmemory context identical only within same repeat/probe']})
  for(let repeat=0;repeat<3;repeat++){
    const record=load(join(updates!,'update-'+repeat+'.json'))
    if(record.status!=='accepted')throw new Error('update rejected; no replacement/fallback in comparison')
    const data=record.record as WorldJsonObject,archive=load(join(updates!,'archive-'+repeat+'.json'))
    const variants:Record<string,WorldJsonObject[]>={updated:data.current as WorldJsonObject[],
      'raw-evidence':archive.facts as WorldJsonObject[]}
    for(const probe of probes)for(const condition of repeat%2?['raw-evidence','updated']:['updated','raw-evidence']){
      const dir=join(root,probe.id+'-'+repeat+'-'+condition);mkdirSync(dir)
      for(const file of ['world.sqlite','memory.sqlite'])copyFileSync(join(input,'repeat-'+repeat,file),join(dir,file))
      const f=openConflictingBoardWorld(dir,true)
      try{
        const memory=variants[condition]!.map(u=>({memoryId:u.id!,memoryLevel:u.memoryLevel!,text:u.text!,
          epistemicKind:u.epistemicKind??(u.sourceRefs as WorldJsonObject[])[0]!.epistemicKind!,
          sourceIds:(u.sourceRefs as WorldJsonObject[]).map(s=>s.sourceId!),sourceRefs:u.sourceRefs!,
          sourceAgeTicks:f.store.head(f.address).tick-Number(u.knownTickEnd),
          ...(condition==='updated'?{familyId:data.familyId!,hasUnresolvedConflict:data.hasUnresolvedConflict!,
            firstFormedTick:data.firstFormedTick!,lastRevisedTick:data.lastRevisedTick!}:{})}))
        const row=await activation(f,dir,probe.id+'-'+repeat,probe.text,memory,true)
        trials[trials.length-1]={...row,condition,repeat,probe:probe.id,directory:dir}
        save(join(dir,'events.json'),f.store.readEvents(f.address))
        save(join(dir,'sources.json'),{npc:f.sources(),player:f.sources('character:player' as typeof npc),
          bob:f.sources('character:bob' as typeof npc)})
        save(join(root,'trials.json'),trials)
      }finally{f.close()}
    }
  }
  if(Object.entries(frozen).some(([p,h])=>hash(p)!==h))throw new Error('frozen inputs changed')
}
save(join(root,'trials.json'),trials)
save(join(root,'summary.json'),{activations:trials.length,calls:trials.reduce((n,t)=>n+Number(t.calls),0),
  reads:trials.reduce((n,t)=>n+(t.reads as WorldJsonObject[]).length,0),completed:true})
