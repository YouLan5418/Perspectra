import { hindsightPython } from './hindsight-python.ts'
/** One cold question on three copies of a completed run, separate from natural play. */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { brandId, RECALL_KEYWORD_TOKENIZER_ID, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn } from '../../packages/application/src/prototype-character-turn.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

if(!process.argv[2]||!process.argv[3])throw new Error('provide completed live directory and fresh probe directory')
const original=resolve(process.argv[2]),root=resolve(process.argv[3]),base=join(original,'base')
const load=<T>(path:string):T=>JSON.parse(readFileSync(path,'utf8')) as T
const completion=load<{completed:boolean;headSeq:number}>(join(original,'completion.json'))
if(!completion.completed||existsSync(root))throw new Error('requires completed run and fresh probe directory')
mkdirSync(root,{recursive:true})
const hash=()=>createHash('sha256').update(readFileSync(join(base,'world.sqlite'))).digest('hex')
const frozenHash=hash(),address=load<WorldAddress>(join(original,'address.json'))
const checkpoints=readFileSync(join(original,'checkpoints.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s) as {checkpoint:number})
const checkpoint=checkpoints.at(-1)!.checkpoint,actor=brandId('character:claude','CharacterId')
const archive=load<{scope:{asOfWorldSeq:number};sources:{worldSeq:number;knownTick:number}[]}>(join(original,'checkpoint-'+checkpoint,'claude-archive.json'))
if(archive.scope.asOfWorldSeq!==completion.headSeq)throw new Error('final archive is incomplete')
const db=new DatabaseSync(join(base,'world.sqlite'),{readOnly:true})
const head=db.prepare('SELECT MAX(seq) AS headSeq,MAX(tick) AS tick FROM events').get() as {headSeq:number;tick:number};db.close()
if(head.headSeq!==completion.headSeq)throw new Error('completed prefix changed')
const python=hindsightPython()
const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
 model:'gemini-3.7-flash',timeoutMs:50000,...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{})})
const question='我们之前在卧室玩过的那局猜数字，最后是怎么结束的？',outcomes:unknown[]=[]
writeFileSync(join(root,'protocol.json'),JSON.stringify({original,checkpoint,head,actor,question,syntheticQuestion:true,
 recentContextRemoved:true,privateActivityStateOmitted:true,frozenHash,model:'gemini-3.7-flash',
 limitation:'one question, one initial sample per condition; no causal efficacy claim'},null,2))
for(const mode of ['native','core-plain','core-expanded']){
 const dir=join(root,mode);mkdirSync(dir)
 cpSync(join(base,'world.sqlite'),join(dir,'world.sqlite'));cpSync(join(base,'memory.sqlite'),join(dir,'memory.sqlite'))
 const store=new WorldStore(join(dir,'world.sqlite')),leases=new WriterLeaseService(join(dir,'world.sqlite')),availability=new CharacterRuntimeAvailabilityService(join(dir,'world.sqlite'))
 const memory=new CognitiveMemoryService(join(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
 let count=0
 try {
  const stimulus=[{observerId:actor,content:{actorId:'character:player',actionType:'speak',status:'accepted',speech:{characterId:'character:player',text:question}}}]
  const turn=new PrototypeCharacterTurn({address,store,leases,availability,memory,
   rulebooks:createCoreRulebookRegistry({interactionPackages:[createBasicInteractionPackage()]}),
   projectContext:context=>({...context,observations:[],selfObservations:[],memories:[]}),
   decide:async(request,signal)=>{
    const query=typeof request.recallEvidence?.query==='string'?request.recallEvidence.query:question
    let memories:WorldJsonObject[],retrieval:unknown=null
    if(mode==='native'){
     const ticks=new Map(archive.sources.map(s=>[s.worldSeq,s.knownTick]))
     memories=memory.recall(address,actor,query,head.headSeq).slice(0,3).map(m=>{
      const tick=ticks.get(m.sourceMaxSeq);if(tick===undefined)throw new Error('native source not in authorized prefix')
      return {...m,sourceAgeTicks:head.tick-tick} as unknown as WorldJsonObject
     })
    }else{
     const input={operation:'recall',archive,index:load(join(original,'checkpoint-'+checkpoint,'claude-index.json')),
      request,tick:head.tick,observations:true,deliveryMode:mode==='core-plain'?'old':'expanded'}
     const run=spawnSync(python,[resolve('experiments/activity-memory/core_bridge.py')],{input:JSON.stringify(input),encoding:'utf8',timeout:120000,
      maxBuffer:128*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0'}})
     if(run.status!==0||run.error)throw new Error('core probe failed: '+(run.error?.message??run.stderr.slice(-1500)))
     const data=JSON.parse(run.stdout) as {delivery:WorldJsonObject[]};memories=data.delivery;retrieval=data
    }
    const visible={...request,context:{...request.context,memories},...(request.recallEvidence?{recallEvidence:{query,memories}}:{})}
    const path=join(dir,'call-'+(++count)+'.json'),record:{[key:string]:unknown}={mode,syntheticQuestion:true,request:visible,retrieval,status:'pending'}
    writeFileSync(path,JSON.stringify(record,null,2))
    const response=await provider.decide(localPrototypeTurnCall(visible),signal)
    record.response=response;record.status='returned';writeFileSync(path,JSON.stringify(record,null,2));return response
   }})
  const result=await turn.run(actor,{stimulus,maxCalls:1,signal:AbortSignal.timeout(90000)})
  const row={mode,result,actualCalls:count,originalWorldUnchanged:hash()===frozenHash}
  if(!row.originalWorldUnchanged)throw new Error('original world changed')
  writeFileSync(join(dir,'result.json'),JSON.stringify(row,null,2));outcomes.push(row);console.log(JSON.stringify(row))
 }finally{memory.close();availability.close();leases.close();store.close()}
}
writeFileSync(join(root,'results.json'),JSON.stringify(outcomes,null,2))
