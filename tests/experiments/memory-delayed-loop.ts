/** Known-family update, eight real unrelated exchanges, then natural current/prior/no recall. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WorldJsonObject } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openActionWorld, actionContext, actionResult, askId, terminalId } from './notice-board-action-fixture.ts'
import { npc } from './notice-board-fixture.ts'
import { privateText } from './notice-board-capability.ts'
import { rawHistorySnapshot, historyBytes } from './raw-history-delivery.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'
import { hindsightPython } from './hindsight-python.ts'
const object = (v: unknown): WorldJsonObject => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as WorldJsonObject : {}
const root = resolve(process.argv[2] ?? ''), mode = process.argv[3] ?? '--prepare'
if (!process.argv[2] || !['--prepare','--finalize'].includes(mode)) throw new Error('fresh root --prepare; shared runner --run; --finalize')
const previous = resolve('.tmp/memory-immediate-delivery-20261005-v2')
const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as WorldJsonObject
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v,null,2))
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const clone = (from: string,to: string) => { mkdirSync(to,{recursive:true}); for (const p of ['world.sqlite','memory.sqlite']) copyFileSync(join(from,p),join(to,p)) }
const paths = ['current-cognition','prior-cognition','no-cognition']
const gaps = ['我把外套换成了浅灰色，这个颜色看起来怎么样？', '我最近在家种了一盆薄荷，叶子长得挺快。',
  '昨晚看了一部慢节奏的电影，我挺喜欢它的配乐。', '我打算周末试着烤面包，先做最普通的那种。',
  '我发现自己的笔写起来比之前顺手了。', '你平时喜欢安静一点的音乐吗？',
  '刚想起家里的窗帘该洗了，回去再处理。', '忙完之后想做顿简单的晚饭，你喜欢什么口味？']
const future = '今天又来这栋办事楼，想给另一份材料办理登记。接下来怎么办？'
type F = ReturnType<typeof openActionWorld>
/** Keep full authorized history for recall, only actual capability observations for known-family revision. */
function evidence(f:F) {
  const snapshot = rawHistorySnapshot(f), es = f.store.readEvents(f.address)
  const sources = snapshot.sources.filter(s => [askId,terminalId,'experiment:inspect-notice-board'].includes(String(object(s.content).capabilityId))).map(s => {
    const e = es.find(e => e.seq===s.worldSeq)!, value = object(object(e.data).value), c = object(s.content)
    const resolved = es.find(e => e.eventType==='action.resolved' && object(e.data).actionId===value.actionId)
    if (!resolved || object(resolved.data).accepted!==true || object(resolved.data).actorId!==npc
      || resolved.transactionId!==e.transactionId || c.sourceActionId!==value.actionId) throw new Error('revision evidence is not atomically accepted')
    return Object.fromEntries(Object.entries(s).filter(([k]) => k!=='content')) as WorldJsonObject
  })
  return { scope:snapshot.scope, sources }
}
async function python(doc: WorldJsonObject, tag: string): Promise<WorldJsonObject> {
  return new Promise((yes,no) => {
    const child=execFile(hindsightPython(),[resolve('experiments/activity-memory/delayed_loop.py')],{
      timeout:180000,maxBuffer:128*1024*1024,encoding:'utf8',windowsHide:true,
      env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0',HCW_HINDSIGHT_UTILITY_TRACE:join(root,tag+'-utility.jsonl')},
    },(error,out,err) => { if(error) no(new Error('known-family operation failed: '+err.slice(-1400))); else { try { yes(JSON.parse(out)) } catch(cause) { no(cause) } } })
    child.stdin!.on('error',()=>{});child.stdin!.end(JSON.stringify(doc))
  })
}
function revisionInput(f:F,initial:WorldJsonObject,firstFormedTick:number,lastRevisedTick:number):WorldJsonObject {
  return {operation:'revise',initial,...evidence(f),tick:f.store.head(f.address).tick,firstFormedTick,lastRevisedTick}
}
if (mode==='--finalize') {
  if (!load(join(root,'summary.json')).completed || existsSync(join(root,'closure.json'))) throw new Error('finalize once after completed run')
  const trials=load(join(root,'trials.json')) as unknown as WorldJsonObject[], closure:WorldJsonObject[]=[]
  for(const path of paths) {
    const row=trials.find(r => r.path===path && r.acquiredEvidence===true)
    if(!row) {closure.push({path,status:'no actual acquisition'});continue}
    const dir=join(root,String(row.seed),'sample-'+row.sample+'-'+path), f=openActionWorld(dir,true)
    try {
      const initial=load(join(root,String(row.seed),'revision.json')), record=object(initial.record),
        input=revisionInput(f,initial,Number(record.firstFormedTick),Number(record.lastRevisedTick))
      // Existing revision expects an initial-style record with its current family.
      save(join(dir,'closure-input.json'),input)
      try {const revision=await python(input,String(row.seed)+'-'+path+'-closure');save(join(dir,'closure-revision.json'),revision)
        closure.push({path,seed:row.seed!,sample:row.sample!,status:'accepted',newSourceIds:object(revision.record).revisionSourceIds!,relation:object(revision.record).relation!})
      } catch(error) {save(join(dir,'closure-failure.json'),{error:String(error)});closure.push({path,seed:row.seed!,sample:row.sample!,status:'update rejected',error:String(error)})}
    } finally {f.close()}
  }
  save(join(root,'closure.json'),closure);console.log(JSON.stringify({closure}))
} else {
  if(existsSync(root)) throw new Error('fresh output required')
  const oldTrials=load(join(previous,'trials.json')) as unknown as WorldJsonObject[]
  const selected=[0,1,2].map(i => {
    const row=oldTrials.find(r => r.seed==='immediate-'+i && r.acquiredEvidence===true)
    if(!row)throw new Error('no actual acquisition for seed '+i)
    return {seed:'delayed-'+i,previousSeed:String(row.seed),path:String(row.path),sample:Number(row.sample),
      source:join(previous,String(row.seed),'sample-'+row.sample+'-'+row.path)}
  })
  const frozen=Object.fromEntries([join(previous,'protocol.json'),join(previous,'trials.json'),...selected.flatMap(s =>
    [join(previous,s.previousSeed,'preparation-input.json'),...['world.sqlite','memory.sqlite','result.json','events.json','sources.json','call-0.json'].map(p => join(s.source,p))])].map(p => [p,hash(p)]))
  mkdirSync(root,{recursive:true});save(join(root,'selected.json'),selected)
  save(join(root,'protocol.json'),{phase:'6.4',contrast:'delayed',model:'gemini-3.7-flash',paths,seeds:selected.map(s=>s.seed),samples:2,
    samplesBySeed:Object.fromEntries(selected.map(s=>[s.seed,2])),frozen,previousRoot:previous,gaps,future,
    maxCharacterCallsPerActivation:2,maxDeliveryItems:3,maxDeliveryJsonChars:4500,
    selection:'first actual committed acquisition per 6.3 seed in recorded trial order; fixed before update',
    controls:['three real committed staff Sources update the existing known family, no automatic family discovery',
      'eight unrelated real player/Character exchanges per trajectory, same full authorized history in three future arms',
      'current/prior/no cognition use original retrieval plus explicit ID admission, no forced target or injected answer',
      'minimal Delivery, no JEV, no implicit native memory, no active recall, no selective Character retries',
      'initial nonmemory requests identical per seed; actual native action, commit and acquisition measured',
      'first actual future acquisition per arm selected for one further known-family update before reviewing update outcome'],
    limits:['canonical first branch update keeps all previous evidence; general multi-branch merge not tested',
      'known family and three trajectories, not production memory or broad capacity acceptance',
      'offline revision/recall preparation reported separately from Character activation']})
  let transport:string|undefined,gapCalls=0
  const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
    model:'gemini-3.7-flash',timeoutMs:90000,maxOutputTokens:1600,
    ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{}),
    fetch:async(input,init)=>{const response=await fetch(input,init);if(transport)save(transport,{status:response.status,body:await response.clone().text()});return response}})
  const activeSeeds:string[]=[], preparation:WorldJsonObject[]=[]
  for(const chosen of selected) {
    const folder=join(root,chosen.seed),dir=join(folder,'trajectory');clone(chosen.source,dir)
    const f=openActionWorld(dir,true);f.memory.prepareStimulus=()=>{throw new Error('implicit retrieval forbidden')}
    let closed=false
    try {
      const initial=object(load(join(previous,chosen.previousSeed,'preparation-input.json')).initial),
        originalSources=object(initial.archive).sources as WorldJsonObject[],
        input=revisionInput(f,initial,Math.min(...originalSources.map(s=>Number(s.knownTick))),Math.max(...originalSources.map(s=>Number(s.knownTick))))
      save(join(folder,'revision-input.json'),input)
      let revision:WorldJsonObject
      try {const start=performance.now();revision=await python(input,chosen.seed+'-initial');save(join(folder,'revision.json'),revision)
        save(join(folder,'revision-timing.json'),{durationMs:Math.round(performance.now()-start)})}
      catch(error) {save(join(folder,'revision-failure.json'),{error:String(error)});preparation.push({seed:chosen.seed,status:'update rejected'});continue}
      console.log(JSON.stringify({seed:chosen.seed,revision:object(revision.record).relation,newSources:object(revision.record).revisionSourceIds}))
      const beforeEvidence=JSON.stringify(evidence(f).sources), gapRows:WorldJsonObject[]=[]
      for(const [i,text] of gaps.entries()) {
        const stimulus=await f.submitPlayer(text,'delayed-gap-'+i),before=f.store.head(f.address)
        const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,leases:f.leases,availability:f.availability,rulebooks:f.rules,
          projectContext:context=>actionContext({character:context.character!,stimulus:context.stimulus!,memories:[],...context}),
          executionResult:actionResult,recentObservations:4,recentSelfObservations:4,
          validateDecision:d=>{if(d.decision==='recall')throw new Error('active recall forbidden')},
          decide:async(r,signal)=>{const visible:PrototypeTurnRequest={...r,canRecall:false,context:{...r.context,memories:[]}},call=localPrototypeTurnCall(visible)
            if(JSON.stringify(visible).includes(privateText))throw new Error('private context leaked')
            transport=join(dir,'gap-'+i+'-transport.json');gapCalls++;const file=join(dir,'gap-'+i+'-call.json'),start=performance.now()
            save(file,{status:'pending',request:visible,prepared:call,requestBytes:historyBytes(call),head:f.store.head(f.address)})
            const response=await provider.decide(call,signal)
            save(file,{status:'returned',request:visible,response,durationMs:Math.round(performance.now()-start),head:f.store.head(f.address)});return response}})
        const started=performance.now(),result=await turn.run(npc,{stimulus,maxCalls:1,signal:AbortSignal.timeout(115000)})
        const row:WorldJsonObject={index:i,before:before as unknown as WorldJsonObject,result:result as unknown as WorldJsonObject,durationMs:Math.round(performance.now()-started)}
        gapRows.push(row);save(join(folder,'gaps.json'),gapRows)
        console.log(JSON.stringify({seed:chosen.seed,gap:i,status:result.status}))
        if(result.failure==='provider_failed'||result.status==='interrupted')throw new Error('provider failure; no selective retry')
      }
      save(join(dir,'events.json'),f.store.readEvents(f.address));save(join(dir,'sources.json'),rawHistorySnapshot(f))
      if(JSON.stringify(evidence(f).sources)!==beforeEvidence) {preparation.push({seed:chosen.seed,status:'new acquisition during gap; frozen revision incomplete'});continue}
      const stimulus=await f.submitPlayer(future,'delayed-future'),before=f.store.head(f.address)
      let request:PrototypeTurnRequest|undefined
      const preview=new PrototypeCharacterTurn({address:f.address,store:f.store,leases:f.leases,availability:f.availability,rulebooks:f.rules,
        projectContext:context=>actionContext({character:context.character!,stimulus:context.stimulus!,memories:[],...context}),
        executionResult:actionResult,recentObservations:4,recentSelfObservations:4,decide:async r=>{request={...r,canRecall:false};return{decision:'abstain'}}})
      await preview.run(npc,{stimulus,maxCalls:1})
      if(!request||JSON.stringify(before)!==JSON.stringify(f.store.head(f.address)))throw new Error('preview changed prefix')
      const snapshot=rawHistorySnapshot(f);save(join(folder,'request.json'),request);save(join(folder,'snapshot.json'),snapshot)
      f.close();closed=true;clone(dir,join(folder,'prefix'))
      for(const variant of paths) {
        const doc:WorldJsonObject={operation:'recall',variant,revision,request:request as unknown as WorldJsonObject,
          tick:before.tick,scope:snapshot.scope,authorizedHistory:snapshot.sources}
        save(join(folder,variant+'-input.json'),doc)
        const start=performance.now(),recalled=await python(doc,chosen.seed+'-'+variant)
        save(join(folder,variant+'.json'),recalled);save(join(folder,variant+'-timing.json'),{durationMs:Math.round(performance.now()-start),reusedForSamples:2})
        console.log(JSON.stringify({seed:chosen.seed,variant,candidates:object(recalled.retrieval).results instanceof Array?(object(recalled.retrieval).results as unknown[]).length:0,delivered:recalled.targetDeliveredIds}))
      }
      activeSeeds.push(chosen.seed);preparation.push({seed:chosen.seed,status:'ready',revision:object(revision.record).relation!})
    } finally {if(!closed)f.close()}
  }
  const protocol=load(join(root,'protocol.json'));save(join(root,'protocol.json'),{...protocol,seeds:activeSeeds})
  if(Object.entries(frozen).some(([p,h])=>hash(p)!==h))throw new Error('old frozen data changed')
  save(join(root,'preparation-summary.json'),{completed:true,gapCharacterCalls:gapCalls,preparation,readySeeds:activeSeeds})
  if(!activeSeeds.length)throw new Error('no valid delayed trajectory; see preparation failures')
  save(join(root,'prepared.json'),{ready:true,gapCharacterCalls:gapCalls,seeds:activeSeeds})
  console.log(JSON.stringify({prepared:true,root,seeds:activeSeeds,gapCalls,futureChoices:activeSeeds.length*6}))
}
