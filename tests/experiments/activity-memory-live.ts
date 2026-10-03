import { hindsightPython } from './hindsight-python.ts'
/** Continuous play through the actual host; experimental memory is injected at the provider boundary. */
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { brandId, worldAddressKey, RECALL_KEYWORD_TOKENIZER_ID, type WorldJsonObject } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import { CognitiveMemoryService } from '@harness-world/memory'
import type { PrototypeTurnRequest } from '../../packages/application/src/prototype-character-turn.ts'
import { FrozenWorldPlaytestRuntime } from './playtest-frozen-runtime.ts'
import type { PlaytestState } from './playtest-server.ts'
import { DEFAULT_PLAYTEST_TUNING } from './playtest-tuning.ts'

const root=resolve(process.argv[2]??'.tmp/hosted-memory-live-20261003-'+randomUUID().slice(0,6))
const resume=process.argv.includes('--resume')
if(existsSync(root)&&!resume)throw new Error('live play needs a new data directory, or explicit --resume')
if(resume&&!existsSync(join(root,'failure.json')))throw new Error('resume requires an interrupted experiment')
if(resume&&(existsSync(join(root,'completion.json'))||existsSync(join(root,'stopped.json'))))throw new Error('completed or deliberately stopped experiment is frozen; use a new directory')
mkdirSync(root,{recursive:true})
const base=join(root,'base'),endpoint=process.env.HCW_LOCAL_ENDPOINT??'http://127.0.0.1:8045/v1/chat/completions'
const python=hindsightPython()
const packPath=resolve('examples/world-packs/ai-girls-hosted-guess'),model='gemini-3.7-flash'
const actors=(JSON.parse(readFileSync(join(packPath,'characters.json'),'utf8')).characters as {characterId:string;controllerClass:string;lifecycle?:string}[])
 .filter(c=>c.controllerClass==='scripted'&&c.lifecycle!=='inactive').map(c=>c.characterId)
const save=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value,null,2))
const append=(name:string,value:unknown)=>writeFileSync(join(root,name),JSON.stringify(value)+'\n',{flag:'a'})
const jsonLines=(name:string):Record<string,unknown>[]=>existsSync(join(root,name))?readFileSync(join(root,name),'utf8').split(/\r?\n/u).filter(Boolean).map(s=>JSON.parse(s)):[]
const object=(v:unknown):WorldJsonObject=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('expected object');return v as WorldJsonObject}
function py(input:unknown,utilityTrace?:string):Record<string,unknown>{
 const run=spawnSync(python,[resolve('experiments/activity-memory/core_bridge.py')],{input:JSON.stringify(input),encoding:'utf8',timeout:utilityTrace?600000:240000,
  maxBuffer:128*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONHASHSEED:'0',...(utilityTrace?{HCW_HINDSIGHT_UTILITY_TRACE:utilityTrace}:{})}})
 if(run.status!==0||run.error)throw new Error('memory core failed: '+(run.error?.message??run.stderr.slice(-1800)))
 return JSON.parse(run.stdout) as Record<string,unknown>
}
async function gateway(body:unknown,signal:AbortSignal){
 const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...(process.env.HCW_LOCAL_API_KEY?{authorization:'Bearer '+process.env.HCW_LOCAL_API_KEY}:{})},body:JSON.stringify(body),signal})
 const text=await response.text()
 if(!response.ok)throw new Error('gateway HTTP '+response.status)
 return {text,value:JSON.parse(text) as {choices:{message:{content?:string;tool_calls?:{function:{arguments:string}}[]}}[]}}
}
let runtime!:FrozenWorldPlaytestRuntime, calls=0,roots=0,playerCalls=0,checkpoint=0,emptyAudienceInputs=0
let resumeFreePlay=false,executionPhase='initial'
const caches=new Map<string,{archive:unknown;index:unknown;headSeq:number;sourceCount:number}>(),people=new Map<string,unknown>()
if(resume){
 const paths=readdirSync(root)
 calls=Math.max(0,...paths.filter(p=>/^character-call-\d+\.json$/u.test(p)).map(p=>Number(p.match(/\d+/u)![0])))
 playerCalls=Math.max(0,...paths.filter(p=>/^player-call-\d+\.json$/u.test(p)).map(p=>Number(p.match(/\d+/u)![0])))
 const failure=JSON.parse(readFileSync(join(root,'failure.json'),'utf8')) as {rootInputs:number;phase?:string;error:string}
 resumeFreePlay=failure.phase==='free'||jsonLines('skipped-games.jsonl').length>0||jsonLines('games.jsonl').length>=3
 roots=Math.max(failure.rootInputs,...jsonLines('inputs.jsonl').map(r=>Number(r.rootInput)))
 checkpoint=Math.max(0,...paths.filter(p=>/^checkpoint-\d+$/u.test(p)).map(p=>Number(p.split('-')[1])))
 for(const name of paths.filter(p=>/^character-call-\d+\.json$/u.test(p)).sort((a,b)=>Number(a.match(/\d+/u)![0])-Number(b.match(/\d+/u)![0]))){
  const row=JSON.parse(readFileSync(join(root,name),'utf8'))
  if(row.request)people.set(row.actor,row.request.context.scene.people)
 }
 if(!jsonLines('inputs.jsonl').some(r=>r.rootInput===failure.rootInputs)){
  const pending=playerCalls>0?JSON.parse(readFileSync(join(root,'player-call-'+playerCalls+'.json'),'utf8')):undefined
  append('inputs.jsonl',{rootInput:failure.rootInputs,kind:'rejected-player-input',input:pending?.rootInput===failure.rootInputs?pending.response:null,
   error:true,rejection:failure.error,committed:false})
 }
 append('resumes.jsonl',{afterRootInput:roots,afterCharacterCall:calls,afterCheckpoint:checkpoint,
  tuning:{...DEFAULT_PLAYTEST_TUNING,reactionDeadlineSeconds:120},reason:'resume same save after recorded failure',failure:failure.error,phase:resumeFreePlay?'free':'games',
  memoryInitialization:process.argv.includes('--reuse-complete-memory')?'reuse latest complete checkpoint':'full-prefix rebuild',
  skipMidRefresh:process.argv.includes('--skip-mid-refresh')})
}
const proxy=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{void(async()=>{
 const id=++calls,path='character-call-'+id+'.json'
 try{
  const wire=JSON.parse(body)
  let request=JSON.parse(wire.messages.at(-1).content) as PrototypeTurnRequest
  const actor=String(object(request.context.character).characterId),cached=caches.get(actor)
  people.set(actor,object(request.context.scene).people)
  const store=new WorldStore(join(base,'world.sqlite'));let head
  try{head=store.head(runtime.address)}finally{store.close()}
  let recall:Record<string,unknown>|null=null
  if(cached){
   // The memory core receives an authorized query context, never the game's private state.
   const context=request.context
   const queryRequest={...request,context:{character:context.character,scene:context.scene,items:context.items??[],
    stimulus:context.stimulus??[],observations:context.observations??[],selfObservations:context.selfObservations??[]}}
   recall=py({operation:'recall',archive:cached.archive,index:cached.index,request:queryRequest,tick:head.tick,observations:true})
   const memories=recall.delivery as WorldJsonObject[]
   request={...request,context:{...context,memories},...(request.recallEvidence?{recallEvidence:{...request.recallEvidence,memories}}:{})}
   wire.messages[wire.messages.length-1].content=JSON.stringify(request)
  }
  const record:{[key:string]:unknown}={id,rootInput:roots,actor,model,headSeq:head.headSeq,tick:head.tick,
   memoryPrefix:cached?.headSeq??null,checkpoint,request,recall,status:'pending'}
  save(path,record)
  const response=await gateway(wire,AbortSignal.timeout(50000)),message=response.value.choices[0]!.message
  const raw=message.tool_calls?.[0]?.function.arguments??message.content
  let value:unknown=raw;try{if(raw)value=JSON.parse(raw)}catch{ /* Keep invalid output for review; host still rejects it. */ }
  record.response=value;record.status='returned';save(path,record)
  console.log(JSON.stringify({stage:'character',id,rootInput:roots,actor,memories:recall?(recall.delivery as unknown[]).length:null}))
  res.writeHead(200,{'content-type':'application/json'});res.end(response.text)
 }catch(error){save(path,{id,rootInput:roots,status:'failed',error:error instanceof Error?error.message:'unknown'});res.writeHead(502);res.end('{}')}
})()})})
await new Promise<void>(ready=>proxy.listen(0,'127.0.0.1',ready))
const port=proxy.address();if(!port||typeof port==='string')throw new Error('no proxy port')
async function refreshMemory(label:string){
 const store=new WorldStore(join(base,'world.sqlite')),memory=new CognitiveMemoryService(join(base,'memory.sqlite'),store,undefined,2,RECALL_KEYWORD_TOKENIZER_ID)
 try{
  const head=store.head(runtime.address),ticks=new Map(store.readEvents(runtime.address).map(e=>[e.seq,e.tick]))
  checkpoint++;const dir='checkpoint-'+checkpoint;mkdirSync(join(root,dir))
  for(const actor of actors){
   memory.catchUp(runtime.address,brandId(actor,'CharacterId'),head.headSeq,'live-memory-export')
   const db=new DatabaseSync(join(base,'memory.sqlite'),{readOnly:true})
   let rows:{source_id:string;source_hash:string;epistemic_kind:string;source_seq:number;text_value:string}[]
   try{rows=db.prepare('SELECT source_id,source_hash,epistemic_kind,source_seq,text_value FROM cognitive_memory_v2_sources WHERE namespace_key=? AND source_seq<=? ORDER BY source_seq,source_id')
     .all(worldAddressKey(runtime.address)+'\u001f'+actor,head.headSeq) as typeof rows}finally{db.close()}
   const scope={worldAddress:runtime.address,characterId:actor,asOfWorldSeq:head.headSeq}
   const sources=rows.map(r=>({sourceId:r.source_id,sourceHash:r.source_hash,epistemicKind:r.epistemic_kind,worldSeq:r.source_seq,
    characterId:actor,worldAddress:runtime.address,text:r.text_value,knownTick:ticks.get(r.source_seq)!}))
   const key=actor.split(':')[1]!
   const previousCheckpoint=jsonLines('checkpoints.jsonl').filter(r=>Number(r.headSeq)<=head.headSeq).at(-1)
   const previousPath=previousCheckpoint?join(root,'checkpoint-'+String(previousCheckpoint.checkpoint),key+'-archive.json'):undefined
   const retainedPrefix=caches.get(actor)?.archive??(previousPath&&existsSync(previousPath)?JSON.parse(readFileSync(previousPath,'utf8')):undefined)
   const input={operation:'build',scope,sources,aliasHistory:people.has(actor)?[{scope,worldSeq:head.headSeq,people:people.get(actor)}]:[],
    ...(retainedPrefix===undefined?{}:{retainedPrefix})}
   save(dir+'/'+key+'-input.json',input)
   console.log(JSON.stringify({stage:'building',checkpoint,label,actor,sources:sources.length,headSeq:head.headSeq}))
   const result=py(input,join(root,dir,key+'-utility-calls.jsonl')),archive=object(result.archive)
   save(dir+'/'+key+'-archive.json',archive);save(dir+'/'+key+'-index.json',result.index);save(dir+'/'+key+'-build.json',result)
   caches.set(actor,{archive,index:result.index,headSeq:head.headSeq,sourceCount:sources.length})
   console.log(JSON.stringify({stage:'built',checkpoint,actor,atoms:(archive.facts as unknown[]).length,episodes:(archive.episodes as unknown[]).length}))
  }
  append('checkpoints.jsonl',{checkpoint,label,headSeq:head.headSeq,tick:head.tick})
 }finally{memory.close();store.close()}
}
function recordInput(kind:string,input:unknown,state:PlaytestState,submittedText?:string){
 save('latest-state.json',state)
 append('inputs.jsonl',{rootInput:roots,kind,input,...(submittedText===undefined?{}:{submittedText}),headSeq:state.debug.headSeq,error:state.error,notice:state.notice,
  activity:state.activity,transcript:state.transcript.slice(-12)})
 console.log(JSON.stringify({stage:'input',rootInput:roots,kind,headSeq:state.debug.headSeq,error:state.error}))
 emptyAudienceInputs=state.world.currentScene?.presentNpcNames.length===0?emptyAudienceInputs+1:0
 if(emptyAudienceInputs>=3){
  const warning={rootInput:roots,reason:'three or more consecutive inputs without a present NPC',emptyAudienceInputs}
  append('warnings.jsonl',warning);console.log(JSON.stringify({stage:'warning',...warning}))
 }
}
async function action(operation:string,parameters:WorldJsonObject={}){
 if(++roots>80)throw new Error('root input budget exhausted')
 const before=await runtime.state()
 const state=await runtime.activityAction({activityId:operation==='start'?null:String(before.activity!.id),revision:operation==='start'?0:Number(before.activity!.revision),
  operation,parameters,requestId:randomUUID()})
 recordInput('game',{operation,parameters},state);return state
}
async function player(state:PlaytestState,instruction:string){
 const visible={playerName:state.world.playerName,world:state.world,transcript:state.transcript.slice(-24),activity:state.activity,
  moves:state.availableActions?.flatMap(a=>a.actionType==='move'?a.destinations??[]:[])}
 const id=++playerCalls
 const prompt='你扮演普通玩家程序员，和 AI 美少女自然相处并玩包内小游戏。只依据下面的玩家视图，不能读 NPC 私密状态。不要为测试记忆编剧情，不要连续寒暄或省略号。输出 JSON：{"kind":"speech","text":"..."}、{"kind":"move","locationId":"已提供的地点ID"} 或 {"kind":"game","operation":"guess/pass/quit","value":整数}。对白只是发言，不代表受控动作已完成。'+instruction
 const body={model,messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(visible)}],response_format:{type:'json_object'},temperature:0.7,max_tokens:350}
 save('player-call-'+id+'.json',{id,rootInput:roots+1,request:visible,instruction,status:'pending'})
 const response=await gateway(body,AbortSignal.timeout(50000)),content=response.value.choices[0]!.message.content
 if(!content)throw new Error('player model returned no content')
 const choice=object(JSON.parse(content.trim().replace(/^```json\s*/u,'').replace(/\s*```$/u,'')))
 save('player-call-'+id+'.json',{id,rootInput:roots+1,request:visible,instruction,response:choice,status:'returned'})
 return choice
}
// Model-generated player paragraphs are submitted as one protocol line. Preserve
// the original JSON choice and the actual input separately in the trace.
function playerText(text:string){
 const normalized=text.replace(/\r\n?|\n|\t/gu,' ')
 if(Array.from(normalized).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new Error('AI player returned an unsupported control character')
 return normalized
}
async function converse(count:number,allowMove=false){
 for(let i=0;i<count;i++){
  const before=await runtime.state()
  const choice=await player(before,allowMove?'现在是自由相处时间，可自然聊天或去已有地点走走。偶尔可聊以前的活动，但不必每次追问回忆。':'现在是同场景自由交流，输出 speech。自然接话、讨论兴趣或下一步安排；偶尔聊刚才的体验，别逐项盘问记忆。')
  let text:string
  if(allowMove&&choice.kind==='move'&&typeof choice.locationId==='string'){
   const move=before.availableActions?.flatMap(a=>a.actionType==='move'?a.destinations??[]:[]).find(d=>d.locationId===choice.locationId)
   if(!move)throw new Error('player proposed unavailable move')
   text='/act move '+JSON.stringify({locationId:move.locationId})
  }else{
   if(choice.kind!=='speech'||typeof choice.text!=='string'||!choice.text.trim())throw new Error('invalid player conversation')
   text=playerText(choice.text)
  }
  if(++roots>80)throw new Error('root input budget exhausted')
  const state=await runtime.submit(text);recordInput('conversation',choice,state,text)
  if(i===Math.floor(count/2)-1&&count>=12&&!process.argv.includes('--skip-mid-refresh'))await refreshMemory('mid-free-play')
 }
}
async function reunite(){
 for(let step=0;step<6;step++){
  const before=await runtime.state()
  if(['GPT','Claude'].every(name=>before.world.currentScene?.presentNpcNames.includes(name)))return true
  const choice=await player(before,'想再玩一局，需要你、GPT、Claude真正处于同一地点。此前大家提议去客厅。只输出 speech 或 move；用已提供的 move 改变自己的位置，发言只邀请其他人自行决定是否过来，不声称别人已经移动。')
  let text:string
  if(choice.kind==='move'&&typeof choice.locationId==='string'){
   const move=before.availableActions?.flatMap(a=>a.actionType==='move'?a.destinations??[]:[]).find(d=>d.locationId===choice.locationId)
   if(!move)throw new Error('player proposed unavailable reunion move')
   text='/act move '+JSON.stringify({locationId:move.locationId})
  }else{
   if(choice.kind!=='speech'||typeof choice.text!=='string'||!choice.text.trim())throw new Error('invalid reunion conversation')
   text=playerText(choice.text)
  }
  if(++roots>80)throw new Error('root input budget exhausted')
  recordInput('reunion',choice,await runtime.submit(text),text)
 }
 return false
}
try{
 runtime=await FrozenWorldPlaytestRuntime.create({packPath,dataDirectory:base,
  provider:'local',model,utilityEndpoint:'http://127.0.0.1:'+port.port,timeoutMs:55000,
  tuning:{...DEFAULT_PLAYTEST_TUNING,reactionDeadlineSeconds:120}})
 save('address.json',runtime.address)
 if(!resume)save('protocol.json',{model,experiment:'three hosted games plus continuous free interaction',limits:{rootInputs:80,targetRootInputs:60,gameInputs:[12,8,12],retryPerStall:2,reactionDeadlineSeconds:120},
  memory:'actual Character Turns receive experimental Core Recall + Observation with ending anchors; recent context retained',
  sources:'CognitiveMemoryService authorized per-character prefixes only',maintenance:'initial, after each game, mid and end of free play; full rebuild, no incremental production runtime',
  player:'same model, public/player-scoped view only; second game may quit for a break',privateLogs:true})
 if(resume&&process.argv.includes('--reuse-complete-memory')){
  const dir=join(root,'checkpoint-'+checkpoint),store=new WorldStore(join(base,'world.sqlite'))
  try{
   const head=store.head(runtime.address)
   for(const actor of actors){
    const key=actor.split(':')[1]!,archivePath=join(dir,key+'-archive.json'),indexPath=join(dir,key+'-index.json')
    if(!existsSync(archivePath)||!existsSync(indexPath))throw new Error('latest checkpoint is incomplete; cannot reuse it')
    const archive=object(JSON.parse(readFileSync(archivePath,'utf8'))),scope=object(archive.scope)
    if(scope.characterId!==actor||worldAddressKey(scope.worldAddress as unknown as typeof runtime.address)!==worldAddressKey(runtime.address)
     ||Number(scope.asOfWorldSeq)>head.headSeq||!Array.isArray(archive.sources))throw new Error('cached archive scope mismatch')
    caches.set(actor,{archive,index:JSON.parse(readFileSync(indexPath,'utf8')),headSeq:Number(scope.asOfWorldSeq),sourceCount:archive.sources.length})
   }
   console.log(JSON.stringify({stage:'memory-reused',checkpoint,headSeq:head.headSeq,actors}))
  }finally{store.close()}
 }else await refreshMemory(resume?'resume-after-recorded-failure':'initial')
 executionPhase='games'
 const finishedGames=jsonLines('games.jsonl').length
 for(let game=resumeFreePlay?4:finishedGames+1;game<=3;game++){
  if(game>1&&!await reunite()){
   append('skipped-games.jsonl',{game,rootInput:roots,reason:'participants did not reunite within six ordinary player inputs'})
   break
  }
  let state=await action('start'),stalls=0
  const activityId=state.activity!.id,max=game===2?8:12
  for(let step=0;step<max&&object(state.activity!.game).active;step++){
   const current=object(state.activity!.game)
   if(current.turn!=='character:player'){
    if(++stalls>2)break
    state=await action('retry');continue
   }
   stalls=0
   const choice=await player(state,game===2&&step>=2?'这轮玩了一会儿，想休息可以用 quit 按玩法退出；只输出 game。':'现在轮到你猜数字。根据公开裁决缩小范围，尽量玩到主持宣布结束，也可以 pass。输出 game；不用 speech 代替提交，不提前声称获胜。')
   if(choice.kind!=='game'||!['guess','pass','quit'].includes(String(choice.operation)))throw new Error('invalid player game operation')
   const parameters:WorldJsonObject=choice.operation==='guess'?{value:choice.value!}:{}
   state=await action(String(choice.operation),parameters)
  }
  if(object(state.activity!.game).active){roots++;state=await runtime.escape();recordInput('host-escape',{reason:'game input/stall budget exhausted'},state)}
  append('games.jsonl',{game,activityId,rootInput:roots,gameState:state.activity!.game,headSeq:state.debug.headSeq})
  await refreshMemory('game-'+game+'-closed')
  if(game<3)await converse(2)
 }
 executionPhase='free'
 await converse(resumeFreePlay?Math.max(0,60-roots):Math.max(32,60-roots),true)
 await refreshMemory('free-play-complete')
 const final=await runtime.state();save('final-state.json',final)
 save('completion.json',{completed:true,rootInputs:roots,characterCalls:calls,playerCalls,checkpoints:checkpoint,headSeq:final.debug.headSeq,
  worldHash:createHash('sha256').update(readFileSync(join(base,'world.sqlite'))).digest('hex')})
 console.log(JSON.stringify({stage:'complete',rootInputs:roots,characterCalls:calls,playerCalls,checkpoints:checkpoint}))
}catch(error){save(resume?'resume-failure-'+roots+'-checkpoint-'+checkpoint+'.json':'failure.json',{rootInputs:roots,characterCalls:calls,phase:executionPhase,error:error instanceof Error?error.message:'unknown'});throw error}
finally{await runtime?.close();await new Promise<void>(done=>proxy.close(()=>done()))}
