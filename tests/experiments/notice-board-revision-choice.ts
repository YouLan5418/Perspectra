/** Post-read update delivery comparison. No retrieval/JEV or production memory changes. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type WorldJsonObject } from '@harness-world/contracts'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { openCapabilityWorld, npc } from './notice-board-fixture.ts'
import { noticeBoardContext, noticeBoardResult, privateText } from './notice-board-capability.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const root=resolve(process.argv[2]??''),revision=resolve(process.argv[3]??'')
if(!process.argv[2]||!process.argv[3]||existsSync(root))throw new Error('fresh output directory + completed revision directory')
const load=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as WorldJsonObject
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2))
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
const protocol=load(join(revision,'protocol.json')),input=String(protocol.inputRoot)
const archive=load(join(revision,'authorized-archive.json'))
const sourceDir=join(input,'repeat-0'),conditions=['old-local','updated-local','raw-evidence']
const probes=[
  {id:'plan',text:'登记处接下来怎么找？我还按去年介绍去隔壁小屋吗？'},
  {id:'certainty',text:'所以我们已经证实去年资料过期、我这次带错地方了，对吧？'},
]
const files=[join(revision,'authorized-archive.json'),join(revision,'protocol.json'),
  ...[0,1].map(r=>join(revision,'local-'+r+'.json')),
  ...['world.sqlite','memory.sqlite'].map(f=>join(sourceDir,f))]
const frozen=Object.fromEntries(files.map(p=>[p,hash(p)]))
const unchanged=()=>Object.entries(frozen).every(([p,h])=>hash(p)===h)
mkdirSync(root,{recursive:true})
save(join(root,'protocol.json'),{revisionRoot:revision,inputRoot:input,model:'gemini-3.7-flash',repeats:2,probes,
  conditions,maximumActivations:12,maximumCalls:24,frozen,newJevCalls:0,newUpdateCalls:0,
  limits:['explicit delivery interventions; not natural retrieval or ordinary long play',
    'recent raw observation/self channels omitted initially; actual inspect continuation retained',
    'certainty question is a leading synthetic stress probe, not normal player dialogue',
    'same prior committed read in every cloned world; old-local reading is omission, not never-observed control',
    'updated recognition carries board attribution, not an omniscient verdict'],
  design:['all probes committed by native player path','initial nonmemory context identical within each probe',
    'all three variants can independently request an actual inspect','no retries for invalid decisions']})
const old=(archive.observations as WorldJsonObject[]).find(o=>o.id==='capability:local:v1')!
const atoms=(archive.facts as WorldJsonObject[]).filter(a=>['event:20','event:23'].includes(
  String((a.sourceRefs as WorldJsonObject[])[0]!.sourceId)))
if(atoms.length!==2)throw new Error('canonical raw evidence missing')
function reading(unit:WorldJsonObject,formed:number,revised:number) {
  return {memoryId:unit.id!,memoryLevel:unit.memoryLevel!,text:unit.text!,
    epistemicKind:unit.epistemicKind??(unit.sourceRefs as WorldJsonObject[])[0]!.epistemicKind!,
    sourceIds:(unit.sourceRefs as WorldJsonObject[]).map(s=>s.sourceId!),sourceRefs:unit.sourceRefs!,
    sourceAgeTicks:6-Number(unit.knownTickEnd),firstFormedTick:formed,lastRevisedTick:revised}
}
const canonical=new Map<string,string>(),summaries:WorldJsonObject[]=[]
for(let repeat=0;repeat<2;repeat++)for(const probe of probes){
  const update=load(join(revision,'local-'+repeat+'.json'))
  if(update.status!=='accepted')throw new Error('selected update rejected; stop')
  const record=update.record as WorldJsonObject,current=(record.current as WorldJsonObject[])[0]!
  const variants:Record<string,WorldJsonObject[]>={'old-local':[reading(old,1,1)],
    'updated-local':[reading(current,Number(record.firstFormedTick),Number(record.lastRevisedTick))],
    'raw-evidence':atoms.map(a=>reading(a,Number(a.knownTickEnd),Number(a.knownTickEnd)))}
  const ordered=repeat===0?conditions:[...conditions].reverse()
  for(const condition of ordered){
    if(!unchanged())throw new Error('frozen input changed')
    const dir=join(root,probe.id+'-'+repeat+'-'+condition);mkdirSync(dir)
    for(const f of ['world.sqlite','memory.sqlite'])copyFileSync(join(sourceDir,f),join(dir,f))
    const f=openCapabilityWorld(dir,undefined,true)
    let calls=0,transportPath:string|undefined
    const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
      model:'gemini-3.7-flash',timeoutMs:90000,maxOutputTokens:1600,
      ...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{}),
      fetch:async(input,init)=>{const response=await fetch(input,init)
        if(transportPath)save(transportPath,{status:response.status,body:await response.clone().text()})
        return response}})
    try{
      const initialSeq=f.store.head(f.address).headSeq
      const stimulus=await f.submitPlayer(probe.text,'revision-probe:'+probe.id)
      const before=f.store.head(f.address).headSeq
      const turn=new PrototypeCharacterTurn({address:f.address,store:f.store,memory:f.memory,leases:f.leases,
        availability:f.availability,rulebooks:f.rules,executionResult:noticeBoardResult,
        projectContext:context=>({...noticeBoardContext(context),observations:[],selfObservations:[],memories:[]}),
        decide:async(request,signal)=>{
          const visible:PrototypeTurnRequest={...request,canRecall:false,context:{...request.context,memories:variants[condition]!}}
          if(JSON.stringify(visible).includes(privateText))throw new Error('private context leaked')
          if(!request.continuation){
            const plain=JSON.stringify({...visible,context:{...visible.context,memories:[]}})
            if(canonical.has(probe.id)&&canonical.get(probe.id)!==plain)throw new Error('nonmemory context changed')
            canonical.set(probe.id,plain)
          }
          const index=calls++,path=join(dir,'call-'+index+'.json')
          transportPath=join(dir,'transport-'+index+'.json')
          save(path,{repeat,probe:probe.id,condition,index,request:visible,status:'pending',head:f.store.head(f.address)})
          const start=performance.now(),response=await provider.decide(localPrototypeTurnCall(visible),signal)
          save(path,{repeat,probe:probe.id,condition,index,request:visible,response,status:'returned',
            durationMs:Math.round(performance.now()-start),head:f.store.head(f.address)})
          return response
        }})
      const result=await turn.run(npc,{stimulus,maxCalls:2,signal:AbortSignal.timeout(160000)})
      f.sources()
      const events=f.store.readEvents(f.address)
      const row:WorldJsonObject={repeat,probe:probe.id,condition,calls,initialSeq,probeSeq:before,
        result:result as unknown as WorldJsonObject,head:f.store.head(f.address) as unknown as WorldJsonObject}
      save(join(dir,'result.json'),row);save(join(dir,'events.json'),events)
      summaries.push(row);save(join(root,'trials.json'),summaries)
      console.log(JSON.stringify({repeat,probe:probe.id,condition,calls,status:result.status,perform:result.performResult?.status??null}))
      if(result.failure==='provider_failed')throw new Error('provider failed; stop experiment')
    }finally{f.close()}
  }
}
if(!unchanged())throw new Error('original changed')
save(join(root,'summary.json'),{trials:summaries.length,calls:summaries.reduce((n,r)=>n+Number(r.calls),0),
  newJevCalls:0,newUpdateCalls:0,originalUnchanged:true,initialNonmemoryIdentical:true})
