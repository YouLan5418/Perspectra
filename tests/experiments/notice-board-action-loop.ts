/** Closed action/evidence/revision loop; experimental sidecars, native rulebook and commit. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type WorldJsonObject, type WorldJsonValue } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openActionWorld, actionContext, actionResult, setupRead, askId, terminalId,
  staffText, terminalText } from './notice-board-action-fixture.ts'
import { bringSecondBoard, secondBoardId } from './notice-board-conflict-fixture.ts'
import { npc, player, bob } from './notice-board-fixture.ts'
import { privateText } from './notice-board-capability.ts'
import { inscriptionReadings } from './notice-board-evidence-delivery.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { hindsightPython } from './hindsight-python.ts'

const root=resolve(process.argv[2]??''),mode=process.argv[3]??'--prepare'
if(!process.argv[2]||!['--prepare','--run','--finalize'].includes(mode))throw new Error('fresh root + --prepare then --run')
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2))
const load=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as WorldJsonObject
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
const obj=(v:unknown):WorldJsonObject=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as WorldJsonObject:{}
const templates=resolve('.tmp/notice-board-timing-updates-20261005-v1')
const conditions=['raw-evidence','paired-evidence','updated-cognition']
const neutral='那我们接下来怎么办？'
const future='今天又来这栋办事楼，想给另一份材料办理登记。接下来怎么办？'
const gaps=['我把外套换成了浅灰色，这个颜色看起来怎么样？',
  '我最近在家种了一盆薄荷，叶子长得挺快。',
  '昨晚看了一部慢节奏的电影，我挺喜欢它的配乐。',
  '我打算周末试着烤面包，先做最普通的那种。',
  '我发现自己的笔写起来比之前顺手了。',
  '你平时喜欢安静一点的音乐吗？',
  '刚想起家里的窗帘该洗了，回去再处理。',
  '忙完之后想做顿简单的晚饭，你喜欢什么口味？']
type F=ReturnType<typeof openActionWorld>
function python(doc:WorldJsonObject):Promise<WorldJsonObject>{
  return new Promise((yes,no)=>{
    const child=execFile(hindsightPython(),[resolve('experiments/activity-memory/notice_board_action_loop.py')],{
      timeout:180000,maxBuffer:128*1024*1024,encoding:'utf8',windowsHide:true,
      env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0',
        HCW_HINDSIGHT_UTILITY_TRACE:join(root,'utility-calls.jsonl'),
        HCW_JEV_APPLICABILITY_TRACE:join(root,'jev-calls.jsonl')}},
      (e,out,err)=>{if(e)no(new Error('authorized memory operation failed: '+err.slice(-1600)));else{
        try{yes(JSON.parse(out) as WorldJsonObject)}catch(cause){no(cause)}}})
    child.stdin!.on('error',()=>{});child.stdin!.end(JSON.stringify(doc))
  })
}
/** Host validates the actual DB; only owner-authorized Sources cross into memory Python. */
function authorized(f:F){
  const history=f.store.readEvents(f.address),rows=f.sources(),sources:WorldJsonObject[]=[]
  for(const row of rows){
    const event=history.find(e=>e.seq===row.source_seq)
    if(!event||event.eventType!=='observation.upsert'||row.source_id!=='event:'+event.seq
      ||row.source_hash!==event.eventHash||row.namespace_key!==[f.address.tenantId,f.address.worldId,f.address.branchId,npc].join('\x1f'))
      throw new Error('Source does not map to an authorized immutable event')
    const value=obj(obj(event.data).value),content=obj(value.content)
    if(value.observerId!==npc)throw new Error('foreign Source')
    if(!['experiment:inspect-notice-board',askId,terminalId].includes(String(content.capabilityId)))continue
    const accepted=history.find(e=>e.eventType==='action.resolved'&&obj(e.data).actionId===value.actionId)
    if(!accepted||obj(accepted.data).actorId!==npc||obj(accepted.data).accepted!==true
      ||accepted.transactionId!==event.transactionId||content.sourceActionId!==value.actionId)
      throw new Error('evidence is not from an atomically accepted native action')
    const expected=content.capabilityId===askId?'reported_speech':'direct_observation'
    if(row.epistemic_kind!==expected||value.epistemicKind!==expected)throw new Error('epistemic kind mismatch')
    if(content.capabilityId===askId){
      if(row.text_value!==obj(content.speech).characterId+' said: '+obj(content.speech).text
        ||obj(content.speech).text!==staffText)throw new Error('staff Source altered')
    }else if(JSON.stringify(obj(JSON.parse(String(row.text_value))))!==JSON.stringify(content)
      ||(content.capabilityId===terminalId&&content.observedText!==terminalText))throw new Error('read Source altered')
    for(const observer of [player,bob]){
      if(f.sources(observer).some(r=>r.source_seq===row.source_seq))throw new Error('private evidence escaped actor')
    }
    sources.push({sourceId:row.source_id!,sourceHash:row.source_hash!,worldSeq:row.source_seq!,
      characterId:npc,worldAddress:{...f.address},epistemicKind:row.epistemic_kind!,text:row.text_value!,knownTick:event.tick})
  }
  return {scope:{characterId:npc,worldAddress:{...f.address},asOfWorldSeq:f.store.head(f.address).headSeq},sources}
}
function exported(f:F,dir:string){
  save(join(dir,'events.json'),f.store.readEvents(f.address))
  save(join(dir,'sources.json'),{npc:f.sources(),player:f.sources(player),bob:f.sources(bob)})
}
function readings(initial:WorldJsonObject,tick:number,condition:string):WorldJsonObject[]{
  const archive=obj(initial.archive),record=obj(initial.record)
  if(condition==='paired-evidence')return inscriptionReadings({...archive,observations:[]},tick,'paired')
  const units=(condition==='raw-evidence'?archive.facts:record.current) as WorldJsonObject[]
  return units.map(u=>({memoryId:u.id!,memoryLevel:u.memoryLevel!,text:u.text!,epistemicKind:u.epistemicKind!,
    sourceIds:(u.sourceRefs as WorldJsonObject[]).map(r=>r.sourceId!),sourceRefs:u.sourceRefs!,sourceAgeTicks:tick-Number(u.knownTickEnd),
    ...(condition==='updated-cognition'?{familyId:record.familyId!,hasUnresolvedConflict:record.hasUnresolvedConflict!}:{} )}))
}
let transport:string|undefined,totalCalls=0
const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
  model:'gemini-3.7-flash',timeoutMs:90000,maxOutputTokens:1600,
  ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{}),
  fetch:async(input,init)=>{const response=await fetch(input,init)
    if(transport)save(transport,{status:response.status,body:await response.clone().text()});return response}})
const comparable=new Map<string,string>()
async function activate(f:F,dir:string,tag:string,stimulus:WorldJsonObject[],memories:WorldJsonObject[],
  maxCalls:1|2=2,key?:string){
  let calls=0
  const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,leases:f.leases,
    availability:f.availability,rulebooks:f.rules,projectContext:actionContext,executionResult:actionResult,
    recentObservations:4,recentSelfObservations:4,
    validateDecision:d=>{if(d.decision==='recall')throw new Error('extra active recall disabled consistently')},
    decide:async(request,signal)=>{
      const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories}}
      if(JSON.stringify(visible).includes(privateText))throw new Error('private context leaked')
      if(!request.continuation&&key){
        const plain=JSON.stringify({...visible,context:{...visible.context,memories:[]}})
        if(comparable.has(key)&&comparable.get(key)!==plain)throw new Error('nonmemory contexts differ')
        comparable.set(key,plain)
      }
      if(!request.continuation){
        const proof=authorized(f)
        for(const [id,text] of [[askId,staffText],[terminalId,terminalText]])
          if(!proof.sources.some(s=>String(s.text).includes(text!))&&JSON.stringify(visible).includes(text!))
            throw new Error('unexecuted evidence leaked: '+id)
      }
      const index=calls++,path=join(dir,tag+'-call-'+index+'.json')
      totalCalls++;transport=join(dir,tag+'-transport-'+index+'.json')
      save(path,{status:'pending',request:visible,head:f.store.head(f.address)})
      const start=performance.now(),response=await provider.decide(localPrototypeTurnCall(visible),signal)
      save(path,{status:'returned',request:visible,response,durationMs:Math.round(performance.now()-start),head:f.store.head(f.address)})
      return response
    }})
  const before=f.store.head(f.address),result=await turn.run(npc,{stimulus,maxCalls,signal:AbortSignal.timeout(115000)})
  const events=f.store.readEvents(f.address).filter(e=>e.seq>before.headSeq)
  const native=load(join(dir,tag+'-call-0.json')).response
  const action=obj(result.performResult?.action),params=obj(action.parameters)
  const kind=result.performResult?.status==='accepted'?(action.actionType==='move'?'move:'+params.locationId:
    String(obj(params.definitionRef).id)):'none'
  const row:Record<string,WorldJsonValue>={tag,calls,before:before as unknown as WorldJsonObject,result:result as unknown as WorldJsonObject,
    nativeResponse:native!,actionKind:kind,events:events as unknown as WorldJsonObject[]}
  save(join(dir,tag+'-result.json'),row)
  if(result.failure==='provider_failed'||result.status==='interrupted')throw new Error('model call failed; no selective retry')
  return row
}
if(mode==='--finalize'){
  const summary=load(join(root,'summary.json'))
  if(summary.completed!==true||existsSync(join(root,'future-revisions.json')))throw new Error('finalize once after completed run')
  const finalized:WorldJsonObject[]=[]
  for(const condition of conditions)for(const variant of ['current-cognition','prior-cognition','no-cognition']){
    const dir=join(root,'later-'+condition,variant)
    if(!existsSync(join(dir,'future-result.json')))continue
    const row=load(join(dir,'future-result.json'))
    if(![askId,terminalId,'experiment:inspect-notice-board'].includes(String(row.actionKind)))continue
    const f=openActionWorld(dir,true)
    try{
      const source=String(load(join(root,'selected.json'))[condition])
      const previous=load(join(source,'revision.json')),record=obj(previous.record)
      const proof=authorized(f)
      const revision=await python({operation:'revise',initial:previous,...proof,tick:f.store.head(f.address).tick,
        firstFormedTick:record.firstFormedTick!,lastRevisedTick:record.lastRevisedTick!})
      save(join(dir,'future-revision.json'),revision)
      finalized.push({condition,variant,actionKind:row.actionKind!,relation:obj(revision.record).relation!,
        newSourceIds:obj(revision.record).revisionSourceIds!})
    }finally{f.close()}
  }
  save(join(root,'future-revisions.json'),finalized)
  console.log(JSON.stringify({futureRevisions:finalized.length,rows:finalized}))
}else if(mode==='--prepare'){
  if(existsSync(root))throw new Error('fresh output required')
  mkdirSync(root,{recursive:true})
  const files=[0,1,2].flatMap(i=>['archive-','update-'].map(s=>join(templates,s+i+'.json')))
  const frozen=Object.fromEntries(files.map(p=>[p,hash(p)]))
  save(join(root,'protocol.json'),{model:'gemini-3.7-flash',conditions,seeds:3,samples:2,neutral,future,gaps,frozen,
    initialChoiceCount:18,maxInitialCharacterCalls:36,maxRevisionCalls:18,maxLongitudinalTrajectories:3,
    delayInteractions:8,maxFutureCharacterCalls:18,continuationBudget:2,newAutomaticFamilyDiscovery:false,
    controls:['only memories differ within each initial seed','setup reads explicitly scripted; not measured choices',
      'unchanged original inscription capability and exact previous cognition bodies; fresh native source refs',
      'first committed acquisition per condition selected for delay, irrespective of update outcome',
      'future alternatives current/prior/no cognition share actual evidence and nonmemory view',
      'local navigation family fixed; no truth adjudication, no keyword semantic reviewer'],
    limits:['extended lab manifest adds evidence choices and physical destinations; historical DBs unchanged',
      'small known-family archive; no 20/50 bank or automatic grouping',
      'update uses existing canonical first branch citing all original support and counterevidence',
      'new navigation task is later return to same office, not cross-building generalization']})
  for(let seed=0;seed<3;seed++){
    const dir=join(root,'seed-'+seed),f=openActionWorld(dir)
    try{
      await f.submitPlayer('我们来办理登记。','setup-first')
      await setupRead(f,'entity:hall-board');await bringSecondBoard(f)
      await f.submitPlayer('窗口指示牌也搬到大厅了。','setup-second');await setupRead(f,secondBoardId)
      const proof=authorized(f)
      const initial=await python({operation:'initial',...proof,
        templateArchive:load(join(templates,'archive-'+seed+'.json')),
        templateUpdate:load(join(templates,'update-'+seed+'.json'))})
      save(join(dir,'initial.json'),initial);save(join(dir,'authorized.json'),proof);exported(f,dir)
    }finally{f.close()}
  }
  save(join(root,'prepared.json'),{ready:true,newModelCalls:0})
  console.log(JSON.stringify({prepared:true,initialChoiceCount:18}))
}else{
  if(!existsSync(join(root,'prepared.json'))||existsSync(join(root,'trials.json')))throw new Error('prepare once then run once')
  const protocol=load(join(root,'protocol.json')),frozen=obj(protocol.frozen)
  if(Object.entries(frozen).some(([p,h])=>hash(p)!==h))throw new Error('frozen initial bodies changed')
  const trials:WorldJsonObject[]=[],selected=new Map<string,string>()
  save(join(root,'trials.json'),trials)
  for(let seed=0;seed<3;seed++)for(let sample=0;sample<2;sample++){
    const offset=(seed+sample)%3,order=[...conditions.slice(offset),...conditions.slice(0,offset)]
    for(const condition of order){
      const dir=join(root,'seed-'+seed+'-sample-'+sample+'-'+condition);mkdirSync(dir)
      for(const p of ['world.sqlite','memory.sqlite'])copyFileSync(join(root,'seed-'+seed,p),join(dir,p))
      const initial=load(join(root,'seed-'+seed,'initial.json')),f=openActionWorld(dir,true)
      try{
        const stimulus=await f.submitPlayer(neutral,'choice')
        const row=await activate(f,dir,'choice',stimulus,readings(initial,f.store.head(f.address).tick,condition),2,'initial:'+seed)
        row.seed=seed;row.sample=sample;row.condition=condition
        const acquired=[askId,terminalId].includes(String(row.actionKind))
        row.acquired=acquired
        if(acquired){
          if(!selected.has(condition))selected.set(condition,dir)
          const proof=authorized(f),archive=obj(initial.archive)
          try{
            const revision=await python({operation:'revise',initial,...proof,tick:f.store.head(f.address).tick,
              firstFormedTick:Number((archive.observations as WorldJsonObject[])[0]!.knownTickStart),
              lastRevisedTick:Math.max(...(archive.sources as WorldJsonObject[]).map(s=>Number(s.knownTick)))})
            save(join(dir,'revision.json'),revision);row.revisionRelation=obj(revision.record).relation!
            row.revisionAccepted=true
          }catch(error){save(join(dir,'revision-failure.json'),{error:String(error)});row.revisionAccepted=false}
        }
        exported(f,dir);trials.push(row);save(join(root,'trials.json'),trials)
        console.log(JSON.stringify({seed,sample,condition,action:row.actionKind,acquired,revision:row.revisionRelation??null}))
      }finally{f.close()}
    }
  }
  save(join(root,'selected.json'),Object.fromEntries(selected))
  const later:WorldJsonObject[]=[]
  for(const [condition,source] of selected){
    if(!existsSync(join(source,'revision.json'))){later.push({condition,source,skipped:'first acquired path update rejected'});continue}
    const dir=join(root,'later-'+condition);mkdirSync(dir)
    for(const p of ['world.sqlite','memory.sqlite'])copyFileSync(join(source,p),join(dir,p))
    const f=openActionWorld(dir,true),revision=load(join(source,'revision.json'))
    let closed=false
    try{
      for(let i=0;i<gaps.length;i++){
        const stimulus=await f.submitPlayer(gaps[i]!,'gap-'+i)
        const row=await activate(f,dir,'gap-'+i,stimulus,[],1)
        console.log(JSON.stringify({condition,gap:i,status:obj(row.result).status,action:row.actionKind}))
      }
      const proof=authorized(f)
      const unchangedEvidence=JSON.stringify(proof.sources)===JSON.stringify(obj(revision.archive).sources)
      save(join(dir,'gap-end.json'),{head:f.store.head(f.address),unexpectedNewEvidence:!unchangedEvidence})
      if(!unchangedEvidence){later.push({condition,source,skipped:'extra acquisition during gap; frozen revision no longer complete'});continue}
      const stimulus=await f.submitPlayer(future,'future'),before=f.store.head(f.address)
      exported(f,dir)
      const snapshots=join(dir,'future-prefix');mkdirSync(snapshots)
      // Close the shared trajectory before copying its SQLite snapshot.
      f.close();closed=true
      for(const p of ['world.sqlite','memory.sqlite'])copyFileSync(join(dir,p),join(snapshots,p))
      const variants=['current-cognition','prior-cognition','no-cognition']
      for(const variant of variants){
        const target=join(dir,variant);mkdirSync(target)
        for(const p of ['world.sqlite','memory.sqlite'])copyFileSync(join(snapshots,p),join(target,p))
        const cf=openActionWorld(target,true)
        try{
          let request:PrototypeTurnRequest|undefined
          const preview=new PrototypeCharacterTurn({address:cf.address,store:cf.store,memory:cf.memory,
            leases:cf.leases,availability:cf.availability,rulebooks:cf.rules,projectContext:actionContext,
            executionResult:actionResult,recentObservations:4,recentSelfObservations:4,
            decide:async r=>{request={...r,canRecall:false};return {decision:'abstain'}}})
          await preview.run(npc,{stimulus,maxCalls:1})
          if(!request)throw new Error('no future request')
          save(join(target,'retrieval-request.json'),request)
          const recalled=await python({operation:'recall',variant,revision,request:request as unknown as WorldJsonObject,
            tick:before.tick,scope:{characterId:npc,worldAddress:{...cf.address},asOfWorldSeq:before.headSeq}})
          save(join(target,'retrieval.json'),recalled)
          const row=await activate(cf,target,'future',stimulus,obj(recalled.delivery).memories as WorldJsonObject[],2,'future:'+condition)
          row.condition=condition;row.variant=variant;row.targetDeliveredIds=recalled.targetDeliveredIds!
          later.push(row);exported(cf,target);save(join(root,'later-trials.json'),later)
          console.log(JSON.stringify({condition,variant,action:row.actionKind,delivered:recalled.targetDeliveredIds}))
        }finally{cf.close()}
      }
    }finally{if(!closed)f.close()}
  }
  if(Object.entries(frozen).some(([p,h])=>hash(p)!==h))throw new Error('frozen body archives changed')
  save(join(root,'summary.json'),{completed:true,initialChoices:trials.length,newCharacterCalls:totalCalls,
    acquisitions:trials.filter(t=>t.acquired).length,revisionsAccepted:trials.filter(t=>t.revisionAccepted).length,
    selected:Object.fromEntries(selected),laterTrials:later,originalUnchanged:true,nonmemoryComparisonsPassed:true})
}
