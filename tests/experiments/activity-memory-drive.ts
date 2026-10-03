import { hindsightPython } from './hindsight-python.ts'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { brandId, worldAddressKey, RECALL_KEYWORD_TOKENIZER_ID, type WorldJsonObject, type WorldAddress } from '@harness-world/contracts'
import { WorldStore, WriterLeaseService, CharacterRuntimeAvailabilityService } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import { createChatProvider } from '@harness-world/provider-chat'
import { createCoreRulebookRegistry } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { PrototypeCharacterTurn, type PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import { localPrototypeTurnCall } from './local-prototype-turn-call.ts'

const rootArg=process.argv[2],stage=process.argv[3]??'game'
if(!rootArg||!['game','sources','build','probe'].includes(stage))throw new Error('provide output directory and game/sources/build/probe stage')
const root=resolve(rootArg),base=join(root,'base'),pack=resolve('examples/world-packs/ai-girls-hosted-guess')
const model='gemini-3.7-flash',endpoint=process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'
const python=hindsightPython()
const actors=['character:gpt','character:claude','character:deepseek']
function save(name:string,value:unknown){writeFileSync(join(root,name),JSON.stringify(value,null,2))}
function append(name:string,value:unknown){writeFileSync(join(root,name),JSON.stringify(value)+'\n',{flag:'a'})}
function load<T>(name:string):T{return JSON.parse(readFileSync(join(root,name),'utf8')) as T}
function object(v:unknown):WorldJsonObject { if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('expected object');return v as WorldJsonObject }
function py(input:unknown):Record<string,unknown>{
 const run=spawnSync(python,[resolve('experiments/activity-memory/core_bridge.py')],{input:JSON.stringify(input),encoding:'utf8',timeout:240000,maxBuffer:96*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0'}})
 if(run.status!==0||run.error)throw new Error('memory core failed: '+(run.error?.message??run.stderr.slice(-2500)))
 return JSON.parse(run.stdout) as Record<string,unknown>
}
if(stage==='game'){
 if(existsSync(root))throw new Error('game needs fresh output directory')
 mkdirSync(root,{recursive:true})
 save('protocol.json',{model,pack,experiment:'one real hosted game, then cold controlled Character Turns',memory:'authorized CognitiveMemoryService sources only',coreDirectory:resolve('experiments/hindsight-core'),limits:'No Hindsight-derived world commits; private answer is not copied into memory. Cold probes are controlled, not elapsed natural play.'})
 let call=0
 const proxy=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{void(async()=>{try{
  const input=JSON.parse(JSON.parse(body).messages.at(-1).content),id=++call
  save('game-call-'+id+'.json',{request:input,status:'pending'})
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...(process.env.HCW_LOCAL_API_KEY?{authorization:'Bearer '+process.env.HCW_LOCAL_API_KEY}:{})},body,signal:AbortSignal.timeout(45000)})
  const text=await response.text(),wire=JSON.parse(text),args=wire.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments
  save('game-call-'+id+'.json',{request:input,httpStatus:response.status,response:args?JSON.parse(args):wire.choices?.[0]?.message?.content})
  console.log(JSON.stringify({stage:'game-call',id,actor:input.context.character.characterId,phase:input.context.activity?.game.phase,status:response.status}))
  res.writeHead(response.status,{'content-type':'application/json'});res.end(text)
 }catch(error){append('errors.jsonl',{stage:'game-call',error:error instanceof Error?error.message:'unknown'});res.writeHead(502);res.end('{}')}})()})})
 await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));const port=proxy.address();if(!port||typeof port==='string')throw new Error('no proxy')
 const runtime=await FrozenWorldPlaytestRuntime.create({packPath:pack,dataDirectory:base,provider:'local',model,utilityEndpoint:'http://127.0.0.1:'+port.port,timeoutMs:50000})
 try{
  const command=async(operation:string,parameters:WorldJsonObject={})=>{const before=await runtime.state(),after=await runtime.activityAction({activityId:operation==='start'?null:String(before.activity!.id),revision:operation==='start'?0:Number(before.activity!.revision),operation,parameters,requestId:randomUUID()});save('game-state.json',after);append('game-steps.jsonl',{operation,parameters,headSeq:after.debug.headSeq,game:after.activity?.game,notice:after.notice,error:after.error});return after}
  let state=await command('start');let low=1,high=100
  const seen=new Set<string>()
  let said=false,retries=0
  for(let round=0;round<12;round++){
   const game=object(state.activity!.game),pub=object(game.public)
   if(!game.active)break
   for(const row of (pub.history??[]) as WorldJsonObject[]){const key=JSON.stringify(row);if(seen.has(key))continue;seen.add(key);if(row.verdict==='偏大')high=Math.min(high,Number(row.value)-1);if(row.verdict==='偏小')low=Math.max(low,Number(row.value)+1)}
   if(game.turn!=='character:player'){if(++retries>3)break;state=await command('retry');continue}
   if(!said){state=await runtime.submit('我先口头猜 1，不过先不提交，等我想一想。');said=true;append('game-steps.jsonl',{speech:'我先口头猜 1，不过先不提交，等我想一想。',headSeq:state.debug.headSeq,revision:state.activity?.revision})}
   if(low>high){append('errors.jsonl',{stage:'game',reason:'contradictory moderator bounds',low,high});break}
   state=await command('guess',{value:Math.floor((low+high)/2)})
  }
  if(object(state.activity!.game).active){state=await runtime.escape();append('game-steps.jsonl',{operation:'host-escape',reason:'bounded experiment stop',game:state.activity?.game})}
  save('game-state.json',state);save('address.json',runtime.address)
  console.log(JSON.stringify({stage:'game-complete',phase:object(state.activity!.game).phase,calls:call,headSeq:state.debug.headSeq}))
 }finally{await runtime.close();await new Promise<void>(done=>proxy.close(()=>done()))}
}
if(stage==='sources'){
 const address=load<WorldAddress>('address.json'),store=new WorldStore(join(base,'world.sqlite'))
 const memory=new CognitiveMemoryService(join(base,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
 try{
  const head=store.head(address),ticks=new Map(store.readEvents(address).map(e=>[e.seq,e.tick]))
  const summary=[]
  for(const actor of actors){
   memory.catchUp(address,brandId(actor,'CharacterId'),head.headSeq,'hosted-memory-export')
   const db=new DatabaseSync(join(base,'memory.sqlite'),{readOnly:true})
   let rows:{source_id:string;source_hash:string;epistemic_kind:string;source_seq:number;text_value:string}[]
   try{rows=db.prepare('SELECT source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id').all(worldAddressKey(address)+'\u001f'+actor,head.headSeq) as typeof rows}finally{db.close()}
   const doc={scope:{worldAddress:address,characterId:actor,asOfWorldSeq:head.headSeq},sources:rows.map(r=>({sourceId:r.source_id,sourceHash:r.source_hash,epistemicKind:r.epistemic_kind,worldSeq:r.source_seq,text:r.text_value,characterId:actor,worldAddress:address,knownTick:ticks.get(r.source_seq)!}))}
   save(actor.split(':')[1]+'-sources.json',doc)
   summary.push({actor,count:rows.length,gameSources:rows.filter(r=>r.text_value.includes('主持')||r.text_value.includes('猜测')).length,answerPropertyPresent:rows.some(r=>r.text_value.includes('"answer"'))})
  }
  save('source-summary.json',{head,tick:head.tick,actors:summary})
  console.log(JSON.stringify({stage:'sources',actors:summary}))
 }finally{memory.close();store.close()}
}
if(stage==='build'){
 const aliasRequest=load<{request:{context:WorldJsonObject}}>('game-call-1.json').request
 const people=object(aliasRequest.context.scene).people
 for(const actor of actors){
  const key=actor.split(':')[1]!,doc=load<{scope:WorldJsonObject;sources:unknown[]}>(key+'-sources.json')
  const input={...doc,operation:'build',aliasHistory:[{scope:doc.scope,worldSeq:doc.scope.asOfWorldSeq,people}]}
  save(key+'-build-input.json',input)
  const result=py(input)
  save(key+'-archive.json',result.archive);save(key+'-index.json',result.index);save(key+'-build-trace.json',result)
  const archive=object(result.archive)
  console.log(JSON.stringify({stage:'build',actor,sources:doc.sources.length,atoms:(archive.facts as unknown[]).length,episodes:(archive.episodes as unknown[]).length,observations:(archive.observations as unknown[]).length}))
 }
}
if(stage==='probe'){
 const address=load<WorldAddress>('address.json'),summary=load<{head:{headSeq:number;tick:number}}>('source-summary.json')
 const provider=createChatProvider({endpoint:new URL(endpoint),model,timeoutMs:50000,...(process.env.HCW_LOCAL_API_KEY?{apiKey:process.env.HCW_LOCAL_API_KEY}:{})})
 const probes=[{id:'natural',text:'下次的小活动换你来安排吧，想玩什么？',actors:['character:gpt','character:claude']},
  {id:'recall',text:'那局猜数字是谁主持、谁在猜？最后是怎么结束的？',actors},
  {id:'speech',text:'我说过先口头猜 1、还没提交。这句话算正式猜数或获胜了吗？',actors:['character:gpt','character:claude']}]
 const jobs=probes.flatMap(probe=>probe.actors.flatMap(actor=>['empty','native','core-recall','core-observation'].map(mode=>({probe,actor,mode}))))
 let cursor=0
 async function job({probe,actor,mode}:{probe:typeof probes[number];actor:string;mode:string}){
  const id=probe.id+'-'+actor.split(':')[1]+'-'+mode,dir=join(root,'probes',id)
  if(existsSync(dir))throw new Error('probe already exists: '+id)
  mkdirSync(dir,{recursive:true});cpSync(join(base,'world.sqlite'),join(dir,'world.sqlite'));cpSync(join(base,'memory.sqlite'),join(dir,'memory.sqlite'))
  const store=new WorldStore(join(dir,'world.sqlite')),leases=new WriterLeaseService(join(dir,'world.sqlite')),availability=new CharacterRuntimeAvailabilityService(join(dir,'world.sqlite'))
  const memory=new CognitiveMemoryService(join(dir,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
  const sourceDoc=load<{sources:{worldSeq:number;knownTick:number}[]}>(actor.split(':')[1]+'-sources.json'),sourceTicks=new Map(sourceDoc.sources.map(s=>[s.worldSeq,s.knownTick]))
  const stimulus=[{value:{observerId:actor,content:{actorId:'character:player',actionType:'speak',status:'accepted',speech:{characterId:'character:player',text:probe.text}}}}]
  let count=0
  try{
   const turn=new PrototypeCharacterTurn({address,store,leases,availability,rulebooks:createCoreRulebookRegistry({interactionPackages:[createBasicInteractionPackage()]}),memory,
    projectContext:context=>({...context,observations:[],selfObservations:[],memories:[]}),
    decide:async(request,signal)=>{
     let memories:unknown[]=[],retrieval:unknown=null
     const query=typeof request.recallEvidence?.query==='string'?request.recallEvidence.query:probe.text
     if(mode==='native')memories=memory.recall(address,brandId(actor,'CharacterId'),query,summary.head.headSeq).slice(0,3).map(m=>({...m,sourceAgeTicks:summary.head.tick-sourceTicks.get(m.sourceMaxSeq)!}))
     if(mode.startsWith('core-')){const result=py({operation:'recall',archive:load(actor.split(':')[1]+'-archive.json'),index:load(actor.split(':')[1]+'-index.json'),request,tick:summary.head.tick,observations:mode==='core-observation'});memories=result.delivery as unknown[];retrieval=result}
     const visible:PrototypeTurnRequest={...request,context:{...request.context,memories:memories as WorldJsonObject[]},...(request.recallEvidence?{recallEvidence:{query,memories:memories as WorldJsonObject[]}}:{})}
     const record:{[key:string]:unknown}={id,mode,probe:probe.text,actor,sourceCutoff:summary.head.headSeq,recentGameContextRemoved:true,request:visible,retrieval,status:'pending'}
     const path=join(dir,'call-'+(++count)+'.json');writeFileSync(path,JSON.stringify(record,null,2))
     const output=await provider.decide(localPrototypeTurnCall(visible),signal);record.response=output;record.status='returned';writeFileSync(path,JSON.stringify(record,null,2));return output
    }})
   const result=await turn.run(brandId(actor,'CharacterId'),{stimulus,maxCalls:1,signal:AbortSignal.timeout(90000)})
   writeFileSync(join(dir,'result.json'),JSON.stringify({id,result,actualCalls:count,sourceSnapshotHash:createHash('sha256').update(readFileSync(join(base,'world.sqlite'))).digest('hex')},null,2))
   append('probe-results.jsonl',{id,...result,actualCalls:count})
   console.log(JSON.stringify({stage:'probe',id,...result,actualCalls:count}))
  }finally{memory.close();availability.close();leases.close();store.close()}
  }
 const worker=async()=>{while(cursor<jobs.length)await job(jobs[cursor++]!)}
 await Promise.all([worker(),worker()])
}
