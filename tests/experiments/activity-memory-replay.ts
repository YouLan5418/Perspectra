import { hindsightPython } from './hindsight-python.ts'
/** Real Character Turns on fresh branches of the frozen game; no source regeneration. */
import { randomUUID, createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { brandId, type WorldAddress, type WorldJsonObject, RECALL_KEYWORD_TOKENIZER_ID } from '@harness-world/contracts'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { createChatProvider } from '@harness-world/provider-chat'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

if(!process.argv[2])throw new Error('provide prepared replay directory')
const root=resolve(process.argv[2])
const load=<T>(name:string):T=>JSON.parse(readFileSync(join(root,name),'utf8')) as T
const audit=load<{originalDirectory:string;frozenWorldHash:string}>('audit.json'),oldBase=join(audit.originalDirectory,'base')
const address=load<WorldAddress>('address.json'),summary=load<{head:{headSeq:number;tick:number}}>('source-summary.json')
const jobs=load<{actor:string;mode:string;repeat:number}[]>('jobs.json')
const python=hindsightPython()
const provider=createChatProvider({endpoint:new URL(process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'),
 model:'gemini-3.7-flash',timeoutMs:45000,...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{})})
function py(input:unknown){
 const run=spawnSync(python,[resolve('experiments/activity-memory/core_bridge.py')],{input:JSON.stringify(input),encoding:'utf8',timeout:120000,
  maxBuffer:96*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}})
 if(run.status!==0||run.error)throw new Error('core failed: '+(run.error?.message??run.stderr.slice(-1200)))
 return JSON.parse(run.stdout) as {delivery:WorldJsonObject[];deliveryTrace:unknown}
}
const outcomes:unknown[]=[]
for(const job of jobs){
 const id=job.actor+'-'+job.mode+'-'+job.repeat,dir=join(root,'probes',id)
 if(existsSync(join(dir,'result.json'))){outcomes.push(load('probes/'+id+'/result.json'));continue}
 if(existsSync(dir))throw new Error('incomplete replay branch exists: '+id)
 mkdirSync(dir,{recursive:true});cpSync(join(oldBase,'world.sqlite'),join(dir,'world.sqlite'));cpSync(join(oldBase,'memory.sqlite'),join(dir,'memory.sqlite'))
 const store=new WorldStore(join(dir,'world.sqlite')),leases=new WriterLeaseService(join(dir,'world.sqlite')),availability=new CharacterRuntimeAvailabilityService(join(dir,'world.sqlite'))
 const memory=new CognitiveMemoryService(join(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
 const frozen=load<{request:PrototypeTurnRequest;probe:string}>(job.actor+'-frozen-request.json')
 let count=0
 try{
  const turn=new PrototypeCharacterTurn({address,store,leases,availability,memory,
   rulebooks:createCoreRulebookRegistry({interactionPackages:[createBasicInteractionPackage()]}),
   projectContext:context=>({...context,observations:[],selfObservations:[],memories:[]}),
   decide:async(request,signal)=>{
    const recall=request.recallEvidence?.query
    const projected={...request,context:{...frozen.request.context,memories:[]}}
    const initial=load<{memories:WorldJsonObject[];trace:unknown}>(job.actor+'-'+job.mode+'-delivery.json')
    const selected=typeof recall==='string'?py({operation:'recall',archive:load(job.actor+'-archive.json'),index:load(job.actor+'-index.json'),
     request:projected,tick:summary.head.tick,observations:false,deliveryMode:job.mode}):{delivery:initial.memories,deliveryTrace:initial.trace}
    const visible:PrototypeTurnRequest={...projected,context:{...projected.context,memories:selected.delivery},
     ...(typeof recall==='string'?{recallEvidence:{query:recall,memories:selected.delivery}}:{})}
    const path=join(dir,'call-'+(++count)+'.json')
    const record:{[key:string]:unknown}={id,mode:job.mode,actor:job.actor,repeat:job.repeat,model:'gemini-3.7-flash',sourceCutoff:summary.head.headSeq,
     request:visible,deliveryTrace:selected.deliveryTrace,status:'pending'}
    writeFileSync(path,JSON.stringify(record,null,2))
    const response=await provider.decide(localPrototypeTurnCall(visible),signal)
    record.response=response;record.status='returned';writeFileSync(path,JSON.stringify(record,null,2));return response
   }})
  const result=await turn.run(brandId('character:'+job.actor,'CharacterId'),{stimulus:frozen.request.context.stimulus as WorldJsonObject[],
   maxCalls:1,signal:AbortSignal.timeout(90000)})
  const output={id,result,actualCalls:count,originalWorldUnchanged:createHash('sha256').update(readFileSync(join(oldBase,'world.sqlite'))).digest('hex')===audit.frozenWorldHash}
  if(!output.originalWorldUnchanged)throw new Error('original world changed')
  writeFileSync(join(dir,'result.json'),JSON.stringify(output,null,2));outcomes.push(output)
  console.log(JSON.stringify(output))
 }finally{memory.close();availability.close();leases.close();store.close()}
}
writeFileSync(join(root,'model-results.json'),JSON.stringify(outcomes,null,2))
console.log(JSON.stringify({completed:outcomes.length,runId:randomUUID()}))
